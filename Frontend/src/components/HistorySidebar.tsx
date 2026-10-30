import { useState, useEffect, useCallback, useMemo } from 'react';
import { X, RotateCw } from 'lucide-react';
import type { Run } from '../types';
import { listRuns } from '../api';
import { mockData } from '../mockData';

interface Props {
  currentRunId?: string | null;
  clientId?: string;
  onSelectRun: (runId: string) => void;
  onClose: () => void;
}

export default function HistorySidebar({ currentRunId, clientId, onSelectRun, onClose }: Props) {
  const [runs, setRuns] = useState<Run[]>([mockData.run]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'my'>('all');

  const fetchRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listRuns();
      data.sort((a, b) => {
        const da = a.created_at ? new Date(a.created_at).getTime() : 0;
        const db = b.created_at ? new Date(b.created_at).getTime() : 0;
        return db - da;
      });
      const withoutMock = data.filter((r) => r.run_id !== mockData.run.run_id);
      setRuns([mockData.run, ...withoutMock]);
    } catch {
      setRuns([mockData.run]);
      setError('Could not reach the backend. Check that it is running and try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      if (active) await fetchRuns();
    })();
    return () => {
      active = false;
    };
  }, [fetchRuns]);

  const myRunsCount = useMemo(() => {
    if (!clientId) return 0;
    return runs.filter((r) => r.client_id === clientId).length;
  }, [runs, clientId]);

  const displayedRuns = useMemo(() => {
    if (filter === 'my' && clientId) {
      return runs.filter((r) => r.client_id === clientId);
    }
    return runs;
  }, [runs, filter, clientId]);

  return (
    <div className="history-overlay" onClick={onClose}>
      <aside className="history-sidebar" aria-label="Run history" onClick={(e) => e.stopPropagation()}>
        <div className="history-sidebar__header">
          <h3 className="history-sidebar__title">History</h3>
          <div className="history-sidebar__actions">
            <button
              type="button"
              className="btn btn--ghost btn--icon"
              onClick={fetchRuns}
              aria-label="Refresh runs"
              title="Refresh runs"
              disabled={loading}
            >
              <RotateCw size={14} strokeWidth={1.5} className={loading ? 'spin' : ''} />
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--icon"
              onClick={onClose}
              aria-label="Close history"
              title="Close history"
            >
              <X size={16} strokeWidth={1.5} />
            </button>
          </div>
        </div>

        <div className="inspector__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'all'}
            className={`inspector__tab ${filter === 'all' ? 'is-active' : ''}`}
            onClick={() => setFilter('all')}
          >
            All runs ({runs.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'my'}
            className={`inspector__tab ${filter === 'my' ? 'is-active' : ''}`}
            onClick={() => setFilter('my')}
          >
            This browser ({myRunsCount})
          </button>
        </div>

        <div className="history-sidebar__body">
          {error && (
            <div className="history-error">
              <p>{error}</p>
              <button type="button" className="btn btn--secondary btn--sm" onClick={fetchRuns}>
                Try again
              </button>
            </div>
          )}

          {displayedRuns.length === 0 ? (
            <div className="history-empty">
              <p className="history-empty__title">No runs yet.</p>
              <p className="history-empty__sub">Load an example to see a full run.</p>
            </div>
          ) : (
            <div className="history-list" role="list">
              {displayedRuns.map((r: Run) => {
                const isActive = r.run_id === currentRunId;
                const score =
                  r.confidence_score != null
                    ? Math.round(r.confidence_score <= 1 ? r.confidence_score * 100 : r.confidence_score)
                    : null;
                const repoShort =
                  (r.repo_url ?? '')
                    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
                    .replace(/\.git$/, '')
                    .replace(/\/$/, '') || 'repository';
                const statusTone =
                  r.status === 'complete' ? 'pass' : r.status === 'failed' ? 'fail' : 'running';
                const statusWord =
                  r.status === 'complete' ? 'Complete' : r.status === 'failed' ? 'Failed' : 'Running';

                return (
                  <button
                    key={r.run_id}
                    type="button"
                    className={`history-row ${isActive ? 'is-active' : ''}`}
                    onClick={() => {
                      onSelectRun(r.run_id);
                      onClose();
                    }}
                  >
                    <div className="history-row__top">
                      <span className="history-row__repo" title={r.repo_url}>
                        {repoShort}
                      </span>
                      <span className="history-row__status">
                        <span className="status-dot" data-status={statusTone} />
                        <span>{statusWord}</span>
                      </span>
                    </div>

                    <p className="history-row__desc" title={r.bug_description}>
                      {r.bug_description || 'No description'}
                    </p>

                    <div className="history-row__meta mono num">
                      <span>${(r.total_cost_usd ?? 0).toFixed(4)}</span>
                      <span>{(r.total_wall_time_seconds ?? 0).toFixed(1)}s</span>
                      {score != null && <span>{score}% stable</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
