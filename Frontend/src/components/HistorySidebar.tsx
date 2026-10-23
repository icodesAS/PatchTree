import { useState, useEffect, useCallback } from 'react';
import { X, RotateCw, History, GitBranch, Clock, DollarSign, Percent, AlertCircle, Loader } from 'lucide-react';
import type { Run } from '../types';
import { listRuns } from '../api';

interface Props {
  currentRunId?: string | null;
  onSelectRun: (runId: string) => void;
  onClose: () => void;
}

export default function HistorySidebar({ currentRunId, onSelectRun, onClose }: Props) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listRuns();
      // Sort newest first
      data.sort((a, b) => {
        const da = a.created_at ? new Date(a.created_at).getTime() : 0;
        const db = b.created_at ? new Date(b.created_at).getTime() : 0;
        return db - da;
      });
      setRuns(data);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to fetch historic runs';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  const formatTime = (iso?: string) => {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return '';
    }
  };

  return (
    <div className="history-overlay" onClick={onClose}>
      <aside className="history-sidebar" onClick={(e) => e.stopPropagation()}>
        <div className="history-sidebar__header">
          <div className="history-sidebar__title">
            <History size={18} className="history-sidebar__icon" />
            <h3>Run History</h3>
          </div>
          <div className="history-sidebar__actions">
            <button
              className="icon-btn"
              onClick={fetchRuns}
              title="Refresh runs"
              disabled={loading}
            >
              <RotateCw size={14} className={loading ? 'spin' : ''} />
            </button>
            <button className="icon-btn" onClick={onClose} title="Close sidebar">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="history-sidebar__body">
          {loading && runs.length === 0 ? (
            <div className="history-sidebar__state">
              <Loader size={20} className="spin" />
              <span>Fetching runs…</span>
            </div>
          ) : error ? (
            <div className="history-sidebar__state history-sidebar__state--error">
              <AlertCircle size={20} />
              <span>{error}</span>
              <button className="btn btn--secondary btn--sm" onClick={fetchRuns}>Retry</button>
            </div>
          ) : runs.length === 0 ? (
            <div className="history-sidebar__state">
              <GitBranch size={28} />
              <p>No backend runs recorded yet.</p>
              <span className="text-muted" style={{ fontSize: '0.75rem' }}>
                Dispatch a verification run via <strong>+ New Run</strong>.
              </span>
            </div>
          ) : (
            <div className="history-list">
              {runs.map((r: Run) => {
                const isActive = r.run_id === currentRunId;
                const score = r.confidence_score != null
                  ? Math.round(r.confidence_score <= 1 ? r.confidence_score * 100 : r.confidence_score)
                  : null;
                const repoShort = (r.repo_url ?? '').split('/').slice(-2).join('/') || 'repo';

                return (
                  <div
                    key={r.run_id}
                    className={`history-card ${isActive ? 'history-card--active' : ''}`}
                    onClick={() => {
                      onSelectRun(r.run_id);
                      onClose();
                    }}
                  >
                    <div className="history-card__top">
                      <span className="history-card__repo" title={r.repo_url}>
                        {repoShort}
                      </span>
                      <span className={`status-pill status-pill--${r.status}`}>
                        {r.status.toUpperCase()}
                      </span>
                    </div>

                    <p className="history-card__desc" title={r.bug_description}>
                      {r.bug_description || 'No description provided'}
                    </p>

                    <div className="history-card__meta">
                      {score != null && (
                        <span className="history-card__stat history-card__stat--score">
                          <Percent size={11} />
                          {score}%
                        </span>
                      )}
                      {r.total_wall_time_seconds != null && (
                        <span className="history-card__stat">
                          <Clock size={11} />
                          {r.total_wall_time_seconds.toFixed(1)}s
                        </span>
                      )}
                      {r.total_cost_usd != null && (
                        <span className="history-card__stat">
                          <DollarSign size={11} />
                          ${r.total_cost_usd.toFixed(4)}
                        </span>
                      )}
                      {r.created_at && (
                        <span className="history-card__stat history-card__stat--time">
                          {formatTime(r.created_at)}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
