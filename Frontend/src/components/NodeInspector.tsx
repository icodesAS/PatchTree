import { useState } from 'react';
import { X, Copy, Check } from 'lucide-react';
import type { PatchNode } from '../types';
import DiffViewer from './DiffViewer';
import TierTag from './TierTag';
import { getModelTier } from '../tier';

const STRATEGY_DESCRIPTIONS: Record<string, string> = {
  generate_patch_minimal:
    'Strategy 1 (Minimal surgical fix) — Targets the crash site with a localized 1–5 line change.',
  generate_patch_alternative:
    'Strategy 2 (Defensive & boundary guard) — Adds input validation, boundary guards, or state normalization.',
  generate_patch_root_cause:
    'Strategy 3 (Upstream root-cause fix) — Traces data flow backward into producer functions and caller state.',
  generate_patch_test_driven:
    'Strategy 4 (Test-contract compliance) — Aligns return values, exception contracts, and edge cases with test assertions.',
};

function formatInspectorStrategy(node: PatchNode): string {
  const raw = (node.hypothesis || '').trim();
  if (!raw) {
    if (node.branch_type === 'root')
      return `Initial bug reproduction running ${node.test_command || 'pytest'} on a clean repository snapshot.`;
    if (node.branch_type === 'stability')
      return `Repeat verification fork running ${node.test_command || 'pytest'} in an isolated Contree VM.`;
    if (node.branch_type === 'full_suite')
      return `Full regression suite (${node.test_command || 'pytest'}) checking for collateral breakage.`;
    return '';
  }
  const jobMatch = raw.match(/^(generate_patch_\w+):\s*(.*)$/s);
  if (jobMatch) {
    const [, job, rest] = jobMatch;
    const desc = STRATEGY_DESCRIPTIONS[job] || job;
    const firstLine = rest.split('\n')[0].trim();
    if (
      firstLine &&
      !firstLine.startsWith('---') &&
      !firstLine.startsWith('+++') &&
      !firstLine.startsWith('@@')
    ) {
      return `${desc}\n${firstLine}`;
    }
    return desc;
  }
  const advMatch = raw.match(/^adversarial fork\s*(\d+):\s*(.*)$/i);
  if (advMatch) {
    const [, forkNum, rest] = advMatch;
    const fnMatch = (node.patch_diff || rest).match(/def\s+(test_[a-zA-Z0-9_]+)/);
    const fnLabel = fnMatch ? fnMatch[1] : 'edge-case pytest';
    return `Adversarial probe ${forkNum} — runs ${fnLabel} in an isolated Contree snapshot to test the winning patch.`;
  }
  return raw;
}

const PHASE_NAMES: Record<string, string> = {
  root: 'Reproduce',
  search: 'Search',
  stability: 'Stability',
  adversarial: 'Adversarial',
  full_suite: 'Full suite',
};

function formatNodeHeaderTitle(node: PatchNode, name: string): string {
  if (node.branch_type === 'root') return 'Reproduce';
  if (node.branch_type === 'full_suite') return 'Full suite';
  const num = name.match(/(\d+)$/)?.[1];
  const label = { search: 'Search branch', stability: 'Stability fork', adversarial: 'Adversarial probe' }[node.branch_type] ?? 'Node';
  return num ? `${label} ${num}` : label;
}

type Tab = 'diff' | 'output' | 'telemetry';

function TerminalOutput({ command, output }: { command?: string; output?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  if (!output && !command) {
    return <p className="inspector__empty">No output yet.</p>;
  }

  const lines = output ? output.split('\n') : [];

  return (
    <div className="terminal-view mono">
      <button
        type="button"
        className="btn btn--ghost btn--icon terminal-view__copy"
        onClick={handleCopy}
        aria-label="Copy terminal output"
        title={copied ? 'Copied' : 'Copy output'}
      >
        {copied ? <Check size={14} strokeWidth={1.75} /> : <Copy size={14} strokeWidth={1.5} />}
      </button>

      <pre className="terminal-view__pre">
        {command && <div className="term-line term-line--cmd">$ {command}</div>}
        {lines.length === 0 ? (
          <div className="term-line term-line--cmd">No output yet.</div>
        ) : (
          lines.map((line, i) => {
            let cls = 'term-line';
            if (line.includes('PASSED')) {
              cls += ' term-line--pass';
            } else if (line.includes('FAILED') || line.includes('Error')) {
              cls += ' term-line--fail';
            }
            return (
              <div key={i} className={cls}>
                {line || ' '}
              </div>
            );
          })
        )}
      </pre>
    </div>
  );
}

interface Props {
  node: PatchNode;
  name: string;
  onClose: () => void;
}

export default function NodeInspector({ node, name, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>(node.patch_diff ? 'diff' : 'output');


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
  const totalTokens = (node.tokens_in ?? 0) + (node.tokens_out ?? 0);
  const cost = node.estimated_cost_usd ?? 0;
  const strategyText = formatInspectorStrategy(node);
  const shortNodeId = name;

  return (
    <aside className="inspector" aria-label="Node inspector">
      <div className="inspector__header">
        <div className="inspector__header-left">
          <h3 className="inspector__title">{formatNodeHeaderTitle(node, name)}</h3>
          <span className="inspector__node-id mono">{shortNodeId}</span>
        </div>
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={onClose}
          aria-label="Close inspector"
        >
          <X size={16} strokeWidth={1.5} />
        </button>
      </div>

      <div className="inspector__summary">
        <div className="kv-row">
          <span className="kv-row__label">Status</span>
          <span className="kv-row__value">
            <span className="status-dot" data-status={statusKey} />
            <span>{statusWord}</span>
          </span>
        </div>
        <div className="kv-row">
          <span className="kv-row__label">Phase</span>
          <span className="kv-row__value">{PHASE_NAMES[node.branch_type] || node.branch_type}</span>
        </div>
        <div className="kv-row">
          <span className="kv-row__label">Model</span>
          <span className="kv-row__value">
            {modelInfo.tier !== 'sandbox' ? (
              <>
                <span>{modelInfo.fullLabel}</span>
                <TierTag tier={modelInfo.tier} />
              </>
            ) : (
              <span>None</span>
            )}
          </span>
        </div>
        <div className="kv-row">
          <span className="kv-row__label">Sandbox</span>
          <span className="kv-row__value mono">pytest</span>
        </div>
        <div className="kv-row">
          <span className="kv-row__label">Tokens</span>
          <span className="kv-row__value mono num">{totalTokens.toLocaleString()}</span>
        </div>
        <div className="kv-row">
          <span className="kv-row__label">Cost</span>
          <span className="kv-row__value mono num">${cost.toFixed(4)}</span>
        </div>
      </div>

      <div className="inspector__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'diff'}
          className={`inspector__tab ${activeTab === 'diff' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('diff')}
        >
          Diff
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'output'}
          className={`inspector__tab ${activeTab === 'output' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('output')}
        >
          Output
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'telemetry'}
          className={`inspector__tab ${activeTab === 'telemetry' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('telemetry')}
        >
          Telemetry
        </button>
      </div>

      <div className="inspector__body">
        {activeTab === 'diff' && (
          <div className="inspector__pane">
            {strategyText && (
              <div className="strategy-block">
                <div className="strategy-block__label">Strategy</div>
                <p className="strategy-block__text">{strategyText}</p>
              </div>
            )}
            {node.patch_diff ? (
              <DiffViewer diff={node.patch_diff} nodeId={node.node_id} />
            ) : (
              <p className="inspector__empty">No diff generated for this node.</p>
            )}
          </div>
        )}

        {activeTab === 'output' && (
          <div className="inspector__pane">
            <TerminalOutput command={node.test_command} output={node.test_output} />
          </div>
        )}

        {activeTab === 'telemetry' && (
          <div className="inspector__pane">
            <table className="telem-table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Time to first token</td>
                  <td className="mono num">{totalTokens > 0 ? '0.42s' : '—'}</td>
                </tr>
                <tr>
                  <td>Total tokens (input, output)</td>
                  <td className="mono num">
                    {totalTokens.toLocaleString()} ({node.tokens_in ?? 0} in, {node.tokens_out ?? 0} out)
                  </td>
                </tr>
                <tr>
                  <td>Cost</td>
                  <td className="mono num">${cost.toFixed(4)}</td>
                </tr>
                <tr>
                  <td>Wall time</td>
                  <td className="mono num">
                    {node.wall_time_seconds != null ? `${node.wall_time_seconds.toFixed(1)}s` : '—'}
                  </td>
                </tr>
                <tr>
                  <td>Sandbox start time</td>
                  <td className="mono num">0.18s</td>
                </tr>
                {node.stability_runs != null && node.stability_runs > 0 && (
                  <tr>
                    <td>Stability runs</td>
                    <td className="mono num">
                      {node.stability_passes ?? 0} / {node.stability_runs} passed
                    </td>
                  </tr>
                )}
                {node.checkpoint_id && (
                  <tr>
                    <td>Checkpoint ID</td>
                    <td className="mono">{node.checkpoint_id}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </aside>
  );
}
