"""Tests for concurrent multi-branch search round."""
import asyncio
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")

from app.models.schemas import Node, Run, RunCreate
from app.orchestrator.pipeline import search_round
from app.sandbox.contree_client import SandboxManager
from tests.test_reproduce import reproduce


async def test_search_round():
    """Test that search_round creates 4 valid search nodes with patches and test results."""
    # Create a Run and reproduce the root node
    req = RunCreate(
        repo_url="https://github.com/example/repo",
        bug_description="Function returns 1 instead of 2",
        target_test="pytest tests/test_bug.py",
    )
    run = Run(run_id=str(uuid.uuid4()), created_at=datetime.now(timezone.utc), **req.model_dump())
    sandbox = SandboxManager(force_stub=True)
    root_node = reproduce(run, sandbox)

    print(f"\n=== Root Node ===")
    print(f"node_id: {root_node.node_id}")
    print(f"test_result: {root_node.test_result}")
    print(f"checkpoint_id: {root_node.checkpoint_id}")
    assert root_node.test_result == "fail", "Root node should have failing test"

    # Run search_round to fan out 4 branches
    search_nodes = await search_round(run, root_node, round_num=1, sandbox=sandbox)

    print(f"\n=== Search Round Results ===")
    print(f"Total nodes created: {len(search_nodes)}")

    # Verify we got exactly 4 nodes
    assert len(search_nodes) == 4, f"Expected 4 search nodes, got {len(search_nodes)}"

    # Verify each node has the expected structure
    expected_jobs = [
        "generate_patch_minimal",
        "generate_patch_alternative",
        "generate_patch_root_cause",
        "generate_patch_test_driven",
    ]

    for i, node in enumerate(search_nodes):
        print(f"\n--- Node {i + 1} ---")
        print(f"node_id: {node.node_id}")
        print(f"parent_node_id: {node.parent_node_id}")
        print(f"branch_type: {node.branch_type}")
        print(f"test_result: {node.test_result}")
        print(f"model_used: {node.model_used}")
        print(f"tokens_in: {node.tokens_in}")
        print(f"tokens_out: {node.tokens_out}")
        print(f"hypothesis: {node.hypothesis[:80]}...")
        print(f"patch_diff length: {len(node.patch_diff or '')}")
        print(f"status: {node.status}")

        # Assertions
        assert node.node_id is not None, f"Node {i + 1} missing node_id"
        assert node.parent_node_id == root_node.node_id, f"Node {i + 1} parent mismatch"
        assert node.branch_type == "search", f"Node {i + 1} should be search branch"
        assert node.run_id == run.run_id, f"Node {i + 1} run_id mismatch"
        assert node.checkpoint_id is not None, f"Node {i + 1} missing checkpoint_id"
        assert node.hypothesis is not None, f"Node {i + 1} missing hypothesis"
        assert node.patch_diff is not None, f"Node {i + 1} missing patch_diff"
        assert node.test_result in ["pass", "fail", "error"], f"Node {i + 1} invalid test_result"
        assert node.test_output is not None, f"Node {i + 1} missing test_output"
        assert node.model_used is not None, f"Node {i + 1} missing model_used"
        assert node.tokens_in > 0, f"Node {i + 1} should have tokens_in"
        assert node.tokens_out > 0, f"Node {i + 1} should have tokens_out"
        assert node.status == "done", f"Node {i + 1} should be done"

        # Verify hypothesis contains the expected job name
        expected_job = expected_jobs[i]
        assert expected_job in node.hypothesis, f"Node {i + 1} hypothesis should mention {expected_job}"

    # At least one node should pass (since we apply patches in stub mode)
    passing_nodes = [n for n in search_nodes if n.test_result == "pass"]
    print(f"\n=== Summary ===")
    print(f"Passing nodes: {len(passing_nodes)}/4")
    assert len(passing_nodes) > 0, "At least one search branch should produce a passing test"

    print("\n✓ All assertions passed!")


if __name__ == "__main__":
    asyncio.run(test_search_round())


# ---------- real-filesystem search round ----------

from unittest.mock import AsyncMock, patch  # noqa: E402

import pytest  # noqa: E402

from tests.local_sandbox import BUGGY_SOURCE, GARBAGE_DIFF, VALID_DIFF, LocalGitSandbox  # noqa: E402


def _llm(diff: str) -> AsyncMock:
    return AsyncMock(return_value={"content": f"```diff\n{diff}```", "model": "stub/nano", "tokens_in": 1, "tokens_out": 1})


async def _real_round(git_repo, diff: str):
    run = Run(run_id=str(uuid.uuid4()), created_at=datetime.now(timezone.utc), repo_url="https://github.com/realorg/realrepo",
              bug_description="add subtracts", target_test="pytest -q test_calc.py")
    sandbox = LocalGitSandbox(git_repo)
    root = reproduce(run, sandbox)
    assert root.test_result == "fail"
    llm = _llm(diff)
    with patch("app.orchestrator.pipeline.call_model", llm):
        nodes = await search_round(run, root, sandbox=sandbox)
    return nodes, llm


async def test_search_round_rejects_unusable_patches_on_real_git(git_repo):
    nodes, llm = await _real_round(git_repo, GARBAGE_DIFF)
    assert llm.await_count == 4
    assert all(n.test_result == "error" and "Patch application failed" in n.test_output for n in nodes)
    assert (git_repo / "calc.py").read_text() == BUGGY_SOURCE


async def test_search_round_valid_patch_passes_on_real_git(git_repo):
    nodes, _ = await _real_round(git_repo, VALID_DIFF)
    assert [n.test_result for n in nodes] == ["pass"] * 4


def test_container_apply_patch_script_uses_git_apply():
    import inspect
    from app.sandbox import contree_client

    assert "git apply" in inspect.getsource(contree_client.SandboxManager.spawn)


def test_failed_patch_in_container_is_not_reported_as_success():
    class FakeImage:
        uuid, stdout, stderr, exit_code = "u", b"", b"error: patch failed", 1

        def run(self, **kw):
            return self

        def wait(self):
            return self

    mgr = SandboxManager(force_stub=True)
    mgr.stub, mgr._image = False, FakeImage()
    assert mgr.run_command("apply_patch x.diff").exit_code != 0
