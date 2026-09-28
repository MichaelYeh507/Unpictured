"""The `unpictured` command."""

import argparse
from importlib.metadata import version


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="unpictured",
        description="Generate and prepare Unpictured world packages.",
    )
    parser.add_argument(
        "--version", action="version", version=f"%(prog)s {version('unpictured-pipeline')}"
    )
    parser.parse_args(argv)
    parser.print_help()
    return 0
