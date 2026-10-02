import subprocess
import sys
from importlib.metadata import version


def test_paid_and_recovery_commands_do_not_load_numpy():
    # Only locate needs numpy, so generate and fetch keep working if it cannot load.
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys, unpictured_pipeline.cli; print('numpy' in sys.modules)",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    assert result.stdout.strip() == "False"


def test_module_entry_point_reports_package_version():
    result = subprocess.run(
        [sys.executable, "-m", "unpictured_pipeline", "--version"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert result.stdout.strip() == f"unpictured-pipeline {version('unpictured-pipeline')}"
