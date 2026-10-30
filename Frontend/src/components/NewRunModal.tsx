import { useState, useEffect, useRef, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import type { RunCreate } from '../types';
import { getApiBaseUrl } from '../api';

const EXAMPLES: { id: string; label: string; data: RunCreate }[] = [
  {
    id: 'checkout',
    label: 'Checkout pricing suite (boundary > vs >=)',
    data: {
      repo_url: 'https://github.com/noshaeec/checkout-pricing-suite',
      bug_description:
        'volume_discount_rate() in src/checkout/pricing.py uses > TIER_2_THRESHOLD instead of >= TIER_2_THRESHOLD so subtotal 1000.00 gets 10% instead of 15%',
      target_test: 'pytest --runxfail tests/test_discounts.py',
      full_suite_test: 'pytest --runxfail tests/test_discounts.py tests/test_items.py',
    },
  },
  {
    id: 'math',
    label: 'Math service (ZeroDivisionError)',
    data: {
      repo_url: 'https://github.com/example/math-service',
      bug_description: 'compute_average() crashes on empty list with ZeroDivisionError',
      target_test: 'pytest tests/test_math.py::test_average_empty',
      full_suite_test: '',
    },
  },
  {
    id: 'auth',
    label: 'Auth service (key rotation multi-file bug)',
    data: {
      repo_url: 'https://github.com/example/auth-service',
      bug_description:
        'JWT token verification fails across token validator and session cache under key rotation',
      target_test: 'pytest tests/test_auth.py::test_key_rotation',
      full_suite_test: 'pytest tests/',
    },
  },
];

interface Props {
  onSubmit: (payload: RunCreate) => void;
  onClose: () => void;
  backendOnline: boolean;
  initialValues?: Partial<RunCreate>;
}

function normalizeAndValidateRepo(raw: string): { normalized: string; valid: boolean } {
  const trimmed = raw.trim();
  if (!trimmed) return { normalized: '', valid: false };
  const normalized = /^github\.com\//i.test(trimmed) ? `https://${trimmed}` : trimmed;
  const isGithub = /^https?:\/\/(www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/i.test(normalized);
  return { normalized, valid: isGithub };
}

export default function NewRunModal({ onSubmit, onClose, backendOnline, initialValues }: Props) {
  const [form, setForm] = useState<RunCreate>({
    repo_url: initialValues?.repo_url || '',
    bug_description: initialValues?.bug_description || '',
    target_test: initialValues?.target_test || '',
    full_suite_test: initialValues?.full_suite_test || '',
  });

  const [selectedExample, setSelectedExample] = useState<string>('');
  const [touched, setTouched] = useState<{ repo: boolean; bug: boolean; test: boolean }>({
    repo: false,
    bug: false,
    test: false,
  });

  const repoRef = useRef<HTMLInputElement>(null);
  const bugRef = useRef<HTMLTextAreaElement>(null);
  const testRef = useRef<HTMLInputElement>(null);
  const suiteRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!form.repo_url.trim()) {
      repoRef.current?.focus();
    } else if (!form.bug_description.trim()) {
      bugRef.current?.focus();
    } else if (!form.target_test.trim()) {
      testRef.current?.focus();
    } else {
      repoRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (k: keyof RunCreate, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const repoCheck = normalizeAndValidateRepo(form.repo_url);
  const repoError = touched.repo && !repoCheck.valid
    ? 'Enter a GitHub URL like https://github.com/owner/repo.'
    : null;
  const bugError = touched.bug && !form.bug_description.trim()
    ? 'Add a short description so the models know what to fix.'
    : form.bug_description.length > 2000
    ? 'Description exceeds maximum length of 2000 characters.'
    : null;
  const testError = touched.test && !form.target_test.trim()
    ? 'Add the command that fails.'
    : form.target_test.length > 2000
    ? 'Command exceeds maximum length of 2000 characters.'
    : null;

  const isValid =
    repoCheck.valid &&
    Boolean(form.bug_description.trim()) &&
    form.bug_description.length <= 2000 &&
    Boolean(form.target_test.trim()) &&
    form.target_test.length <= 2000 &&
    (form.full_suite_test ?? '').length <= 2000;

  const handleSubmit = () => {
    setTouched({ repo: true, bug: true, test: true });
    if (!isValid || !backendOnline) return;
    onSubmit({
      repo_url: repoCheck.normalized,
      bug_description: form.bug_description.trim(),
      target_test: form.target_test.trim(),
      full_suite_test: (form.full_suite_test ?? '').trim(),
    });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose} onKeyDown={handleKeyDown}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-run-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__header">
          <h2 id="new-run-modal-title" className="modal__title">
            New run
          </h2>
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            onClick={onClose}
            aria-label="Close modal"
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>

        {!backendOnline && (
          <div className="modal__offline-banner">
            Could not reach the backend at <code>{getApiBaseUrl()}</code>. Check that it is running and try again.
          </div>
        )}

        <div className="modal__body">
          <div className="field">
            <label htmlFor="example-select" className="field__label">
              Load an example
            </label>
            <select
              id="example-select"
              className="field__select"
              value={selectedExample}
              onChange={(e) => {
                const val = e.target.value;
                setSelectedExample(val);
                const found = EXAMPLES.find((ex) => ex.id === val);
                if (found) {
                  setForm(found.data);
                  setTouched({ repo: false, bug: false, test: false });
                }
              }}
            >
              <option value="">Select an example...</option>
              {EXAMPLES.map((ex) => (
                <option key={ex.id} value={ex.id}>
                  {ex.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="field-repo" className="field__label">
              Repository
            </label>
            <input
              ref={repoRef}
              id="field-repo"
              className={`field__input ${repoError ? 'is-error' : ''}`}
              type="text"
              placeholder="https://github.com/owner/repo"
              value={form.repo_url}
              onChange={(e) => set('repo_url', e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, repo: true }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                  e.preventDefault();
                  bugRef.current?.focus();
                }
              }}
            />
            {repoError && <span className="field__error">{repoError}</span>}
          </div>

          <div className="field">
            <label htmlFor="field-bug" className="field__label">
              What is going wrong?
            </label>
            <textarea
              ref={bugRef}
              id="field-bug"
              className={`field__input field__textarea ${bugError ? 'is-error' : ''}`}
              placeholder="Describe the bug and what you see when it happens."
              value={form.bug_description}
              onChange={(e) => set('bug_description', e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, bug: true }))}
              rows={3}
            />
            {bugError && <span className="field__error">{bugError}</span>}
          </div>

          <div className="field">
            <div className="field__label-row">
              <label htmlFor="field-test" className="field__label">
                Failing test command
              </label>
              <span className="field__hint">Runs first, to confirm the bug.</span>
            </div>
            <input
              ref={testRef}
              id="field-test"
              className={`field__input mono ${testError ? 'is-error' : ''}`}
              type="text"
              placeholder="pytest tests/test_bug.py::test_function"
              value={form.target_test}
              onChange={(e) => set('target_test', e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, test: true }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                  e.preventDefault();
                  suiteRef.current?.focus();
                }
              }}
            />
            {testError && <span className="field__error">{testError}</span>}
          </div>

          <div className="field">
            <div className="field__label-row">
              <label htmlFor="field-suite" className="field__label">
                Full test suite (optional)
              </label>
              <span className="field__hint">Leave empty to skip the regression check.</span>
            </div>
            <input
              ref={suiteRef}
              id="field-suite"
              className="field__input mono"
              type="text"
              placeholder="pytest"
              value={form.full_suite_test ?? ''}
              onChange={(e) => set('full_suite_test', e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
            />
          </div>
        </div>

        <div className="modal__footer">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!isValid || !backendOnline}
            onClick={handleSubmit}
          >
            Start run
          </button>
        </div>
      </div>
    </div>
  );
}
