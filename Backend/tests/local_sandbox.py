"""Real-filesystem sandbox for integration tests: runs `git apply` / `pytest` in a temp git repo."""
import shlex
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

from app.sandbox.contree_client import PATCH_MARKER, CommandResult, SandboxManager

BUGGY_SOURCE = "def add(a, b):\n    return a - b\n"
FAILING_TEST = "from calc import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n"
VALID_DIFF = (
    "--- a/calc.py\n+++ b/calc.py\n@@ -1,2 +1,2 @@\n"
    " def add(a, b):\n-    return a - b\n+    return a + b\n"
)
# Context line does not match the file -> "patch does not apply"
MISMATCHED_DIFF = (
    "--- a/calc.py\n+++ b/calc.py\n@@ -1,2 +1,2 @@\n"
    " def subtract(a, b):\n-    return a * b\n+    return a + b\n"
)
GARBAGE_DIFF = "Sure! Here is the fix: change the minus to a plus.\n"


def make_git_repo(base: Path) -> Path:
    """Create `base/repo` as a real git repo holding a buggy module and a failing pytest file."""
    repo = base / "repo"
    repo.mkdir(parents=True)
    (repo / "calc.py").write_bytes(BUGGY_SOURCE.encode())
    (repo / "test_calc.py").write_bytes(FAILING_TEST.encode())
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    return repo


class LocalGitSandbox(SandboxManager):
    """Executes commands in a real directory; checkpoint/fork copy the whole tree."""

    def __init__(self, root: Path):
        super().__init__(force_stub=True)  # keeps pipeline in its non-clone, no-context path
        self.root = Path(root)

    def spawn(self, image: str, repo_url: str | None = None) -> None:
        self._repo_url = repo_url or ""

    def run_command(self, cmd: str) -> CommandResult:
        self._history.append(cmd)
        parts = shlex.split(cmd)
        if parts[0] == PATCH_MARKER:
            parts = ["git", "apply", *parts[1:]]
        elif parts[0] == "pytest":
            parts = [sys.executable, "-m", "pytest", "-p", "no:cacheprovider", *parts[1:]]
        try:
            p = subprocess.run(parts, cwd=self.root, capture_output=True, text=True, timeout=60)
        except FileNotFoundError as e:
            return CommandResult(127, str(e))
        return CommandResult(p.returncode, (p.stdout + p.stderr).strip())

    def checkpoint(self) -> str:
        cid = uuid.uuid4().hex
        shutil.copytree(self.root, self.root.parent / f"snap_{cid}", ignore=shutil.ignore_patterns("__pycache__"))
        return cid

    def fork(self, checkpoint_id: str) -> "LocalGitSandbox":
        dst = self.root.parent / f"fork_{uuid.uuid4().hex}"
        shutil.copytree(self.root.parent / f"snap_{checkpoint_id}", dst)
        return LocalGitSandbox(dst)


class ScriptedSandbox(SandboxManager):
    """Non-stub sandbox whose command results come from (substring -> result) rules, first match wins."""

    def __init__(self, rules: list[tuple[str, CommandResult]], default: CommandResult):
        super().__init__(force_stub=True)
        self.stub = False  # make reproduce() take the real clone / dependency-install path
        self.rules, self.default, self.commands = rules, default, []

    def spawn(self, image: str, repo_url: str | None = None) -> None:
        pass

    def run_command(self, cmd: str) -> CommandResult:
        self.commands.append(cmd)
        return next((r for key, r in self.rules if key in cmd), self.default)

    def checkpoint(self) -> str:
        return str(uuid.uuid4())

    def fork(self, checkpoint_id: str) -> "ScriptedSandbox":
        return self
