"""Runs the CLI as `python -m unpictured_pipeline`.

There is no generated launcher .exe: Windows Smart App Control blocks unsigned ones.
"""

import sys

from unpictured_pipeline.cli import main

if __name__ == "__main__":
    sys.exit(main())
