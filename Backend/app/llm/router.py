import logging
import os
from pathlib import Path

from dotenv import load_dotenv
import httpx
from openai import AsyncOpenAI

load_dotenv(Path(__file__).resolve().parents[3] / ".env")
load_dotenv(Path(__file__).resolve().parents[2] / ".env")

logger = logging.getLogger(__name__)

_http2_clients: dict[str, AsyncOpenAI] = {}


def _get_llm_client(api_key: str, base_url: str) -> AsyncOpenAI:
    cache_key = f"{api_key}:{base_url}"
    if cache_key not in _http2_clients:
        http_client = httpx.AsyncClient(http2=True, timeout=60.0)
        _http2_clients[cache_key] = AsyncOpenAI(
            api_key=api_key,
            base_url=base_url,
            http_client=http_client,
        )
    return _http2_clients[cache_key]
TIERS = {
    "nano": {
        "model": os.getenv("NEBIUS_MODEL_NANO", "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"),
        "base_url": os.getenv("NEBIUS_BASE_URL_NANO", "https://api.tokenfactory.nebius.com/v1/"),
    },
    "super": {
        "model": os.getenv("NEBIUS_MODEL_SUPER", "nvidia/nemotron-3-super-120b-a12b"),
        "base_url": os.getenv("NEBIUS_BASE_URL_SUPER", "https://api.tokenfactory.us-central1.nebius.com/v1/"),
    },
    "ultra": {
        "model": os.getenv("NEBIUS_MODEL_ULTRA", "nvidia/Nemotron-3-Ultra-550b-a55b"),
        "base_url": os.getenv("NEBIUS_BASE_URL_ULTRA", "https://api.tokenfactory.us-central1.nebius.com/v1/"),
    },
}

# job -> (tier, default temperature)
ROUTES = {
    "generate_patch_minimal": ("nano", 0.2),
    "generate_patch_alternative": ("super", 0.5),
    "generate_patch_root_cause": ("super", 0.6),
    "generate_patch_test_driven": ("nano", 0.2),
    "replan_after_failure": ("ultra", 0.3),
    "generate_patch_ultra": ("ultra", 0.2),
    "generate_adversarial_test": ("super", 0.6),
    "generate_confidence_report": ("ultra", 0.3),
}


async def call_model(job: str, prompt: str, system_prompt: str | None = None, temperature: float = 0.3) -> dict:
    """Returns {content, model, tokens_in, tokens_out, stub}."""
    if job not in ROUTES:
        raise ValueError(f"Unknown job: {job}")
    tier, route_temp = ROUTES[job]
    cfg = TIERS[tier]
    model = cfg["model"]
    base_url = cfg["base_url"]
    temp = route_temp

    key = os.getenv("NEBIUS_API_KEY")
    if key:
        try:
            client = _get_llm_client(key, base_url)
            messages = []
            if system_prompt:
                messages.append({"role": "system", "content": system_prompt})
            messages.append({"role": "user", "content": prompt})

            resp = await client.chat.completions.create(
                model=model, temperature=temp, messages=messages
            )
            msg = resp.choices[0].message
            content = msg.content or getattr(msg, "reasoning", "") or ""
            usage = resp.usage
            return {
                "content": content,
                "model": model,
                "tokens_in": usage.prompt_tokens if usage else 0,
                "tokens_out": usage.completion_tokens if usage else 0,
                "stub": False,
            }
        except Exception as e:
            logger.warning("Nebius call failed for %s (%s); using stub response", model, e)

    if job == "replan_after_failure":
        return {
            "content": (
                "1. Focus on the core assertion failure and fix edge-case values.\n"
                "2. Check input validation and boundary conditions.\n"
                "3. Refactor conditional logic to handle unexpected state.\n"
                "4. Address caller expectations and align return types."
            ),
            "model": f"stub/{model}",
            "tokens_in": len(prompt.split()),
            "tokens_out": 40,
            "stub": True,
        }

    if job == "generate_patch_ultra":
        return {
            "content": (
                "--- a/app.py\n"
                "+++ b/app.py\n"
                "@@ -1,3 +1,4 @@\n"
                " def calculate(x):\n"
                "-    return x\n"
                "+    # Ultra fix: correct the return value after analysing all prior failures\n"
                "+    return x + 1\n"
            ),
            "model": f"stub/{model}",
            "tokens_in": len(prompt.split()),
            "tokens_out": 60,
            "stub": True,
        }

    if job == "generate_adversarial_test":
        return {
            "content": (
                "```python\n"
                "def test_adversarial_edge_case():\n"
                "    assert True\n"
                "```"
            ),
            "model": f"stub/{model}",
            "tokens_in": len(prompt.split()),
            "tokens_out": 25,
            "stub": True,
        }

    if job == "generate_confidence_report":
        return {
            "content": (
                "### PatchTree Confidence Report\n\n"
                "**Verdict:** Verified Stable & Resilient\n\n"
                "- **Flaky-Test Forensics:** 5/5 passes (100% stable)\n"
                "- **Adversarial Resilience:** 2/2 attacks survived (100% resilient)\n"
                "- **Regression Suite:** Full test suite passed cleanly\n"
                "- **Risk Level:** Low — Recommended for PR creation.\n"
            ),
            "model": f"stub/{model}",
            "tokens_in": len(prompt.split()),
            "tokens_out": 80,
            "stub": True,
        }

    return {
        "content": f"[stub:{job}] --- a/app.py\n+++ b/app.py\n@@ -1 +1 @@\n-return 1\n+return 2\n",
        "model": f"stub/{model}",
        "tokens_in": len(prompt.split()),
        "tokens_out": 20,
        "stub": True,
    }

