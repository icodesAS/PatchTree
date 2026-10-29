"""Root-node early-stop matrix: no LLM call may happen when the clean repo cannot yield a bug to patch."""
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest

from app.models.schemas import Run
from app.orchestrator import pipeline
from app.sandbox.contree_client import CommandResult
from tests.local_sandbox import ScriptedSandbox

OK = CommandResult(0, "")
FAIL_TEST = CommandResult(1, "FAILED tests/test_bug.py::test_x - AssertionError")
REQ = ("requirements", CommandResult(0, "/app/requirements.txt"))
NO_PKG = ("pyproject", OK)

# case id -> (rules, default result for the target test, expected root test_result, expected output fragment)
CASES = {
    "git-clone-fails": (
        [("test -d /app", CommandResult(1, "")), ("git clone", CommandResult(128, "fatal: repository not found"))],
        FAIL_TEST, "error", "Git clone failed"),
    "no-dependency-manifest": ([], FAIL_TEST, "error", "No requirements.txt, pyproject.toml, or setup.py"),
    "pip-install-fails": (
        [("pip install", CommandResult(1, "ERROR: No matching distribution")), REQ],
        FAIL_TEST, "error", "Dependency installation failed"),
    "root-test-passes": ([REQ, NO_PKG], CommandResult(0, "1 passed"), "pass", ""),
    "pytest-collects-nothing": ([REQ, NO_PKG], CommandResult(5, "no tests ran"), "error", "no tests ran"),
    "pytest-missing-in-container": ([REQ, NO_PKG], CommandResult(127, "pytest: not found"), "error", "pytest: not found"),
}


async def _run_case(case: str):
    rules, default, _, _ = CASES[case]
    run = Run(run_id=str(uuid.uuid4()), created_at=datetime.now(timezone.utc) - timedelta(seconds=3),
              repo_url="https://github.com/realorg/realrepo", bug_description="bug", target_test="pytest tests/test_bug.py")
    llm = AsyncMock()
    with patch.object(pipeline, "call_model", llm):
        final, nodes = await pipeline.run_pipeline(run, sandbox=ScriptedSandbox([*rules, ("pytest tests/test_bug.py", default)], OK))
    return final, nodes, llm


@pytest.mark.parametrize("case", CASES)
async def test_root_early_stop_makes_zero_llm_calls(case):
    final, nodes, llm = await _run_case(case)
    _, _, result, fragment = CASES[case]

    assert llm.await_count == 0
    assert len(nodes) == 1 and nodes[0].branch_type == "root"
    assert nodes[0].test_result == result
    assert fragment in nodes[0].test_output
    assert final.status == "failed" and final.winner_node_id is None
    assert final.confidence_score == 0.0 and final.completed_at is not None
    assert "Reproduction Aborted" in final.confidence_report


@pytest.mark.parametrize("case", CASES)
async def test_root_early_stop_records_wall_time(case):
    final, _, _ = await _run_case(case)
    assert final.total_wall_time_seconds > 0


async def test_root_failing_test_proceeds_to_search():
    """Control: a genuine failing root must NOT be halted (guards against over-eager aborts)."""
    run = Run(run_id=str(uuid.uuid4()), created_at=datetime.now(timezone.utc), repo_url="https://github.com/realorg/realrepo",
              bug_description="bug", target_test="pytest tests/test_bug.py")
    llm = AsyncMock(return_value={"content": "x", "model": "stub/nano", "tokens_in": 1, "tokens_out": 1})
    with patch.object(pipeline, "call_model", llm):
        await pipeline.run_pipeline(run, sandbox=ScriptedSandbox([REQ, NO_PKG, ("pytest tests/test_bug.py", FAIL_TEST)], OK))
    assert llm.await_count >= 4
