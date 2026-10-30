import { useState } from 'react';
import { X, Zap, ChevronRight } from 'lucide-react';
import type { RunCreate } from '../types';

const SAMPLES: { label: string; data: RunCreate }[] = [
  {
    label: '🛒 Checkout Pricing Suite (Live GitHub Bug)',
    data: {
      repo_url: 'https://github.com/noshaeec/checkout-pricing-suite',
      bug_description: 'volume_discount_rate() in src/checkout/pricing.py uses > TIER_2_THRESHOLD instead of >= TIER_2_THRESHOLD so subtotal 1000.00 gets 10% instead of 15%',
      target_test: 'pytest --runxfail tests/test_discounts.py',
      full_suite_test: 'pytest --runxfail tests/test_discounts.py tests/test_items.py',
    },
  },
  {
    label: '🐛 Math Service (ZeroDivisionError)',
    data: {
      repo_url: 'https://github.com/example/math-service',
      bug_description: 'compute_average() crashes on empty list with ZeroDivisionError',
      target_test: 'pytest tests/test_math.py::test_average_empty',
      full_suite_test: '',
    },
  },
  {
    label: '🔢 Pricing Calculator (Discount Off-By-One)',
    data: {
      repo_url: 'https://github.com/example/pricing-service',
      bug_description: 'calculate_discount() returns negative value when discount_pct > 100',
      target_test: 'pytest tests/test_discount.py::test_calculate_discount',
      full_suite_test: '',
    },
  },
];

interface Props {
  onSubmit: (payload: RunCreate) => void;
  onClose: () => void;
  backendOnline: boolean;
  initialValues?: Partial<RunCreate>;
}

function validateRepoUrl(raw: string): { normalized: string; error: string | null } {
  const trimmed = raw.trim();
  if (!trimmed) return { normalized: '', error: null };
  if (/\s/.test(trimmed)) {
    return {
      normalized: trimmed,
      error: 'Enter a Git repository URL without spaces or commands (e.g. https://github.com/owner/repo).',
    };
  }
  const normalized = /^(github\.com|gitlab\.com|bitbucket\.org)\//i.test(trimmed)
    ? `https://${trimmed}`
    : trimmed;
  const isGitUrl = /^(https?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+|git@[^\s:]+:[^\s/]+\/[^\s/]+|ssh:\/\/[^\s/]+\/.+)/i.test(
    normalized,
  );
  return {
    normalized,
    error: isGitUrl ? null : 'Must be a valid Git repository URL (e.g. https://github.com/owner/repo).',
  };
}

export default function NewRunModal({ onSubmit, onClose, backendOnline, initialValues }: Props) {
  const [form, setForm] = useState<RunCreate>({
    repo_url: initialValues?.repo_url || '',
    bug_description: initialValues?.bug_description || '',
    target_test: initialValues?.target_test || '',
    full_suite_test: initialValues?.full_suite_test || '',
  });

  const set = (k: keyof RunCreate, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const repoCheck = validateRepoUrl(form.repo_url);
  const valid = Boolean(
    repoCheck.normalized && !repoCheck.error && form.bug_description.trim() && form.target_test.trim(),
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <div className="modal__title-wrap">
            <Zap size={18} className="modal__icon" />
            <h2 className="modal__title">New PatchTree Run</h2>
          </div>
          <button className="inspector__close" onClick={onClose}><X size={16} /></button>
        </div>

        {!backendOnline && (
          <div className="modal__offline-banner">
            🔴 Backend offline at <code>{import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000'}</code>. Start FastAPI server before dispatching runs.
          </div>
        )}

        <div className="modal__body">
          <label className="field">
            <span className="field__label">Repository URL</span>
            <input
              className="field__input"
              type="text"
              placeholder="https://github.com/owner/repo"
              value={form.repo_url}
              onChange={(e) => set('repo_url', e.target.value)}
            />
            {repoCheck.error && (
              <span style={{ color: '#f87171', fontSize: '0.76rem', marginTop: 4, display: 'block' }}>
                {repoCheck.error}
              </span>
            )}
          </label>

          <label className="field">
            <span className="field__label">Bug Description</span>
            <textarea
              className="field__input field__textarea"
              placeholder="Describe the bug and its symptoms…"
              value={form.bug_description}
              onChange={(e) => set('bug_description', e.target.value)}
              rows={3}
            />
          </label>

          <label className="field">
            <span className="field__label">Target Test Command</span>
            <input
              className="field__input"
              type="text"
              placeholder="pytest tests/test_bug.py::test_function"
              value={form.target_test}
              onChange={(e) => set('target_test', e.target.value)}
            />
          </label>

          <label className="field">
            <span className="field__label">Full Suite Command <span className="field__optional">(optional)</span></span>
            <input
              className="field__input"
              type="text"
              placeholder="e.g. pytest, npm test (leave empty to skip)"
              value={form.full_suite_test ?? ''}
              onChange={(e) => set('full_suite_test', e.target.value)}
            />
          </label>

          {/* Hackathon Demo Scenarios for Judges */}
          <div className="modal__demo-section">
            <div className="modal__demo-header">
              <span className="modal__demo-title">💡 Hackathon Demo Templates (Quick-Fill Form)</span>
              <span className="modal__demo-sub">
                Click a sample scenario below to automatically populate the fields above for evaluation:
              </span>
            </div>
            <div className="modal__demo-chips">
              {SAMPLES.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  className="modal__demo-chip"
                  onClick={() => setForm(s.data)}
                  title="Populate form with this benchmark scenario"
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="modal__footer">
          <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn btn--primary"
            disabled={!valid || !backendOnline}
            onClick={() =>
              onSubmit({
                ...form,
                repo_url: repoCheck.normalized,
                bug_description: form.bug_description.trim(),
                target_test: form.target_test.trim(),
                full_suite_test: (form.full_suite_test ?? '').trim(),
              })
            }
          >
            <ChevronRight size={15} /> Start Search &amp; Verification
          </button>
        </div>
      </div>
    </div>
  );
}
