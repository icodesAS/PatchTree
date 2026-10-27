"""SearchNode fan-out, evaluation, replan, and pipeline orchestration."""
import ast
import asyncio
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Literal

from ..llm.router import call_model
from ..models.schemas import Node, Run
from ..sandbox.contree_client import CommandResult, SandboxManager

logger = logging.getLogger(__name__)

# Branch definitions: (job, temperature, instruction_template)
SEARCH_BRANCHES: list[tuple[str, float, str]] = [
    (
        "generate_patch_minimal",
        0.2,
        """You are a minimal-fix expert. Generate the smallest possible patch that fixes this bug.

Bug description: {bug_description}
Test command: {test_command}
Current test output (failing): {test_output}

Provide a unified diff patch that makes the test pass with minimal changes. Focus on the most direct fix.""",
    ),
    (
        "generate_patch_alternative",
        0.5,
        """You are exploring alternative approaches. Generate a patch using a different strategy than the obvious fix.

Bug description: {bug_description}
Test command: {test_command}
Current test output (failing): {test_output}

Provide a unified diff patch that fixes the bug using an alternative approach or refactoring.""",
    ),
    (
        "generate_patch_root_cause",
        0.6,
        """You are a root-cause analyst. The bug might not be where it appears. Look for the underlying cause elsewhere.

Bug description: {bug_description}
Test command: {test_command}
Current test output (failing): {test_output}

Provide a unified diff patch that addresses the root cause, which may be in a different module or layer.""",
    ),
    (
        "generate_patch_test_driven",
        0.2,
        """You are a test-driven development expert. Generate a patch that strictly satisfies the test contract.

Bug description: {bug_description}
Test command: {test_command}
Current test output (failing): {test_output}

Provide a unified diff patch that makes the test pass by strictly adhering to the expected behavior.""",
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

ULTRA_SYNTHESIS_SYSTEM_PROMPT = (
    "You are Nemotron Ultra, the most capable model in the PatchTree pipeline. "
    "All 4 initial search attempts failed to fix this bug. "
    "Carefully analyze every failed attempt — the hypothesis, the patch diff, and the pytest failure trace — "
    "then synthesize a correct unified diff (--- a/... +++ b/...) that avoids the mistakes of all prior attempts. "
    "Output ONLY the unified diff, with no prose before or after it."
)

ADVERSARIAL_SYSTEM_PROMPT = (
    "You are an adversarial tester. Given a bug description, the target test, and a "
    "candidate patch, write one pytest test function designed to break the patch: probe "
    "edge cases, boundary values, and regressions the patch may have missed. "
    "Reply with only a python code block containing the test."
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

        # Search for requirements.txt (root or nested subfolders)
        find_res = sandbox.run_command("find /app -name '*requirements*.txt' -o -name 'requirements.txt' 2>/dev/null | head -n 1")
        req_path = find_res.output.strip().splitlines()[0] if find_res.output.strip() else ""

        if not req_path:
            logger.warning(f"No requirements.txt found in {repo_url}")
            return Node(
                node_id=str(uuid.uuid4()),
                run_id=run.run_id,
                branch_type="root",
                checkpoint_id=sandbox.checkpoint(),
                test_command=run.target_test,
                test_result="error",
                test_output="No requirements.txt file found in repository. Please ensure a requirements.txt file exists in the repository root or a subfolder so dependencies can be installed.",
                status="done",
            )

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
    source_context = extract_relevant_source_context(
        sandbox=sandbox,
        target_test=parent_node.test_command or run.target_test,
        test_output=failed_branches[0].test_output if failed_branches else "",
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
    hypothesis = f"ultra_synthesis: {patch_diff[:100]}..."

    fork = sandbox.fork(parent_node.checkpoint_id)
    apply_result = fork.run_command(f"apply_patch {node_id}.diff")
    logger.debug(f"Ultra escalation: patch apply exit_code={apply_result.exit_code}")

    if apply_result.exit_code != 0:
        test_result: Literal["pass", "fail", "error"] = "error"
        test_output = f"Patch application failed:\n{apply_result.output}"
    else:
        test_result_obj = fork.run_command(parent_node.test_command or run.target_test)
        test_result = "pass" if test_result_obj.exit_code == 0 else "fail"
        test_output = test_result_obj.output

    checkpoint_id = fork.checkpoint()
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
    match = re.search(r"```(?:diff|patch)?\s*\n([\s\S]*?)\n```", content)
    if match:
        return match.group(1).strip()
    return content.strip()


def extract_code(content: str) -> str:
    """Extract a python code block from a model response, stripping markdown fences."""
    match = re.search(r"```(?:python|py)?\s*\n([\s\S]*?)\n```", content)
    if match:
        return match.group(1).strip()
    return content.strip()


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
    max_files: int = 3,
    max_lines: int = 250,
) -> str:
    """Read failing source files and AST-detected local dependencies from sandbox."""
    if sandbox.stub:
        return ""

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
) -> Node:
    """Execute a single search branch: fork, call model, apply patch, test."""
    node_id = str(uuid.uuid4())
    logger.info(f"Branch {branch_index + 1}/4 ({job}): starting node {node_id}")

    # Fork the sandbox from parent checkpoint
    fork = parent_sandbox.fork(parent_node.checkpoint_id)

    # Build the prompt
    prompt = instruction_template.format(
        bug_description=run.bug_description,
        test_command=parent_node.test_command or run.target_test,
        test_output=parent_node.test_output or "",
    )
    if guidance:
        prompt += f"\n\nRevised guidance from the failed previous round: {guidance}"

    source_context = extract_relevant_source_context(
        sandbox=parent_sandbox,
        target_test=parent_node.test_command or run.target_test,
        test_output=parent_node.test_output or "",
    )
    if source_context:
        prompt += f"\n\n{source_context}"

    # Call the model
    model_response = await call_model(job=job, prompt=prompt, temperature=temperature)

    # Extract patch from response (clean markdown fences if model wrapped the diff)
    raw_content = model_response.get("content", "")
    patch_diff = extract_diff(raw_content) or raw_content
    hypothesis = f"{job}: {patch_diff[:100]}..."

    # Apply the patch in the forked sandbox
    apply_result = fork.run_command(f"apply_patch {node_id}.diff")
    logger.debug(f"Branch {branch_index + 1}: patch apply exit_code={apply_result.exit_code}")

    if apply_result.exit_code != 0:
        test_result: Literal["pass", "fail", "error"] = "error"
        test_output = f"Patch application failed:\n{apply_result.output}"
    else:
        # Run the test
        test_result_obj = fork.run_command(parent_node.test_command or run.target_test)
        test_result = "pass" if test_result_obj.exit_code == 0 else "fail"
        test_output = test_result_obj.output

    # Create checkpoint after applying patch
    checkpoint_id = fork.checkpoint()
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
        return Node(
            node_id=str(uuid.uuid4()),
            run_id=run.run_id,
            parent_node_id=candidate.node_id,
            branch_type="adversarial",
            checkpoint_id=checkpoint_id,
            hypothesis=f"adversarial fork {index + 1}: {test_code.splitlines()[0] if test_code else 'empty'}",
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

    Args:
        run: The Run to process.
        max_rounds: Unused (kept for API compatibility). Ultra escalation is
            always the single fallback after round 1 fails.
        sandbox: Optional sandbox instance (defaults to SandboxManager()).
        live_nodes: Optional mutable list that receives nodes in real-time.

    Returns:
        (updated_run, all_nodes_created). On success run.status is "complete"
        and run.winner_node_id is set; otherwise run.status is "failed".
    """
    force_stub = bool(
        os.environ.get("PATCHTREE_FORCE_STUB", "").lower() in ("1", "true")
        or "example" in (run.repo_url or "").lower()
    )
    sandbox = sandbox or SandboxManager(force_stub=force_stub)
    all_nodes: list[Node] = live_nodes if live_nodes is not None else []
    run.status = "running"

    root_node = reproduce(run, sandbox)
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
            f"> [!IMPORTANT]\n"
            f"> Search fan-out was halted early to protect against unnecessary LLM and compute costs."
        )
        run.completed_at = datetime.now(timezone.utc)
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
