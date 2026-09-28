import subprocess
from importlib.metadata import version


def test_installed_command_reports_package_version():
    result = subprocess.run(["unpictured", "--version"], capture_output=True, text=True, check=True)
    assert result.stdout.strip() == f"unpictured {version('unpictured-pipeline')}"
