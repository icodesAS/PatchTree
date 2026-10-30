import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Check } from 'lucide-react';
import type { PatchNode } from '../types';
import TierTag from './TierTag';
import { getModelTier } from '../tier';

const JOB_LABELS: Record<string, string> = {
  generate_patch_minimal: 'Minimal surgical fix',
  generate_patch_alternative: 'Defensive guard path',
  generate_patch_root_cause: 'Upstream root-cause fix',
  generate_patch_test_driven: 'Test-contract compliance',
};

function formatRow2(node: PatchNode, isRunning: boolean, stabRunNum?: number): string {
  if (node.branch_type === 'root') {
    return node.test_command || 'pytest';
  }
  if (node.branch_type === 'stability') {
    const raw = (node.hypothesis || '').trim();
    if (/^Run\s+\d+\s+of\s+\d+/i.test(raw)) return raw;
    const total = node.stability_runs || 5;
    const num = stabRunNum ?? node.stability_passes ?? 1;
    return `Run ${num} of ${total}`;
  }

  const raw = (node.hypothesis || '').trim();
  if (!raw) {
    if (isRunning) return 'Evaluating candidate patch in sandbox...';
    if (node.branch_type === 'full_suite') return node.test_command || 'pytest';
    return node.test_command || 'Verification check';
  }

  const jobMatch = raw.match(/^(generate_patch_\w+):\s*(.*)$/s);
  if (jobMatch) {
    const [, job, rest] = jobMatch;
    const baseLabel = JOB_LABELS[job] || job;
    const firstLine = rest.split('\n')[0].trim();
    if (firstLine && !firstLine.startsWith('---') && !firstLine.startsWith('+++') && !firstLine.startsWith('@@')) {
      return firstLine;
    }
    return baseLabel;
  }

  const advMatch = raw.match(/^adversarial fork\s*(\d+):\s*(.*)$/i);
  if (advMatch) {
    const [, forkNum, rest] = advMatch;
    const fnMatch = (node.patch_diff || rest).match(/def\s+(test_[a-zA-Z0-9_]+)/);
    const fnLabel = fnMatch ? fnMatch[1].replace(/^test_/, '').replace(/_/g, ' ') : 'boundary check';
    return `Probe ${forkNum}: ${fnLabel}`;
  }

  return raw.split('\n')[0];
}

export default function PNode({ data, selected }: NodeProps) {
  const node = (data.patchNode as PatchNode) || {};
  const isWinner = Boolean(data.isWinner);
  const siblingIndex = typeof data.siblingIndex === 'number' ? data.siblingIndex : undefined;

  const isQueued = node.status === 'pending' && node.test_result == null;
  const isRunning = !isQueued && (node.test_result == null || node.status === 'running');
  const isPass = node.test_result === 'pass';

  const statusKey: 'queued' | 'running' | 'pass' | 'fail' = isQueued
    ? 'queued'
    : isRunning
    ? 'running'
    : isPass
    ? 'pass'
    : 'fail';

  const statusWord =
    statusKey === 'queued'
      ? 'Queued'
      : statusKey === 'running'
      ? 'Running'
      : statusKey === 'pass'
      ? 'Pass'
      : 'Fail';

  const modelInfo = getModelTier(node.model_used || '');
  const nodeName = (data.name as string) || node.branch_type;
  const row2Text = formatRow2(node, isRunning, typeof siblingIndex === 'number' ? siblingIndex + 1 : undefined);

  const totalTokens = (node.tokens_in ?? 0) + (node.tokens_out ?? 0);
  const cost = node.estimated_cost_usd ?? 0;

  const isStability = node.branch_type === 'stability';
  const stabRuns = node.stability_runs || 5;
  const stabResults = (data.stabResults as string[] | undefined) ?? [];
  const stabPassedCount = stabResults.slice(0, (siblingIndex ?? 0) + 1).filter((r) => r === 'pass').length;

  return (
    <div
      role="button"
      tabIndex={0}
      className={`pnode ${selected ? 'is-selected' : ''}`}
      data-status={statusKey}
      data-winner={isWinner ? 'true' : undefined}
      aria-label={`${nodeName} (${isWinner ? 'Selected' : statusWord})`}
    >
      <Handle type="target" position={Position.Top} className="pnode__handle" />

      <div className="pnode__row1">
        <div className="pnode__name-wrap">
          <span className="status-dot" data-status={statusKey} />
          <span className="pnode__name mono">{nodeName}</span>
        </div>

        {isWinner ? (
          <span className="pnode__winner-status">
            <Check size={14} strokeWidth={1.75} />
            <span>Selected</span>
          </span>
        ) : (
          <span className="pnode__status" data-status={statusKey}>
            {statusWord}
          </span>
        )}
      </div>

      <div className="pnode__row2" title={row2Text}>
        {row2Text}
      </div>

      <div className="pnode__row3">
        {isStability ? (
          <>
            <span className="pnode__stab-bar" aria-label={`${stabPassedCount} of ${stabRuns} stability runs passed`}>
              {Array.from({ length: stabRuns }, (_, idx) => {
                const r = idx <= (siblingIndex ?? 0) ? stabResults[idx] : undefined;
                const segState = r === 'pass' ? 'pass' : r === 'fail' ? 'fail' : 'pending';
                return <span key={idx} className="pnode__stab-seg" data-seg={segState} />;
              })}
            </span>
            <span className="pnode__meta mono num">${cost.toFixed(4)}</span>
          </>
        ) : (
          <>
            {modelInfo.tier !== 'sandbox' && <TierTag tier={modelInfo.tier} />}
            <span className="pnode__meta mono num">{totalTokens} tok</span>
            <span className="pnode__meta mono num">${cost.toFixed(4)}</span>
          </>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} className="pnode__handle" />
    </div>
  );
}
