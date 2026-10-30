import { useState, useEffect } from 'react';
import { X, Cpu, DollarSign, Copy, Check, FileCode, Terminal, Activity } from 'lucide-react';
import type { PatchNode } from '../types';
import DiffViewer from './DiffViewer';

const STRATEGY_DESCRIPTIONS: Record<string, string> = {
  generate_patch_minimal: 'Strategy 1 (Minimal Surgical Fix) — Targets the exact crash site with the smallest localized 1–5 line change.',
  generate_patch_alternative: 'Strategy 2 (Defensive & Boundary Guard) — Introduces input validation, boundary guards, or state normalization.',
  generate_patch_root_cause: 'Strategy 3 (Upstream Root-Cause Fix) — Traces data flow backward into producer functions and caller state.',
  generate_patch_test_driven: 'Strategy 4 (Test-Contract Compliance) — Aligns return values, exception contracts, and edge cases with test assertions.',
};

function formatInspectorHypothesis(node: PatchNode): string {
  const raw = (node.hypothesis || '').trim();
  if (!raw) {
    if (node.branch_type === 'root') return `Initial bug reproduction checkpoint executing \`${node.test_command || 'pytest'}\` on clean repository state.`;
    if (node.branch_type === 'stability') return `Determinism verification fork: re-running \`${node.test_command || 'pytest'}\` in an isolated Contree snapshot to rule out flakiness.`;
    if (node.branch_type === 'full_suite') return `Full regression suite execution (\`${node.test_command || 'pytest'}\`) verifying no collateral breakage.`;
    return '';
  }
  const jobMatch = raw.match(/^(generate_patch_\w+):\s*(.*)$/s);
  if (jobMatch) {
    const [, job, rest] = jobMatch;
    const desc = STRATEGY_DESCRIPTIONS[job] || job;
    const firstLine = rest.split('\n')[0].trim();
    if (firstLine && !firstLine.startsWith('---') && !firstLine.startsWith('+++') && !firstLine.startsWith('@@')) {
      return `${desc}\n\nSummary: ${firstLine}`;
    }
    return desc;
  }
  const advMatch = raw.match(/^adversarial fork\s*(\d+):\s*(.*)$/i);
  if (advMatch) {
    const [, forkNum, rest] = advMatch;
    const fnMatch = (node.patch_diff || rest).match(/def\s+(test_[a-zA-Z0-9_]+)/);
    const fnLabel = fnMatch ? `\`${fnMatch[1]}\`` : 'synthesized boundary & edge-case pytest';
    return `Adversarial red-team fork ${forkNum} — executes ${fnLabel} in an isolated Contree snapshot to stress-test the winning patch.`;
  }
  return raw;
}

const BRANCH_LABELS: Record<string, string> = {
  root: 'Root', search: 'Search', stability: 'Stability',
  adversarial: 'Adversarial', full_suite: 'Full Suite',
};
const BRANCH_COLORS: Record<string, string> = {
  root: '#6366f1', search: '#3b82f6', stability: '#10b981',
  adversarial: '#f59e0b', full_suite: '#8b5cf6',
};
const MODEL_SHORT: Record<string, string> = {
  'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B': 'Nano 30B',
  'nvidia/nemotron-3-super-120b-a12b': 'Super 120B',
  'nvidia/Nemotron-Super-70B': 'Super 120B',
  'nvidia/Nemotron-3-Ultra-550b-a55b': 'Ultra 550B',
  'nvidia/Nemotron-Ultra-253B': 'Ultra 550B',
  'none': 'None',
};

type Tab = 'diff' | 'output' | 'telemetry';

function FormattedTerminal({ output }: { output: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const lines = output.split('\n');

  return (
    <div className="terminal-card">
      <div className="terminal-card__header">
        <span className="terminal-card__title">Terminal Output ({lines.length} lines)</span>
        <button className="btn-copy" onClick={handleCopy} title="Copy terminal output to clipboard">
          {copied ? <Check size={12} className="text-pass" /> : <Copy size={12} />}
          <span>{copied ? 'Copied!' : 'Copy Output'}</span>
        </button>
      </div>
      <pre className="terminal-card__body">
        {lines.map((line, i) => {
          let cls = 'term-line';
          if (line.includes('FAILED') || line.includes('ERROR') || line.includes('AssertionError') || line.includes('Traceback')) {
            cls += ' term-line--fail';
          } else if (line.includes('PASSED') || line.includes('passed in') || line.includes('== 1 passed')) {
            cls += ' term-line--pass';
          } else if (line.includes('WARNING') || line.includes('warning') || line.includes('demoted')) {
            cls += ' term-line--warn';
          } else if (line.trim().startsWith('tests/') || line.trim().startsWith('src/') || line.trim().startsWith('File ')) {
            cls += ' term-line--path';
          }
          return (
            <div key={i} className={cls}>
              {line || ' '}
            </div>
          );
        })}
      </pre>
    </div>
  );
}

interface Props {
  node: PatchNode;
  onClose: () => void;
}

export default function NodeInspector({ node, onClose }: Props) {
  // Default to diff if present, else output; sync when user selects a different node
  const [activeTab, setActiveTab] = useState<Tab>(node.patch_diff ? 'diff' : 'output');
  useEffect(() => {
    setActiveTab(node.patch_diff ? 'diff' : 'output');
  }, [node.node_id, node.patch_diff]);
  const color = BRANCH_COLORS[node.branch_type] ?? '#6b7280';
  const modelLabel = MODEL_SHORT[node.model_used] ?? node.model_used;
  const formattedHyp = formatInspectorHypothesis(node);

  return (
    <aside className="inspector">
      <div className="inspector__header" style={{ borderTopColor: color }}>
        <div className="inspector__header-left">
          <h3 className="inspector__title">{BRANCH_LABELS[node.branch_type]} Node</h3>
          <span className="inspector__node-id">{node.node_id.slice(0, 8)}</span>
        </div>
        <button className="inspector__close" onClick={onClose}><X size={16} /></button>
      </div>

      {/* Overview Meta Strip */}
      <div className="inspector__meta-strip">
        <div className="inspector__meta-item">
          <span className="inspector__label">Status</span>
          {!node.test_result || node.status === 'pending' || node.status === 'running' ? (
            <span className="pnode__badge pnode__badge--running">⟳ RUNNING</span>
          ) : node.test_result === 'pass' ? (
            <span className="pnode__badge pnode__badge--pass">✓ PASS</span>
          ) : node.test_result === 'fail' ? (
            <span className="pnode__badge pnode__badge--fail">✗ FAIL</span>
          ) : (
            <span className="pnode__badge pnode__badge--error">⚠ {node.test_result.toUpperCase()}</span>
          )}
        </div>

        <div className="inspector__meta-item">
          <span className="inspector__label">Branch</span>
          <span className="inspector__pill" style={{ background: color + '22', color }}>
            {BRANCH_LABELS[node.branch_type]}
          </span>
        </div>

        {node.model_used && node.model_used !== 'none' && (
          <div className="inspector__meta-item">
            <span className="inspector__label">Model</span>
            <span className="inspector__value"><Cpu size={11} style={{ marginRight: 3 }} />{modelLabel}</span>
          </div>
        )}
      </div>

      {/* Tab Navigation */}
      <div className="inspector__tabs">
        <button
          className={`inspector__tab ${activeTab === 'diff' ? 'inspector__tab--active' : ''}`}
          onClick={() => setActiveTab('diff')}
        >
          <FileCode size={13} />
          <span>{node.branch_type === 'adversarial' ? 'Adversarial Test Code' : 'Unified Diff'}</span>
        </button>
        <button
          className={`inspector__tab ${activeTab === 'output' ? 'inspector__tab--active' : ''}`}
          onClick={() => setActiveTab('output')}
        >
          <Terminal size={13} />
          <span>Pytest Output</span>
        </button>
        <button
          className={`inspector__tab ${activeTab === 'telemetry' ? 'inspector__tab--active' : ''}`}
          onClick={() => setActiveTab('telemetry')}
        >
          <Activity size={13} />
          <span>Telemetry</span>
        </button>
      </div>

      <div className="inspector__body">
        {activeTab === 'diff' && (
          <div className="inspector__tab-pane">
            {formattedHyp && (
              <div className="inspector__section">
                <div className="inspector__label">
                  {node.branch_type === 'adversarial' ? 'Adversarial Attack Strategy' : 'Hypothesis & Repair Strategy'}
                </div>
                <p className="inspector__text" style={{ whiteSpace: 'pre-line' }}>{formattedHyp}</p>
              </div>
            )}
            {node.branch_type === 'adversarial' && node.patch_diff ? (
              <div className="terminal-card">
                <div className="terminal-card__header">
                  <span className="terminal-card__title">Generated Adversarial Attack (pytest)</span>
                  <span className="pnode__badge pnode__badge--fail" style={{ fontSize: '0.65rem' }}>Attack Vector</span>
                </div>
                <pre className="terminal-card__body diff-viewer" style={{ color: '#e2e8f0', background: '#020617', padding: '10px 12px' }}>
                  {node.patch_diff}
                </pre>
              </div>
            ) : node.patch_diff ? (
              <DiffViewer diff={node.patch_diff} nodeId={node.node_id} />
            ) : (
              <p className="inspector__empty">No patch diff associated with this node (root or reproduction checkpoint).</p>
            )}
          </div>
        )}

        {activeTab === 'output' && (
          <div className="inspector__tab-pane">
            {node.test_command && (
              <div className="inspector__section">
                <div className="inspector__label">Test Command Executed</div>
                <code className="inspector__cmd">{node.test_command}</code>
              </div>
            )}
            {node.test_output ? (
              <FormattedTerminal output={node.test_output} />
            ) : (
              <p className="inspector__empty">No terminal output recorded.</p>
            )}
          </div>
        )}

        {activeTab === 'telemetry' && (
          <div className="inspector__tab-pane">
            <div className="telemetry-grid">
              <div className="telemetry-card">
                <span className="telemetry-card__label">Input Tokens</span>
                <span className="telemetry-card__val">{node.tokens_in ?? 0}</span>
              </div>
              <div className="telemetry-card">
                <span className="telemetry-card__label">Output Tokens</span>
                <span className="telemetry-card__val">{node.tokens_out ?? 0}</span>
              </div>
              <div className="telemetry-card">
                <span className="telemetry-card__label">Estimated Cost</span>
                <span className="telemetry-card__val text-cost">
                  <DollarSign size={12} style={{ display: 'inline', marginRight: 2 }} />
                  {(node.estimated_cost_usd ?? 0).toFixed(4)}
                </span>
              </div>
              <div className="telemetry-card">
                <span className="telemetry-card__label">Total Tokens</span>
                <span className="telemetry-card__val">
                  {((node.tokens_in ?? 0) + (node.tokens_out ?? 0)).toLocaleString()}
                </span>
              </div>
            </div>

            {node.stability_runs != null && node.stability_runs > 0 && (
              <div className="inspector__stab" style={{ marginTop: '12px' }}>
                Stability Forensics: <strong>{node.stability_passes}/{node.stability_runs}</strong> sandbox forks passed
              </div>
            )}

            {node.checkpoint_id && (
              <div className="inspector__section" style={{ marginTop: '12px' }}>
                <div className="inspector__label">Contree Checkpoint ID</div>
                <code className="inspector__cmd">{node.checkpoint_id}</code>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
