"""The command line, run as `python -m unpictured_pipeline`."""

import argparse
import os
import random
import re
import sys
import tempfile
import time
from datetime import datetime
from importlib.metadata import version
from pathlib import Path

from unpictured_pipeline.photos import PhotoError, write_clean_copy
from unpictured_pipeline.spending import (
    ESTIMATED_CREDITS_FROM_PHOTO,
    CostLog,
    SpendingLimitError,
    check_daily_cap,
    credits_to_usd,
    estimate_credits,
)
from unpictured_pipeline.world_package import source_photo_name, write_package
from unpictured_pipeline.worldlabs import API_BASE_URL, WorldLabsClient, WorldLabsError

DEFAULT_MODEL = "marble-1.0-draft"
DEFAULT_DAILY_CAP_USD = 3.0
MAX_UPLOAD_BYTES = 20_000_000
MAX_PHOTOS = 4  # the World API's limit for photos placed by direction
PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
PACKAGE_NAME = re.compile(r"[a-z0-9][a-z0-9-]*")
POLL_SECONDS = 5
WAIT_TIMEOUT_SECONDS = 30 * 60


class UsageError(Exception):
    pass


class GenerationFailedError(Exception):
    pass


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command is None:
        parser.print_help()
        return 0
    try:
        return args.run(args)
    except (
        UsageError,
        PhotoError,
        SpendingLimitError,
        WorldLabsError,
        GenerationFailedError,
        FileExistsError,
    ) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        return 130


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m unpictured_pipeline",
        description="Generate and prepare Unpictured world packages. "
        "Commands that call the World API read the key from WLT_API_KEY.",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"unpictured-pipeline {version('unpictured-pipeline')}",
    )
    commands = parser.add_subparsers(dest="command")

    credits = commands.add_parser("credits", help="show the remaining API credits (free)")
    credits.set_defaults(run=run_credits)

    generate = commands.add_parser(
        "generate", help="generate a world from 1 to 4 photos (a dry run unless --yes)"
    )
    generate.add_argument("photos", nargs="+", type=Path, metavar="photo")
    generate.add_argument(
        "--azimuth",
        type=float,
        action="append",
        default=[],
        help="with 2 to 4 photos, each photo's direction in degrees, in the same order "
        "(0 front, 90 right, 180 back, 270 left)",
    )
    generate.add_argument(
        "--model", choices=sorted(ESTIMATED_CREDITS_FROM_PHOTO), default=DEFAULT_MODEL
    )
    generate.add_argument("--name", help="package folder name (default: from the photo)")
    generate.add_argument("--yes", action="store_true", help="spend the credits")
    generate.add_argument("--worlds-dir", type=Path)
    generate.set_defaults(run=run_generate)

    fetch = commands.add_parser(
        "fetch", help="download an existing world again (free), e.g. after an interruption"
    )
    source = fetch.add_mutually_exclusive_group(required=True)
    source.add_argument("--world", help="world ID")
    source.add_argument("--operation", help="operation ID printed by generate")
    fetch.add_argument("--name", required=True, help="package folder name")
    fetch.add_argument(
        "--photo",
        type=Path,
        action="append",
        default=[],
        help="source photo to add to the package; repeat it for each photo, in order",
    )
    fetch.add_argument(
        "--azimuth",
        type=float,
        action="append",
        default=[],
        help="each photo's direction, as it was given to generate",
    )
    fetch.add_argument("--worlds-dir", type=Path)
    fetch.set_defaults(run=run_fetch)
    return parser


def run_credits(args: argparse.Namespace) -> int:
    remaining = api_client().get_credits()
    print(f"Remaining credits: {remaining:,.0f} (${credits_to_usd(remaining):.2f})")
    return 0


def run_generate(args: argparse.Namespace) -> int:
    photos = [check_photo(photo) for photo in args.photos]
    azimuths = check_azimuths(photos, args.azimuth)
    worlds_dir = args.worlds_dir or default_worlds_dir()
    name = check_name(args.name or default_package_name(photos[0], args.model))
    destination = worlds_dir / name
    if destination.exists():
        raise UsageError(f"{destination} already exists; choose another --name")

    estimated_credits = estimate_credits(args.model, len(photos))
    cap_usd = daily_cap_usd()
    cost_log = CostLog(cost_log_path())
    today = datetime.now().astimezone().date()
    spent_usd = credits_to_usd(cost_log.credits_started_on(today))
    client = api_client()
    remaining = client.get_credits()

    with tempfile.TemporaryDirectory() as temp_dir:
        uploads = prepare_uploads(photos, Path(temp_dir))
        for index, photo in enumerate(photos):
            direction = "" if azimuths is None else f" at azimuth {azimuths[index]:g}"
            print(
                f"Photo:   {photo.name}{direction}, uploaded as a "
                f"{uploads[index].stat().st_size / 1e6:.1f} MB JPEG with its metadata removed"
            )
        print(
            f"Model:   {args.model}, about {estimated_credits:,} credits "
            f"(${credits_to_usd(estimated_credits):.2f})"
        )
        print(f"Balance: {remaining:,.0f} credits")
        print(f"Today:   ${spent_usd:.2f} spent of the ${cap_usd:.2f} daily cap")
        print(f"Log:     {cost_log.path}")
        print(f"Package: {destination}")
        if not args.yes:
            print("Dry run: nothing was spent. Add --yes to generate.")
            return 0

        check_daily_cap(cost_log, estimated_credits, cap_usd, today)
        media_asset_ids = [client.upload_image(upload) for upload in uploads]
        seed = random.randrange(2**31)
        operation_id = start_generation_logged(
            client,
            cost_log,
            media_asset_ids,
            azimuths,
            args.model,
            name,
            seed,
            estimated_credits,
        )
        print("Drafts take about 20 seconds, standard worlds about 5 minutes.")
        world_id = None
        try:
            operation = wait_for_operation(client, operation_id)
            credits = record_settled_cost(cost_log, operation)
            world_id = operation["response"]["world_id"]
            world = client.get_world(world_id)
            write_package(
                world,
                destination,
                source_photos=uploads,
                photo_azimuths=azimuths,
                operation_id=operation_id,
                seed=seed,
                credits=credits,
            )
        except GenerationFailedError:
            raise
        except BaseException:  # also Ctrl-C: the generation carries on without us
            print_fetch_hint(photos, azimuths, name, args.worlds_dir, operation_id, world_id)
            raise
    print_package_summary(destination, world, credits)
    return 0


def run_fetch(args: argparse.Namespace) -> int:
    worlds_dir = args.worlds_dir or default_worlds_dir()
    destination = worlds_dir / check_name(args.name)
    if destination.exists():
        raise UsageError(f"{destination} already exists; choose another --name")
    photos = [check_photo(photo) for photo in args.photo]
    azimuths = check_azimuths(photos, args.azimuth)
    client = api_client()
    credits = None
    if args.operation:
        operation = wait_for_operation(client, args.operation)
        credits = record_settled_cost(CostLog(cost_log_path()), operation)
        world_id = operation["response"]["world_id"]
    else:
        world_id = args.world
    world = client.get_world(world_id)
    with tempfile.TemporaryDirectory() as temp_dir:
        write_package(
            world,
            destination,
            source_photos=prepare_uploads(photos, Path(temp_dir)),
            photo_azimuths=azimuths,
            operation_id=args.operation,
            credits=credits,
        )
    print_package_summary(destination, world, credits)
    return 0


def prepare_uploads(photos: list[Path], temp_dir: Path) -> list[Path]:
    """The uploads and the package's source photos are these cleaned copies, never the originals."""
    uploads = []
    for index, photo in enumerate(photos, start=1):
        upload = write_clean_copy(photo, temp_dir / source_photo_name(index, len(photos)))
        if upload.stat().st_size >= MAX_UPLOAD_BYTES:
            raise UsageError(f"{photo.name} is still over the API's 20 MB limit as a JPEG")
        uploads.append(upload)
    return uploads


def start_generation_logged(
    client: WorldLabsClient,
    cost_log: CostLog,
    media_asset_ids: list[str],
    azimuths: list[float] | None,
    model: str,
    name: str,
    seed: int,
    estimated_credits: float,
) -> str:
    try:
        reply = client.start_generation(media_asset_ids, azimuths, model, name, seed)
        operation_id = reply.get("operation_id")
        if not operation_id:
            raise WorldLabsError("The reply has no operation ID.")
    except BaseException as error:  # also Ctrl-C while the request is in flight
        # Only a 4xx reply means the start was refused. Anything else may have started it.
        if isinstance(error, WorldLabsError) and error.status and 400 <= error.status < 500:
            raise
        unknown_id = f"unconfirmed-{datetime.now().strftime('%Y%m%dT%H%M%S')}"
        cost_log.record("unconfirmed", unknown_id, estimated_credits, model=model, name=name)
        print(
            "The generation may have started anyway: check "
            "https://platform.worldlabs.ai/usage before trying again.",
            file=sys.stderr,
        )
        if isinstance(error, Exception) and not isinstance(error, WorldLabsError):
            raise WorldLabsError(f"Unexpected reply: {error!r}") from None
        raise
    # Shown before logging, so the ID is on screen even if the log write fails.
    print(f"Started operation {operation_id} (seed {seed}).")
    cost_log.record("started", operation_id, estimated_credits, model=model, name=name, seed=seed)
    return operation_id


def wait_for_operation(client: WorldLabsClient, operation_id: str) -> dict:
    deadline = time.monotonic() + WAIT_TIMEOUT_SECONDS
    last_progress = None
    while True:
        operation = client.get_operation(operation_id)
        if operation.get("done"):
            break
        progress = ((operation.get("metadata") or {}).get("progress") or {}).get("description")
        if progress and progress != last_progress:
            print(f"  {progress}")
            last_progress = progress
        if time.monotonic() > deadline:
            raise WorldLabsError(
                f"Operation {operation_id} is still running after "
                f"{WAIT_TIMEOUT_SECONDS // 60} minutes."
            )
        time.sleep(POLL_SECONDS)
    error = operation.get("error")
    if error:
        raise GenerationFailedError(
            f"Generation failed (code {error.get('code')}): {error.get('message')}"
        )
    return operation


def record_settled_cost(cost_log: CostLog, operation: dict) -> float | None:
    cost = operation.get("cost")
    if not cost:
        return None
    credits = cost["total_credits"]
    if cost_log.is_settled(operation["operation_id"]):
        return credits
    cost_log.record(
        "settled",
        operation["operation_id"],
        credits,
        world_id=operation["response"]["world_id"],
        line_items=cost.get("line_items", []),
    )
    return credits


def print_fetch_hint(
    photos: list[Path],
    azimuths: list[float] | None,
    name: str,
    worlds_dir: Path | None,
    operation_id: str,
    world_id: str | None,
) -> None:
    if world_id:
        state, source = "was generated and billed", f"--world {world_id}"
    else:
        state, source = "was started and will be billed", f"--operation {operation_id}"
    command = f"python -m unpictured_pipeline fetch {source} --name {name}"
    for photo in photos:
        command += f' --photo "{photo}"'
    for azimuth in azimuths or []:
        command += f" --azimuth {azimuth:g}"
    if worlds_dir:
        command += f' --worlds-dir "{worlds_dir}"'
    print(
        f"Do not run generate again: the world {state}. Download it for free with: {command}",
        file=sys.stderr,
    )


def print_package_summary(destination: Path, world: dict, credits: float | None) -> None:
    print(f"World {world['world_id']} saved to {destination}")
    if credits is not None:
        print(f"Billed: {credits:,.0f} credits (${credits_to_usd(credits):.2f})")
    if world.get("world_marble_url"):
        print(f"View in Marble: {world['world_marble_url']}")


def api_client() -> WorldLabsClient:
    api_key = os.environ.get("WLT_API_KEY", "").strip()
    if not api_key:
        raise UsageError(
            "WLT_API_KEY is not set. Run with: "
            "uv run --env-file <path to key file> python -m unpictured_pipeline ..."
        )
    base_url = os.environ.get("UNPICTURED_API_BASE_URL", API_BASE_URL)
    return WorldLabsClient(api_key, base_url)


def cost_log_path() -> Path:
    """One log per user, so every clone and --worlds-dir counts toward the same daily cap."""
    override = os.environ.get("UNPICTURED_COST_LOG", "").strip()
    if not override:
        return Path.home() / ".unpictured" / "cost_log.jsonl"
    path = Path(override).expanduser()
    if not path.is_absolute():
        raise UsageError(f"UNPICTURED_COST_LOG must be an absolute path, not {override!r}")
    return path


def daily_cap_usd() -> float:
    raw = os.environ.get("UNPICTURED_DAILY_CAP_USD", str(DEFAULT_DAILY_CAP_USD))
    try:
        return float(raw)
    except ValueError:
        raise UsageError(f"UNPICTURED_DAILY_CAP_USD must be a number, not {raw!r}") from None


def check_photo(photo: Path) -> Path:
    if not photo.is_file():
        raise UsageError(f"{photo} is not a file")
    if photo.suffix.lower() not in PHOTO_EXTENSIONS:
        raise UsageError(
            f"{photo.name}: use one of {', '.join(sorted(PHOTO_EXTENSIONS))} "
            "(convert HEIC photos to JPG first)"
        )
    return photo


def check_azimuths(photos: list[Path], azimuths: list[float]) -> list[float] | None:
    """One photo takes no direction; two to four photos take one --azimuth each, in order."""
    if len(photos) > MAX_PHOTOS:
        raise UsageError(f"{len(photos)} photos: the World API takes at most {MAX_PHOTOS}")
    if len(photos) <= 1:
        if azimuths:
            raise UsageError("--azimuth is only for two or more photos")
        return None
    if len(azimuths) != len(photos):
        raise UsageError(
            f"{len(photos)} photos need {len(photos)} --azimuth values, one per photo in "
            f"order, not {len(azimuths)}"
        )
    for azimuth in azimuths:
        if not 0 <= azimuth < 360:
            raise UsageError(
                f"--azimuth {azimuth:g}: use degrees from 0 up to 360 "
                "(0 front, 90 right, 180 back, 270 left)"
            )
    return azimuths


def check_name(name: str) -> str:
    if not PACKAGE_NAME.fullmatch(name):
        raise UsageError(
            f"--name {name!r}: use lowercase letters, digits and hyphens "
            "(it becomes a folder and a URL)"
        )
    return name


def default_package_name(photo: Path, model: str) -> str:
    name = re.sub(r"[^a-z0-9]+", "-", photo.stem.lower()).strip("-") or "world"
    return f"{name}-draft" if model.endswith("-draft") else name


def default_worlds_dir() -> Path:
    for folder in [Path.cwd(), *Path.cwd().parents]:
        if (folder / ".git").exists():
            return folder / "worlds"
    raise UsageError("Could not find the repo root; pass --worlds-dir.")
