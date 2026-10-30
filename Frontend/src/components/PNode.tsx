import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { PatchNode } from '../types';

const tierOf = (model = '') =>
  /ultra|550/i.test(model) ? 'ultra' : /super|120/i.test(model) ? 'super' : /nano|30/i.test(model) ? 'nano' : 'sandbox';

const chipText = (tier: string) =>
  tier === 'sandbox' ? 'Sandbox · pytest' : tier === 'ultra' ? 'Ultra 550B' : tier === 'super' ? 'Super 120B' : 'Nano 30B';

const JOB_LABELS: Record<string, string> = {
  generate_patch_minimal: 'Strategy 1 · Minimal surgical fix',
  generate_patch_alternative: 'Strategy 2 · Defensive guard path',
  generate_patch_root_cause: 'Strategy 3 · Upstream root-cause fix',
  generate_patch_test_driven: 'Strategy 4 · Test-contract compliance',
};

function formatCardHypothesis(node: PatchNode, isRunning: boolean): string {
  const raw = (node.hypothesis || '').trim();
  if (!raw) {
    if (isRunning) return 'Thinking & evaluating in sandbox…';
    if (node.branch_type === 'root') return `Reproduce: ${node.test_command || 'pytest'}`;
    if (node.branch_type === 'stability') return `Stability re-run: ${node.test_command || 'pytest'}`;
    if (node.branch_type === 'full_suite') return `Full suite: ${node.test_command || 'pytest'}`;
    return node.test_command || 'Verification checkpoint';
  }
  const jobMatch = raw.match(/^(generate_patch_\w+):\s*(.*)$/s);
  if (jobMatch) {
    const [, job, rest] = jobMatch;
    const baseLabel = JOB_LABELS[job] || job;
    const fileMatch = (node.patch_diff || rest).match(/(?:\+\+\+\s+b\/|---\s+a\/)([^\s\n]+)/);
    const firstLine = rest.split('\n')[0].trim();
    if (firstLine && !firstLine.startsWith('---') && !firstLine.startsWith('+++') && !firstLine.startsWith('@@')) {
      return firstLine;
    }
    return fileMatch ? `${baseLabel} (${fileMatch[1]})` : baseLabel;
  }
  const advMatch = raw.match(/^adversarial fork\s*(\d+):\s*(.*)$/i);
  if (advMatch) {
    const [, forkNum, rest] = advMatch;
    const fnMatch = (node.patch_diff || rest).match(/def\s+(test_[a-zA-Z0-9_]+)/);
    const fnLabel = fnMatch ? fnMatch[1].replace(/_/g, ' ') : 'boundary & invariant probe';
    return `Adversarial probe ${forkNum} — ${fnLabel}`;
  }
  return raw.split('\n')[0];
}

export default function PNode({ data, selected }: NodeProps) {
  const node = (data.patchNode as PatchNode) || {};
  const isWinner = Boolean(data.isWinner);
  const isDimmed = Boolean(data.isDimmed);
  const index = typeof data.index === 'number' ? data.index : 0;

  const isRunning = node.test_result == null || node.status === 'pending' || node.status === 'running';
  const isPass = node.test_result === 'pass';
  const isError = node.test_result === 'error';
  const status: 'running' | 'pass' | 'fail' | 'idle' = isRunning ? 'running' : isPass ? 'pass' : 'fail';

  const tier = tierOf(node.model_used || '');
  const stage = node.branch_type === 'full_suite' ? 'full' : node.branch_type || 'search';

  const label = node.branch_type === 'root'
    ? 'root'
    : `${node.branch_type || 'branch'}/${(node.node_id || '').slice(0, 4)}`;

  const totalTokens = (node.tokens_in ?? 0) + (node.tokens_out ?? 0);
  const cost = node.estimated_cost_usd ?? 0;

  const checks = (node.branch_type === 'stability' || node.branch_type === 'search') && node.stability_runs
    ? Array.from({ length: node.stability_runs }, (_, i) => (i < (node.stability_passes ?? 0) ? 'ok' : 'bad'))
    : [];

  const displayHyp = formatCardHypothesis(node, isRunning);

  return (
    <div
      className={`pnode ${selected ? 'is-selected' : ''}`}
      data-stage={stage}
      data-status={status}
      data-tier={tier}
      data-winner={isWinner ? 'true' : undefined}
      data-dim={isDimmed ? 'true' : undefined}
      style={{ '--i': index } as React.CSSProperties}
    >
      <Handle type="target" position={Position.Top} />
      {isWinner && <span className="pnode__crown">★ WINNER</span>}

      <header className="pnode__head">
        <span className="pnode__dot" />
        <span className="pnode__label">{label}</span>
        <span className="pnode__badge">
          {status === 'running' ? 'RUNNING' : status === 'pass' ? '✓ PASS' : isError ? '⚠ ERROR' : '✕ FAIL'}
        </span>
      </header>

      <div className="pnode__body">
        <span className="pnode__chip">{chipText(tier)}</span>
        <p className={`pnode__hyp ${status === 'running' ? 'is-streaming' : ''}`}>
          {displayHyp}
        </p>
      </div>

      <footer className="pnode__foot">
        <span><b>{totalTokens ? totalTokens.toLocaleString() : '—'}</b> tok</span>
        <span><b>${cost.toFixed(4)}</b></span>
        {checks.length > 0 && (
          <span
            className="pnode__ticks"
            title={`${checks.filter((c) => c === 'ok').length}/${checks.length} checks passed`}
          >
            {checks.map((c, i) => (
              <i key={i} className={c} />
            ))}
          </span>
        )}
      </footer>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
