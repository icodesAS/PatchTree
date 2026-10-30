import { Fragment, useState } from 'react';
import Logo from './Logo';
import {
  History,
  FileText,
  Plus,
  X,
  Check,
  CircleX,
  ChevronRight,
  Loader,
} from 'lucide-react';

export interface TopBarRun {
  run_id: string;
  status: string;
  total_cost_usd?: number | null;
  total_wall_time_seconds?: number | null;
  confidence_score?: number | null;
  confidence_report?: unknown;
  repo_url?: string | null;
  target_test?: string | null;
}

export interface Stage {
  id: string;
  label: string;
}

type RunState = 'idle' | 'running' | 'complete' | 'failed';
type StepState = 'done' | 'active' | 'failed' | 'todo';

interface TopBarProps {
  loading: boolean;
  run: TopBarRun | null;
  elapsed: number;
  liveCost?: number;
  stages: Stage[];
  currentStage: number;
  hasNodes: boolean;
  onHome: () => void;
  onHistory: () => void;
  onReport: () => void;
  onNewRun: () => void;
  onSelectPhase?: (phaseId: string) => void;
}

function stepState(i: number, current: number, runState: RunState): StepState {
  if (runState === 'complete') return 'done';
  if (i < current) return 'done';
  if (i === current) return runState === 'failed' ? 'failed' : runState === 'running' ? 'active' : 'todo';
  return 'todo';
}

const fmtTime = (s: number) =>
  s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${s.toFixed(1)}s`;

function RepoBreadcrumb({ repoUrl, runId }: { repoUrl?: string | null; runId?: string }) {
  const [copied, setCopied] = useState(false);
  if (!repoUrl && !runId) return null;

  const ownerRepo = (repoUrl ?? '')
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/^https?:\/\//i, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');

  const handleCopy = async () => {
    if (!repoUrl) return;
    try {
      await navigator.clipboard.writeText(repoUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore clipboard error */
    }
  };

  return (
    <div className="topbar__crumb-wrap">
      <span className="topbar__divider" aria-hidden="true" />
      <button
        type="button"
        className="topbar__crumb-repo"
        onClick={handleCopy}
        title={copied ? 'Copied' : `${repoUrl || ownerRepo} (Click to copy URL)`}
      >
        <span className="topbar__crumb-repo-text">{ownerRepo || 'repository'}</span>
        {copied && <span className="topbar__copied-tag">Copied</span>}
      </button>
      {runId && (
        <>
          <ChevronRight size={12} className="topbar__crumb-sep" />
          <span className="topbar__crumb-id mono">{runId}</span>
        </>
      )}
    </div>
  );
}

function PhaseBar({
  stages,
  currentStage,
  state,
  onSelectPhase,
}: {
  stages: Stage[];
  currentStage: number;
  state: RunState;
  onSelectPhase?: (phaseId: string) => void;
}) {
  return (
    <nav className="phasebar" aria-label="Pipeline progress">
      {stages.map((s, i) => {
        const st = stepState(i, currentStage, state);
        const match = s.label.match(/^(.*?)\s*(\(.*\))\s*$/);
        const name = match ? match[1] : s.label;
        const countPart = match ? match[2] : null;

        return (
          <Fragment key={s.id}>
            {i > 0 && <ChevronRight size={12} className="phasebar__sep" aria-hidden="true" />}
            <button
              type="button"
              className="phasebar__step"
              data-state={st}
              aria-current={st === 'active' ? 'step' : undefined}
              onClick={() => onSelectPhase?.(s.id)}
            >
              <span className="phasebar__icon" aria-hidden="true">
                {st === 'done' ? (
                  <Check size={14} strokeWidth={1.75} />
                ) : st === 'failed' ? (
                  <CircleX size={14} strokeWidth={1.75} />
                ) : st === 'active' ? (
                  <Loader size={14} strokeWidth={1.75} className="spin" />
                ) : (
                  <span className="phasebar__pending-dot" />
                )}
              </span>
              <span className="phasebar__label">
                {name}
                {countPart && <span className="phasebar__count"> {countPart}</span>}
              </span>
            </button>
          </Fragment>
        );
      })}
    </nav>
  );
}

export default function TopBar({
  loading,
  run,
  elapsed,
  liveCost = 0,
  stages,
  currentStage,
  hasNodes,
  onHome,
  onHistory,
  onReport,
  onNewRun,
  onSelectPhase,
}: TopBarProps) {
  const state: RunState = loading
    ? 'running'
    : run?.status === 'complete'
    ? 'complete'
    : run?.status === 'failed'
    ? 'failed'
    : 'idle';

  const secs = loading ? elapsed : run?.total_wall_time_seconds;
  const cost = loading && !run?.total_cost_usd ? liveCost : run?.total_cost_usd;
  const conf =
    run?.confidence_score != null
      ? Math.round(run.confidence_score <= 1 ? run.confidence_score * 100 : run.confidence_score)
      : null;

  const statusLabel =
    state === 'running'
      ? 'Running'
      : state === 'complete'
      ? 'Complete'
      : state === 'failed'
      ? 'Failed'
      : 'Idle';

  const showRibbon = loading || (Boolean(run) && hasNodes);
  const canReport =
    Boolean(run) && (Boolean(run?.confidence_report) || run?.status === 'complete' || run?.status === 'failed');

  return (
    <header className="topbar-shell">
      <div className="topbar">
        <button type="button" className="topbar__brand" onClick={onHome} aria-label="PatchTree home">
          <Logo size={24} />
          <span className="topbar__name">PatchTree</span>
        </button>

        {run && <RepoBreadcrumb repoUrl={run.repo_url} runId={run.run_id} />}

        <div className="topbar__spacer" />

        {run && (
          <div className="topbar__summary" aria-label="Run summary">
            <span className="topbar__status">
              <span className="status-dot" data-status={state === 'complete' ? 'pass' : state === 'failed' ? 'fail' : 'running'} />
              <span className="topbar__status-word">{statusLabel}</span>
            </span>

            {cost != null && (
              <>
                <span className="topbar__divider" aria-hidden="true" />
                <span className="topbar__metric mono num" title="Total model cost">
                  ${cost.toFixed(4)}
                </span>
              </>
            )}

            {secs != null && (
              <>
                <span className="topbar__divider" aria-hidden="true" />
                <span className="topbar__metric mono num" title="Total run time">
                  {fmtTime(secs)}
                </span>
              </>
            )}

            {conf != null && (
              <>
                <span className="topbar__divider" aria-hidden="true" />
                <span
                  className="topbar__metric num"
                  title="Share of repeat runs that passed for the winning patch"
                >
                  {conf}% stable
                </span>
              </>
            )}
          </div>
        )}

        <div className="topbar__actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={onHistory}>
            <History size={15} strokeWidth={1.5} />
            <span>History</span>
          </button>
          {canReport && (
            <button type="button" className="btn btn--secondary btn--sm" onClick={onReport}>
              <FileText size={15} strokeWidth={1.5} />
              <span>View report</span>
            </button>
          )}
          {hasNodes && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={onHome}>
              <X size={15} strokeWidth={1.5} />
              <span>Close run</span>
            </button>
          )}
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={onNewRun}
            disabled={loading}
          >
            <Plus size={15} strokeWidth={1.5} />
            <span>New run</span>
          </button>
        </div>
      </div>

      {showRibbon && (
        <PhaseBar
          stages={stages}
          currentStage={currentStage}
          state={state}
          onSelectPhase={onSelectPhase}
        />
      )}
    </header>
  );
}
