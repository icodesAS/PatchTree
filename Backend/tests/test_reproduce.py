import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.models.schemas import Run, RunCreate
from app.orchestrator.pipeline import (
    reproduce,
    slice_smart_context,
    extract_file_locations_from_trace,
)
from app.sandbox.contree_client import CommandResult, SandboxManager


def test_reproduce():
    req = RunCreate(repo_url="https://github.com/example/repo", bug_description="off by one", target_test="pytest tests/test_bug.py")
    run = Run(run_id=str(uuid.uuid4()), created_at=datetime.now(timezone.utc), **req.model_dump())
    sandbox = SandboxManager(force_stub=True)  # drop force_stub once Contree beta access is granted
    root = reproduce(run, sandbox)
    assert root.test_result == "fail" and "AssertionError" in root.test_output

    # fork from the root checkpoint, apply a patch, test passes; root checkpoint stays failing
    fork = sandbox.fork(root.checkpoint_id)
    fork.run_command("apply_patch fix.diff")
    assert fork.run_command(run.target_test).exit_code == 0
    assert sandbox.fork(root.checkpoint_id).run_command(run.target_test).exit_code == 1
    print("test_reproduce: OK")


def test_missing_requirements_txt():
    """Verify that a repository with no requirements.txt halts with the exact error message."""
    req = RunCreate(
        repo_url="https://github.com/realorg/realrepo",
        bug_description="missing requirements bug",
        target_test="pytest tests/test_bug.py",
    )
    run = Run(run_id=str(uuid.uuid4()), created_at=datetime.now(timezone.utc), **req.model_dump())

    # Simulated sandbox with real mode behavior (stub=False)
    sandbox = SandboxManager(force_stub=True)
    sandbox.stub = False
    sandbox.spawn = lambda *args, **kwargs: None
    sandbox._image = object()

    commands_executed = []

    def mock_run_command(cmd: str) -> CommandResult:
        commands_executed.append(cmd)
        if "test -d /app" in cmd:
            return CommandResult(0, "")
        if "find /app" in cmd:
            return CommandResult(0, "")  # No requirements.txt found anywhere!
        return CommandResult(0, "")

    sandbox.run_command = mock_run_command

    root = reproduce(run, sandbox)
    assert root.test_result == "error", f"expected error, got {root.test_result}"
    assert "No requirements.txt, pyproject.toml, or setup.py" in root.test_output
    print("test_missing_requirements_txt: OK")


def test_pyproject_toml_install():
    """Verify that a repository with pyproject.toml and no requirements.txt installs in editable mode."""
    req = RunCreate(
        repo_url="https://github.com/realorg/tomlrepo",
        bug_description="toml package bug",
        target_test="pytest tests/test_bug.py",
    )
    run = Run(run_id=str(uuid.uuid4()), created_at=datetime.now(timezone.utc), **req.model_dump())

    sandbox = SandboxManager(force_stub=True)
    sandbox.stub = False
    sandbox.spawn = lambda *args, **kwargs: None
    sandbox._image = object()

    commands_executed = []

    def mock_run_command(cmd: str) -> CommandResult:
        commands_executed.append(cmd)
        if "test -d /app" in cmd:
            return CommandResult(0, "")
        if "find /app -name '*requirements*.txt'" in cmd:
            return CommandResult(0, "")  # No requirements.txt
        if "find /app -name 'pyproject.toml'" in cmd:
            return CommandResult(0, "/app/pyproject.toml\n")  # pyproject.toml found!
        if "pip install" in cmd:
            return CommandResult(0, "Successfully installed tomlrepo")
        if "pytest" in cmd:
            return CommandResult(1, "FAILED tests/test_bug.py - AssertionError")
        return CommandResult(0, "")

    sandbox.run_command = mock_run_command

    root = reproduce(run, sandbox)
    assert any("pip install --prefer-binary --quiet -e '/app'" in c for c in commands_executed), (
        f"Did not install from pyproject.toml: {commands_executed}"
    )
    assert root.test_result == "fail"
    print("test_pyproject_toml_install: OK")


def test_setup_py_install():
    """Verify that a repository with setup.py and no requirements.txt installs in editable mode."""
    req = RunCreate(
        repo_url="https://github.com/realorg/setuppyrepo",
        bug_description="setup.py package bug",
        target_test="pytest tests/test_bug.py",
    )
    run = Run(run_id=str(uuid.uuid4()), created_at=datetime.now(timezone.utc), **req.model_dump())

    sandbox = SandboxManager(force_stub=True)
    sandbox.stub = False
    sandbox.spawn = lambda *args, **kwargs: None
    sandbox._image = object()

    commands_executed = []

    def mock_run_command(cmd: str) -> CommandResult:
        commands_executed.append(cmd)
        if "test -d /app" in cmd:
            return CommandResult(0, "")
        if "find /app -name '*requirements*.txt'" in cmd:
            return CommandResult(0, "")
        if "find /app -name 'pyproject.toml'" in cmd:
            return CommandResult(0, "/app/setup.py\n")  # setup.py found!
        if "pip install" in cmd:
            return CommandResult(0, "Successfully installed setuppyrepo")
        if "pytest" in cmd:
            return CommandResult(1, "FAILED tests/test_bug.py - AssertionError")
        return CommandResult(0, "")

    sandbox.run_command = mock_run_command

    root = reproduce(run, sandbox)
    assert any("pip install --prefer-binary --quiet -e '/app'" in c for c in commands_executed), (
        f"Did not install from setup.py: {commands_executed}"
    )
    assert root.test_result == "fail"
    print("test_setup_py_install: OK")


def test_nested_requirements_txt():
    """Verify that a nested requirements.txt (e.g. backend/requirements.txt) is discovered and installed."""
    req = RunCreate(
        repo_url="https://github.com/realorg/realrepo",
        bug_description="nested requirements bug",
        target_test="pytest tests/test_bug.py",
    )
    run = Run(run_id=str(uuid.uuid4()), created_at=datetime.now(timezone.utc), **req.model_dump())

    sandbox = SandboxManager(force_stub=True)
    sandbox.stub = False
    sandbox.spawn = lambda *args, **kwargs: None
    sandbox._image = object()

    commands_executed = []

    def mock_run_command(cmd: str) -> CommandResult:
        commands_executed.append(cmd)
        if "test -d /app" in cmd:
            return CommandResult(0, "")
        if "find /app" in cmd:
            return CommandResult(0, "/app/backend/requirements.txt\n")  # nested!
        if "pip install" in cmd:
            return CommandResult(0, "Successfully installed")
        if "pytest" in cmd:
            return CommandResult(1, "FAILED tests/test_bug.py - AssertionError")
        return CommandResult(0, "")

    sandbox.run_command = mock_run_command

    root = reproduce(run, sandbox)
    assert any("pip install --prefer-binary --quiet -r '/app/backend/requirements.txt'" in c for c in commands_executed), (
        "Did not install from nested requirements.txt"
    )
    assert root.test_result == "fail"  # Successfully ran pytest after dependency install!
    print("test_nested_requirements_txt: OK")


def test_smart_context_windowing():
    """Verify that a 1000-line file correctly captures lines 117 and 876 without blind truncation."""
    lines = [f"# Code line {i}" for i in range(1, 1001)]
    lines[116] = "def calculate_subtotal(): return 117"
    lines[875] = "def execute_final_tax(): return 876 / 0"
    content = "\n".join(lines)

    trace = "src/calculator.py:876: in execute_final_tax\nsrc/calculator.py:117: in calculate_subtotal"
    locations = extract_file_locations_from_trace("pytest tests/test_calc.py", trace)

    assert "src/calculator.py" in locations
    assert 117 in locations["src/calculator.py"]
    assert 876 in locations["src/calculator.py"]

    sliced = slice_smart_context(content, locations["src/calculator.py"], max_total_lines=250)

    # Line 117 must be present
    assert "117 | def calculate_subtotal(): return 117" in sliced
    # Line 876 must be present
    assert "876 | def execute_final_tax(): return 876 / 0" in sliced
    # Intermediate lines must be skipped
    assert "lines skipped" in sliced
    # Header lines must be present
    assert "   1 | # Code line 1" in sliced

    print("test_smart_context_windowing: OK")


if __name__ == "__main__":
    test_reproduce()
    test_missing_requirements_txt()
    test_pyproject_toml_install()
    test_setup_py_install()
    test_nested_requirements_txt()
    test_smart_context_windowing()
    print("All reproduction and context tests passed!")
