import type { PatchNode, Run } from './types';

const RUN_ID = 'demo-run-001';
const WINNER = 'search-002';

const nodes: PatchNode[] = [
  {
    node_id: 'root-001', run_id: RUN_ID, parent_node_id: null,
    branch_type: 'root',
    hypothesis: 'Bug reproduced: test_calculate_discount fails when discount_pct > 100%. Checkpoint A created.',
    patch_diff: '', test_command: 'pytest tests/test_discount.py::test_calculate_discount -v',
    test_result: 'fail',
    test_output: 'FAILED tests/test_discount.py::test_calculate_discount\nAssertionError: Expected 0 but got -50.0\n  assert result >= 0',
    model_used: 'none', status: 'done',
    tokens_in: 0, tokens_out: 0, estimated_cost_usd: 0, wall_time_seconds: 2.1,
  },
  {
    node_id: 'search-001', run_id: RUN_ID, parent_node_id: 'root-001',
    branch_type: 'search',
    hypothesis: 'Clamp discount value to [0, 100] range before applying. Simple guard clause.',
    patch_diff: `--- a/src/pricing.py\n+++ b/src/pricing.py\n@@ -12,6 +12,7 @@\n+    discount_pct = max(0.0, min(100.0, discount_pct))\n     return price * (1 - discount_pct / 100)`,
    test_command: 'pytest tests/test_discount.py -v',
    test_result: 'fail',
    test_output: 'FAILED tests/test_discount.py::test_calculate_discount\nAssertionError: Expected 100.0 for 0% discount but got 90.0',
    model_used: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B', status: 'done',
    tokens_in: 320, tokens_out: 88, estimated_cost_usd: 0.0012, wall_time_seconds: 4.3,
  },
  {
    node_id: WINNER, run_id: RUN_ID, parent_node_id: 'root-001',
    branch_type: 'search',
    hypothesis: 'Validate discount is within [0, 100], raise ValueError if not, then apply.',
    patch_diff: `--- a/src/pricing.py\n+++ b/src/pricing.py\n@@ -12,3 +12,5 @@\n+    if not 0 <= discount_pct <= 100:\n+        raise ValueError(f"discount_pct must be between 0 and 100, got {discount_pct}")\n     return price * (1 - discount_pct / 100)`,
    test_command: 'pytest tests/test_discount.py -v',
    test_result: 'pass',
    test_output: 'PASSED tests/test_discount.py::test_calculate_discount\n1 passed in 0.12s',
    model_used: 'nvidia/nemotron-3-super-120b-a12b', status: 'done',
    tokens_in: 298, tokens_out: 72, estimated_cost_usd: 0.0011, wall_time_seconds: 3.9,
  },
  {
    node_id: 'search-003', run_id: RUN_ID, parent_node_id: 'root-001',
    branch_type: 'search',
    hypothesis: 'Return 0 for negative price or discount > 100 using early return pattern.',
    patch_diff: `--- a/src/pricing.py\n+++ b/src/pricing.py\n@@ -12,3 +12,5 @@\n+    if discount_pct > 100 or price < 0:\n+        return 0.0\n     return price * (1 - discount_pct / 100)`,
    test_command: 'pytest tests/test_discount.py -v',
    test_result: 'fail',
    test_output: 'FAILED tests/test_discount.py::test_calculate_discount\nAssertionError: Expected 75.0 for 25% discount but got 0.0',
    model_used: 'nvidia/Nemotron-Super-70B', status: 'done',
    tokens_in: 512, tokens_out: 104, estimated_cost_usd: 0.0034, wall_time_seconds: 5.1,
  },
  {
    node_id: 'search-004', run_id: RUN_ID, parent_node_id: 'root-001',
    branch_type: 'search',
    hypothesis: 'Use abs() to ensure positive discount always, correct mathematical formula.',
    patch_diff: `--- a/src/pricing.py\n+++ b/src/pricing.py\n@@ -12,3 +12,4 @@\n-    return price * (1 - discount_pct / 100)\n+    pct = abs(discount_pct) % 101\n+    return price * (1 - pct / 100)`,
    test_command: 'pytest tests/test_discount.py -v',
    test_result: 'fail',
    test_output: 'FAILED\nTypeError: unsupported operand type for %: float and int',
    model_used: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B', status: 'done',
    tokens_in: 265, tokens_out: 61, estimated_cost_usd: 0.0009, wall_time_seconds: 3.4,
  },
  {
    node_id: 'stab-001', run_id: RUN_ID, parent_node_id: WINNER,
    branch_type: 'stability',
    hypothesis: 'Run 1 of 5',
    patch_diff: '', test_command: 'pytest tests/test_discount.py -v -p no:randomly',
    test_result: 'pass',
    test_output: 'PASSED tests/test_discount.py::test_calculate_discount\n1 passed in 0.11s',
    model_used: 'none', is_stable: true, stability_passes: 1, stability_runs: 5, status: 'done',
    tokens_in: 0, tokens_out: 0, estimated_cost_usd: 0, wall_time_seconds: 1.1,
  },
  {
    node_id: 'stab-002', run_id: RUN_ID, parent_node_id: WINNER,
    branch_type: 'stability', hypothesis: 'Run 2 of 5',
    patch_diff: '', test_command: 'pytest tests/test_discount.py -v -p no:randomly',
    test_result: 'pass', test_output: 'PASSED\n1 passed in 0.10s',
    model_used: 'none', is_stable: true, stability_passes: 2, stability_runs: 5, status: 'done',
    tokens_in: 0, tokens_out: 0, estimated_cost_usd: 0, wall_time_seconds: 1.0,
  },
  {
    node_id: 'stab-003', run_id: RUN_ID, parent_node_id: WINNER,
    branch_type: 'stability', hypothesis: 'Run 3 of 5',
    patch_diff: '', test_command: 'pytest tests/test_discount.py -v -p no:randomly',
    test_result: 'pass', test_output: 'PASSED\n1 passed in 0.13s',
    model_used: 'none', is_stable: true, stability_passes: 3, stability_runs: 5, status: 'done',
    tokens_in: 0, tokens_out: 0, estimated_cost_usd: 0, wall_time_seconds: 1.3,
  },
  {
    node_id: 'stab-004', run_id: RUN_ID, parent_node_id: WINNER,
    branch_type: 'stability', hypothesis: 'Run 4 of 5',
    patch_diff: '', test_command: 'pytest tests/test_discount.py -v -p no:randomly',
    test_result: 'pass', test_output: 'PASSED\n1 passed in 0.12s',
    model_used: 'none', is_stable: true, stability_passes: 4, stability_runs: 5, status: 'done',
    tokens_in: 0, tokens_out: 0, estimated_cost_usd: 0, wall_time_seconds: 1.2,
  },
  {
    node_id: 'stab-005', run_id: RUN_ID, parent_node_id: WINNER,
    branch_type: 'stability', hypothesis: 'Run 5 of 5',
    patch_diff: '', test_command: 'pytest tests/test_discount.py -v -p no:randomly',
    test_result: 'pass', test_output: 'PASSED\n1 passed in 0.11s\nStability verified: 5/5 runs passed.',
    model_used: 'none', is_stable: true, stability_passes: 5, stability_runs: 5, status: 'done',
    tokens_in: 0, tokens_out: 0, estimated_cost_usd: 0, wall_time_seconds: 1.1,
  },
  {
    node_id: 'adv-001', run_id: RUN_ID, parent_node_id: WINNER,
    branch_type: 'adversarial',
    hypothesis: 'Boundary value: exactly 100% discount yields 0.0 without ValueError',
    patch_diff: `+++ tests/test_attack_1.py\n@@ -0,0 +1,5 @@\n+def test_exactly_100_pct():\n+    result = calculate_discount(200.0, 100.0)\n+    assert result == 0.0, f"Expected 0.0 but got {result}"`,
    test_command: 'pytest tests/test_attack_1.py -v',
    test_result: 'pass',
    test_output: 'PASSED tests/test_attack_1.py::test_exactly_100_pct\nPatch survived adversarial attack #1.\n1 passed in 0.09s',
    model_used: 'nvidia/Nemotron-Super-70B', status: 'done',
    tokens_in: 680, tokens_out: 145, estimated_cost_usd: 0.0089, wall_time_seconds: 6.2,
  },
  {
    node_id: 'adv-002', run_id: RUN_ID, parent_node_id: WINNER,
    branch_type: 'adversarial',
    hypothesis: 'Float precision edge: discount of 99.9999999 produces non-negative result',
    patch_diff: `+++ tests/test_attack_2.py\n@@ -0,0 +1,4 @@\n+def test_float_precision():\n+    result = calculate_discount(1000.0, 99.9999999)\n+    assert result >= 0.0, f"Got negative: {result}"`,
    test_command: 'pytest tests/test_attack_2.py -v',
    test_result: 'pass',
    test_output: 'PASSED tests/test_attack_2.py::test_float_precision\nPatch survived adversarial attack #2.\n1 passed in 0.08s',
    model_used: 'nvidia/Nemotron-Super-70B', status: 'done',
    tokens_in: 590, tokens_out: 128, estimated_cost_usd: 0.0091, wall_time_seconds: 5.8,
  },
  {
    node_id: 'fullsuite-001', run_id: RUN_ID, parent_node_id: WINNER,
    branch_type: 'full_suite',
    hypothesis: 'Run entire test suite against winning patch.',
    patch_diff: '', test_command: 'pytest tests/ -v --tb=short',
    test_result: 'pass',
    test_output: `PASSED tests/test_discount.py::test_calculate_discount
PASSED tests/test_discount.py::test_zero_discount
PASSED tests/test_discount.py::test_negative_price
PASSED tests/test_pricing.py::test_bulk_pricing
PASSED tests/test_pricing.py::test_currency_conversion
PASSED tests/test_cart.py::test_cart_total
PASSED tests/test_cart.py::test_empty_cart
7 passed in 0.43s — No regressions found.`,
    model_used: 'none', status: 'done',
    tokens_in: 0, tokens_out: 0, estimated_cost_usd: 0, wall_time_seconds: 3.8,
  },
];

const run: Run = {
  run_id: RUN_ID,
  status: 'complete',
  winner_node_id: WINNER,
  confidence_score: 0.94,
  adversarial_runs: 2,
  adversarial_survived: 2,
  full_suite_result: 'pass',
  total_cost_usd: 0.0246,
  total_wall_time_seconds: 41.4,
  repo_url: 'https://github.com/example/pricing-service',
  bug_description: 'calculate_discount() returns negative values when discount_pct > 100, causing downstream cart total to go negative.',
  target_test: 'pytest tests/test_discount.py::test_calculate_discount',
  full_suite_test: 'pytest',
  confidence_report: `## Summary

The patch introduces a validation guard in \`calculate_discount()\` that raises a \`ValueError\` when \`discount_pct\` falls outside the valid \`[0, 100]\` range. This is a precise, minimal fix that directly addresses the reported bug without side effects.

## Verification evidence

- **Search phase (4 branches):** Branch 2 (\`ValueError\` guard, Super 120B) passed all target assertions; the remaining 3 candidate strategies failed test validation.
- **Stability verification (5/5 forks):** The winning branch was re-executed 5 times in independent Contree sandbox forks. All 5 passed.
- **Adversarial testing (2/2 survived):** Survived both boundary value (100% discount) and float precision (99.9999999%) probes.
- **Full suite (7/7 passing):** Zero regressions detected across the repository test suite.

## Recommendation

**Merge recommended.** The \`ValueError\` guard is the idiomatic Python fix — it fails fast and preserves existing caller contracts.`,
};

export const mockData = { run, nodes };
