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
)
from unpictured_pipeline.world_package import write_package
from unpictured_pipeline.worldlabs import API_BASE_URL, WorldLabsClient, WorldLabsError

DEFAULT_MODEL = "marble-1.0-draft"
DEFAULT_DAILY_CAP_USD = 3.0
MAX_UPLOAD_BYTES = 20_000_000
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
        "generate", help="generate a world from a photo (a dry run unless --yes)"
    )
    generate.add_argument("photo", type=Path)
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
    fetch.add_argument("--photo", type=Path, help="source photo to add to the package")
    fetch.add_argument("--worlds-dir", type=Path)
    fetch.set_defaults(run=run_fetch)
    return parser


def run_credits(args: argparse.Namespace) -> int:
    remaining = api_client().get_credits()
    print(f"Remaining credits: {remaining:,.0f} (${credits_to_usd(remaining):.2f})")
    return 0


def run_generate(args: argparse.Namespace) -> int:
    photo = check_photo(args.photo)
    worlds_dir = args.worlds_dir or default_worlds_dir()
    name = check_name(args.name or default_package_name(photo, args.model))
    destination = worlds_dir / name
    if destination.exists():
        raise UsageError(f"{destination} already exists; choose another --name")

    estimated_credits = ESTIMATED_CREDITS_FROM_PHOTO[args.model]
    cap_usd = daily_cap_usd()
    cost_log = CostLog(worlds_dir / "cost_log.jsonl")
    today = datetime.now().astimezone().date()
    spent_usd = credits_to_usd(cost_log.credits_started_on(today))
    client = api_client()
    remaining = client.get_credits()

    with tempfile.TemporaryDirectory() as temp_dir:
        upload = prepare_upload(photo, Path(temp_dir))
        print(
            f"Photo:   {photo.name}, uploaded as a {upload.stat().st_size / 1e6:.1f} MB "
            "JPEG with its metadata removed"
        )
        print(
            f"Model:   {args.model}, about {estimated_credits:,} credits "
            f"(${credits_to_usd(estimated_credits):.2f})"
        )
        print(f"Balance: {remaining:,.0f} credits")
        print(f"Today:   ${spent_usd:.2f} spent of the ${cap_usd:.2f} daily cap")
        print(f"Package: {destination}")
        if not args.yes:
            print("Dry run: nothing was spent. Add --yes to generate.")
            return 0

        check_daily_cap(cost_log, estimated_credits, cap_usd, today)
        media_asset_id = client.upload_image(upload)
        seed = random.randrange(2**31)
        operation_id = start_generation_logged(
            client, cost_log, media_asset_id, args.model, name, seed, estimated_credits
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
                source_photo=upload,
                operation_id=operation_id,
                seed=seed,
                credits=credits,
            )
        except GenerationFailedError:
            raise
        except BaseException:  # also Ctrl-C: the generation carries on without us
            print_fetch_hint(photo, name, args.worlds_dir, operation_id, world_id)
            raise
    print_package_summary(destination, world, credits)
    return 0


def run_fetch(args: argparse.Namespace) -> int:
    worlds_dir = args.worlds_dir or default_worlds_dir()
    destination = worlds_dir / check_name(args.name)
    if destination.exists():
        raise UsageError(f"{destination} already exists; choose another --name")
    photo = check_photo(args.photo) if args.photo else None
    client = api_client()
    credits = None
    if args.operation:
        operation = wait_for_operation(client, args.operation)
        credits = record_settled_cost(CostLog(worlds_dir / "cost_log.jsonl"), operation)
        world_id = operation["response"]["world_id"]
    else:
        world_id = args.world
    world = client.get_world(world_id)
    with tempfile.TemporaryDirectory() as temp_dir:
        clean_photo = prepare_upload(photo, Path(temp_dir)) if photo else None
        write_package(
            world,
            destination,
            source_photo=clean_photo,
            operation_id=args.operation,
            credits=credits,
        )
    print_package_summary(destination, world, credits)
    return 0


def prepare_upload(photo: Path, temp_dir: Path) -> Path:
    """The upload and the package's source photo are this cleaned copy, never the original."""
    upload = write_clean_copy(photo, temp_dir / "source.jpg")
    if upload.stat().st_size >= MAX_UPLOAD_BYTES:
        raise UsageError(f"{photo.name} is still over the API's 20 MB limit as a JPEG")
    return upload


def start_generation_logged(
    client: WorldLabsClient,
    cost_log: CostLog,
    media_asset_id: str,
    model: str,
    name: str,
    seed: int,
    estimated_credits: float,
) -> str:
    try:
        reply = client.start_generation(media_asset_id, model, name, seed)
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
    photo: Path, name: str, worlds_dir: Path | None, operation_id: str, world_id: str | None
) -> None:
    if world_id:
        state, source = "was generated and billed", f"--world {world_id}"
    else:
        state, source = "was started and will be billed", f"--operation {operation_id}"
    command = f'python -m unpictured_pipeline fetch {source} --name {name} --photo "{photo}"'
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
