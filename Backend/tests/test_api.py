"""API endpoint tests for runs, status polling, and execution tree."""

import os
import sys
import unittest
from datetime import datetime
from io import TextIOWrapper
from pathlib import Path
from unittest.mock import AsyncMock, patch
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

if sys.platform == "win32":
    for stream in (sys.stdout, sys.stderr):
        if isinstance(stream, TextIOWrapper):
            stream.reconfigure(encoding="utf-8")

from app import main
from app.orchestrator import pipeline
from starlette.testclient import TestClient
from tests.test_evaluate import AlwaysFailingSandbox

REQUEST = {
    "repo_url": "https://github.com/example/repo",
    "bug_description": "Off-by-one error — expected 2, got 1 (测试)",
    "target_test": "pytest tests/test_bug.py",
    "full_suite_test": "pytest",
}


class APITests(unittest.TestCase):
    def setUp(self):
        main.runs.clear()
        main.nodes.clear()
        self.addCleanup(main.runs.clear)
        self.addCleanup(main.nodes.clear)
        self.enterContext(patch.dict(os.environ, {"NEBIUS_API_KEY": ""}))
        self.client = self.enterContext(TestClient(main.app))

    def create_run(self) -> dict:
        response = self.client.post("/runs", json=REQUEST)
        self.assertEqual(response.status_code, 201)
        created = response.json()
        self.assertEqual(created["status"], "running")
        self.assertEqual(str(UUID(created["run_id"])), created["run_id"])
        self.assertIsNotNone(datetime.fromisoformat(created["created_at"]).tzinfo)
        self.assertIsNone(created["completed_at"])
        self.assertIsNone(created["winner_node_id"])
        for field, value in REQUEST.items():
            self.assertEqual(created[field], value)
        return created

    def get_results(self, run_id: str) -> tuple[dict, list[dict]]:
        # TestClient waits for BackgroundTasks before returning the POST response.
        response = self.client.get(f"/runs/{run_id}")
        self.assertEqual(response.status_code, 200)
        final_run = response.json()
        self.assertEqual(final_run["run_id"], run_id)
        self.assertIsNotNone(final_run["completed_at"])
        self.assertGreaterEqual(
            datetime.fromisoformat(final_run["completed_at"]),
            datetime.fromisoformat(final_run["created_at"]),
        )
        response = self.client.get(f"/runs/{run_id}/tree")
        self.assertEqual(response.status_code, 200)
        tree = response.json()
        self.assertIsInstance(tree, list)
        self.assertEqual(len({node["node_id"] for node in tree}), len(tree))
        for node in tree:
            self.assertEqual(node["run_id"], run_id)
            self.assertEqual(node["status"], "done")
        if tree:
            self.assertEqual(tree[0]["branch_type"], "root")
            self.assertIsNone(tree[0]["parent_node_id"])
            search_ids = {node["node_id"] for node in tree if node["branch_type"] == "search"}
            for node in tree[1:]:
                self.assertIn(node["branch_type"], ("search", "stability", "adversarial", "full_suite"))
                if node["branch_type"] == "search":
                    self.assertEqual(node["parent_node_id"], tree[0]["node_id"])
                elif node["branch_type"] == "stability":
                    self.assertIn(node["parent_node_id"], search_ids)
                elif node["branch_type"] in ("adversarial", "full_suite"):
                    self.assertEqual(node["parent_node_id"], final_run["winner_node_id"])
        return final_run, tree

    def test_health(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})
        self.assertEqual(main.app.title, "PatchTree API")
        self.assertEqual(main.app.version, "0.1.0")

    def test_pipeline_complete_and_tree(self):
        captured_nodes = []

        async def capture_pipeline(run, *args, **kwargs):
            final_run, created_nodes = await pipeline.run_pipeline(run, *args, **kwargs)
            captured_nodes.extend(created_nodes)
            return final_run, created_nodes

        with patch.object(main, "run_pipeline", side_effect=capture_pipeline) as task:
            created = self.create_run()
            self.assertEqual(task.await_count, 1)
            self.assertEqual(task.call_args[0][0], main.runs[created["run_id"]])

        final_run, tree = self.get_results(created["run_id"])
        self.assertEqual(final_run["status"], "complete")
        self.assertEqual(len(tree), 13)
        self.assertEqual(
            tree, [node.model_dump(mode="json") for node in captured_nodes]
        )
        winner = next(
            node for node in tree if node["node_id"] == final_run["winner_node_id"]
        )
        self.assertEqual(winner["test_result"], "pass")
        self.assertEqual(winner["branch_type"], "search")
        self.assertTrue(winner["is_stable"])
        self.assertEqual(winner["stability_passes"], 5)
        self.assertEqual(winner["stability_runs"], 5)
        self.assertEqual(final_run["adversarial_runs"], 2)
        self.assertEqual(final_run["adversarial_survived"], 2)
        self.assertEqual(final_run["full_suite_result"], "pass")
        self.assertEqual(final_run["confidence_score"], 1.0)
        self.assertIsNotNone(final_run["confidence_report"])
        suite = [n for n in tree if n["branch_type"] == "full_suite"]
        self.assertEqual(len(suite), 1)
        self.assertEqual(suite[0]["parent_node_id"], final_run["winner_node_id"])

    def test_pipeline_failed_and_tree(self):
        with patch.object(pipeline, "SandboxManager", AlwaysFailingSandbox):
            created = self.create_run()
        final_run, tree = self.get_results(created["run_id"])
        self.assertEqual(final_run["status"], "failed")
        self.assertIsNone(final_run["winner_node_id"])
        # root + 4 search (all fail) + 1 ultra escalation (also fails) = 6
        self.assertEqual(len(tree), 6)
        self.assertIsNotNone(final_run["confidence_report"])
        self.assertTrue(all(node["test_result"] in ("fail", "error") for node in tree))

    def test_pipeline_exception_marks_run_failed(self):
        with (
            patch.object(
                main, "run_pipeline", side_effect=RuntimeError("sandbox unavailable")
            ),
            self.assertLogs(main.logger, level="ERROR"),
        ):
            created = self.create_run()
        final_run, tree = self.get_results(created["run_id"])
        self.assertEqual(final_run["status"], "failed")
        self.assertIsNone(final_run["winner_node_id"])
        self.assertEqual(tree, [])

    def test_tree_empty_while_running(self):
        with patch.object(main, "_run_pipeline", new_callable=AsyncMock) as task:
            created = self.create_run()
            task.assert_awaited_once()
        response = self.client.get(f"/runs/{created['run_id']}/tree")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [])
        self.assertEqual(
            self.client.get(f"/runs/{created['run_id']}").json()["status"], "running"
        )

    def test_runs_are_isolated(self):
        first, second = self.create_run(), self.create_run()
        self.assertNotEqual(first["run_id"], second["run_id"])
        for created in (first, second):
            final_run, tree = self.get_results(created["run_id"])
            self.assertEqual(final_run["status"], "complete")
            self.assertEqual(len(tree), 13)
            self.assertIsNotNone(final_run["confidence_report"])

    def test_missing_runs_return_404(self):
        for path in ("/runs/missing", "/runs/missing/tree"):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 404)
                self.assertEqual(response.json(), {"detail": "Run not found"})

    def test_invalid_request_does_not_schedule_pipeline(self):
        with patch.object(main, "run_pipeline") as task:
            for payload in ({}, {**REQUEST, "target_test": None}):
                with self.subTest(payload=payload):
                    self.assertEqual(
                        self.client.post("/runs", json=payload).status_code, 422
                    )
            task.assert_not_called()
        self.assertEqual(main.runs, {})
        self.assertEqual(main.nodes, {})

    def test_cors_preflight(self):
        response = self.client.options(
            "/runs",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["access-control-allow-origin"], "*")
        self.assertIn("POST", response.headers["access-control-allow-methods"])
        self.assertEqual(
            response.headers["access-control-allow-headers"], "content-type"
        )
        response = self.client.get(
            "/health", headers={"Origin": "http://localhost:5173"}
        )
        self.assertEqual(response.headers["access-control-allow-origin"], "*")


    def test_pasted_command_or_blank_repo_url_returns_422(self):
        with patch.object(main, "run_pipeline") as task:
            for bad_url in ("pytest tests/test_discount.py::test_x", "   ", "not-a-url"):
                with self.subTest(repo_url=bad_url):
                    res = self.client.post("/runs", json={**REQUEST, "repo_url": bad_url})
                    self.assertEqual(res.status_code, 422)
            task.assert_not_called()

    def test_bare_github_domain_is_normalized(self):
        with patch.object(main, "_run_pipeline", new_callable=AsyncMock):
            res = self.client.post("/runs", json={**REQUEST, "repo_url": "github.com/example/repo"})
            self.assertEqual(res.status_code, 201)
            self.assertEqual(res.json()["repo_url"], "https://github.com/example/repo")

    def test_pipeline_timeout_marks_failed_and_releases_concurrency_lock(self):
        import asyncio as _asyncio

        async def slow_pipeline(run, *args, **kwargs):
            await _asyncio.sleep(1.0)
            return run, []

        with (
            patch.object(main, "RUN_TIMEOUT_SECONDS", 0.02),
            patch.object(main, "run_pipeline", side_effect=slow_pipeline),
            self.assertLogs(main.logger, level="ERROR"),
        ):
            timed_out = self.create_run()

        final_run = self.client.get(f"/runs/{timed_out['run_id']}").json()
        self.assertEqual(final_run["status"], "failed")
        self.assertIn("Timed Out", final_run["confidence_report"])
        # Concurrency lock must be released so the next run succeeds
        next_run = self.create_run()
        self.assertEqual(self.client.get(f"/runs/{next_run['run_id']}").json()["status"], "complete")

    def test_per_run_llm_circuit_breaker(self):
        import asyncio as _asyncio
        from types import SimpleNamespace
        from app.llm import router

        fake_resp = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="diff"))],
            usage=SimpleNamespace(prompt_tokens=5, completion_tokens=5),
        )
        fake_client = SimpleNamespace(
            chat=SimpleNamespace(completions=SimpleNamespace(create=AsyncMock(return_value=fake_resp)))
        )

        async def _exercise():
            tok = router.start_run_llm_budget()
            try:
                await router.call_model("generate_patch_minimal", "p1")
                await router.call_model("generate_patch_minimal", "p2")
                with self.assertRaises(RuntimeError):
                    await router.call_model("generate_patch_minimal", "p3")
            finally:
                router.end_run_llm_budget(tok)

        with (
            patch.dict(os.environ, {"NEBIUS_API_KEY": "fake-key", "MAX_LLM_CALLS_PER_RUN": "2"}),
            patch.object(router, "_get_llm_client", return_value=fake_client),
        ):
            _asyncio.run(_exercise())


if __name__ == "__main__":
    unittest.main(verbosity=2)
