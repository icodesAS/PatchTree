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
import re
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware

from .db.client import db
from .models.schemas import Node, Run, RunCreate
from .orchestrator.pipeline import run_pipeline

logger = logging.getLogger(__name__)

IS_PRODUCTION = bool(os.getenv("RENDER") or os.getenv("RAILWAY_ENVIRONMENT"))
MAX_CONCURRENT_RUNS = int(os.getenv("MAX_CONCURRENT_RUNS", "1"))
MAX_DAILY_RUNS = int(os.getenv("MAX_DAILY_RUNS", "15"))
RUN_TIMEOUT_SECONDS = int(os.getenv("RUN_TIMEOUT_SECONDS", "300"))
RATE_LIMIT_WINDOW_SECONDS = int(os.getenv("RATE_LIMIT_WINDOW_SECONDS", "900"))
MAX_RUNS_PER_IP_WINDOW = int(os.getenv("MAX_RUNS_PER_IP_WINDOW", "3"))

_ip_run_timestamps: dict[str, list[float]] = defaultdict(list)
_client_run_timestamps: dict[str, list[float]] = defaultdict(list)

DEFAULT_PROD_ORIGINS = [
    "https://patch-tree.vercel.app",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]
VERCEL_ORIGIN_RE = re.compile(r"^https://patch-tree[a-z0-9-]*\.vercel\.app$", re.IGNORECASE)

cors_origins_raw = os.getenv("ALLOWED_ORIGINS", "")
if cors_origins_raw.strip():
    origins = [o.strip().rstrip("/") for o in cors_origins_raw.split(",") if o.strip()]
elif IS_PRODUCTION:
    origins = DEFAULT_PROD_ORIGINS
else:
    origins = ["*"]

app = FastAPI(
    title="PatchTree API",
    version="0.1.0",
    docs_url=None if IS_PRODUCTION else "/docs",
    redoc_url=None if IS_PRODUCTION else "/redoc",
    openapi_url=None if IS_PRODUCTION else "/openapi.json",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins if origins else ["*"],
    allow_origin_regex=r"^https://patch-tree[a-z0-9-]*\.vercel\.app$" if IS_PRODUCTION else None,
    allow_methods=["*"],
    allow_headers=["*"],
)

runs: dict[str, Run] = db.runs
nodes: dict[str, list[Node]] = db.nodes


def _is_trusted_origin(candidate: str) -> bool:
    clean = (candidate or "").strip().rstrip("/")
    if not clean:
        return False
    for allowed in DEFAULT_PROD_ORIGINS + ([o for o in origins if o != "*"]):
        if clean == allowed or clean.startswith(f"{allowed}/"):
            return True
    host_match = re.match(r"^(https://[^/]+)", clean)
    if host_match and VERCEL_ORIGIN_RE.match(host_match.group(1)):
        return True
    return False


def _verify_frontend_request(http_request: Request) -> None:
    is_prod = bool(os.getenv("RENDER") or os.getenv("RAILWAY_ENVIRONMENT"))
    if not is_prod:
        return
    client_header = http_request.headers.get("x-patchtree-client", "")
    origin = http_request.headers.get("origin", "") or http_request.headers.get("referer", "")
    if client_header != "patchtree-web-v1" or not _is_trusted_origin(origin):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Direct API access is disabled. Please dispatch runs from https://patch-tree.vercel.app.",
        )


def _normalize_and_validate_repo_url(raw_url: str) -> str:
    repo = (raw_url or "").strip()
    if repo.startswith(("github.com/", "gitlab.com/", "bitbucket.org/")):
        repo = f"https://{repo}"
    if (
        not repo
        or len(repo) > 300
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
    # ── Protection 0: Frontend-Only Origin & Handshake Verification (Production) ──
    _verify_frontend_request(http_request)

    normalized_repo = _normalize_and_validate_repo_url(request.repo_url)
    bug_desc = (request.bug_description or "").strip()
    target_cmd = (request.target_test or "").strip()
    suite_cmd = (request.full_suite_test or "").strip()
    if not target_cmd or not bug_desc:
        raise HTTPException(
            status_code=422,
            detail="Both bug_description and target_test must be non-empty.",
        )
    if len(bug_desc) > 2000 or len(target_cmd) > 300 or len(suite_cmd) > 300:
        raise HTTPException(
            status_code=422,
            detail="Input payload exceeds maximum allowed character length (bug_description <= 2000, test command <= 300).",
        )

    # ── Protection 1: Active In-Flight Concurrency Lock ──
    active_runs = [r for r in runs.values() if r.status == "running"]
    if len(active_runs) >= MAX_CONCURRENT_RUNS:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="A verification run is currently in progress. Please wait for it to complete.",
        )

    # ── Protection 2: Dual Per-IP & Per-Client Sliding-Window Rate Limit (Live Cloud Mode) ──
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
        recent_ip = [ts for ts in _ip_run_timestamps[client_ip] if ts > cutoff]
        client_key = (request.client_id or "").strip()
        recent_client = [ts for ts in _client_run_timestamps[client_key] if ts > cutoff] if client_key else []
        if len(recent_ip) >= MAX_RUNS_PER_IP_WINDOW or len(recent_client) >= MAX_RUNS_PER_IP_WINDOW:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"Rate limit exceeded ({MAX_RUNS_PER_IP_WINDOW} live runs per {RATE_LIMIT_WINDOW_SECONDS // 60} minutes). Please wait before dispatching another run.",
            )
        recent_ip.append(now_ts)
        _ip_run_timestamps[client_ip] = recent_ip
        if client_key:
            recent_client.append(now_ts)
            _client_run_timestamps[client_key] = recent_client

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
    if IS_PRODUCTION or bool(os.getenv("RENDER") or os.getenv("RAILWAY_ENVIRONMENT")):
        return {"service": "PatchTree API", "status": "ok"}
    from fastapi.responses import RedirectResponse
    return RedirectResponse(url="/docs")