"""Shared pytest config: keep the default suite offline ($0) and gate live smoke tests."""
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

LIVE = os.getenv("RUN_LIVE_SMOKE") == "1"

# Scripts that talk to real Nebius / Contree; only collected with RUN_LIVE_SMOKE=1.
collect_ignore = [] if LIVE else ["test_nebius.py", "test_contree.py", "test_real_contree.py"]


@pytest.fixture(autouse=True)
def offline_env(monkeypatch):
    """No API key => router.call_model returns deterministic stubs; sandbox never reaches Contree."""
    if not LIVE:
        monkeypatch.setenv("NEBIUS_API_KEY", "")
        monkeypatch.setenv("PATCHTREE_FORCE_STUB", "1")


@pytest.fixture
def git_repo(tmp_path):
    from tests.local_sandbox import make_git_repo

    return make_git_repo(tmp_path)
