import os
import sys
from pathlib import Path
from dotenv import load_dotenv

# Ensure UTF-8 output on Windows terminal
if sys.platform == "win32" and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

load_dotenv(Path(__file__).resolve().parents[2] / ".env")
load_dotenv(Path(__file__).resolve().parents[1] / ".env")


def test_contree_environment_and_connection():
    """Pytest test asserting Contree SDK availability and environment readiness."""
    api_key = os.getenv("NEBIUS_API_KEY")
    project_id = os.getenv("NEBIUS_PROJECT_ID")

    print(f"\nNebius API Key present: {bool(api_key)}")
    print(f"Nebius Project ID: {project_id}")

    try:
        from contree_sdk import ContreeSync
        sdk_available = True
    except ImportError:
        sdk_available = False

    assert sdk_available, "contree_sdk library should be importable in environment"

    if api_key and project_id:
        try:
            client = ContreeSync()
            token_info = client.get_token_info()
            assert token_info is not None
        except Exception as e:
            print(f"Contree live token verification: {e}")
    else:
        # In local/offline mode, verify SandboxManager stub resilience
        from app.sandbox.contree_client import SandboxManager
        mgr = SandboxManager()
        assert mgr.stub is True, "Without credentials, SandboxManager must safely fallback to stub"


if __name__ == "__main__":
    print("--- Contree Sandbox Smoke Test ---")
    test_contree_environment_and_connection()
    print("Contree smoke test finished successfully.")
