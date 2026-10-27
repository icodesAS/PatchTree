"""Unit tests for Supabase DatabaseManager and in-memory fallback."""

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db.client import DatabaseManager, _dict_to_node, _dict_to_run, _node_to_dict, _run_to_dict
from app.models.schemas import Node, Run


def _sample_run() -> Run:
    return Run(
        run_id=str(uuid4()),
        repo_url="https://github.com/example/repo",
        bug_description="Example bug",
        target_test="pytest tests/test_example.py",
        full_suite_test="pytest",
        status="running",
        created_at=datetime.now(timezone.utc),
    )


def _sample_node(run_id: str, branch_type: str = "search") -> Node:
    return Node(
        node_id=str(uuid4()),
        run_id=run_id,
        branch_type=branch_type,
        hypothesis="Test hypothesis",
        patch_diff="--- a\n+++ b",
        test_command="pytest",
        test_result="pass",
        status="complete",
    )


class DatabaseManagerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.mgr = DatabaseManager()
        self.mgr.clear()

    def test_run_serialization_roundtrip(self):
        run = _sample_run()
        run.completed_at = datetime.now(timezone.utc)
        payload = _run_to_dict(run)
        self.assertIsInstance(payload["created_at"], str)
        self.assertIsInstance(payload["completed_at"], str)

        restored = _dict_to_run(payload)
        self.assertEqual(restored.run_id, run.run_id)
        self.assertEqual(restored.repo_url, run.repo_url)
        self.assertEqual(restored.status, run.status)

    def test_node_serialization_roundtrip(self):
        run_id = str(uuid4())
        node = _sample_node(run_id)
        payload = _node_to_dict(node)
        self.assertEqual(payload["node_id"], node.node_id)
        self.assertEqual(payload["run_id"], run_id)

        restored = _dict_to_node(payload)
        self.assertEqual(restored.node_id, node.node_id)
        self.assertEqual(restored.hypothesis, node.hypothesis)

    async def test_in_memory_save_and_get_run(self):
        run = _sample_run()
        await self.mgr.save_run(run)

        fetched = await self.mgr.get_run(run.run_id)
        self.assertIsNotNone(fetched)
        self.assertEqual(fetched.run_id, run.run_id)

    async def test_in_memory_list_runs_ordered(self):
        r1 = _sample_run()
        r1.created_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
        r2 = _sample_run()
        r2.created_at = datetime(2026, 1, 2, tzinfo=timezone.utc)

        await self.mgr.save_run(r1)
        await self.mgr.save_run(r2)

        runs = await self.mgr.list_runs()
        self.assertEqual(len(runs), 2)
        # Newest first
        self.assertEqual(runs[0].run_id, r2.run_id)
        self.assertEqual(runs[1].run_id, r1.run_id)

    async def test_in_memory_save_and_get_nodes(self):
        run = _sample_run()
        n1 = _sample_node(run.run_id, "root")
        n2 = _sample_node(run.run_id, "search")

        await self.mgr.save_nodes(run.run_id, [n1, n2])
        nodes = await self.mgr.get_nodes(run.run_id)
        self.assertEqual(len(nodes), 2)
        self.assertEqual(nodes[0].node_id, n1.node_id)
        self.assertEqual(nodes[1].node_id, n2.node_id)

    async def test_resilient_fallback_on_supabase_exception(self):
        """Verify that network or API errors from Supabase don't crash operations."""
        mock_client = MagicMock()
        mock_client.table.side_effect = RuntimeError("Supabase connection timeout / paused")

        self.mgr._client = mock_client
        run = _sample_run()

        # Should not raise exception
        await self.mgr.save_run(run)
        fetched = await self.mgr.get_run(run.run_id)
        self.assertIsNotNone(fetched)
        self.assertEqual(fetched.run_id, run.run_id)

        runs = await self.mgr.list_runs()
        self.assertEqual(len(runs), 1)

    async def test_supabase_successful_read(self):
        """Verify that when Supabase returns rows, they are loaded into memory."""
        mock_client = MagicMock()
        run = _sample_run()
        data_payload = _run_to_dict(run)

        # Mock select query response
        mock_response = MagicMock()
        mock_response.data = [data_payload]
        mock_client.table().select().eq().execute.return_value = mock_response

        self.mgr._client = mock_client
        # Clear in-memory so it has to query Supabase
        self.mgr.runs.clear()

        fetched = await self.mgr.get_run(run.run_id)
        self.assertIsNotNone(fetched)
        self.assertEqual(fetched.run_id, run.run_id)
        # Should now be cached locally
        self.assertIn(run.run_id, self.mgr.runs)

    async def test_list_runs_filtered_by_client_id(self):
        r1 = _sample_run()
        r1.client_id = "client-alpha"
        r2 = _sample_run()
        r2.client_id = "client-beta"
        r3 = _sample_run()
        r3.client_id = "client-alpha"

        await self.mgr.save_run(r1)
        await self.mgr.save_run(r2)
        await self.mgr.save_run(r3)

        # Filter by client-alpha
        alpha_runs = await self.mgr.list_runs(client_id="client-alpha")
        self.assertEqual(len(alpha_runs), 2)
        self.assertTrue(all(r.client_id == "client-alpha" for r in alpha_runs))

        # Filter by client-beta
        beta_runs = await self.mgr.list_runs(client_id="client-beta")
        self.assertEqual(len(beta_runs), 1)
        self.assertEqual(beta_runs[0].run_id, r2.run_id)

        # Unfiltered returns all
        all_runs = await self.mgr.list_runs()
        self.assertEqual(len(all_runs), 3)


if __name__ == "__main__":
    unittest.main()
