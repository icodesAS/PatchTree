import { useState, useEffect } from 'react';
import { X, Shield, Clock, DollarSign, Percent, Copy, Check, Download, AlertTriangle, CheckCircle, XCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { Run } from '../types';
import { getRun } from '../api';

interface Props {
  run: Run;
  onClose: () => void;
}

function ScoreGauge({ score }: { score: number }) {
  const pct = Math.min(100, Math.max(0, score));
  const isHigh = pct >= 80;
  const isMid = pct >= 50 && pct < 80;

  const colorStart = isHigh ? '#10b981' : isMid ? '#f59e0b' : '#ef4444';
  const colorEnd = isHigh ? '#34d399' : isMid ? '#fbbf24' : '#f87171';
  const glowColor = isHigh ? 'rgba(16, 185, 129, 0.45)' : isMid ? 'rgba(245, 158, 11, 0.45)' : 'rgba(239, 68, 68, 0.45)';

  const r = 42;
  const circ = 2 * Math.PI * r;
  const strokeOffset = circ - (pct / 100) * circ;

  return (
    <div className="gauge-wrap">
      <div className="gauge" style={{ filter: `drop-shadow(0 0 16px ${glowColor})` }}>
        <svg width="124" height="124" viewBox="0 0 124 124">
          <defs>
            <linearGradient id="scoreGaugeGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor={colorStart} />
              <stop offset="100%" stopColor={colorEnd} />
            </linearGradient>
          </defs>
          {/* Background track circle */}
          <circle
            cx="62"
            cy="62"
            r={r}
            fill="none"
            stroke="rgba(30, 41, 59, 0.7)"
            strokeWidth="10"
          />
          {/* Animated score ring */}
          <circle
            cx="62"
            cy="62"
            r={r}
            fill="none"
            stroke="url(#scoreGaugeGrad)"
            strokeWidth="10"
            strokeDasharray={circ}
            strokeDashoffset={strokeOffset}
            strokeLinecap="round"
            transform="rotate(-90 62 62)"
            className="gauge-circle-progress"
          />
          {/* Centered Percentage */}
          <text
            x="62"
            y="58"
            textAnchor="middle"
            fill="#f8fafc"
            fontSize="24"
            fontWeight="800"
            fontFamily="monospace"
            letterSpacing="-0.03em"
          >
            {pct}%
          </text>
          <text
            x="62"
            y="74"
            textAnchor="middle"
            fill="#94a3b8"
            fontSize="9"
            fontWeight="700"
            letterSpacing="0.08em"
          >
            CONFIDENCE
          </text>
        </svg>
      </div>

      <div
        className={`gauge__badge ${
          isHigh ? 'gauge__badge--pass' : isMid ? 'gauge__badge--warn' : 'gauge__badge--fail'
        }`}
      >
        {isHigh ? (
          <>
            <CheckCircle size={13} />
            <span>PRODUCTION-READY</span>
          </>
        ) : isMid ? (
          <>
            <AlertTriangle size={13} />
            <span>REVIEW NEEDED</span>
          </>
        ) : (
          <>
            <XCircle size={13} />
            <span>HONEST FAILURE</span>
          </>
        )}
      </div>
    </div>
  );
}

export default function ReportModal({ run: initialRun, onClose }: Props) {
  const [run, setRun] = useState<Run>(initialRun);
  const [copiedReport, setCopiedReport] = useState(false);

  useEffect(() => {
    if (!run.confidence_report && run.run_id && !run.run_id.startsWith('mock-')) {
      getRun(run.run_id)
        .then((fresh) => {
          if (fresh && fresh.confidence_report) setRun(fresh);
        })
        .catch(() => {});
    }
  }, [run.run_id, run.confidence_report]);

  const rawScore = run.confidence_score ?? 0;
  const score = Math.round(rawScore <= 1 ? rawScore * 100 : rawScore);

  const handleCopyReport = () => {
    if (!run.confidence_report) return;
    navigator.clipboard.writeText(run.confidence_report);
    setCopiedReport(true);
    setTimeout(() => setCopiedReport(false), 2000);
  };

  const handleDownloadAudit = () => {
    const summaryMd = `# PatchTree Verification Audit Summary
**Run ID:** \`${run.run_id}\`
**Repository:** \`${run.repo_url || 'N/A'}\`
**Status:** \`${run.status.toUpperCase()}\`
**Confidence Score:** **${score}%**
**Target Test:** \`${run.target_test || 'N/A'}\`
**Full Suite Result:** \`${run.full_suite_result || 'N/A'}\`
**Adversarial Invariant Probes:** ${run.adversarial_survived ?? 0}/${run.adversarial_runs ?? 0} survived
**Total Compute Cost:** $${(run.total_cost_usd ?? 0).toFixed(4)} USD
**Total Wall Time:** ${(run.total_wall_time_seconds ?? 0).toFixed(1)}s
**Audit Timestamp:** ${run.completed_at || new Date().toISOString()}

---

## Executive Confidence Report

${run.confidence_report || 'No detailed confidence report recorded.'}

---
*Generated autonomously by PatchTree Agent Verification Engine (Nebius Nemotron 550B & Contree Sandbox)*
`;

    const blob = new Blob([summaryMd], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `patchtree-audit-${run.run_id.slice(0, 8)}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal--wide report-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <div className="modal__title-wrap">
            <Shield size={18} className="modal__icon" />
            <div>
              <h2 className="modal__title">Executive Confidence Report</h2>
              <span className="modal__subtitle">
                Autonomous verification audit generated by Nemotron Ultra 550B
              </span>
            </div>
          </div>
          <div className="modal__actions">
            {run.confidence_report && (
              <>
                <button
                  className="btn-copy"
                  onClick={handleCopyReport}
                  title="Copy markdown report to clipboard"
                >
                  {copiedReport ? <Check size={13} className="text-pass" /> : <Copy size={13} />}
                  <span>{copiedReport ? 'Copied!' : 'Copy Markdown Report'}</span>
                </button>
                <button
                  className="btn-copy"
                  onClick={handleDownloadAudit}
                  title="Download complete audit summary markdown file"
                >
                  <Download size={13} />
                  <span>Download Audit Summary</span>
                </button>
              </>
            )}
            <button className="inspector__close" onClick={onClose} title="Close modal">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="report-modal__body">
          <div className="report-modal__sidebar">
            <ScoreGauge score={score} />

            <div className="report-modal__stats">
              {run.confidence_score != null && (
                <div className="telemetry-pill telemetry-pill--highlight">
                  <div className="telemetry-pill__label">Confidence Score</div>
                  <div className="telemetry-pill__val">
                    <Percent size={13} />
                    <span>{score}%</span>
                  </div>
                </div>
              )}

              {run.total_cost_usd != null && (
                <div className="telemetry-pill">
                  <div className="telemetry-pill__label">Compute Cost</div>
                  <div className="telemetry-pill__val text-cost">
                    <DollarSign size={13} />
                    <span>${run.total_cost_usd.toFixed(4)}</span>
                  </div>
                </div>
              )}

              {run.total_wall_time_seconds != null && (
                <div className="telemetry-pill">
                  <div className="telemetry-pill__label">Execution Wall Time</div>
                  <div className="telemetry-pill__val">
                    <Clock size={13} />
                    <span>{run.total_wall_time_seconds.toFixed(1)}s</span>
                  </div>
                </div>
              )}

              {run.adversarial_runs != null && run.adversarial_runs > 0 && (
                <div className="telemetry-pill">
                  <div className="telemetry-pill__label">Adversarial Resistance</div>
                  <div className="telemetry-pill__val text-warn">
                    <Shield size={13} />
                    <span>
                      {run.adversarial_survived}/{run.adversarial_runs} survived
                    </span>
                  </div>
                </div>
              )}

              {run.full_suite_result && (
                <div
                  className={`telemetry-pill ${
                    run.full_suite_result === 'pass'
                      ? 'telemetry-pill--pass'
                      : 'telemetry-pill--fail'
                  }`}
                >
                  <div className="telemetry-pill__label">Full Test Suite</div>
                  <div className="telemetry-pill__val">
                    {run.full_suite_result === 'pass' ? '✓ PASS' : '✗ FAIL'}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="report-modal__content">
            {run.confidence_report ? (
              <div className="md-report">
                <ReactMarkdown>{run.confidence_report}</ReactMarkdown>
              </div>
            ) : (
              <div className="report-modal__empty">
                <Shield size={32} />
                <p>Generating executive confidence report from Nemotron Ultra…</p>
                <span className="text-muted" style={{ fontSize: '0.8rem' }}>
                  Forensics and adversarial verifications are being summarized.
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
