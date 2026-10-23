import { useState } from 'react';
import { X, Zap, ChevronRight } from 'lucide-react';
import type { RunCreate } from '../types';

const SAMPLES: { label: string; data: RunCreate }[] = [
  {
    label: '🐛 Math Bug',
    data: {
      repo_url: 'https://github.com/example/math-service',
      bug_description: 'compute_average() crashes on empty list with ZeroDivisionError',
      target_test: 'pytest tests/test_math.py::test_average_empty',
      full_suite_test: 'pytest',
    },
  },
  {
    label: '🔢 Off-By-One',
    data: {
      repo_url: 'https://github.com/example/pricing-service',
      bug_description: 'calculate_discount() returns negative value when discount_pct > 100',
      target_test: 'pytest tests/test_discount.py::test_calculate_discount',
      full_suite_test: 'pytest',
    },
  },
];

interface Props {
  onSubmit: (payload: RunCreate) => void;
  onClose: () => void;
  backendOnline: boolean;
}

export default function NewRunModal({ onSubmit, onClose, backendOnline }: Props) {
  const [form, setForm] = useState<RunCreate>({
    repo_url: '',
    bug_description: '',
    target_test: '',
    full_suite_test: '',
  });

  const set = (k: keyof RunCreate, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const valid = form.repo_url.trim() && form.bug_description.trim() && form.target_test.trim();

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
          <div className="modal__samples">
            <span className="modal__samples-label">Quick fill:</span>
            {SAMPLES.map((s) => (
              <button key={s.label} className="btn btn--ghost" onClick={() => setForm(s.data)}>
                {s.label}
              </button>
            ))}
          </div>

          <label className="field">
            <span className="field__label">Repository URL</span>
            <input
              className="field__input"
              type="text"
              placeholder="https://github.com/owner/repo"
              value={form.repo_url}
              onChange={(e) => set('repo_url', e.target.value)}
            />
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
        </div>

        <div className="modal__footer">
          <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn btn--primary"
            disabled={!valid || !backendOnline}
            onClick={() => onSubmit(form)}
          >
            <ChevronRight size={15} /> Start Search &amp; Verification
          </button>
        </div>
      </div>
    </div>
  );
}
