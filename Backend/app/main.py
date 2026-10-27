import logging
import sys
from datetime import datetime, timezone
from uuid import uuid4

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import os
from fastapi import BackgroundTasks, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware

from .db.client import db
from .models.schemas import Node, Run, RunCreate
from .orchestrator.pipeline import run_pipeline

logger = logging.getLogger(__name__)

MAX_CONCURRENT_RUNS = int(os.getenv("MAX_CONCURRENT_RUNS", "1"))
MAX_DAILY_RUNS = int(os.getenv("MAX_DAILY_RUNS", "50"))

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


async def _run_pipeline(run: Run) -> None:
    live_list = nodes.setdefault(run.run_id, [])
    try:
        updated_run, _ = await run_pipeline(run, live_nodes=live_list)
        runs[run.run_id] = updated_run
        await db.save_run(updated_run)
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
async def create_run(request: RunCreate, background_tasks: BackgroundTasks) -> Run:
    # ── Protection 1: Active In-Flight Concurrency Lock ──
    active_runs = [r for r in runs.values() if r.status == "running"]
    if len(active_runs) >= MAX_CONCURRENT_RUNS:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="A verification run is currently in progress. Please wait for it to complete.",
        )

    # ── Protection 4: Daily Budget / Run Cap ──
    today_prefix = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    today_runs = sum(1 for r in runs.values() if r.created_at and r.created_at.strftime("%Y-%m-%d") == today_prefix)
    if today_runs >= MAX_DAILY_RUNS:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Daily demo run limit ({MAX_DAILY_RUNS}) reached for today to prevent cloud budget overruns.",
        )

    run = Run(
        **request.model_dump(),
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