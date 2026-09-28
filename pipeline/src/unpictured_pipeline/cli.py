"""The `unpictured` command."""

import argparse
import os
import random
import re
import sys
import time
from datetime import datetime
from importlib.metadata import version
from pathlib import Path

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
MAX_PHOTO_BYTES = 20_000_000
PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
POLL_SECONDS = 5
WAIT_TIMEOUT_SECONDS = 30 * 60


class UsageError(Exception):
    pass


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command is None:
        parser.print_help()
        return 0
    try:
        return args.run(args)
    except (UsageError, SpendingLimitError, WorldLabsError, FileExistsError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="unpictured",
        description="Generate and prepare Unpictured world packages. "
        "Commands that call the World API read the key from WLT_API_KEY.",
    )
    parser.add_argument(
        "--version", action="version", version=f"%(prog)s {version('unpictured-pipeline')}"
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
    fetch.add_argument("--photo", type=Path, help="source photo to copy into the package")
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
    name = args.name or default_package_name(photo, args.model)
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

    print(f"Photo:   {photo.name} ({photo.stat().st_size / 1_000_000:.1f} MB)")
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
    media_asset_id = client.upload_image(photo)
    seed = random.randrange(2**31)
    operation_id = start_generation_logged(
        client, cost_log, media_asset_id, args.model, name, seed, estimated_credits
    )
    print(
        f"Started operation {operation_id} (seed {seed}). "
        "Drafts take about 20 seconds, standard worlds about 5 minutes."
    )
    operation = wait_for_operation(client, operation_id)
    credits = record_settled_cost(cost_log, operation)
    write_package(
        operation["response"],
        destination,
        source_photo=photo,
        operation_id=operation_id,
        seed=seed,
        credits=credits,
    )
    print_package_summary(destination, operation["response"], credits)
    return 0


def run_fetch(args: argparse.Namespace) -> int:
    worlds_dir = args.worlds_dir or default_worlds_dir()
    destination = worlds_dir / args.name
    if destination.exists():
        raise UsageError(f"{destination} already exists; choose another --name")
    photo = check_photo(args.photo) if args.photo else None
    client = api_client()
    credits = None
    if args.operation:
        operation = wait_for_operation(client, args.operation)
        credits = record_settled_cost(CostLog(worlds_dir / "cost_log.jsonl"), operation)
        world = operation["response"]
    else:
        world = client.get_world(args.world)
    write_package(
        world, destination, source_photo=photo, operation_id=args.operation, credits=credits
    )
    print_package_summary(destination, world, credits)
    return 0


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
        operation = client.start_generation(media_asset_id, model, name, seed)
    except WorldLabsError as error:
        # A 4xx means the start was refused. Anything else may have been accepted.
        if error.status is None or error.status >= 500:
            unknown_id = f"unconfirmed-{datetime.now().strftime('%Y%m%dT%H%M%S')}"
            cost_log.record("unconfirmed", unknown_id, estimated_credits, model=model, name=name)
            raise WorldLabsError(
                f"{error} The generation may have started anyway: check "
                "https://platform.worldlabs.ai/usage before trying again."
            ) from None
        raise
    operation_id = operation["operation_id"]
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
                f"Still running after {WAIT_TIMEOUT_SECONDS // 60} minutes. Resume with: "
                f"unpictured fetch --operation {operation_id} --name <name>"
            )
        time.sleep(POLL_SECONDS)
    error = operation.get("error")
    if error:
        raise WorldLabsError(
            f"Generation failed (code {error.get('code')}): {error.get('message')}"
        )
    return operation


def record_settled_cost(cost_log: CostLog, operation: dict) -> float | None:
    cost = operation.get("cost")
    if not cost:
        return None
    credits = cost["total_credits"]
    cost_log.record(
        "settled",
        operation["operation_id"],
        credits,
        world_id=operation["response"]["world_id"],
        line_items=cost.get("line_items", []),
    )
    return credits


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
            "WLT_API_KEY is not set. Run with: uv run --env-file <path to key file> unpictured ..."
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
        raise UsageError(f"{photo.name}: use one of {', '.join(sorted(PHOTO_EXTENSIONS))}")
    if photo.stat().st_size >= MAX_PHOTO_BYTES:
        raise UsageError(f"{photo.name} is over the API's 20 MB limit")
    return photo


def default_package_name(photo: Path, model: str) -> str:
    name = re.sub(r"[^a-z0-9]+", "-", photo.stem.lower()).strip("-") or "world"
    return f"{name}-draft" if model.endswith("-draft") else name


def default_worlds_dir() -> Path:
    for folder in [Path.cwd(), *Path.cwd().parents]:
        if (folder / ".git").exists():
            return folder / "worlds"
    raise UsageError("Could not find the repo root; pass --worlds-dir.")
