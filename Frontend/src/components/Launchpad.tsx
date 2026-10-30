import { useState, useEffect, type FormEvent } from 'react';
import { GitBranch, ChevronRight } from 'lucide-react';
import type { Run } from '../types';
import { listRuns } from '../api';
import { mockData } from '../mockData';
import { PRESETS, type PresetDef } from '../presets';


const HOW_STEPS = [
  {
    num: 1,
    title: 'Reproduce',
    detail: 'Runs the failing test in a clean cloud VM.',
  },
  {
    num: 2,
    title: 'Search',
    detail: 'Four models propose fixes at the same time.',
  },
  {
    num: 3,
    title: 'Stability',
    detail: 'Runs each passing fix 5 times to catch flaky results.',
  },
  {
    num: 4,
    title: 'Adversarial',
    detail: 'Tries to break the patch before you merge it.',
  },
];

interface Props {
  onCustomRepo: (repoUrl: string) => void;
  onConfigurePreset: (preset: PresetDef) => void;
  onSelectRun: (runId: string) => void;
  onOpenHistory: () => void;
}

function formatOwnerRepo(url?: string): string {
  if (!url) return 'example/pricing-service';
  return (
    url
      .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
      .replace(/^https?:\/\//i, '')
      .replace(/\.git$/, '')
      .replace(/\/$/, '') || 'repository'
  );
}

export default function Launchpad({
  onCustomRepo,
  onConfigurePreset,
  onSelectRun,
  onOpenHistory,
}: Props) {
  const [repo, setRepo] = useState('');
  const [recentRuns, setRecentRuns] = useState<Run[]>([mockData.run]);

  useEffect(() => {
    let active = true;
    listRuns()
      .then((fetched) => {
        if (!active) return;
        const sorted = [...fetched].sort((a, b) => {
          const da = a.created_at ? new Date(a.created_at).getTime() : 0;
          const db = b.created_at ? new Date(b.created_at).getTime() : 0;
          return db - da;
        });
        const withoutMock = sorted.filter((r) => r.run_id !== mockData.run.run_id);
        setRecentRuns([mockData.run, ...withoutMock].slice(0, 6));
      })
      .catch(() => {
        if (active) setRecentRuns([mockData.run]);
      });
    return () => {
      active = false;
    };
  }, []);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onCustomRepo(repo.trim());
  };

  return (
    <section className="home-workspace">
      <div className="home-workspace__grid">
        <div className="home-workspace__main">
          <header className="home-header">
            <h1 className="home-header__title">New run</h1>
            <p className="home-header__subtitle">
              Reproduce a bug, try four fixes in parallel, and check the best patch before you merge.
            </p>
          </header>

          <form className="command-bar" onSubmit={handleSubmit}>
            <div className="command-bar__input-wrap">
              <GitBranch size={16} strokeWidth={1.5} className="command-bar__icon" aria-hidden="true" />
              <input
                type="text"
                className="command-bar__input"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                placeholder="github.com/owner/repository"
                aria-label="GitHub repository URL"
              />
              {repo.trim().length > 0 && (
                <kbd className="command-bar__kbd" aria-hidden="true">
                  ⏎
                </kbd>
              )}
            </div>
            <button type="submit" className="btn btn--primary command-bar__btn">
              Configure run
            </button>
          </form>

          <section className="how-section" aria-labelledby="how-heading">
            <h2 id="how-heading" className="section-title">
              How a run works
            </h2>
            <div className="how-steps">
              {HOW_STEPS.map((s) => (
                <div key={s.num} className="how-step">
                  <div className="how-step__marker-row">
                    <span className="how-step__circle num">{s.num}</span>
                  </div>
                  <div className="how-step__content">
                    <div className="how-step__title">{s.title}</div>
                    <p className="how-step__detail">{s.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="examples-section" aria-labelledby="examples-heading">
            <div className="section-header-row">
              <h2 id="examples-heading" className="section-title">
                Examples
              </h2>
              <span className="section-hint">Select a verified benchmark repository</span>
            </div>

            <div className="examples-list" role="list">
              {PRESETS.map((p) => (
                <div
                  key={p.id}
                  role="listitem"
                  tabIndex={0}
                  className="examples-row"
                  onClick={() => onConfigurePreset(p)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onConfigurePreset(p);
                    }
                  }}
                >
                  <span className="examples-row__name">{p.title}</span>
                  <span className="examples-row__desc">{p.desc}</span>
                  <span className="examples-row__test">
                    <span className="test-badge mono">{p.testRunner}</span>
                  </span>
                  <span className="examples-row__cost mono num">{p.cost}</span>
                  <span className="examples-row__action">
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm examples-row__btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onConfigurePreset(p);
                      }}
                    >
                      <span>Load</span>
                      <ChevronRight size={13} strokeWidth={1.5} className="examples-row__chevron" />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>

        <aside className="home-workspace__sidebar" aria-labelledby="recent-runs-heading">
          <div className="section-header-row">
            <h2 id="recent-runs-heading" className="section-title">
              Recent runs
            </h2>
            <button type="button" className="btn btn--ghost btn--xs" onClick={onOpenHistory}>
              View all
            </button>
          </div>

          {recentRuns.length === 0 ? (
            <div className="recent-empty">
              <p className="recent-empty__title">No runs yet.</p>
              <p className="recent-empty__sub">Load an example to see a full run.</p>
            </div>
          ) : (
            <div className="recent-list" role="list">
              {recentRuns.map((r) => {
                const statusTone =
                  r.status === 'complete' ? 'pass' : r.status === 'failed' ? 'fail' : 'running';
                const costStr = `$${(r.total_cost_usd ?? 0).toFixed(4)}`;
                const timeStr = `${(r.total_wall_time_seconds ?? 0).toFixed(1)}s`;
                const confNum =
                  r.confidence_score != null
                    ? Math.round(r.confidence_score <= 1 ? r.confidence_score * 100 : r.confidence_score)
                    : null;

                return (
                  <button
                    key={r.run_id}
                    type="button"
                    className="recent-row"
                    onClick={() => onSelectRun(r.run_id)}
                  >
                    <div className="recent-row__top">
                      <span className="status-dot" data-status={statusTone} />
                      <span className="recent-row__repo">{formatOwnerRepo(r.repo_url)}</span>
                    </div>
                    <div className="recent-row__meta mono num">
                      <span>{costStr}</span>
                      <span>{timeStr}</span>
                      {confNum != null && <span>{confNum}% stable</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
