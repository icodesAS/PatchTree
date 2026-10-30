import { Fragment, useState } from 'react'
import {
  GitBranch, Zap, DollarSign, Clock, Percent, History, Shield, Plus,
  X, Check, ChevronRight, Copy,
} from 'lucide-react'

/* ---------- types ---------- */
// Only the fields TopBar reads. Your real Run type just needs to include them.
// repo_url and test_command are placeholders: rename to whatever your run object calls them.
export interface TopBarRun {
  status: string
  total_cost_usd?: number | null
  total_wall_time_seconds?: number | null
  confidence_score?: number | null
  confidence_report?: unknown
  repo_url?: string | null          // e.g. "https://github.com/icodesAS/PatchTree"
  test_command?: string | null      // e.g. "pytest Backend/tests/test_contree.py"
  target_test?: string | null
}

export interface Stage { label: string }   // e.g. "Search (4 branches)"

type RunState = 'idle' | 'running' | 'complete' | 'failed'
type StepState = 'done' | 'active' | 'failed' | 'todo'

interface TopBarProps {
  backendOnline: boolean
  loading: boolean
  run: TopBarRun | null
  elapsed: number                   // seconds, live while loading
  stages: Stage[]
  currentStage: number              // 0-based index of the stage that is running now
  hasNodes: boolean                 // patchNodes.length > 0
  onHome: () => void
  onHistory: () => void
  onReport: () => void
  onNewRun: () => void
}

/* ---------- helpers ---------- */
function stepState(i: number, current: number, run: RunState): StepState {
  if (run === 'complete') return 'done'
  if (i < current) return 'done'
  if (i === current) return run === 'failed' ? 'failed' : run === 'running' ? 'active' : 'todo'
  return 'todo'
}

const fmtTime = (s: number) =>
  s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${s.toFixed(1)}s`

/* ---------- repo + test breadcrumb ---------- */
function RepoCrumb({ repoUrl, testCommand }: { repoUrl?: string | null; testCommand?: string | null }) {
  const [copied, setCopied] = useState(false)
  if (!repoUrl && !testCommand) return null

  const repo = (repoUrl ?? '').replace(/^https?:\/\//, '').replace(/\.git$/, '').replace(/\/$/, '')
  const copy = async () => {
    if (!testCommand) return
    try {
      await navigator.clipboard.writeText(testCommand)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch { /* clipboard blocked: ignore */ }
  }

  return (
    <button
      className="hud-crumb"
      onClick={copy}
      title={`${repo}${testCommand ? `  ›  ${testCommand}` : ''}\nClick to copy the test command`}
    >
      <GitBranch size={13} className="hud-crumb__icon" />
      {repo && <span className="hud-crumb__repo">{repo}</span>}
      {repo && testCommand && <ChevronRight size={12} className="hud-crumb__sep" />}
      {testCommand && (
        <span className="hud-crumb__cmd">
          <span className="hud-crumb__prompt">$</span>{testCommand}
        </span>
      )}
      <span className="hud-crumb__copy" data-copied={copied}>
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </span>
    </button>
  )
}

/* ---------- pipeline ribbon ---------- */
function PipelineRibbon({ stages, currentStage, state }: { stages: Stage[]; currentStage: number; state: RunState }) {
  return (
    <nav className="hud-ribbon" aria-label="Pipeline progress">
      {stages.map((s, i) => {
        const st = stepState(i, currentStage, state)
        const prev = i > 0 ? stepState(i - 1, currentStage, state) : 'done'
        const linkState = prev === 'done' ? (st === 'done' ? 'done' : st === 'todo' ? 'todo' : 'active') : 'todo'

        // "Search (4 branches)"  ->  name "Search", meta "4 branches"
        const m = s.label.match(/^(.*?)\s*\((.*)\)\s*$/)
        const name = m ? m[1] : s.label
        const meta = m ? m[2] : null

        return (
          <Fragment key={i}>
            {i > 0 && <span className="hud-link" data-state={linkState} />}
            <span className="hud-step" data-state={st} aria-current={st === 'active' ? 'step' : undefined}>
              <span className="hud-step__ico">
                {st === 'done' ? <Check size={11} strokeWidth={3} />
                  : st === 'failed' ? <X size={11} strokeWidth={3} />
                  : st === 'active' ? <span className="hud-step__pulse" />
                  : <span className="hud-step__num">{i + 1}</span>}
              </span>
              <span className="hud-step__name">{name}</span>
              {meta && <span className="hud-step__meta">{meta}</span>}
            </span>
          </Fragment>
        )
      })}
    </nav>
  )
}

/* ---------- the bar ---------- */
export default function TopBar({
  backendOnline: _backendOnline, loading, run, elapsed, stages, currentStage, hasNodes,
  onHome, onHistory, onReport, onNewRun,
}: TopBarProps) {
  const state: RunState =
    loading ? 'running' : run?.status === 'complete' ? 'complete' : run?.status === 'failed' ? 'failed' : 'idle'

  const secs = loading ? elapsed : run?.total_wall_time_seconds
  const conf = run?.confidence_score != null
    ? Math.round(run.confidence_score <= 1 ? run.confidence_score * 100 : run.confidence_score)
    : null
  const statusText = (loading ? 'running' : run?.status ?? '').toUpperCase()
  const showRibbon = loading || (!!run && hasNodes)
  const canReport = !!run && (!!run.confidence_report || run.status === 'complete' || run.status === 'failed')

  return (
    <header className="hud" data-run={state}>
      {/* brand */}
      <button className="hud-brand" onClick={onHome} aria-label="PatchTree home">
        <GitBranch size={20} className="hud-brand__mark" />
        <span className="hud-brand__name">PatchTree</span>
      </button>

      {/* repo + test */}
      {run && <RepoCrumb repoUrl={run.repo_url} testCommand={run.test_command || run.target_test} />}

      {/* telemetry */}
      {run && (
        <div className="hud-telem">
          <span className="hud-pill" data-tone={state}>
            {state === 'running' ? <span className="hud-beacon" /> : <Zap size={13} />}
            {statusText}
          </span>
          {run.total_cost_usd != null && (
            <span className="hud-pill"><DollarSign size={13} />
              <span key={run.total_cost_usd} className={`hud-num ${loading ? 'is-changing' : ''}`}>
                {run.total_cost_usd.toFixed(4)}
              </span>
            </span>
          )}
          {secs != null && (
            <span className="hud-pill"><Clock size={13} /><span className="hud-num">{fmtTime(secs)}</span></span>
          )}
          {conf != null && (
            <span className="hud-pill" data-tone="confidence"><Percent size={13} /><span className="hud-num">{conf}%</span></span>
          )}
        </div>
      )}

      {/* actions */}
      <div className="hud-actions">
        <button className="hud-btn" onClick={onHistory}>
          <History size={14} /><span className="hud-btn__label">History</span>
        </button>
        {canReport && (
          <button className="hud-btn" data-variant="ghost" onClick={onReport}>
            <Shield size={14} /><span className="hud-btn__label">View Report</span>
          </button>
        )}
        {hasNodes && (
          <button className="hud-btn" data-variant="ghost" onClick={onHome}>
            <X size={14} /><span className="hud-btn__label">Close Run</span>
          </button>
        )}
        <button className="hud-btn" data-variant="primary" onClick={onNewRun} disabled={loading}>
          <Plus size={14} /><span className="hud-btn__label">New Run</span>
        </button>
      </div>

      {/* pipeline */}
      {showRibbon && <PipelineRibbon stages={stages} currentStage={currentStage} state={state} />}
    </header>
  )
}
