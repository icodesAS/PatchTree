"""Supabase database client for PatchTree with robust in-memory fallback.

Handles run and node persistence in hosted PostgreSQL via Supabase, with
seamless automatic fallback to in-memory state if Supabase credentials
are missing, offline, or project is paused.
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime
from typing import Any

from dotenv import load_dotenv

from ..models.schemas import Node, Run

load_dotenv()
logger = logging.getLogger(__name__)


def _run_to_dict(run: Run) -> dict[str, Any]:
    data = run.model_dump()
    if isinstance(data.get("created_at"), datetime):
        data["created_at"] = data["created_at"].isoformat()
    if isinstance(data.get("completed_at"), datetime):
        data["completed_at"] = data["completed_at"].isoformat()
    return data


def _dict_to_run(data: dict[str, Any]) -> Run:
    return Run.model_validate(data)


def _node_to_dict(node: Node) -> dict[str, Any]:
    return node.model_dump()


def _dict_to_node(data: dict[str, Any]) -> Node:
    return Node.model_validate(data)


class DatabaseManager:
    """Manages persistent storage for PatchTree runs and nodes."""

    def __init__(self) -> None:
        self.url = (
            os.getenv("SUPABASE_URL")
            or os.getenv("VITE_SUPABASE_URL")
            or ""
        ).strip()
        self.key = (
            os.getenv("SUPABASE_SERVICE_ROLE_KEY")
            or os.getenv("SUPABASE_KEY")
            or os.getenv("VITE_SUPABASE_ANON_KEY")
            or ""
        ).strip()

        # In-memory caches (guarantees zero-failure fallback & instant polling)
        self.runs: dict[str, Run] = {}
        self.nodes: dict[str, list[Node]] = {}

        self._client: Any = None
        self._supabase_disabled = False
        self._warned_offline = False
        self._init_supabase()

    def _init_supabase(self) -> None:
        if not self.url or not self.key:
            logger.info("Supabase credentials not configured; using resilient in-memory storage.")
            return

        try:
            from supabase import Client, create_client

            self._client: Client = create_client(self.url, self.key)
            logger.info("Supabase client initialized successfully (%s)", self.url)
        except Exception as exc:
            logger.warning("Failed to initialize Supabase client: %s; using in-memory storage.", exc)
            self._client = None

    @property
    def is_connected(self) -> bool:
        return self._client is not None and not self._supabase_disabled

    def clear(self) -> None:
        """Clear local in-memory state (useful for test isolation)."""
        self.runs.clear()
        self.nodes.clear()

    # ──────────────────────────────────────────────────────────────────────────
    # Runs CRUD
    # ──────────────────────────────────────────────────────────────────────────

    def _sync_save_run(self, run: Run) -> None:
        self.runs[run.run_id] = run
        if not self.is_connected:
            return

        try:
            payload = _run_to_dict(run)
            self._client.table("runs").upsert(payload).execute()
        except Exception as exc:
            if not self._warned_offline:
                logger.warning("Supabase save_run failed (%s): %s; using in-memory fallback.", run.run_id, exc)
                self._warned_offline = True

    async def save_run(self, run: Run) -> None:
        self.runs[run.run_id] = run
        if self.is_connected:
            await asyncio.to_thread(self._sync_save_run, run)

    def _sync_get_run(self, run_id: str) -> Run | None:
        if run_id in self.runs:
            return self.runs[run_id]

        if self.is_connected:
            try:
                res = self._client.table("runs").select("*").eq("run_id", run_id).execute()
                if res.data and len(res.data) > 0:
                    run = _dict_to_run(res.data[0])
                    self.runs[run.run_id] = run
                    return run
            except Exception as exc:
                if not self._warned_offline:
                    logger.warning("Supabase get_run failed for %s: %s; falling back to memory.", run_id, exc)
                    self._warned_offline = True

        return self.runs.get(run_id)

    async def get_run(self, run_id: str) -> Run | None:
        if run_id in self.runs:
            return self.runs[run_id]
        if self.is_connected:
            return await asyncio.to_thread(self._sync_get_run, run_id)
        return self.runs.get(run_id)

    def _sync_list_runs(self, client_id: str | None = None) -> list[Run]:
        if self.is_connected:
            try:
                query = self._client.table("runs").select("*")
                if client_id:
                    query = query.eq("client_id", client_id)
                res = query.order("created_at", desc=True).execute()
                if res.data is not None:
                    db_runs = [_dict_to_run(row) for row in res.data]
                    for r in db_runs:
                        self.runs[r.run_id] = r
                    if client_id:
                        return db_runs
            except Exception as exc:
                if not self._warned_offline:
                    logger.warning("Supabase list_runs failed: %s; falling back to memory.", exc)
                    self._warned_offline = True

        all_runs = list(self.runs.values())
        if client_id:
            all_runs = [r for r in all_runs if getattr(r, "client_id", None) == client_id]

        return sorted(
            all_runs,
            key=lambda r: r.created_at.timestamp() if r.created_at else 0.0,
            reverse=True,
        )

    async def list_runs(self, client_id: str | None = None) -> list[Run]:
        if self.is_connected:
            return await asyncio.to_thread(self._sync_list_runs, client_id)
        all_runs = list(self.runs.values())
        if client_id:
            all_runs = [r for r in all_runs if getattr(r, "client_id", None) == client_id]
        return sorted(
            all_runs,
            key=lambda r: r.created_at.timestamp() if r.created_at else 0.0,
            reverse=True,
        )

    # ──────────────────────────────────────────────────────────────────────────
    # Nodes CRUD
    # ──────────────────────────────────────────────────────────────────────────

    def _sync_save_node(self, node: Node) -> None:
        node_list = self.nodes.setdefault(node.run_id, [])
        for i, existing in enumerate(node_list):
            if existing.node_id == node.node_id:
                node_list[i] = node
                break
        else:
            node_list.append(node)

        if not self.is_connected:
            return

        try:
            payload = _node_to_dict(node)
            self._client.table("nodes").upsert(payload).execute()
        except Exception as exc:
            if not self._warned_offline:
                logger.warning("Supabase save_node failed for %s: %s; using in-memory fallback.", node.node_id, exc)
                self._warned_offline = True

    async def save_node(self, node: Node) -> None:
        self._sync_save_node(node)
        if self.is_connected:
            await asyncio.to_thread(self._sync_save_node, node)

    def _sync_save_nodes(self, run_id: str, nodes_list: list[Node]) -> None:
        self.nodes[run_id] = list(nodes_list)
        if not self.is_connected or not nodes_list:
            return

        try:
            payloads = [_node_to_dict(n) for n in nodes_list]
            self._client.table("nodes").upsert(payloads).execute()
        except Exception as exc:
            if not self._warned_offline:
                logger.warning("Supabase batch save_nodes failed for run %s: %s; using in-memory fallback.", run_id, exc)
                self._warned_offline = True

    async def save_nodes(self, run_id: str, nodes_list: list[Node]) -> None:
        self.nodes[run_id] = list(nodes_list)
        if self.is_connected and nodes_list:
            await asyncio.to_thread(self._sync_save_nodes, run_id, nodes_list)

    def _sync_get_nodes(self, run_id: str) -> list[Node]:
        if run_id in self.nodes and self.nodes[run_id]:
            return self.nodes[run_id]

        if self.is_connected:
            try:
                res = self._client.table("nodes").select("*").eq("run_id", run_id).execute()
                if res.data is not None and len(res.data) > 0:
                    loaded = [_dict_to_node(row) for row in res.data]
                    self.nodes[run_id] = loaded
                    return loaded
            except Exception as exc:
                if not self._warned_offline:
                    logger.warning("Supabase get_nodes failed for run %s: %s; falling back to memory.", run_id, exc)
                    self._warned_offline = True

        return self.nodes.get(run_id, [])

    async def get_nodes(self, run_id: str) -> list[Node]:
        if run_id in self.nodes and self.nodes[run_id]:
            return self.nodes[run_id]
        if self.is_connected:
            return await asyncio.to_thread(self._sync_get_nodes, run_id)
        return self.nodes.get(run_id, [])


# Global database singleton
db = DatabaseManager()
