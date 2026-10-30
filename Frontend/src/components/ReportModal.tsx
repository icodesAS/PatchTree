import { useState, useEffect } from 'react';
import { X, Copy, Check, Download } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { PatchNode, Run } from '../types';
import { getRun } from '../api';
import DiffViewer from './DiffViewer';

interface Props {
  run: Run;
  nodes?: PatchNode[];
  onClose: () => void;
}

export default function ReportModal({ run: initialRun, nodes = [], onClose }: Props) {
  const [run, setRun] = useState<Run>(initialRun);
  const [copiedDiff, setCopiedDiff] = useState(false);

  useEffect(() => {
    if (!run.confidence_report && run.run_id && !run.run_id.startsWith('demo-') && !run.run_id.startsWith('mock-')) {
      getRun(run.run_id)
        .then((fresh) => {
          if (fresh && fresh.confidence_report) setRun(fresh);
        })
        .catch(() => {});
    }
  }, [run.run_id, run.confidence_report]);

  const rawScore = run.confidence_score ?? 0;
  const score = Math.round(rawScore <= 1 ? rawScore * 100 : rawScore);

  const winnerNode = nodes.find((n) => n.node_id === run.winner_node_id) ?? null;
  const adversarialNodes = nodes.filter((n) => n.branch_type === 'adversarial');
  const stabilityNodes = nodes.filter((n) => n.branch_type === 'stability');
  const stabPassed = stabilityNodes.filter((n) => n.test_result === 'pass').length;
  const stabTotal = stabilityNodes.length || 5;

  const ownerRepo = (run.repo_url ?? '')
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/^https?:\/\//i, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');

  const handleCopyDiff = async () => {
    const text = winnerNode?.patch_diff || run.confidence_report || '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedDiff(true);
      setTimeout(() => setCopiedDiff(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const handleDownloadPatch = () => {
    const patchContent = winnerNode?.patch_diff || run.confidence_report || '';
    const filename = winnerNode?.patch_diff
      ? `patch-${run.run_id.slice(0, 8)}.patch`
      : `report-${run.run_id.slice(0, 8)}.md`;
    const blob = new Blob([patchContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const statusTone = run.status === 'complete' ? 'pass' : run.status === 'failed' ? 'fail' : 'running';
  const statusWord = run.status === 'complete' ? 'Complete' : run.status === 'failed' ? 'Failed' : 'Running';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal modal--report"
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="report-view">
          <div className="report-view__top">
            <div>
              <h2 id="report-modal-title" className="report-view__title">
                Run report
              </h2>
              <div className="report-view__sub">
                <span>{ownerRepo || 'repository'}</span>
                <span className="report-view__sep">·</span>
                <span className="mono">{run.run_id}</span>
              </div>
            </div>

            <div className="report-view__actions">
              {(winnerNode?.patch_diff || run.confidence_report) && (
                <>
                  <button type="button" className="btn btn--secondary" onClick={handleCopyDiff}>
                    {copiedDiff ? <Check size={14} strokeWidth={1.75} /> : <Copy size={14} strokeWidth={1.5} />}
                    <span>{copiedDiff ? 'Copied' : 'Copy diff'}</span>
                  </button>
                  <button type="button" className="btn btn--primary" onClick={handleDownloadPatch}>
                    <Download size={14} strokeWidth={1.5} />
                    <span>Download .patch</span>
                  </button>
                </>
              )}
              <button
                type="button"
                className="btn btn--ghost btn--icon"
                onClick={onClose}
                aria-label="Close report"
              >
                <X size={16} strokeWidth={1.5} />
              </button>
            </div>
          </div>

          <section className="report-section">
            <h3 className="section-title">Summary</h3>
            <div className="report-kv-box">
              <div className="kv-row">
                <span className="kv-row__label">Result</span>
                <span className="kv-row__value">
                  <span className="status-dot" data-status={statusTone} />
                  <span>{statusWord}</span>
                </span>
              </div>
              <div className="kv-row">
                <span className="kv-row__label">Winning patch</span>
                <span className="kv-row__value mono">
                  {run.winner_node_id ? run.winner_node_id.replace(/-0+(\d+)$/, '-$1').slice(0, 12) : 'None'}
                </span>
              </div>
              <div className="kv-row">
                <span className="kv-row__label">Stability</span>
                <span className="kv-row__value num">
                  {score}% stable ({stabPassed}/{stabTotal} runs)
                </span>
              </div>
              <div className="kv-row">
                <span className="kv-row__label">Adversarial attacks survived</span>
                <span className="kv-row__value mono num">
                  {run.adversarial_survived ?? 0} / {run.adversarial_runs ?? 0}
                </span>
              </div>
              <div className="kv-row">
                <span className="kv-row__label">Full suite</span>
                <span className="kv-row__value">
                  {run.full_suite_result === 'pass'
                    ? 'Passed'
                    : run.full_suite_result === 'fail'
                    ? 'Failed'
                    : 'Skipped'}
                </span>
              </div>
              <div className="kv-row">
                <span className="kv-row__label">Total cost</span>
                <span className="kv-row__value mono num">${(run.total_cost_usd ?? 0).toFixed(4)}</span>
              </div>
              <div className="kv-row">
                <span className="kv-row__label">Total time</span>
                <span className="kv-row__value mono num">{(run.total_wall_time_seconds ?? 0).toFixed(1)}s</span>
              </div>
            </div>
          </section>

          {winnerNode?.patch_diff && (
            <section className="report-section">
              <h3 className="section-title">Winning diff</h3>
              <DiffViewer diff={winnerNode.patch_diff} nodeId={winnerNode.node_id} />
            </section>
          )}

          {adversarialNodes.length > 0 && (
            <section className="report-section">
              <h3 className="section-title">Adversarial attacks</h3>
              <div className="examples-list">
                {adversarialNodes.map((adv, idx) => {
                  const survived = adv.test_result === 'pass';
                  return (
                    <div key={adv.node_id} className="attack-row">
                      <span className="attack-row__name">
                        {adv.hypothesis || `Adversarial probe ${idx + 1}`}
                      </span>
                      <span
                        className="attack-row__result"
                        data-status={survived ? 'pass' : 'fail'}
                      >
                        <span className="status-dot" data-status={survived ? 'pass' : 'fail'} />
                        <span>{survived ? 'Survived' : 'Broke patch'}</span>
                      </span>
                      <span className="attack-row__cost mono num">
                        ${(adv.estimated_cost_usd ?? 0).toFixed(4)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {run.confidence_report && (
            <section className="report-section">
              <h3 className="section-title">Analysis</h3>
              <div className="md-report">
                <ReactMarkdown>{run.confidence_report}</ReactMarkdown>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
