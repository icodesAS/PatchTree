"""Tests for the PatchTree context engine. Needs only Python + git; no network, no sandbox.

Run:  python -m pytest tests/test_context_engine.py -q      (or: python tests/test_context_engine.py)
"""
import pathlib
import subprocess
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from app.orchestrator import context_engine as ce


# ---- a tiny repo that contains every edge case from the design doc -------------------
def make_repo(root: pathlib.Path, git: bool = True) -> pathlib.Path:
    w = lambda rel, txt: (root / rel).parent.mkdir(parents=True, exist_ok=True) or (root / rel).write_text(txt)
    w("pkg/__init__.py", "from .gateway import PaymentGateway\n")
    w("pkg/decorators.py",
      "import functools\n\n\ndef retry(exceptions=(Exception,), times=2):\n"
      '    """Retry the wrapped call."""\n    def deco(fn):\n        @functools.wraps(fn)\n'
      "        def wrapper(*args, **kwargs):\n            last = None\n            for _ in range(times):\n"
      "                try:\n                    return fn(*args, **kwargs)\n                except exceptions as exc:\n"
      "                    last = exc\n            raise last\n        return wrapper\n    return deco\n")
    w("pkg/base.py",
      'import json\nimport os\n\nSCHEMA_FILE = "schema.json"\nMAX_TOKENS = 5\n\n\nclass BaseGateway:\n'
      '    """Common gateway logic."""\n\n    def __init__(self):\n        self.calls = 0\n\n'
      "    def _load_schema(self):\n        here = os.path.dirname(__file__)\n"
      '        with open(os.path.join(here, "schema.json")) as fh:\n            return json.load(fh)\n\n'
      "    def _parse_token(self, data):\n        # BUG: assumes the key always exists\n"
      '        return data["token"].strip()\n\n    def process(self, payload):\n        self.calls += 1\n'
      "        token = self._parse_token(payload)\n        return len(token) * 10\n")
    w("pkg/schema.json", '{"required": ["token"]}\n')
    w("pkg/queries/get_user.sql", "SELECT id, name FROM users WHERE token = :token;\n")
    w("ext/fast.c", "#include <stdio.h>\nint fast_len(const char *s) {\n    int n = 0;\n    while (s[n]) n++;\n    return n;\n}\n")
    body = ["from .base import BaseGateway", "from .decorators import retry", "", "",
            "class PaymentGateway(BaseGateway):", '    """Card payments."""', ""]
    for i in range(30):
        body += [f"    def filler_{i}(self):", f"        return {i}", ""]
    body += ["    def _transform(self, payload):", '        """Normalise the payload before parsing."""',
             "        out = dict(payload)", '        out["tok"] = out.pop("token", None)  # BUG', "        return out", ""]
    for i in range(60):
        body += [f"    def filler_b{i}(self):", f"        return {i}", ""]
    body += ["    @retry(exceptions=(ValueError,))", "    def process(self, payload):",
             "        data = self._transform(payload)", "        return super().process(data)", ""]
    w("pkg/gateway.py", "\n".join(body))
    w("tests/test_gateway.py",
      "from pkg import PaymentGateway\n\n\ndef test_process_returns_length_times_ten():\n    g = PaymentGateway()\n"
      '    assert g.process({"token": " abc "}) == 30\n\n\ndef test_assertion_only():\n    g = PaymentGateway()\n'
      '    result = g.process({"token": "abcd"})\n    assert result == 40\n')
    if git:
        subprocess.run(["git", "init", "-q", "."], cwd=root, check=True)
        subprocess.run(["git", "add", "."], cwd=root, check=True)
        subprocess.run(["git", "-c", "user.email=a@b", "-c", "user.name=t", "commit", "-qm", "init"], cwd=root, check=True)
    return root


# line numbers below were taken from real pytest output on this repo
KEYERROR_TRACE = """\
    def test_process_returns_length_times_ten():
        g = PaymentGateway()
>       assert g.process({"token": " abc "}) == 30

tests/test_gateway.py:6: 
_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ 
pkg/decorators.py:12: in wrapper
    return fn(*args, **kwargs)
pkg/gateway.py:287: in process
    return super().process(data)
pkg/base.py:25: in process
    token = self._parse_token(payload)
_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ 
>       return data["token"].strip()
E       KeyError: 'token'

pkg/base.py:21: KeyError
"""

ASSERT_TRACE = """\
>       assert result == 40
E       assert 41 == 40

tests/test_gateway.py:12: AssertionError
"""

ASSET_TRACE = """\
Traceback (most recent call last):
  File "/workspace/repo/tests/test_gateway.py", line 6, in test_x
    g._load_schema()
  File "/workspace/repo/pkg/base.py", line 16, in _load_schema
    with open(os.path.join(here, "schema.json")) as fh:
FileNotFoundError: [Errno 2] No such file or directory: '/workspace/repo/pkg/schema.json'
sqlite3.OperationalError: syntax error while running pkg/queries/get_user.sql
ext/fast.c:3:5: error: expected ';' before 'while'
"""


@pytest.fixture()
def repo(tmp_path):
    return make_repo(tmp_path / "r")


def paths(res):
    return {b["path"] for b in res["blocks"]}


def reasons(res, path):
    return " | ".join(b["reason"] for b in res["blocks"] if b["path"] == path)


# ---- parsing -------------------------------------------------------------------------
def test_parse_frames_pytest_format_keeps_order_and_test_frame():
    frames = ce.parse_frames(KEYERROR_TRACE)
    assert [(f.path, f.line) for f in frames] == [
        ("tests/test_gateway.py", 6), ("pkg/decorators.py", 12), ("pkg/gateway.py", 287),
        ("pkg/base.py", 25), ("pkg/base.py", 21)]


def test_parse_frames_native_format():
    frames = ce.parse_frames(ASSET_TRACE)
    assert [f.line for f in frames if f.path.endswith(".py")] == [6, 16]


# ---- the edge cases from the design doc ---------------------------------------------
def test_follows_calls_that_are_not_in_the_traceback(repo):
    """_transform already returned before the crash, so it is NOT in the traceback."""
    res = ce.extract_repository_context(str(repo), KEYERROR_TRACE)
    gw = [b for b in res["blocks"] if b["path"] == "pkg/gateway.py"]
    assert any("called from PaymentGateway.process" in b["reason"] for b in gw)
    assert "def _transform" in res["text"]


def test_includes_base_class_method_and_decorator_definition(repo):
    res = ce.extract_repository_context(str(repo), KEYERROR_TRACE)
    assert "base-class version of PaymentGateway.process" in reasons(res, "pkg/base.py")
    assert "def retry" in res["text"]          # decorator defined in another file


def test_assertion_only_failure_finds_code_under_test(repo):
    res = ce.extract_repository_context(str(repo), ASSERT_TRACE)
    assert any("assertion-style" in n for n in res["notes"])
    assert "pkg/gateway.py" in paths(res) and "pkg/base.py" in paths(res)
    assert "def process" in res["text"]


def test_scope_extraction_returns_whole_function_not_a_blind_window(repo):
    res = ce.extract_repository_context(str(repo), KEYERROR_TRACE)
    # the whole of _parse_token, including its comment and decorator-free signature
    assert "def _parse_token(self, data):" in res["text"]
    assert "# BUG: assumes the key always exists" in res["text"]


def test_non_python_assets_are_bundled(repo):
    res = ce.extract_repository_context(str(repo), ASSET_TRACE)
    assert {"pkg/schema.json", "pkg/queries/get_user.sql", "ext/fast.c"} <= paths(res)


def test_other_checkout_root_in_traceback_still_resolves(repo):
    res = ce.extract_repository_context(str(repo), ASSET_TRACE)
    assert "pkg/base.py" in paths(res)          # trace said /workspace/repo/pkg/base.py


def test_hint_from_bug_report_pulls_in_named_function(repo):
    res = ce.extract_repository_context(str(repo), ASSERT_TRACE, "the bug is somewhere in `_transform`")
    assert "def _transform" in res["text"]


# ---- budget, time, robustness --------------------------------------------------------
@pytest.mark.parametrize("budget", [250, 600, 1500, 4000])
def test_never_exceeds_budget(repo, budget):
    res = ce.extract_repository_context(str(repo), KEYERROR_TRACE, "`_transform`", budget_tokens=budget)
    assert res["tokens"] <= budget
    assert res["blocks"], "even a tiny budget should return something"


def test_small_budget_keeps_the_failing_code(repo):
    res = ce.extract_repository_context(str(repo), KEYERROR_TRACE, budget_tokens=250)
    assert "data[\"token\"].strip()" in res["text"]


def test_wide_profile_allows_more_context(repo):
    a = ce.extract_repository_context(str(repo), KEYERROR_TRACE, "`_transform`", budget_tokens=300)
    b = ce.extract_repository_context(str(repo), KEYERROR_TRACE, "`_transform`", budget_tokens=300, profile="wide")
    assert b["tokens"] >= a["tokens"]


def test_works_without_git(tmp_path):
    repo = make_repo(tmp_path / "nogit", git=False)
    res = ce.extract_repository_context(str(repo), KEYERROR_TRACE, "`_transform`", use_git=False)
    assert "def _transform" in res["text"]


def test_syntax_error_in_a_frame_file_falls_back_to_line_window(repo):
    (repo / "pkg" / "base.py").write_text("def broken(:\n" + "\n".join(f"x{i} = {i}" for i in range(60)) + "\n")
    res = ce.extract_repository_context(str(repo), KEYERROR_TRACE)   # must not raise
    assert "pkg/base.py" in paths(res)


def test_garbage_input_does_not_crash(repo):
    res = ce.extract_repository_context(str(repo), "no traceback here at all")
    assert res["blocks"] == [] and res["notes"]


def test_time_limit_is_respected(repo):
    res = ce.extract_repository_context(str(repo), KEYERROR_TRACE, deadline_s=0.0)
    assert res["truncated"] is True


def test_fetch_symbols_returns_real_symbols_and_reports_missing(repo):
    res = ce.fetch_symbols(str(repo), ["pkg/gateway.py::PaymentGateway._transform", "_parse_token", "nope_xyz"])
    assert "def _transform" in res["text"] and "def _parse_token" in res["text"]
    assert any("nope_xyz" in n for n in res["notes"])


def test_cli_roundtrip(repo):
    import json
    script = pathlib.Path(ce.__file__)
    out = subprocess.run([sys.executable, str(script), "--repo", str(repo), "--budget", "1500"],
                         input=KEYERROR_TRACE, capture_output=True, text=True, check=True).stdout
    assert json.loads(out)["blocks"]


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
