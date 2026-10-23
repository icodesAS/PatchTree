"""Unit tests for search evaluation, replanning, and pipeline execution."""
import asyncio
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")

from app.models.schemas import Node, Run, RunCreate
from app.orchestrator import pipeline
from app.sandbox.contree_client import PATCH_MARKER, CommandResult, SandboxManager


def _make_run() -> Run:
    req = RunCreate(
        repo_url="https://github.com/example/repo",
        bug_description="Function returns 1 instead of 2",
        target_test="pytest tests/test_bug.py",
        full_suite_test="pytest",
    )
    return Run(run_id=str(uuid.uuid4()), created_at=datetime.now(timezone.utc), **req.model_dump())


def _make_node(test_result: str, run_id: str, tag: str = "") -> Node:
    return Node(
        node_id=str(uuid.uuid4()),
        run_id=run_id,
        branch_type="search",
        checkpoint_id=str(uuid.uuid4()),
        hypothesis=f"hypothesis {tag}",
        patch_diff=f"diff {tag}",
        test_command="pytest tests/test_bug.py",
        test_result=test_result,
        test_output=f"test output {tag or test_result}",
        model_used="stub/model",
        tokens_in=10,
        tokens_out=20,
        status="done",
    )


class AlwaysFailingSandbox(SandboxManager):
    """Stub sandbox where tests never pass, even after apply_patch."""

    def __init__(self, force_stub: bool = True):
        super().__init__(force_stub=True)

    def fork(self, checkpoint_id: str) -> "AlwaysFailingSandbox":
        child = AlwaysFailingSandbox()
        child._history = list(self._checkpoints[checkpoint_id])
        child._checkpoints = self._checkpoints
        return child

    def _stub_run(self, cmd: str) -> CommandResult:
        self._history.append(cmd)
        if cmd.startswith(PATCH_MARKER):
            return CommandResult(0, "patch applied")
        if "pytest" in cmd or "test" in cmd:
            return CommandResult(1, "FAILED tests/test_bug.py::test_bug\n== 1 failed in 0.01s ==")
        return CommandResult(0, "")


class SecondRoundPassSandbox(AlwaysFailingSandbox):
    """Stub sandbox that fails every test through call 5, then passes.

    Call 1 is the reproduce test; calls 2-5 are the round-1 branch tests, so
    round 1 always fails and the Ultra escalation (call 6) always passes.
    """

    test_calls = 0

    def fork(self, checkpoint_id: str) -> "SecondRoundPassSandbox":
        child = SecondRoundPassSandbox()
        child._history = list(self._checkpoints[checkpoint_id])
        child._checkpoints = self._checkpoints
        return child

    def _stub_run(self, cmd: str) -> CommandResult:
        self._history.append(cmd)
        if cmd.startswith(PATCH_MARKER):
            return CommandResult(0, "patch applied")
        if "pytest" in cmd or "test" in cmd:
            type(self).test_calls += 1
            if type(self).test_calls > 5:
                return CommandResult(0, "== 1 passed in 0.01s ==")
            return CommandResult(1, "FAILED tests/test_bug.py::test_bug\n== 1 failed in 0.01s ==")
        return CommandResult(0, "")


# ---------- evaluate_search ----------


def test_evaluate_search():
    print("\n=== test_evaluate_search ===")
    run = _make_run()

    # All 4 branches fail -> None
    branches = [_make_node("fail", run.run_id) for _ in range(4)]
    assert pipeline.evaluate_search(branches) is None
    print("all fail -> None: OK")

    # Mixed results -> the passing node wins
    winner = _make_node("pass", run.run_id)
    branches = [_make_node("fail", run.run_id), winner, _make_node("error", run.run_id), _make_node("fail", run.run_id)]
    assert pipeline.evaluate_search(branches) is winner
    print("one pass -> winner: OK")

    # Multiple passes -> first one wins (deterministic)
    first, second = _make_node("pass", run.run_id), _make_node("pass", run.run_id)
    assert pipeline.evaluate_search([first, second]) is first
    print("multiple pass -> first: OK")

    # Empty input -> None
    assert pipeline.evaluate_search([]) is None
    print("empty -> None: OK")

    print("test_evaluate_search: all assertions passed")



# ---------- run_pipeline ----------


async def test_run_pipeline_winner_round_1():
    print("\n=== test_run_pipeline_winner_round_1 ===")
    run = _make_run()
    stub_sandbox = SandboxManager(force_stub=True)
    final_run, all_nodes = await pipeline.run_pipeline(run, max_rounds=2, sandbox=stub_sandbox)

    # Default stub passes tests after apply_patch, so round 1 finds a winner
    assert final_run.status == "complete", f"expected complete, got {final_run.status}"
    assert final_run.winner_node_id is not None
    node_ids = {n.node_id for n in all_nodes}
    assert final_run.winner_node_id in node_ids, "winner not among created nodes"
    assert len(all_nodes) == 13, f"expected root + 4 + 5 stability + 2 adversarial + 1 full_suite, got {len(all_nodes)}"
    assert final_run.confidence_score == 1.0
    assert final_run.full_suite_result == "pass"
    assert final_run.confidence_report is not None
    assert all_nodes[0].branch_type == "root"
    assert all_nodes[-1].branch_type == "full_suite"
    assert final_run.completed_at is not None
    print(f"winner in round 1: {final_run.winner_node_id}")
    print("test_run_pipeline_winner_round_1: all assertions passed")


async def test_run_pipeline_ultra_escalation_wins():
    print("\n=== test_run_pipeline_ultra_escalation_wins ===")
    run = _make_run()
    SecondRoundPassSandbox.test_calls = 0

    jobs_called: list[str] = []
    real_call_model = pipeline.call_model

    async def spy_call_model(job: str, prompt: str, system_prompt: str | None = None, temperature: float = 0.3) -> dict:
        jobs_called.append(job)
        if job == "generate_patch_ultra":
            return {
                "content": "--- a/app.py\n+++ b/app.py\n@@ -1 +1 @@\n-return 1\n+return 2\n",
                "model": "stub/nvidia/Nemotron-3-Ultra-550b-a55b",
                "tokens_in": 1,
                "tokens_out": 1,
                "stub": True,
            }
        return await real_call_model(job=job, prompt=prompt, system_prompt=system_prompt, temperature=temperature)

    original_sandbox = pipeline.SandboxManager
    pipeline.call_model = spy_call_model
    pipeline.SandboxManager = SecondRoundPassSandbox
    try:
        final_run, all_nodes = await pipeline.run_pipeline(run, max_rounds=2)
    finally:
        pipeline.call_model = real_call_model
        pipeline.SandboxManager = original_sandbox

    assert "generate_patch_ultra" in jobs_called, "Ultra synthesis was not invoked after round 1 failed"
    assert "replan_after_failure" not in jobs_called, "replan should not be called in new architecture"
    assert final_run.status == "complete", f"expected complete, got {final_run.status}"
    assert final_run.winner_node_id is not None
    # root + 4 search (fail) + 1 ultra + 5 stability + 2 adversarial + 1 full_suite = 14
    assert len(all_nodes) == 14, f"expected root+4+1 ultra+5 stability+2 adversarial+1 full_suite=14, got {len(all_nodes)}"
    assert final_run.confidence_report is not None
    # Ultra node is the 6th node (index 5)
    ultra_node = all_nodes[5]
    assert ultra_node.branch_type == "search"
    assert "Ultra" in ultra_node.model_used or "ultra" in ultra_node.model_used.lower()
    print(f"Ultra winner: {final_run.winner_node_id}")
    print("test_run_pipeline_ultra_escalation_wins: all assertions passed")


async def test_run_pipeline_honest_failure():
    print("\n=== test_run_pipeline_honest_failure ===")
    run = _make_run()

    original_sandbox = pipeline.SandboxManager
    pipeline.SandboxManager = AlwaysFailingSandbox
    try:
        final_run, all_nodes = await pipeline.run_pipeline(run, max_rounds=2)
    finally:
        pipeline.SandboxManager = original_sandbox

    assert final_run.status == "failed", f"expected failed, got {final_run.status}"
    assert final_run.winner_node_id is None
    # root + 4 search branches (all fail) + 1 ultra node (also fails) = 6
    assert len(all_nodes) == 6, f"expected root+4 search+1 ultra=6 nodes, got {len(all_nodes)}"
    assert final_run.confidence_report is not None
    assert final_run.completed_at is not None
    print(f"no winner after round 1 + Ultra -> status: {final_run.status}, nodes: {len(all_nodes)}")
    print("test_run_pipeline_honest_failure: all assertions passed")


async def test_run_pipeline_aborts_on_missing_test():
    print("\n=== test_run_pipeline_aborts_on_missing_test ===")
    run = _make_run()

    class MissingTestSandbox(SandboxManager):
        def __init__(self):
            super().__init__(force_stub=True)

        def run_command(self, cmd: str) -> CommandResult:
            self._history.append(cmd)
            return CommandResult(127, "/bin/sh: 1: pytest: not found")

    sandbox = MissingTestSandbox()
    final_run, all_nodes = await pipeline.run_pipeline(run, sandbox=sandbox)

    assert final_run.status == "failed"
    assert final_run.winner_node_id is None
    # Only root node created; 0 search branches dispatched
    assert len(all_nodes) == 1, f"expected only 1 root node, got {len(all_nodes)}"
    assert all_nodes[0].test_result == "error"
    assert "Reproduction Aborted" in (final_run.confidence_report or "")
    print(f"aborted early: nodes={len(all_nodes)}, root_result={all_nodes[0].test_result}")
    print("test_run_pipeline_aborts_on_missing_test: all assertions passed")


async def _main():
    test_evaluate_search()
    await test_run_pipeline_winner_round_1()
    await test_run_pipeline_ultra_escalation_wins()
    await test_run_pipeline_honest_failure()
    await test_run_pipeline_aborts_on_missing_test()
    print("\nAll evaluate/replan tests passed!")



if __name__ == "__main__":
    asyncio.run(_main())
