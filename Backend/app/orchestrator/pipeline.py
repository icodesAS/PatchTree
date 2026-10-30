"""SearchNode fan-out, evaluation, replan, and pipeline orchestration."""
import ast
import asyncio
import base64
import json
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from ..llm.router import call_model, end_run_llm_budget, start_run_llm_budget
from ..models.schemas import Node, Run
from ..sandbox.contree_client import CommandResult, SandboxManager
from . import context_engine as ce

logger = logging.getLogger(__name__)

SEARCH_SYSTEM_PROMPT = (
    "You are an autonomous program repair engine generating git unified diffs.\n\n"
    "STRICT OUTPUT CONTRACT:\n"
    "1. Output ONLY a valid git unified diff enclosed in a single ```diff ... ``` block.\n"
    "2. ZERO conversational prose, ZERO chain-of-thought, ZERO commentary or explanations before, inside, or after the diff.\n"
    "3. Every hunk MUST start with standard headers:\n"
    "   --- a/<exact_repo_relative_path>\n"
    "   +++ b/<exact_repo_relative_path>\n"
    "   @@ -<start>,<count> +<start>,<count> @@\n"
    "4. Every line inside a hunk MUST begin with a single space ' ' (unchanged context), '-' (deletion), or '+' (addition). "
    "Never place reasoning or notes inside diff hunks.\n\n"
    "CONTEXT GROUNDING & LINE NUMBERS:\n"
    "1. Only modify files shown in `=== TARGET REPOSITORY SOURCE CONTEXT ===` or explicitly cited in the traceback.\n"
    "2. Never invent or hallucinate file paths, module names, or imports that do not exist in the repository.\n"
    "3. Source context lines are prefixed with `<line_number> | <code>` (e.g., `   42 |     return x`). "
    "Use those exact line numbers for `@@` hunk headers, and strip the `<line_number> | ` prefix from the code lines in your diff.\n\n"
    "ANTI-REWARD-HACKING POLICY (CRITICAL):\n"
    "1. NEVER modify, weaken, skip, comment out, or delete any test files (`test_*.py`, `*_test.py`, or files under `tests/`).\n"
    "2. Your patch MUST fix the underlying implementation code so that the unmodified target test passes."
)

# Branch definitions: (job, temperature, instruction_template)
SEARCH_BRANCHES: list[tuple[str, float, str]] = [
    (
        "generate_patch_minimal",
        0.2,
        """STRATEGY: MINIMAL SURGICAL FIX
Generate the smallest, most localized 1-to-5 line change at the exact failure site in the implementation code.
Do not refactor surrounding logic or alter function signatures unless strictly required by the crash.

Bug description: {bug_description}
Test command: {test_command}
Failing pytest traceback:
{test_output}

Produce ONLY the unified diff (`--- a/...` / `+++ b/...`) fixing the source implementation.""",
    ),
    (
        "generate_patch_alternative",
        0.5,
        """STRATEGY: DEFENSIVE & ALTERNATIVE PATH FIX
Assume a naive one-line tweak at the crash line is insufficient. Fix the bug by introducing a defensive guard clause, boundary/None validation, state normalization, or an alternative execution branch in the target function.

Bug description: {bug_description}
Test command: {test_command}
Failing pytest traceback:
{test_output}

Produce ONLY the unified diff (`--- a/...` / `+++ b/...`) fixing the source implementation.""",
    ),
    (
        "generate_patch_root_cause",
        0.6,
        """STRATEGY: UPSTREAM ROOT-CAUSE FIX
The traceback line may only be where bad state surfaces. Trace the data flow backward into producer functions, callers, class initialization, or module configuration shown in `=== TARGET REPOSITORY SOURCE CONTEXT ===` and fix where the invalid state originates.

Bug description: {bug_description}
Test command: {test_command}
Failing pytest traceback:
{test_output}

Produce ONLY the unified diff (`--- a/...` / `+++ b/...`) fixing the upstream source implementation.""",
    ),
    (
        "generate_patch_test_driven",
        0.2,
        """STRATEGY: TEST-CONTRACT COMPLIANCE FIX
Inspect the failing assertion, expected return type, exception contract, or interface signature demanded by the test in the traceback. Align the implementation's return value, side effects, and edge-case behavior to strictly satisfy that contract without touching the test file.

Bug description: {bug_description}
Test command: {test_command}
Failing pytest traceback:
{test_output}

Produce ONLY the unified diff (`--- a/...` / `+++ b/...`) fixing the source implementation.""",
    ),
]

# Tier-accurate token pricing (USD per token)
# Nano 30B: $0.10 / 1M tokens ($0.00000010 / token)
# Super 120B: $0.35 / 1M tokens ($0.00000035 / token)
# Ultra 550B: $1.20 / 1M tokens ($0.00000120 / token)
TIER_COST_PER_TOKEN = {
    "nano": 0.10 / 1_000_000,
    "super": 0.35 / 1_000_000,
    "ultra": 1.20 / 1_000_000,
}


def calculate_token_cost(model_name: str | None, tokens_in: int, tokens_out: int) -> float:
    """Calculate tier-aware USD cost for prompt + completion tokens."""
    if not model_name or model_name == "none":
        return 0.0
    lowered = model_name.lower()
    if "ultra" in lowered or "550b" in lowered or "253b" in lowered:
        rate = TIER_COST_PER_TOKEN["ultra"]
    elif "super" in lowered or "120b" in lowered or "70b" in lowered:
        rate = TIER_COST_PER_TOKEN["super"]
    else:
        rate = TIER_COST_PER_TOKEN["nano"]
    return round((tokens_in + tokens_out) * rate, 6)


def _apply_patch_in_sandbox(sandbox: SandboxManager, filename: str, patch_diff: str) -> CommandResult:
    """Write unified diff bytes to the target sandbox, run apply_patch, and clean up temp diff files."""
    normalized = (patch_diff or "").replace("\r\n", "\n")
    if normalized and not normalized.endswith("\n"):
        normalized += "\n"
    local_root = getattr(sandbox, "root", None)
    if local_root is not None:
        diff_path = Path(local_root) / filename
        diff_path.write_bytes(normalized.encode("utf-8"))
        try:
            return sandbox.run_command(f"apply_patch {filename}")
        finally:
            diff_path.unlink(missing_ok=True)
    if not sandbox.stub:
        b64 = base64.b64encode(normalized.encode("utf-8")).decode("ascii")
        sandbox.run_command(f"echo '{b64}' | base64 -d > '{filename}'")
    return sandbox.run_command(f"apply_patch {filename}")

ULTRA_SYNTHESIS_SYSTEM_PROMPT = (
    "You are Nemotron Ultra, the final escalation repair architect in the PatchTree pipeline.\n"
    "All 4 initial search branches failed to produce a passing patch.\n\n"
    "DIAGNOSIS & SYNTHESIS PROTOCOL:\n"
    "1. Cross-reference all 4 failed attempts (their diffs and resulting `git apply` or `pytest` errors) against `=== TARGET REPOSITORY SOURCE CONTEXT ===`.\n"
    "2. Identify why each prior attempt failed:\n"
    "   - Malformed diff syntax, wrong line numbers, or unstripped `<line_num> | ` prefixes.\n"
    "   - Hallucinated file paths or editing test files instead of source files.\n"
    "   - Incomplete logic that fixed one crash condition but broke another constraint.\n"
    "3. Synthesize a complete, robust patch that reconciles the caller contracts and implementation invariants.\n\n"
    "STRICT OUTPUT CONTRACT:\n"
    "1. Output ONLY a valid git unified diff inside a single ```diff ... ``` block.\n"
    "2. ZERO conversational prose before or after the diff.\n"
    "3. NEVER modify tests (`tests/*`, `test_*.py`). Fix the underlying source code."
)

ADVERSARIAL_SYSTEM_PROMPT = (
    "You are an adversarial software tester probing a candidate patch for hidden regressions and unhandled edge cases.\n\n"
    "TEST DESIGN RULES:\n"
    "1. Write exactly one targeted pytest test function designed to probe the candidate patch's boundaries.\n"
    "2. Probe boundary values (e.g., zero, negative numbers, empty strings/lists, None, extreme ranges, float precision).\n"
    "3. DO NOT repeat or duplicate the original target test. Probe new, plausible inputs the patch author might have overlooked.\n"
    "4. Self-contained: import all necessary standard libraries, pytest, and target application modules.\n\n"
    "OUTPUT CONTRACT:\n"
    "Output ONLY executable Python code inside a single ```python ... ``` block. ZERO commentary, markdown explanation, or prose outside the code block."
)

ADVERSARIAL_TEST_FILENAME = "test_adversarial_check.py"


def is_reproduction_error(exit_code: int, output: str) -> bool:
    """Check if test failed due to environment, missing runner, or invalid test command."""
    if exit_code in (4, 5, 127):
        return True
    lowered = (output or "").lower()
    error_indicators = (
        "pytest: not found",
        ": command not found",
        "file or directory not found",
        "no tests were found",
        "collected 0 items",
        "usageerror",
        "interrupted: 1 error during collection",
        "fatal: could not read",
        "fatal: repository not found",
        "no such file or directory",
        "error: file not found",
    )
    return any(ind in lowered for ind in error_indicators)


def reproduce(run: Run, sandbox: SandboxManager) -> Node:
    """ReproduceNode: boot sandbox, prepare repository, run target test, record root node."""
    repo_url = (run.repo_url or "").strip()
    if repo_url.startswith(("github.com/", "gitlab.com/", "bitbucket.org/")):
        repo_url = f"https://{repo_url}"
        run.repo_url = repo_url

    if not sandbox.stub and (
        not repo_url
        or any(ch.isspace() for ch in repo_url)
        or not repo_url.startswith(("https://", "http://", "git@", "ssh://"))
    ):
        logger.warning(f"Invalid repository URL rejected before container spawn: {repo_url!r}")
        return Node(
            node_id=str(uuid.uuid4()),
            run_id=run.run_id,
            branch_type="root",
            checkpoint_id=None,
            test_command=run.target_test,
            test_result="error",
            test_output=(
                f"Invalid repository URL: '{repo_url}'.\n"
                "Expected an HTTPS or SSH Git repository URL (e.g. https://github.com/owner/repo)."
            ),
            status="done",
        )

    sandbox.spawn("python:3.11", repo_url=repo_url)

    # In real sandbox, clone repository into /app if a valid remote URL is provided
    if not sandbox.stub and repo_url and not any(d in repo_url.lower() for d in ("example.com", "example/")):
        # If spawn did not clone into /app, do depth 1 clone here
        check_dir = sandbox.run_command("test -d /app")
        if check_dir.exit_code != 0:
            logger.info(f"Cloning {repo_url} into sandbox...")
            clone_res = sandbox.run_command(f"git clone --depth 1 {repo_url} /app")
            if clone_res.exit_code != 0:
                logger.warning(f"Git clone failed for {repo_url}: {clone_res.output}")
                return Node(
                    node_id=str(uuid.uuid4()),
                    run_id=run.run_id,
                    branch_type="root",
                    checkpoint_id=sandbox.checkpoint(),
                    test_command=run.target_test,
                    test_result="error",
                    test_output=f"Git clone failed for {repo_url}:\n{clone_res.output}",
                    status="done",
                )

        # Discover and install dependencies from requirements.txt, pyproject.toml, or setup.py
        sandbox.run_command('export PYTHONPATH="/app:/app/Backend:/app/src:$PYTHONPATH"')
        find_req = sandbox.run_command("find /app -name '*requirements*.txt' -o -name 'requirements.txt' 2>/dev/null | head -n 1")
        req_path = find_req.output.strip().splitlines()[0] if find_req.output.strip() else ""

        find_pkg = sandbox.run_command("find /app -name 'pyproject.toml' -o -name 'setup.py' 2>/dev/null | head -n 1")
        pkg_path = find_pkg.output.strip().splitlines()[0] if find_pkg.output.strip() else ""

        installed_any = False

        if req_path:
            logger.info(f"Installing dependencies from {req_path}...")
            install_res = sandbox.run_command(f"pip install --prefer-binary --quiet -r '{req_path}'")
            if install_res.exit_code != 0:
                logger.warning(f"Dependency installation failed from {req_path}: {install_res.output}")
                return Node(
                    node_id=str(uuid.uuid4()),
                    run_id=run.run_id,
                    branch_type="root",
                    checkpoint_id=sandbox.checkpoint(),
                    test_command=run.target_test,
                    test_result="error",
                    test_output=f"Dependency installation failed from {req_path}:\n{install_res.output}",
                    status="done",
                )
            installed_any = True

        if pkg_path:
            pkg_dir = os.path.dirname(pkg_path) or "/app"
            logger.info(f"Installing project package from {pkg_path} in editable mode...")
            flag = "--no-deps" if installed_any else "--prefer-binary"
            pkg_res = sandbox.run_command(f"pip install {flag} --quiet -e '{pkg_dir}'")
            if pkg_res.exit_code == 0:
                installed_any = True
            else:
                logger.warning(f"Package install from {pkg_dir} failed (non-fatal): {pkg_res.output}")

        if not installed_any and not req_path and not pkg_path:
            logger.warning(f"No requirements.txt, pyproject.toml, or setup.py found in {repo_url}")
            return Node(
                node_id=str(uuid.uuid4()),
                run_id=run.run_id,
                branch_type="root",
                checkpoint_id=sandbox.checkpoint(),
                test_command=run.target_test,
                test_result="error",
                test_output=(
                    "No requirements.txt, pyproject.toml, or setup.py file found in repository.\n"
                    "Cloud sandboxes run in an isolated environment and cannot access local virtual environments.\n"
                    "Please ensure dependencies are committed to your repository in a requirements.txt, pyproject.toml, or setup.py file."
                ),
                status="done",
            )

    result = sandbox.run_command(run.target_test)

    if result.exit_code == 0:
        test_res = "pass"
    elif is_reproduction_error(result.exit_code, result.output):
        test_res = "error"
    else:
        test_res = "fail"

    return Node(
        node_id=str(uuid.uuid4()),
        run_id=run.run_id,
        branch_type="root",
        checkpoint_id=sandbox.checkpoint(),
        test_command=run.target_test,
        test_result=test_res,
        test_output=result.output,
        status="done",
    )


def evaluate_search(branches: list[Node]) -> Node | None:
    """
    Deterministically pick a winner from a search round.

    Args:
        branches: Nodes produced by a search round.

    Returns:
        The first Node with test_result == "pass", or None if all failed.
    """
    for node in branches:
        if node.test_result == "pass":
            return node
    return None





async def ultra_synthesize_patch(
    run: Run,
    failed_branches: list[Node],
    parent_node: Node,
    sandbox: SandboxManager,
) -> Node:
    """
    Escalation path: Nemotron Ultra directly synthesizes a patch after all
    initial search branches failed.

    Ultra receives the bug description, target test, and the complete failure
    context of every failed branch (hypothesis + patch diff + pytest trace),
    then outputs a unified diff which is applied and tested immediately.

    Args:
        run: The Run being repaired.
        failed_branches: All failed Nodes from round 1.
        parent_node: The root Node to fork from.
        sandbox: Sandbox to fork for patch application.

    Returns:
        A Node with branch_type="search" and model_used=Ultra's model name.
    """
    attempts = "\n\n".join(
        f"--- Attempt {i + 1} ---\n"
        f"hypothesis: {node.hypothesis or ''}\n"
        f"patch diff:\n{node.patch_diff or ''}\n"
        f"pytest failure trace:\n{node.test_output or ''}"
        for i, node in enumerate(failed_branches)
    )
    trace_for_context = "\n".join(
        part for part in (
            parent_node.test_output or "",
            failed_branches[0].test_output if failed_branches else "",
        ) if part
    )
    source_context = await asyncio.to_thread(
        extract_relevant_source_context,
        sandbox,
        parent_node.test_command or run.target_test,
        trace_for_context,
        run.bug_description,
        4500,
        "wide",
    )
    prompt = (
        f"Bug description: {run.bug_description}\n"
        f"Target test command: {run.target_test}\n\n"
        f"All {len(failed_branches)} patch attempts failed. Here is the full failure context:\n\n"
        f"{attempts}\n\n"
    )
    if source_context:
        prompt += f"{source_context}\n\n"
    prompt += "Write the corrected unified diff that fixes this bug, avoiding the mistakes above."
    node_id = str(uuid.uuid4())
    logger.info(f"Ultra escalation: synthesizing patch directly, node {node_id}")

    response = await call_model(
        job="generate_patch_ultra",
        prompt=prompt,
        system_prompt=ULTRA_SYNTHESIS_SYSTEM_PROMPT,
    )
    raw_content = response.get("content", "")
    patch_diff = extract_diff(raw_content) or raw_content
    hypothesis = "Escalated to Nemotron Ultra 550B: Analyzed all prior failed search branches and synthesized an authoritative multi-line fix."

    def _verify_ultra() -> tuple[Literal["pass", "fail", "error"], str, str]:
        fork = sandbox.fork(parent_node.checkpoint_id)
        apply_result = _apply_patch_in_sandbox(fork, f"ultra_{node_id}.diff", patch_diff)
        logger.debug(f"Ultra escalation: patch apply exit_code={apply_result.exit_code}")
        if apply_result.exit_code != 0:
            return "error", f"Patch application failed:\n{apply_result.output}", fork.checkpoint()
        test_result_obj = fork.run_command(parent_node.test_command or run.target_test)
        res: Literal["pass", "fail", "error"] = "pass" if test_result_obj.exit_code == 0 else "fail"
        return res, test_result_obj.output, fork.checkpoint()

    test_result, test_output, checkpoint_id = await asyncio.to_thread(_verify_ultra)
    cost = calculate_token_cost(response["model"], response["tokens_in"], response["tokens_out"])
    node = Node(
        node_id=node_id,
        run_id=run.run_id,
        parent_node_id=parent_node.node_id,
        branch_type="search",
        checkpoint_id=checkpoint_id,
        hypothesis=hypothesis,
        patch_diff=patch_diff,
        test_command=parent_node.test_command or run.target_test,
        test_result=test_result,
        test_output=test_output,
        model_used=response["model"],
        tokens_in=response["tokens_in"],
        tokens_out=response["tokens_out"],
        estimated_cost_usd=cost,
        status="done",
    )
    logger.info(
        f"Ultra escalation: node {node_id} -> test_result={test_result}, "
        f"tokens={response['tokens_in']}+{response['tokens_out']}"
    )
    return node


def extract_diff(content: str) -> str:
    """Extract unified diff from model response, stripping markdown fences if present."""
    blocks = re.findall(r"```(?:diff|patch|[a-zA-Z0-9_-]*)\s*\n([\s\S]*?)\n```", content or "")
    for block in blocks:
        if "--- " in block and "+++ " in block:
            return block.strip()
    if blocks:
        return blocks[0].strip()
    raw = (content or "").strip()
    idx = raw.find("--- a/")
    if idx != -1:
        return raw[idx:].strip()
    return raw


def extract_code(content: str) -> str:
    """Extract a python code block from a model response, stripping markdown fences."""
    blocks = re.findall(r"```(?:python|py)?\s*\n([\s\S]*?)\n```", content or "")
    for block in blocks:
        if "def test_" in block:
            return block.strip()
    if blocks:
        return blocks[0].strip()
    return (content or "").strip()


def extract_file_locations_from_trace(test_command: str, test_output: str) -> dict[str, list[int]]:
    """Extract candidate repository file paths and failing line numbers from traceback."""
    locations: dict[str, list[int]] = {}

    # 1. From test command (e.g., pytest tests/test_bug.py)
    for part in (test_command or "").split():
        if part.endswith(".py") and not part.startswith("-"):
            clean = part.split("::")[0].strip()
            if clean and clean not in locations:
                locations[clean] = []

    # 2. From traceback lines like:
    # src/parser.py:876: in parse_payload
    # tests/test_bug.py:15: in test_something
    matches = re.findall(r"(?:^|[ \t\n\"'\(])([a-zA-Z0-9_\-./]+\.py)(?::(\d+))?", test_output or "")
    for filepath, line_str in matches:
        clean = filepath.strip()
        if any(ign in clean.lower() for ign in (
            "site-packages", "/usr/lib", "pytest", "pluggy", "_pytest", "unittest", "<string>"
        )):
            continue
        if clean not in locations:
            locations[clean] = []
        if line_str:
            try:
                line_num = int(line_str)
                if line_num not in locations[clean]:
                    locations[clean].append(line_num)
            except ValueError:
                pass

    return locations


def slice_smart_context(content: str, target_lines: list[int], max_total_lines: int = 250) -> str:
    """
    Slices a file intelligently around failure points:
    - If total lines <= max_total_lines: return entire file with 1-based line numbers.
    - If total lines > max_total_lines:
      - Always include module header (lines 1 to 25) for top-level imports and declarations.
      - Center a window (e.g. line - 25 to line + 25) around each error line.
      - Merge overlapping windows and display with line numbers so LLM sees exact locations.
    """
    all_lines = content.splitlines()
    total = len(all_lines)
    if total <= max_total_lines:
        return "\n".join(f"{i + 1:4d} | {line}" for i, line in enumerate(all_lines))

    indices_to_include = set()

    # Always include top 25 lines (imports, declarations)
    for i in range(min(25, total)):
        indices_to_include.add(i)

    # For each target error line, include window of 25 lines before and after
    for tgt in target_lines:
        tgt_idx = tgt - 1
        start_idx = max(0, tgt_idx - 25)
        end_idx = min(total, tgt_idx + 26)
        for i in range(start_idx, end_idx):
            indices_to_include.add(i)

    if not target_lines:
        for i in range(min(max_total_lines, total)):
            indices_to_include.add(i)

    sorted_indices = sorted(indices_to_include)

    output_lines: list[str] = []
    prev_idx = -1
    for idx in sorted_indices:
        if prev_idx != -1 and idx > prev_idx + 1:
            skipped = idx - prev_idx - 1
            output_lines.append(f"     | ... [{skipped} lines skipped] ...")
        output_lines.append(f"{idx + 1:4d} | {all_lines[idx]}")
        prev_idx = idx

    if sorted_indices and sorted_indices[-1] < total - 1:
        output_lines.append(f"     | ... [{total - 1 - sorted_indices[-1]} lines skipped to EOF] ...")

    return "\n".join(output_lines)


def extract_relevant_source_context(
    sandbox: SandboxManager,
    target_test: str,
    test_output: str,
    bug_description: str = "",
    budget_tokens: int = 3500,
    profile: Literal["default", "wide"] = "default",
    max_files: int = 3,
    max_lines: int = 250,
) -> str:
    """Read failing source files and AST-detected local dependencies using context_engine."""
    if not test_output or not test_output.strip():
        return ""

    if sandbox.stub:
        return ""

    # Mode 1: In-container execution via context_engine if real cloud container
    if not sandbox.stub:
        try:
            esc_trace = base64.b64encode(test_output.encode("utf-8")).decode("ascii")
            esc_hint = base64.b64encode((bug_description or "").encode("utf-8")).decode("ascii")
            cmd = (
                f"echo '{esc_trace}' | base64 -d > /tmp/failure_trace.txt 2>/dev/null; "
                f"echo '{esc_hint}' | base64 -d > /tmp/bug_hint.txt 2>/dev/null; "
                f"python3 /usr/local/bin/context_engine.py --repo /app --budget {budget_tokens} "
                f"--profile {profile} --hint-file /tmp/bug_hint.txt < /tmp/failure_trace.txt"
            )
            res = sandbox.run_command(cmd)
            if res.exit_code == 0 and res.output.strip():
                try:
                    data = json.loads(res.output)
                    if data.get("text"):
                        return data["text"]
                except Exception:
                    pass
        except Exception as e:
            logger.warning("Container context extraction error (%s)", e)

    # Mode 2: Fallback AST & file scanner
    file_locations = extract_file_locations_from_trace(target_test, test_output)
    if not file_locations:
        return ""

    context_blocks: list[str] = []
    seen_files = set()

    for path, target_lines in list(file_locations.items())[:max_files]:
        if path in seen_files or len(seen_files) >= max_files:
            continue

        read_cmd = f"if [ -f '/app/{path}' ]; then cat '/app/{path}'; elif [ -f '{path}' ]; then cat '{path}'; fi"
        res = sandbox.run_command(read_cmd)
        if res.exit_code == 0 and res.output.strip():
            seen_files.add(path)
            smart_content = slice_smart_context(res.output, target_lines, max_total_lines=max_lines)
            context_blocks.append(f"File: `{path}` (with line numbers)\n```python\n{smart_content}\n```")

            # Check AST for direct relative or local imports
            try:
                tree = ast.parse(res.output)
                for node in ast.walk(tree):
                    if isinstance(node, ast.ImportFrom) and node.module and len(seen_files) < max_files:
                        mod_filename = os.path.basename(node.module.replace(".", "/") + ".py")
                        mod_cmd = f"find /app -name '{mod_filename}' 2>/dev/null | head -n 1"
                        find_res = sandbox.run_command(mod_cmd)
                        mod_path = find_res.output.strip()
                        if mod_path and mod_path not in seen_files:
                            sub_res = sandbox.run_command(f"cat '{mod_path}'")
                            if sub_res.exit_code == 0 and sub_res.output.strip():
                                seen_files.add(mod_path)
                                sub_content = slice_smart_context(sub_res.output, [], max_total_lines=max_lines)
                                rel_display = mod_path.replace("/app/", "")
                                context_blocks.append(f"File: `{rel_display}` (imported dependency)\n```python\n{sub_content}\n```")
            except Exception:
                pass

    if not context_blocks:
        return ""

    return "=== TARGET REPOSITORY SOURCE CONTEXT ===\n" + "\n\n".join(context_blocks) + "\n========================================"


async def _execute_branch(
    run: Run,
    parent_node: Node,
    parent_sandbox: SandboxManager,
    branch_index: int,
    job: str,
    temperature: float,
    instruction_template: str,
    guidance: str | None = None,
    source_context: str | None = None,
) -> Node:
    """Execute a single search branch: fork, call model, apply patch, test."""
    node_id = str(uuid.uuid4())
    logger.info(f"Branch {branch_index + 1}/4 ({job}): starting node {node_id}")

    # Build the prompt
    prompt = instruction_template.format(
        bug_description=run.bug_description,
        test_command=parent_node.test_command or run.target_test,
        test_output=parent_node.test_output or "",
    )
    if guidance:
        prompt += f"\n\nRevised guidance from the failed previous round: {guidance}"

    if source_context is None:
        source_context = await asyncio.to_thread(
            extract_relevant_source_context,
            parent_sandbox,
            parent_node.test_command or run.target_test,
            parent_node.test_output or "",
            run.bug_description,
            3000,
            "default",
        )
    if source_context:
        prompt += f"\n\n{source_context}"

    # Call the model
    model_response = await call_model(
        job=job,
        prompt=prompt,
        system_prompt=SEARCH_SYSTEM_PROMPT,
        temperature=temperature,
    )

    # Extract patch from response (clean markdown fences if model wrapped the diff)
    raw_content = model_response.get("content", "")
    patch_diff = extract_diff(raw_content) or raw_content
    strategy_labels = {
        "generate_patch_minimal": "Minimal surgical fix",
        "generate_patch_alternative": "Defensive & boundary guard path",
        "generate_patch_root_cause": "Upstream root-cause fix",
        "generate_patch_test_driven": "Test-contract compliance fix",
    }
    file_match = re.search(r"(?:\+\+\+\s+b/|---\s+a/)([^\s\n]+)", patch_diff)
    target_file = file_match.group(1) if file_match else "target module"
    hypothesis = f"{job}: {strategy_labels.get(job, job)} in {target_file}"

    def _apply_and_verify() -> tuple[Literal["pass", "fail", "error"], str, str]:
        fork = parent_sandbox.fork(parent_node.checkpoint_id)
        apply_res = _apply_patch_in_sandbox(fork, f"{node_id}.diff", patch_diff)
        logger.debug(f"Branch {branch_index + 1}: patch apply exit_code={apply_res.exit_code}")
        if apply_res.exit_code != 0:
            return "error", f"Patch application failed:\n{apply_res.output}", fork.checkpoint()
        test_res_obj = fork.run_command(parent_node.test_command or run.target_test)
        res_label: Literal["pass", "fail", "error"] = "pass" if test_res_obj.exit_code == 0 else "fail"
        return res_label, test_res_obj.output, fork.checkpoint()

    test_result, test_output, checkpoint_id = await asyncio.to_thread(_apply_and_verify)
    cost = calculate_token_cost(model_response["model"], model_response["tokens_in"], model_response["tokens_out"])

    node = Node(
        node_id=node_id,
        run_id=run.run_id,
        parent_node_id=parent_node.node_id,
        branch_type="search",
        checkpoint_id=checkpoint_id,
        hypothesis=hypothesis,
        patch_diff=patch_diff,
        test_command=parent_node.test_command or run.target_test,
        test_result=test_result,
        test_output=test_output,
        model_used=model_response["model"],
        tokens_in=model_response["tokens_in"],
        tokens_out=model_response["tokens_out"],
        estimated_cost_usd=cost,
        status="done",
    )

    logger.info(
        f"Branch {branch_index + 1}/4 ({job}): node {node_id} -> test_result={test_result}, "
        f"tokens={model_response['tokens_in']}+{model_response['tokens_out']}"
    )

    return node


async def search_round(
    run: Run,
    parent_node: Node,
    round_num: int = 1,
    guidance: list[str] | None = None,
    sandbox: SandboxManager | None = None,
) -> list[Node]:
    """
    Execute a single search round with 4 concurrent branches from parent_node.

    Args:
        run: The Run object containing bug description and test command
        parent_node: The parent Node (typically root node from reproduce step)
        round_num: Round number for logging (default: 1)
        guidance: Optional revised strategies from replan(); guidance[i] is
            appended to branch i's prompt when present.
        sandbox: Optional sandbox instance (defaults to SandboxManager()).

    Returns:
        List of 4 Node objects, one per search branch
    """
    logger.info(f"=== Search Round {round_num}: starting 4-branch fan-out from node {parent_node.node_id} ===")

    # Create a parent sandbox from the parent checkpoint
    # We'll reuse this to fork for each branch
    parent_sandbox = sandbox or SandboxManager()
    if parent_sandbox.stub:
        parent_sandbox._checkpoints.setdefault(parent_node.checkpoint_id, [])

    shared_context = await asyncio.to_thread(
        extract_relevant_source_context,
        parent_sandbox,
        parent_node.test_command or run.target_test,
        parent_node.test_output or "",
        run.bug_description,
        3000,
        "default",
    )

    # Build tasks for concurrent execution
    tasks = [
        _execute_branch(
            run=run,
            parent_node=parent_node,
            parent_sandbox=parent_sandbox,
            branch_index=i,
            job=job,
            temperature=temp,
            instruction_template=instruction,
            guidance=guidance[i] if guidance and i < len(guidance) else None,
            source_context=shared_context,
        )
        for i, (job, temp, instruction) in enumerate(SEARCH_BRANCHES)
    ]

    # Execute all 4 branches concurrently
    nodes = await asyncio.gather(*tasks)

    logger.info(f"=== Search Round {round_num}: completed 4 branches ===")
    return list(nodes)


async def check_stability(
    run: Run,
    candidate: Node,
    sandbox: SandboxManager,
    k: int = 5,
) -> list[Node]:
    """
    Flaky-test forensics: fork the candidate's checkpoint k times and re-run the test in each fork.

    Args:
        run: The Run being repaired.
        candidate: A Node whose test passed once; updated in place with is_stable,
            stability_runs and stability_passes (stable only if every fork passes).
        sandbox: Sandbox used to fork the candidate checkpoint.
        k: Number of concurrent forks (default 5).

    Returns:
        One "stability" Node per fork.
    """
    cmd = candidate.test_command or run.target_test

    def _one() -> Node:
        fork = sandbox.fork(candidate.checkpoint_id)
        result = fork.run_command(cmd)
        return Node(
            node_id=str(uuid.uuid4()),
            run_id=run.run_id,
            parent_node_id=candidate.node_id,
            branch_type="stability",
            checkpoint_id=fork.checkpoint(),
            test_command=cmd,
            test_result="pass" if result.exit_code == 0 else "fail",
            test_output=result.output,
            status="done",
        )

    nodes = list(await asyncio.gather(*(asyncio.to_thread(_one) for _ in range(k))))
    candidate.stability_runs = k
    candidate.stability_passes = sum(n.test_result == "pass" for n in nodes)
    candidate.is_stable = candidate.stability_passes == k
    logger.info(f"Stability: node {candidate.node_id} passed {candidate.stability_passes}/{k}")
    return nodes


async def check_adversarial(
    run: Run,
    candidate: Node,
    sandbox: SandboxManager,
    m: int = 2,
) -> list[Node]:
    """
    Adversarial verification: fork the candidate checkpoint m times and, in each fork,
    write and run a freshly generated adversarial pytest designed to break the patch.

    test_result="pass" means the patch survived the attack; "fail" means the attack
    exposed a flaw. Sets run.adversarial_runs and run.adversarial_survived.

    Args:
        run: The Run being repaired.
        candidate: The stability-verified winner Node.
        sandbox: Sandbox used to fork the candidate checkpoint.
        m: Number of concurrent adversarial forks (default 2).

    Returns:
        One "adversarial" Node per fork.
    """
    prompt = (
        f"Bug description: {run.bug_description}\n"
        f"Target test command: {candidate.test_command or run.target_test}\n\n"
        f"Candidate patch under attack:\n{candidate.patch_diff or ''}\n\n"
        f"Write one pytest test function to save as {ADVERSARIAL_TEST_FILENAME} that tries "
        "to break this patch: edge cases, boundary inputs, and regressions it may miss."
    )
    test_command = f"pytest {ADVERSARIAL_TEST_FILENAME}"

    async def _one(index: int) -> Node:
        response = await call_model(
            job="generate_adversarial_test",
            prompt=prompt,
            system_prompt=ADVERSARIAL_SYSTEM_PROMPT,
        )
        test_code = extract_code(response["content"])

        def _exec() -> tuple[CommandResult, str]:
            fork = sandbox.fork(candidate.checkpoint_id)
            write = fork.run_command(
                f"cat > {ADVERSARIAL_TEST_FILENAME} << 'PATCHTREE_EOF'\n"
                f"{test_code}\nPATCHTREE_EOF"
            )
            logger.debug(f"Adversarial fork {index + 1}: write exit_code={write.exit_code}")
            result = fork.run_command(test_command)
            return result, fork.checkpoint()

        result, checkpoint_id = await asyncio.to_thread(_exec)
        cost = calculate_token_cost(response["model"], response["tokens_in"], response["tokens_out"])
        fn_match = re.search(r"def\s+(test_[a-zA-Z0-9_]+)\s*\(", test_code or "")
        fn_label = fn_match.group(1) if fn_match else (test_code.splitlines()[0] if test_code else "empty")
        return Node(
            node_id=str(uuid.uuid4()),
            run_id=run.run_id,
            parent_node_id=candidate.node_id,
            branch_type="adversarial",
            checkpoint_id=checkpoint_id,
            patch_diff=test_code,
            hypothesis=f"adversarial fork {index + 1}: {fn_label}",
            test_command=test_command,
            test_result="pass" if result.exit_code == 0 else "fail",
            test_output=result.output,
            model_used=response["model"],
            tokens_in=response["tokens_in"],
            tokens_out=response["tokens_out"],
            estimated_cost_usd=cost,
            status="done",
        )

    nodes = list(await asyncio.gather(*(_one(i) for i in range(m))))
    run.adversarial_runs = m
    run.adversarial_survived = sum(n.test_result == "pass" for n in nodes)
    logger.info(
        f"Adversarial: patch {candidate.node_id} survived "
        f"{run.adversarial_survived}/{m} attacks"
    )
    return nodes


async def run_full_suite(
    run: Run,
    candidate: Node,
    sandbox: SandboxManager,
) -> Node | None:
    """Runs the full repository test suite on the winning candidate checkpoint if specified."""
    cmd = (run.full_suite_test or "").strip()
    if not cmd:
        run.full_suite_result = "skipped"
        return None

    fork = sandbox.fork(candidate.checkpoint_id)
    result = await asyncio.to_thread(fork.run_command, cmd)
    passed = result.exit_code == 0
    run.full_suite_result = "pass" if passed else "fail"
    return Node(
        node_id=str(uuid.uuid4()),
        run_id=run.run_id,
        parent_node_id=candidate.node_id,
        branch_type="full_suite",
        checkpoint_id=fork.checkpoint(),
        test_command=cmd,
        test_result="pass" if passed else "fail",
        test_output=result.output,
        status="done",
    )


async def generate_confidence_report(
    run: Run,
    winner: Node | None,
    all_nodes: list[Node],
) -> str:
    """Calls Nemotron Ultra to generate a structured plain-language confidence report."""
    if winner is not None:
        prompt = (
            f"You are the PatchTree Verification Agent. Synthesize a plain-language confidence report:\n"
            f"Bug Description: {run.bug_description}\n"
            f"Target Test: {run.target_test}\n"
            f"Patch Diff:\n{winner.patch_diff}\n\n"
            f"Telemetry:\n"
            f"- Stability Forensics: {winner.stability_passes}/{winner.stability_runs} passes\n"
            f"- Adversarial Attacks: {run.adversarial_survived}/{run.adversarial_runs} survived\n"
            f"- Full Suite Result: {run.full_suite_result}\n"
            f"- Overall Confidence Score: {run.confidence_score}\n"
            f"- Total Wall Time: {run.total_wall_time_seconds}s, Total Cost: ${run.total_cost_usd}\n\n"
            f"Provide an Executive Summary, Layer-by-Layer Verification Breakdown, and Production Readiness Recommendation in GitHub Markdown."
        )
    else:
        prompt = (
            f"You are the PatchTree Verification Agent. Synthesize an Honest Failure Report:\n"
            f"Bug Description: {run.bug_description}\n"
            f"Target Test: {run.target_test}\n"
            f"No candidate patch passed verification across search rounds.\n"
            f"Summarize what failed, identify the least-bad attempt from the tree, and provide actionable next steps for the engineering team."
        )
    res = await call_model("generate_confidence_report", prompt=prompt)
    report_cost = calculate_token_cost(res.get("model", "ultra"), res.get("tokens_in", 0), res.get("tokens_out", 0))
    run.total_cost_usd = round(run.total_cost_usd + report_cost, 6)
    return res["content"]


async def run_pipeline(
    run: Run,
    max_rounds: int = 2,
    sandbox: SandboxManager | None = None,
    live_nodes: list[Node] | None = None,
) -> tuple[Run, list[Node]]:
    """
    End-to-end patch search state machine:
    reproduce -> 4-branch search -> evaluate -> if all fail, Ultra synthesizes
    directly -> stability -> adversarial -> full_suite -> report.
    """
    budget_token = start_run_llm_budget()
    try:
        return await _run_pipeline_impl(run, max_rounds=max_rounds, sandbox=sandbox, live_nodes=live_nodes)
    finally:
        end_run_llm_budget(budget_token)


async def _run_pipeline_impl(
    run: Run,
    max_rounds: int = 2,
    sandbox: SandboxManager | None = None,
    live_nodes: list[Node] | None = None,
) -> tuple[Run, list[Node]]:
    force_stub = bool(
        os.environ.get("PATCHTREE_FORCE_STUB", "").lower() in ("1", "true")
        or "example" in (run.repo_url or "").lower()
    )
    sandbox = sandbox or SandboxManager(force_stub=force_stub)
    all_nodes: list[Node] = live_nodes if live_nodes is not None else []
    run.status = "running"

    root_node = await asyncio.to_thread(reproduce, run, sandbox)
    all_nodes.append(root_node)
    logger.info(f"Reproduce: root node {root_node.node_id} -> test_result={root_node.test_result}")

    # ── Guard: Stop early if bug reproduction failed or test already passed ───
    if root_node.test_result != "fail":
        if root_node.test_result == "pass":
            msg = (
                "Target test passed with exit code 0 on the clean repository.\n"
                "No bug was reproduced to patch. Verify that the target test asserts the buggy behavior."
            )
        else:
            msg = (
                f"Bug reproduction failed: test command could not be executed or target test was not found.\n\n"
                f"Output:\n{root_node.test_output}\n\n"
                f"Verify that the repository URL, test path, and required test runners are correctly specified."
            )
        run.status = "failed"
        run.confidence_score = 0.0
        run.confidence_report = (
            f"### PatchTree Reproduction Aborted\n\n"
            f"**Status:** `{root_node.test_result.upper()}`\n\n"
            f"**Reason:**\n{msg}\n\n"
            f"- **Repository:** `{run.repo_url}`\n"
            f"- **Target Test:** `{run.target_test}`\n\n"
            f"> **Important:** Search fan-out was halted early to protect against unnecessary LLM and compute costs."
        )
        run.completed_at = datetime.now(timezone.utc)
        if run.created_at:
            run.total_wall_time_seconds = max(0.01, round((run.completed_at - run.created_at).total_seconds(), 2))
        run.total_cost_usd = round(sum(n.estimated_cost_usd for n in all_nodes), 6)
        logger.warning(f"Run {run.run_id} aborted early at reproduce stage: {root_node.test_result}")
        return run, all_nodes

    # ── Round 1: 4-branch concurrent search ───────────────────────────────────
    branches = await search_round(run, root_node, round_num=1, sandbox=sandbox)
    all_nodes.extend(branches)

    candidates: list[Node] = []
    for b in branches:
        if b.test_result == "pass":
            candidates.append(b)

    # ── Evaluate round-1 candidates through stability check ───────────────────
    winner: Node | None = None
    for candidate in candidates:
        logger.info(f"Running stability check on candidate {candidate.node_id} (k=5)...")
        stability_nodes = await check_stability(run, candidate, sandbox=sandbox, k=5)
        all_nodes.extend(stability_nodes)
        if candidate.is_stable:
            winner = candidate
            logger.info(
                f"Candidate {candidate.node_id} verified stable "
                f"({candidate.stability_passes}/{candidate.stability_runs})!"
            )
            break
        logger.warning(
            f"Candidate {candidate.node_id} demoted due to flakiness "
            f"({candidate.stability_passes}/{candidate.stability_runs} passes)."
        )

    # ── Escalation: Ultra direct patch synthesis if round 1 fully failed ──────
    if winner is None and not any(b.test_result == "pass" for b in branches):
        logger.info("Round 1: all 4 branches failed — escalating to Nemotron Ultra for direct patch synthesis")
        ultra_node = await ultra_synthesize_patch(run, branches, root_node, sandbox)
        all_nodes.append(ultra_node)

        if ultra_node.test_result == "pass":
            logger.info(f"Ultra synthesis passed — running stability check on {ultra_node.node_id}")
            stability_nodes = await check_stability(run, ultra_node, sandbox=sandbox, k=5)
            all_nodes.extend(stability_nodes)
            if ultra_node.is_stable:
                winner = ultra_node
                logger.info(
                    f"Ultra candidate {ultra_node.node_id} verified stable "
                    f"({ultra_node.stability_passes}/{ultra_node.stability_runs})!"
                )
            else:
                logger.warning(
                    f"Ultra candidate {ultra_node.node_id} flaky "
                    f"({ultra_node.stability_passes}/{ultra_node.stability_runs} passes)."
                )
        else:
            logger.warning(f"Ultra synthesis also failed: test_result={ultra_node.test_result}")

    if winner is not None:
        # 1. Adversarial verification
        logger.info(f"Running adversarial verification on winner {winner.node_id} (m=2)...")
        adversarial_nodes = await check_adversarial(run, winner, sandbox=sandbox, m=2)
        all_nodes.extend(adversarial_nodes)
        # 2. Full-suite check
        if (run.full_suite_test or "").strip():
            logger.info(f"Running full suite check on winner {winner.node_id}...")
            suite_node = await run_full_suite(run, winner, sandbox=sandbox)
            if suite_node:
                all_nodes.append(suite_node)
        else:
            logger.info("Full suite check skipped (no command specified).")
            run.full_suite_result = "skipped"

        # 3. Confidence score
        stability_rate = (winner.stability_passes / winner.stability_runs) if winner.stability_runs else 1.0
        adversarial_rate = (run.adversarial_survived / run.adversarial_runs) if run.adversarial_runs else 1.0
        if run.full_suite_result == "skipped":
            run.confidence_score = round(0.5 * stability_rate + 0.5 * adversarial_rate, 2)
        else:
            suite_rate = 1.0 if run.full_suite_result == "pass" else 0.0
            run.confidence_score = round(0.4 * stability_rate + 0.4 * adversarial_rate + 0.2 * suite_rate, 2)
        run.winner_node_id = winner.node_id
        run.completed_at = datetime.now(timezone.utc)
        if run.created_at:
            run.total_wall_time_seconds = round((run.completed_at - run.created_at).total_seconds(), 2)
        run.total_cost_usd = round(sum(n.estimated_cost_usd for n in all_nodes), 6)
        # 4. Ultra Report
        logger.info("Generating Nemotron Ultra Confidence Report...")
        run.confidence_report = await generate_confidence_report(run, winner, all_nodes)
        run.status = "complete"
        logger.info(f"Pipeline complete: verified winner {winner.node_id} with confidence {run.confidence_score}")
        return run, all_nodes

    # All attempts (including Ultra) failed
    run.status = "failed"
    run.completed_at = datetime.now(timezone.utc)
    if run.created_at:
        run.total_wall_time_seconds = round((run.completed_at - run.created_at).total_seconds(), 2)
    run.total_cost_usd = round(sum(n.estimated_cost_usd for n in all_nodes), 6)
    run.confidence_report = await generate_confidence_report(run, None, all_nodes)
    logger.info("Pipeline failed: no passing patch after round 1 + Ultra escalation")
    return run, all_nodes
