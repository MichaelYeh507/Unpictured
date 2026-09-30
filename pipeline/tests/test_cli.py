import subprocess
import sys
from importlib.metadata import version


def test_module_entry_point_reports_package_version():
    result = subprocess.run(
        [sys.executable, "-m", "unpictured_pipeline", "--version"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert result.stdout.strip() == f"unpictured-pipeline {version('unpictured-pipeline')}"
