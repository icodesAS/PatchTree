import asyncio
from collections import defaultdict
import logging
import sys
import time
from datetime import datetime, timezone
from uuid import uuid4

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import os
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware

from .db.client import db
from .models.schemas import Node, Run, RunCreate
from .orchestrator.pipeline import run_pipeline

logger = logging.getLogger(__name__)

MAX_CONCURRENT_RUNS = int(os.getenv("MAX_CONCURRENT_RUNS", "1"))
MAX_DAILY_RUNS = int(os.getenv("MAX_DAILY_RUNS", "50"))
RUN_TIMEOUT_SECONDS = int(os.getenv("RUN_TIMEOUT_SECONDS", "300"))
RATE_LIMIT_WINDOW_SECONDS = int(os.getenv("RATE_LIMIT_WINDOW_SECONDS", "900"))
MAX_RUNS_PER_IP_WINDOW = int(os.getenv("MAX_RUNS_PER_IP_WINDOW", "10"))

_ip_run_timestamps: dict[str, list[float]] = defaultdict(list)

cors_origins_raw = os.getenv("ALLOWED_ORIGINS", "*")
origins = [o.strip() for o in cors_origins_raw.split(",") if o.strip()]

app = FastAPI(title="PatchTree API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins if origins else ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

runs: dict[str, Run] = db.runs
nodes: dict[str, list[Node]] = db.nodes


def _normalize_and_validate_repo_url(raw_url: str) -> str:
    repo = (raw_url or "").strip()
    if repo.startswith(("github.com/", "gitlab.com/", "bitbucket.org/")):
        repo = f"https://{repo}"
    if (
        not repo
        or any(ch.isspace() for ch in repo)
        or not repo.startswith(("https://", "http://", "git@", "ssh://"))
    ):
        raise HTTPException(
            status_code=422,
            detail="Invalid repository URL. Expected an HTTPS or SSH Git repository URL (e.g. https://github.com/owner/repo).",
        )
    return repo


async def _run_pipeline(run: Run) -> None:
    live_list = nodes.setdefault(run.run_id, [])
    try:
        updated_run, _ = await asyncio.wait_for(
            run_pipeline(run, live_nodes=live_list),
            timeout=RUN_TIMEOUT_SECONDS,
        )
        runs[run.run_id] = updated_run
        await db.save_run(updated_run)
        await db.save_nodes(run.run_id, live_list)
    except asyncio.TimeoutError:
        logger.error("Pipeline timed out after %ss for run %s", RUN_TIMEOUT_SECONDS, run.run_id)
        run.status = "failed"
        run.completed_at = datetime.now(timezone.utc)
        if run.created_at:
            run.total_wall_time_seconds = round((run.completed_at - run.created_at).total_seconds(), 2)
        run.confidence_report = (
            f"### Verification Timed Out\n\n"
            f"Execution exceeded the `{RUN_TIMEOUT_SECONDS}s` wall-clock safety budget and was terminated "
            f"to protect sandbox and inference credits."
        )
        runs[run.run_id] = run
        await db.save_run(run)
        await db.save_nodes(run.run_id, live_list)
    except Exception as e:
        logger.exception("Pipeline failed for run %s: %s", run.run_id, e)
        run.status = "failed"
        run.completed_at = datetime.now(timezone.utc)
        if run.created_at:
            run.total_wall_time_seconds = round((run.completed_at - run.created_at).total_seconds(), 2)
        runs[run.run_id] = run
        await db.save_run(run)
        await db.save_nodes(run.run_id, live_list)


@app.post("/runs", response_model=Run, status_code=status.HTTP_201_CREATED)
async def create_run(request: RunCreate, background_tasks: BackgroundTasks, http_request: Request) -> Run:
    normalized_repo = _normalize_and_validate_repo_url(request.repo_url)
    if not (request.target_test or "").strip() or not (request.bug_description or "").strip():
        raise HTTPException(
            status_code=422,
            detail="Both bug_description and target_test must be non-empty.",
        )

    # ── Protection 1: Active In-Flight Concurrency Lock ──
    active_runs = [r for r in runs.values() if r.status == "running"]
    if len(active_runs) >= MAX_CONCURRENT_RUNS:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="A verification run is currently in progress. Please wait for it to complete.",
        )

    # ── Protection 2: Per-IP Sliding-Window Rate Limit (Live Cloud Mode) ──
    is_live_cloud = bool(os.getenv("NEBIUS_API_KEY", "").strip()) and os.getenv(
        "PATCHTREE_FORCE_STUB", ""
    ).lower() not in ("1", "true")
    if is_live_cloud and "example" not in normalized_repo.lower():
        forwarded = http_request.headers.get("x-forwarded-for", "")
        client_ip = forwarded.split(",")[0].strip() if forwarded else (
            http_request.client.host if http_request.client else "unknown"
        )
        now_ts = time.monotonic()
        cutoff = now_ts - RATE_LIMIT_WINDOW_SECONDS
        recent = [ts for ts in _ip_run_timestamps[client_ip] if ts > cutoff]
        if len(recent) >= MAX_RUNS_PER_IP_WINDOW:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"Rate limit exceeded ({MAX_RUNS_PER_IP_WINDOW} live runs per {RATE_LIMIT_WINDOW_SECONDS // 60} minutes). Please wait before dispatching another run.",
            )
        recent.append(now_ts)
        _ip_run_timestamps[client_ip] = recent

    # ── Protection 3: Daily Budget / Run Cap (Persistent across restarts when Supabase is active) ──
    today_prefix = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    known_runs = await db.list_runs() if db.is_connected else list(runs.values())
    today_runs = sum(
        1 for r in known_runs if r.created_at and r.created_at.strftime("%Y-%m-%d") == today_prefix
    )
    if today_runs >= MAX_DAILY_RUNS:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Daily demo run limit ({MAX_DAILY_RUNS}) reached for today to prevent cloud budget overruns.",
        )

    payload = request.model_dump()
    payload["repo_url"] = normalized_repo
    run = Run(
        **payload,
        run_id=str(uuid4()),
        status="running",
        created_at=datetime.now(timezone.utc),
    )
    runs[run.run_id] = run
    nodes[run.run_id] = []
    await db.save_run(run)
    background_tasks.add_task(_run_pipeline, run)
    return run


@app.get("/runs", response_model=list[Run])
async def list_runs(client_id: str | None = None) -> list[Run]:
    return await db.list_runs(client_id=client_id)


@app.get("/runs/{run_id}", response_model=Run)
async def get_run(run_id: str) -> Run:
    run = await db.get_run(run_id)
    if not run:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Run not found"
        )
    return run


@app.get("/runs/{run_id}/tree", response_model=list[Node])
async def get_tree(run_id: str) -> list[Node]:
    await get_run(run_id)
    return await db.get_nodes(run_id)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/", include_in_schema=False)
async def root():
    from fastapi.responses import RedirectResponse
    return RedirectResponse(url="/docs")