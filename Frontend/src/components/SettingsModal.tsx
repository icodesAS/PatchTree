import { useEffect, useState } from 'react';
import { X, Server, Cpu, Box, Keyboard, CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  backendOnline: boolean;
  onPingBackend?: () => void;
}

export default function SettingsModal({ isOpen, onClose, backendOnline, onPingBackend }: Props) {
  const [testing, setTesting] = useState(false);
  const apiUrl = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/+$/, '');

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleTestPing = async () => {
    if (!onPingBackend || testing) return;
    setTesting(true);
    try {
      await onPingBackend();
    } finally {
      setTimeout(() => setTesting(false), 500);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div className="modal" style={{ maxWidth: '640px' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <h2 id="settings-title" className="modal__title">Workspace Settings</h2>
            <span style={{ fontSize: '11px', color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>v0.1.0</span>
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            onClick={onClose}
            aria-label="Close settings"
          >
            <X size={16} />
          </button>
        </div>

        <div className="modal__body" style={{ gap: '20px' }}>
          {/* Section 1: Backend Connection */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: 600, color: 'var(--text)' }}>
                <Server size={14} style={{ color: 'var(--text-2)' }} />
                <span>Backend API Connection</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                {backendOnline ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px', color: 'var(--pass)' }}>
                    <CheckCircle2 size={13} />
                    Connected
                  </span>
                ) : (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px', color: 'var(--fail)' }}>
                    <AlertCircle size={13} />
                    Offline
                  </span>
                )}
                {onPingBackend && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--xs"
                    onClick={handleTestPing}
                    disabled={testing}
                    title="Ping backend health endpoint"
                    style={{ padding: '2px 6px', height: '22px' }}
                  >
                    <RefreshCw size={11} className={testing ? 'spin' : ''} />
                    <span style={{ fontSize: '11px' }}>Ping</span>
                  </button>
                )}
              </div>
            </div>

            <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: '10px 14px', fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Endpoint:</span>
              <code style={{ color: 'var(--text)', background: 'var(--surface-1)', padding: '2px 6px', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)' }}>
                {apiUrl}
              </code>
            </div>
          </div>

          {/* Section 2: AI & Cloud Sandboxes */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: 600, color: 'var(--text)', marginBottom: '8px' }}>
              <Cpu size={14} style={{ color: 'var(--text-2)' }} />
              <span>Inference & Execution Infrastructure</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 600, color: 'var(--text)', marginBottom: '4px' }}>
                  <Cpu size={13} style={{ color: 'var(--text-2)' }} />
                  Nebius Token Factory
                </div>
                <p style={{ margin: 0, fontSize: '11px', color: 'var(--text-3)', lineHeight: 1.4 }}>
                  Tiered models with HTTP/2 dispatch: Nano 30B, Super 120B, and Ultra 550B escalation.
                </p>
              </div>

              <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 600, color: 'var(--text)', marginBottom: '4px' }}>
                  <Box size={13} style={{ color: 'var(--text-2)' }} />
                  Contree Cloud Sandboxes
                </div>
                <p style={{ margin: 0, fontSize: '11px', color: 'var(--text-3)', lineHeight: 1.4 }}>
                  Isolated MicroVM environments with git-level checkpointing and parallel fork execution.
                </p>
              </div>
            </div>
          </div>

          {/* Section 3: Keyboard Shortcuts */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: 600, color: 'var(--text)', marginBottom: '8px' }}>
              <Keyboard size={14} style={{ color: 'var(--text-2)' }} />
              <span>Keyboard Shortcuts</span>
            </div>
            <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                <tbody>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 12px', color: 'var(--text-2)' }}>Open command palette</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                      <kbd className="kbd">Ctrl</kbd> + <kbd className="kbd">K</kbd>
                    </td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 12px', color: 'var(--text-2)' }}>New verification run</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                      <kbd className="kbd">N</kbd>
                    </td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 12px', color: 'var(--text-2)' }}>Open settings</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                      <kbd className="kbd">,</kbd>
                    </td>
                  </tr>
                  <tr>
                    <td style={{ padding: '8px 12px', color: 'var(--text-2)' }}>Close active modal / deselect node</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                      <kbd className="kbd">Esc</kbd>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="modal__footer" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
