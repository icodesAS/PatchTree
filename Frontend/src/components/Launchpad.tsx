import { useState, type MouseEvent, type FormEvent } from 'react';
import { GitBranch, ArrowRight, Cpu, ShieldCheck, Layers, Sparkles } from 'lucide-react';
import PipelinePreviewModal from './PipelinePreviewModal';

export interface PresetDef {
  id: string;
  tone: 'search' | 'stability' | 'ultra';
  title: string;
  desc: string;
  meta: string[];
  kids: number;
  repo: string;
  bugDesc: string;
  testCmd: string;
  fullSuiteCmd?: string;
}

const PRESETS: PresetDef[] = [
  {
    id: 'discount',
    tone: 'search',
    title: 'Discount bug',
    desc: 'A price goes negative when discount exceeds 100%. Direct minimal fix on single file.',
    meta: ['Nano 30B', 'Single-File Fix', '~$0.004'],
    kids: 4,
    repo: 'https://github.com/example/discount-calc',
    bugDesc: 'Discount percentage exceeds 100% causing negative final total calculation.',
    testCmd: 'pytest tests/test_discount.py',
    fullSuiteCmd: undefined,
  },
  {
    id: 'flaky',
    tone: 'stability',
    title: 'Flaky test isolation',
    desc: 'Timer race condition passes intermittently. 5 stability forks isolate and quarantine flaky failure.',
    meta: ['Super 120B', '5 Forks (4/5)', '~$0.01'],
    kids: 5,
    repo: 'https://github.com/example/async-scheduler',
    bugDesc: 'Race condition in timer cancellation causing intermittent assertion errors.',
    testCmd: 'pytest tests/test_timer.py',
    fullSuiteCmd: undefined,
  },
  {
    id: 'multifile',
    tone: 'ultra',
    title: 'Hard bug · Ultra 550B',
    desc: 'Small models fail round 1. Pipeline escalates to Nemotron-3-Ultra 550B with full regression suite.',
    meta: ['Ultra 550B', 'Escalation', '~$0.05'],
    kids: 3,
    repo: 'https://github.com/example/auth-pipeline',
    bugDesc: 'Multi-layer token verification failure across session middleware and JWT validator.',
    testCmd: 'pytest tests/test_auth.py',
    fullSuiteCmd: 'pytest',
  },
];

function MiniTree({ kids }: { kids: number }) {
  const xs = Array.from({ length: kids }, (_, i) => 20 + (i * 160) / (kids - 1 || 1));
  return (
    <svg className="preset__tree" viewBox="0 0 200 64" preserveAspectRatio="xMidYMid meet" aria-hidden>
      {xs.map((x, i) => (
        <path key={i} className="preset__edge" d={`M100 12 C100 34 ${x} 28 ${x} 50`} />
      ))}
      <circle cx="100" cy="12" r="4" fill="var(--c-root)" />
      {xs.map((x, i) => (
        <circle key={i} cx={x} cy="50" r="3.5" fill="var(--c)" />
      ))}
    </svg>
  );
}

interface Props {
  onCustomRepo: (repoUrl: string) => void;
  onSimulatePreset: (preset: PresetDef) => void;
  onConfigurePreset: (preset: PresetDef) => void;
}

export default function Launchpad({ onCustomRepo, onSimulatePreset, onConfigurePreset }: Props) {
  const [repo, setRepo] = useState('');
  const [previewPreset, setPreviewPreset] = useState<PresetDef | null>(null);

  const spot = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`);
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (repo.trim()) {
      onCustomRepo(repo.trim());
    }
  };

  return (
    <section className="launchpad">
      <div className="launchpad__inner">
        <div className="launchpad__hero">
          <div className="launchpad__brand-pill">
            <span className="launchpad__brand-logo">
              <GitBranch size={14} />
            </span>
            <span className="launchpad__brand-label">PatchTree</span>
            <span className="launchpad__brand-sep">·</span>
            <span className="launchpad__brand-tag">Nebius Nemotron × Contree MicroVMs</span>
          </div>

          <h1 className="launchpad__title">
            Autonomous bug repair,{' '}
            <span className="launchpad__title-accent">verified in parallel sandboxes.</span>
          </h1>
          <p className="launchpad__sub">
            Fork isolated cloud microVMs, race 4 concurrent Nemotron repair strategies, and prove patch stability with{' '}
            <code>k=5</code> flaky-test forensics and adversarial attacks before merge.
          </p>
        </div>

        <form className="launchpad__cmd" onSubmit={handleSubmit}>
          <span className="launchpad__prompt">$</span>
          <input
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="github.com/owner/repository"
            aria-label="GitHub repository URL"
          />
          <button type="submit" className="launchpad__submit">
            <span>Configure Run</span>
            <ArrowRight size={13} />
          </button>
        </form>

        <div className="launchpad__stages" aria-label="Verification architecture stages">
          <div className="launchpad__stage-pill" data-stage="root">
            <Layers size={13} className="launchpad__stage-ico" />
            <span><b>01</b> Reproduce in Contree VM</span>
          </div>
          <div className="launchpad__stage-pill" data-stage="search">
            <Cpu size={13} className="launchpad__stage-ico" />
            <span><b>02</b> 4× Parallel Nemotron Search</span>
          </div>
          <div className="launchpad__stage-pill" data-stage="stability">
            <ShieldCheck size={13} className="launchpad__stage-ico" />
            <span><b>03</b> 5× Stability Forensics</span>
          </div>
          <div className="launchpad__stage-pill" data-stage="ultra">
            <Sparkles size={13} className="launchpad__stage-ico" />
            <span><b>04</b> Adversarial &amp; Ultra Audit</span>
          </div>
        </div>

        <div className="preset-grid">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="preset"
              data-tone={p.tone}
              onMouseMove={spot}
              onClick={() => setPreviewPreset(p)}
            >
              <MiniTree kids={p.kids} />
              <h3 className="preset__title">{p.title}</h3>
              <p className="preset__desc">{p.desc}</p>
              <div className="preset__meta">
                {p.meta.map((m) => (
                  <span key={m}>{m}</span>
                ))}
              </div>
              <span className="preset__go">
                <GitBranch size={13} />
                <span>Inspect Architecture &amp; Flow</span>
                <ArrowRight size={13} />
              </span>
            </button>
          ))}
        </div>
      </div>

      {previewPreset && (
        <PipelinePreviewModal
          preset={previewPreset}
          onClose={() => setPreviewPreset(null)}
          onSimulate={(p) => {
            setPreviewPreset(null);
            onSimulatePreset(p);
          }}
          onConfigureCloudRun={(p) => {
            setPreviewPreset(null);
            onConfigurePreset(p);
          }}
        />
      )}
    </section>
  );
}
