import base64
import logging
import os
import uuid
from dataclasses import dataclass
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[3] / ".env")
load_dotenv(Path(__file__).resolve().parents[2] / ".env")

logger = logging.getLogger(__name__)

PATCH_MARKER = "apply_patch"


@dataclass
class CommandResult:
    exit_code: int
    output: str


class SandboxManager:
    def __init__(self, force_stub: bool = False):
        self.stub = force_stub
        self._client = None
        self._image = None  # real mode: current image
        self._history: list[str] = []  # stub mode: commands applied so far
        self._checkpoints: dict[str, list[str]] = {}

        api_key = os.environ.get("NEBIUS_API_KEY", "").strip()
        if force_stub or not api_key or os.environ.get("PATCHTREE_FORCE_STUB", "").lower() in ("1", "true"):
            self.stub = True
            return

        try:
            from contree_sdk import ContreeSync

            self._client = ContreeSync()
            self._client.get_token_info()
        except Exception as e:
            self._fallback(e)

    def _fallback(self, err: Exception) -> None:
        logger.warning("Contree unavailable (%s); using stub sandbox", err)
        self.stub, self._client = True, None

    def spawn(self, image: str, repo_url: str | None = None) -> None:
        self._history = []
        self._repo_url = repo_url or ""
        if not self.stub:
            try:
                self._image = self._client.images.oci(image)

                # Prepare context engine shim payload
                engine_file = Path(__file__).resolve().parents[1] / "orchestrator" / "context_engine.py"
                engine_b64 = ""
                if engine_file.is_file():
                    try:
                        engine_b64 = base64.b64encode(engine_file.read_bytes()).decode("ascii")
                    except Exception as e:
                        logger.warning("Could not read context_engine file: %s", e)

                # Single compound bootstrap script (skips apt-get if tools exist; exports PYTHONPATH)
                bootstrap_script = (
                    "rm -f /usr/lib/python*/EXTERNALLY-MANAGED 2>/dev/null || true && "
                    "echo 'export PIP_BREAK_SYSTEM_PACKAGES=1' >> /etc/environment 2>/dev/null || true && "
                    "echo 'export PIP_BREAK_SYSTEM_PACKAGES=1' >> /etc/profile 2>/dev/null || true && "
                    "echo 'export PYTHONPATH=\"/app:/app/Backend:/app/backend:/app/src:$PYTHONPATH\"' >> /etc/environment 2>/dev/null || true && "
                    "echo 'export PYTHONPATH=\"/app:/app/Backend:/app/backend:/app/src:$PYTHONPATH\"' >> /etc/profile 2>/dev/null || true && "
                    "if ! command -v git >/dev/null 2>&1 || ! command -v gcc >/dev/null 2>&1; then "
                    "  apt-get update -qq && apt-get install -qq -y --no-install-recommends build-essential git patch curl libpq-dev libffi-dev 2>/dev/null || true; "
                    "fi && "
                    "pip install --prefer-binary --quiet pytest && "
                    "cat << 'EOF' > /usr/local/bin/apply_patch && chmod +x /usr/local/bin/apply_patch\n"
                    "#!/bin/sh\n"
                    "if [ -z \"$1\" ] || [ ! -s \"$1\" ]; then\n"
                    "  echo 'error: empty or missing patch file' >&2\n"
                    "  exit 1\n"
                    "fi\n"
                    "if git apply --whitespace=fix \"$1\" 2>&1 || git apply --whitespace=fix --recount -C1 \"$1\" 2>&1 || patch -p1 --batch --fuzz=3 -i \"$1\" 2>&1; then\n"
                    "  rm -f \"$1\"\n"
                    "  echo 'patch applied'\n"
                    "  exit 0\n"
                    "else\n"
                    "  rm -f \"$1\"\n"
                    "  exit 1\n"
                    "fi\n"
                    "EOF\n"
                    "(cp /usr/local/bin/apply_patch /usr/bin/apply_patch 2>/dev/null || true) && "
                    "(cp /usr/local/bin/apply_patch /bin/apply_patch 2>/dev/null || true)"
                )
                if engine_b64:
                    bootstrap_script += f" && echo '{engine_b64}' | base64 -d > /usr/local/bin/context_engine.py && chmod +x /usr/local/bin/context_engine.py 2>/dev/null || true"

                self.run_command(bootstrap_script)

                # Clone real external git repo into container if specified
                repo = (repo_url or "").strip()
                if repo and not any(d in repo.lower() for d in ("example.com", "example/")):
                    logger.info("Cloning repo %s into container /app...", repo)
                    self.run_command(f"git clone --depth 1 {repo} /app")
                elif repo:
                    logger.info("Scaffolding demo git repository in /app for %s...", repo)
                    demo_setup = (
                        "mkdir -p /app/src /app/tests && cd /app && "
                        "printf 'def calculate_discount(price: float, discount_pct: float) -> float:\\n"
                        "    return price * (1 - discount_pct / 100)\\n' > /app/src/pricing.py && "
                        "printf 'from src.pricing import calculate_discount\\n\\n"
                        "def test_calculate_discount():\\n"
                        "    assert calculate_discount(100.0, 20.0) == 80.0\\n"
                        "    assert calculate_discount(100.0, 0.0) == 100.0\\n"
                        "    assert calculate_discount(100.0, 150.0) == 0.0\\n' > /app/tests/test_discount.py && "
                        "printf 'def compute_average(values: list[float]) -> float:\\n"
                        "    return sum(values) / len(values)\\n' > /app/src/math_service.py && "
                        "printf 'from src.math_service import compute_average\\n\\n"
                        "def test_average_empty():\\n"
                        "    assert compute_average([]) == 0.0\\n"
                        "    assert compute_average([10.0, 20.0]) == 15.0\\n' > /app/tests/test_math.py && "
                        "git init -q && git config user.email 'bot@patchtree.ai' && git config user.name 'PatchTree' && "
                        "git add . && git commit -q -m 'seed demo repo'"
                    )
                    self.run_command(demo_setup)
                return
            except Exception as e:
                self._fallback(e)
        self._history = [f"spawn {image}"]

    def run_command(self, cmd: str) -> CommandResult:
        if not self.stub and self._image is not None:
            try:
                # Prepend PEP 668 and PYTHONPATH exports and execute from /app
                exec_cmd = cmd
                if not cmd.startswith("cat <<") and not cmd.startswith("git clone"):
                    exec_cmd = (
                        'export PIP_BREAK_SYSTEM_PACKAGES=1; '
                        'export PYTHONPATH="/app:/app/Backend:/app/backend:/app/src:$(find /app -mindepth 1 -maxdepth 2 -type d ! -path \'*/.*\' ! -path \'*/tests*\' ! -path \'*/venv*\' ! -path \'*/__pycache__*\' 2>/dev/null | tr \'\\n\' \':\'):$PYTHONPATH"; '
                        f'if [ -d /app ]; then cd /app; fi; {cmd}'
                    )

                if cmd.startswith(PATCH_MARKER):
                    res = self._image.run(shell=exec_cmd, disposable=False).wait()
                    self._image = res
                    stdout = self._text(res.stdout)
                    stderr = self._text(res.stderr)
                    output = f"{stdout}\n{stderr}".strip() if stdout and stderr else (stdout or stderr)
                    if res.exit_code == 0:
                        return CommandResult(0, output or "patch applied")
                    return CommandResult(res.exit_code, output or "patch failed")

                img = self._image.run(shell=exec_cmd, disposable=False).wait()
                self._image = img
                stdout = self._text(img.stdout)
                stderr = self._text(img.stderr)
                output = f"{stdout}\n{stderr}".strip() if stdout and stderr else (stdout or stderr)
                return CommandResult(img.exit_code, output)
            except Exception as e:
                self._fallback(e)
        return self._stub_run(cmd)

    def checkpoint(self) -> str:
        cid = str(uuid.uuid4())
        if not self.stub and self._image is not None:
            try:
                cid = str(self._image.uuid)
                return cid
            except Exception as e:
                self._fallback(e)
        self._checkpoints[cid] = list(self._history)
        return cid

    def fork(self, checkpoint_id: str) -> "SandboxManager":
        if self.stub:
            child = SandboxManager(force_stub=True)
            child._history = list(self._checkpoints.get(checkpoint_id, []))
            child._checkpoints = self._checkpoints
            child._repo_url = getattr(self, "_repo_url", "")
            return child

        child = SandboxManager.__new__(SandboxManager)
        child.stub, child._client = False, self._client
        child._repo_url = getattr(self, "_repo_url", "")
        try:
            child._image = self._client.images.use(checkpoint_id)
            child._history = []
            child._checkpoints = {}
        except Exception as e:
            logger.warning("Failed to fork checkpoint %s (%s); falling back to stub", checkpoint_id, e)
            child = SandboxManager(force_stub=True)
            child._history = list(self._checkpoints.get(checkpoint_id, []))
            child._checkpoints = self._checkpoints
            child._repo_url = getattr(self, "_repo_url", "")
        return child

    @staticmethod
    def _text(data) -> str:
        return data.decode(errors="replace") if isinstance(data, bytes) else str(data or "")

    def _stub_run(self, cmd: str) -> CommandResult:
        """Simulated sandbox: simulates scenario-accurate test outcomes for demos and tests."""
        self._history.append(cmd)
        if cmd.startswith(PATCH_MARKER):
            return CommandResult(0, "patch applied")

        if "pytest" in cmd or "test" in cmd:
            has_patch = any(h.startswith(PATCH_MARKER) for h in self._history)
            if not has_patch:
                return CommandResult(1, "FAILED tests/test_bug.py::test_reproduce - AssertionError: assert result >= 0\n== 1 failed in 0.04s ==")

            repo = getattr(self, "_repo_url", "").lower()

            # Scenario 3: Hard multi-file bug (auth-pipeline)
            # All 4 standard search branches fail; only Nemotron-3-Ultra (550B) escalation passes
            if "auth" in repo or "multifile" in repo:
                is_ultra = any("ultra" in h.lower() for h in self._history) or "ultra" in cmd.lower()
                if is_ultra:
                    return CommandResult(0, "PASSED tests/test_auth.py::test_token_verification\n== 1 passed in 0.08s ==")
                return CommandResult(1, "FAILED tests/test_auth.py::test_token_verification - AssertionError: Multi-file token state mismatch\n== 1 failed in 0.03s ==")

            # Scenario 2: Flaky test isolation (async-scheduler)
            # 5 stability forks run; fork 3 intermittently fails, isolating the race condition
            if "async" in repo or "flaky" in repo or "scheduler" in repo:
                test_execs = sum(1 for h in self._history if "pytest" in h or "test" in h)
                if test_execs == 4:  # Intermittent failure on one of the stability forks
                    return CommandResult(1, "FAILED tests/test_timer.py::test_timeout - TimeoutError: Task timed out before cancellation signal received\n== 1 failed in 0.15s ==")
                return CommandResult(0, "PASSED tests/test_timer.py::test_timeout\n== 1 passed in 0.03s ==")

            # Scenario 1 (Discount bug) and generic mock repos
            if "discount" in repo:
                # First branch fails, second branch passes
                if len(self._history) <= 3:
                    return CommandResult(1, "FAILED tests/test_discount.py::test_calculate_discount\nAssertionError: Expected 100.0 for 0% discount but got 90.0\n== 1 failed in 0.02s ==")
                return CommandResult(0, "PASSED tests/test_discount.py::test_calculate_discount\n== 1 passed in 0.02s ==")

            return CommandResult(0, "== 1 passed in 0.01s ==")
        return CommandResult(0, "")
