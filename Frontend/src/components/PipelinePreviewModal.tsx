import { useState } from 'react';
import {
  X,
  GitBranch,
  ShieldCheck,
  Zap,
  Play,
  Settings2,
  Cpu,
  Layers,
  Sparkles,
  AlertTriangle,
} from 'lucide-react';
import type { PresetDef } from './Launchpad';

interface Props {
  preset: PresetDef;
  onClose: () => void;
  onSimulate: (preset: PresetDef) => void;
  onConfigureCloudRun: (preset: PresetDef) => void;
}

export default function PipelinePreviewModal({
  preset,
  onClose,
  onSimulate,
  onConfigureCloudRun,
}: Props) {
  const [activeTab, setActiveTab] = useState<'flowchart' | 'scenario' | 'telemetry'>('flowchart');

  const getToneBadge = (tone: string) => {
    switch (tone) {
      case 'ultra':
        return { label: 'Ultra 550B Escalation', color: 'var(--ultra)', bg: 'rgba(168, 85, 247, 0.15)' };
      case 'stability':
        return { label: '5-Fork Flakiness Isolation', color: 'var(--pass)', bg: 'rgba(16, 185, 129, 0.15)' };
      default:
        return { label: 'Standard 4-Way Search', color: 'var(--accent)', bg: 'rgba(99, 102, 241, 0.15)' };
    }
  };

  const badge = getToneBadge(preset.tone);

  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        background: 'rgba(3, 7, 18, 0.82)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
      }}
    >
      <div
        className="pipeline-modal modal--wide"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: '920px',
          maxHeight: '85vh',
          background: 'linear-gradient(180deg, #0e1628 0%, #070c18 100%)',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          borderRadius: '16px',
          boxShadow: '0 24px 64px -12px rgba(0, 0, 0, 0.85), 0 0 32px -8px var(--accent-glow)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          animation: 'modal-in 0.25s cubic-bezier(0.16, 1, 0.3, 1) both',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '20px 24px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            background: 'rgba(255, 255, 255, 0.02)',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  padding: '3px 8px',
                  borderRadius: '6px',
                  color: badge.color,
                  background: badge.bg,
                  border: `1px solid ${badge.color}33`,
                }}
              >
                {badge.label}
              </span>
              <span style={{ fontSize: '12px', color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
                {preset.repo.replace('https://github.com/', '')}
              </span>
            </div>
            <h2 style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-1)', margin: 0 }}>
              {preset.title}
            </h2>
          </div>

          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              borderRadius: '8px',
              padding: '6px',
              color: 'var(--text-2)',
              cursor: 'pointer',
              display: 'flex',
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Tab Navigation */}
        <div
          style={{
            display: 'flex',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            padding: '0 24px',
            background: 'rgba(0, 0, 0, 0.2)',
          }}
        >
          <button
            onClick={() => setActiveTab('flowchart')}
            style={{
              padding: '12px 16px',
              background: 'transparent',
              border: 'none',
              borderBottom: activeTab === 'flowchart' ? '2px solid var(--accent)' : '2px solid transparent',
              color: activeTab === 'flowchart' ? 'var(--text-1)' : 'var(--text-3)',
              fontWeight: 600,
              fontSize: '13px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <GitBranch size={14} /> Pipeline Flowchart & Lifecycle
          </button>
          <button
            onClick={() => setActiveTab('scenario')}
            style={{
              padding: '12px 16px',
              background: 'transparent',
              border: 'none',
              borderBottom: activeTab === 'scenario' ? '2px solid var(--accent)' : '2px solid transparent',
              color: activeTab === 'scenario' ? 'var(--text-1)' : 'var(--text-3)',
              fontWeight: 600,
              fontSize: '13px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <Layers size={14} /> Scenario Deep-Dive & Target Bug
          </button>
          <button
            onClick={() => setActiveTab('telemetry')}
            style={{
              padding: '12px 16px',
              background: 'transparent',
              border: 'none',
              borderBottom: activeTab === 'telemetry' ? '2px solid var(--accent)' : '2px solid transparent',
              color: activeTab === 'telemetry' ? 'var(--text-1)' : 'var(--text-3)',
              fontWeight: 600,
              fontSize: '13px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <Cpu size={14} /> Architecture & Cloud Economics
          </button>
        </div>

        {/* Modal Body */}
        <div style={{ padding: '24px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {activeTab === 'flowchart' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <p style={{ margin: 0, fontSize: '13.5px', color: 'var(--text-2)', lineHeight: 1.6 }}>
                Every verification run in PatchTree undergoes a deterministic 6-phase autonomous tree traversal. No single model's output is trusted without sandbox survival proofs:
              </p>

              {/* Step cards */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '12px' }}>
                {/* Phase 1 */}
                <div
                  style={{
                    padding: '14px 16px',
                    borderRadius: '10px',
                    background: 'rgba(239, 68, 68, 0.06)',
                    border: '1px solid rgba(239, 68, 68, 0.25)',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '14px',
                  }}
                >
                  <div
                    style={{
                      width: '32px',
                      height: '32px',
                      borderRadius: '8px',
                      background: 'rgba(239, 68, 68, 0.2)',
                      color: 'var(--fail)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: 700,
                      fontSize: '13px',
                      flexShrink: 0,
                    }}
                  >
                    1
                  </div>
                  <div>
                    <h4 style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: 600, color: 'var(--text-1)' }}>
                      💥 Phase 1: Root Bug Reproduction & Sandbox Checkpoint
                    </h4>
                    <p style={{ margin: 0, fontSize: '12.5px', color: 'var(--text-2)', lineHeight: 1.5 }}>
                      Executes <code>{preset.testCmd}</code> in an isolated Contree microVM. Verifies the bug reproduces (exit code ≠ 0). If tests pass or are missing, execution halts immediately with <strong>$0.00 cost</strong> to safeguard credits. Checkpoint A is snapshotted.
                    </p>
                  </div>
                </div>

                {/* Phase 2 */}
                <div
                  style={{
                    padding: '14px 16px',
                    borderRadius: '10px',
                    background: 'rgba(99, 102, 241, 0.06)',
                    border: '1px solid rgba(99, 102, 241, 0.25)',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '14px',
                  }}
                >
                  <div
                    style={{
                      width: '32px',
                      height: '32px',
                      borderRadius: '8px',
                      background: 'rgba(99, 102, 241, 0.2)',
                      color: 'var(--accent)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: 700,
                      fontSize: '13px',
                      flexShrink: 0,
                    }}
                  >
                    2
                  </div>
                  <div>
                    <h4 style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: 600, color: 'var(--text-1)' }}>
                      🌿 Phase 2: 4-Way Parallel Search Fan-Out (Nano 30B / Super 120B)
                    </h4>
                    <p style={{ margin: 0, fontSize: '12.5px', color: 'var(--text-2)', lineHeight: 1.5 }}>
                      From Checkpoint A, forks 4 concurrent candidate branches exploring distinct repair strategies:
                      <br />• <strong>Minimal Fix</strong>: direct guard clause or bounds clamp
                      <br />• <strong>Alternative Approach</strong>: structural refactoring
                      <br />• <strong>Root Cause Analysis</strong>: upstream dependency resolution
                      <br />• <strong>Test-Driven Contract</strong>: strict adherence to expected behavior
                    </p>
                  </div>
                </div>

                {/* Phase 3 */}
                <div
                  style={{
                    padding: '14px 16px',
                    borderRadius: '10px',
                    background: 'rgba(16, 185, 129, 0.06)',
                    border: '1px solid rgba(16, 185, 129, 0.25)',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '14px',
                  }}
                >
                  <div
                    style={{
                      width: '32px',
                      height: '32px',
                      borderRadius: '8px',
                      background: 'rgba(16, 185, 129, 0.2)',
                      color: 'var(--pass)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: 700,
                      fontSize: '13px',
                      flexShrink: 0,
                    }}
                  >
                    3
                  </div>
                  <div>
                    <h4 style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: 600, color: 'var(--text-1)' }}>
                      🛡️ Phase 3: 5 Stability Stress Tests (Monte Carlo Isolation)
                    </h4>
                    <p style={{ margin: 0, fontSize: '12.5px', color: 'var(--text-2)', lineHeight: 1.5 }}>
                      The winning candidate patch is forked into <strong>5 parallel sandbox environments</strong> to test under variable timing, concurrency, and repeated runs. Isolates intermittent timer race conditions and quarantines flaky failures.
                    </p>
                  </div>
                </div>

                {/* Phase 4 */}
                <div
                  style={{
                    padding: '14px 16px',
                    borderRadius: '10px',
                    background: 'rgba(245, 158, 11, 0.06)',
                    border: '1px solid rgba(245, 158, 11, 0.25)',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '14px',
                  }}
                >
                  <div
                    style={{
                      width: '32px',
                      height: '32px',
                      borderRadius: '8px',
                      background: 'rgba(245, 158, 11, 0.2)',
                      color: 'var(--warning)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: 700,
                      fontSize: '13px',
                      flexShrink: 0,
                    }}
                  >
                    4
                  </div>
                  <div>
                    <h4 style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: 600, color: 'var(--text-1)' }}>
                      ⚔️ Phase 4: 2 Adversarial Edge-Case Probes (Super 120B Red-Team)
                    </h4>
                    <p style={{ margin: 0, fontSize: '12.5px', color: 'var(--text-2)', lineHeight: 1.5 }}>
                      Nemotron Super 120B inspects the candidate diff and synthesizes 2 hostile pytest test cases specifically designed to break the patch (boundary values, null checks, type coercion, overflow). Developers can click red adversarial nodes to inspect the generated test code and pytest traceback.
                    </p>
                  </div>
                </div>

                {/* Phase 5 */}
                <div
                  style={{
                    padding: '14px 16px',
                    borderRadius: '10px',
                    background: 'rgba(168, 85, 247, 0.06)',
                    border: '1px solid rgba(168, 85, 247, 0.25)',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '14px',
                  }}
                >
                  <div
                    style={{
                      width: '32px',
                      height: '32px',
                      borderRadius: '8px',
                      background: 'rgba(168, 85, 247, 0.2)',
                      color: 'var(--ultra)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: 700,
                      fontSize: '13px',
                      flexShrink: 0,
                    }}
                  >
                    5
                  </div>
                  <div>
                    <h4 style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: 600, color: 'var(--text-1)' }}>
                      🚀 Phase 5: Autonomous Ultra 550B Escalation (Failure Fallback)
                    </h4>
                    <p style={{ margin: 0, fontSize: '12.5px', color: 'var(--text-2)', lineHeight: 1.5 }}>
                      If all 4 initial search branches fail, PatchTree does not crash or give up. It triggers <strong>Nemotron-3-Ultra 550B</strong>, feeding it all 4 failed patch attempts, hypotheses, and pytest failure traces to synthesize an authoritative multi-file fix.
                    </p>
                  </div>
                </div>

                {/* Phase 6 */}
                <div
                  style={{
                    padding: '14px 16px',
                    borderRadius: '10px',
                    background: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '14px',
                  }}
                >
                  <div
                    style={{
                      width: '32px',
                      height: '32px',
                      borderRadius: '8px',
                      background: 'rgba(255, 255, 255, 0.1)',
                      color: 'var(--text-1)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: 700,
                      fontSize: '13px',
                      flexShrink: 0,
                    }}
                  >
                    6
                  </div>
                  <div>
                    <h4 style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: 600, color: 'var(--text-1)' }}>
                      📋 Phase 6: Executive Confidence Audit & Verification Seal
                    </h4>
                    <p style={{ margin: 0, fontSize: '12.5px', color: 'var(--text-2)', lineHeight: 1.5 }}>
                      Runs the full repository test suite, calculates the survival confidence score (0–100%), tallies exact dollar costs from token telemetry, generates a cryptographic telemetry hash, and outputs a copyable <code>git apply patch.diff</code> snippet.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'scenario' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div
                style={{
                  padding: '16px',
                  borderRadius: '12px',
                  background: 'rgba(0, 0, 0, 0.3)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <AlertTriangle size={16} color="var(--warning)" />
                  <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-1)' }}>Bug Description</span>
                </div>
                <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-2)', lineHeight: 1.6, fontFamily: 'var(--font-mono)' }}>
                  {preset.bugDesc}
                </p>
              </div>

              <div
                style={{
                  padding: '16px',
                  borderRadius: '12px',
                  background: 'rgba(0, 0, 0, 0.3)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <ShieldCheck size={16} color="var(--pass)" />
                  <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-1)' }}>Why This Preset Was Designed</span>
                </div>
                <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-2)', lineHeight: 1.6 }}>
                  {preset.id === 'discount' && (
                    <>
                      <strong>Fast Path Single-File Resolution:</strong> Shows how PatchTree quickly resolves straightforward bugs using the low-cost <strong>Nano 30B</strong> model (~$0.003 USD). Branch 2 clamps negative discounts, passes all 5 stability forks, survives adversarial probes, and achieves 100% confidence in ~20 seconds.
                    </>
                  )}
                  {preset.id === 'flaky' && (
                    <>
                      <strong>Quarantining Flakiness via 5 Stability Forks:</strong> In single-run automated repair tools, a flaky test that passes once is falsely declared "fixed". In this scenario, a timer race condition intermittently passes. PatchTree executes 5 parallel stability forks: 4 pass and 1 fails, correctly flagging the patch as unstable (50% confidence) and saving developers from merging bad code.
                    </>
                  )}
                  {preset.id === 'multifile' && (
                    <>
                      <strong>Ultra 550B Autonomous Escalation:</strong> Single-file repair tools cannot fix multi-layer architectural bugs. In this JWT authentication bug, both session middleware and token validation require synchronized changes. All 4 initial search branches fail. PatchTree automatically escalates to <strong>Nemotron-3-Ultra 550B</strong>, synthesizing the cross-file patch and achieving full verification.
                    </>
                  )}
                </p>
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gap: '12px',
                }}
              >
                <div style={{ padding: '12px', borderRadius: '8px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-3)', display: 'block', marginBottom: '4px' }}>Target Test</span>
                  <code style={{ fontSize: '12px', color: 'var(--text-1)' }}>{preset.testCmd}</code>
                </div>
                <div style={{ padding: '12px', borderRadius: '8px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-3)', display: 'block', marginBottom: '4px' }}>Model Tier</span>
                  <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--accent)' }}>{preset.meta[0]}</span>
                </div>
                <div style={{ padding: '12px', borderRadius: '8px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-3)', display: 'block', marginBottom: '4px' }}>Estimated Cost</span>
                  <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--pass)' }}>{preset.meta[2]}</span>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'telemetry' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <p style={{ margin: 0, fontSize: '13.5px', color: 'var(--text-2)', lineHeight: 1.6 }}>
                PatchTree couples <strong>Contree OCI sandboxes</strong> with <strong>Nebius Token Factory</strong> tiered inference to deliver cost-efficient, verifiable program repair:
              </p>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
                <div style={{ padding: '16px', borderRadius: '12px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                    <Zap size={16} color="var(--accent)" />
                    <h4 style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: 'var(--text-1)' }}>Tiered Model Routing</h4>
                  </div>
                  <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12.5px', color: 'var(--text-2)', lineHeight: 1.6 }}>
                    <li><strong>Nano 30B</strong> ($0.10/M): minimal patch generation & quick repairs</li>
                    <li><strong>Super 120B</strong> ($0.35/M): root-cause exploration & adversarial test generation</li>
                    <li><strong>Ultra 550B</strong> ($1.20/M): reserved strictly for escalation on hard failures</li>
                  </ul>
                </div>

                <div style={{ padding: '16px', borderRadius: '12px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                    <ShieldCheck size={16} color="var(--pass)" />
                    <h4 style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: 'var(--text-1)' }}>Credit Burn Safeguards</h4>
                  </div>
                  <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12.5px', color: 'var(--text-2)', lineHeight: 1.6 }}>
                    <li><strong>Hard Token Caps</strong>: max 1500 tokens for patches, 2500 for reports</li>
                    <li><strong>Root Early Guard</strong>: aborts immediately ($0.00 cost) if tests are missing</li>
                    <li><strong>Single Concurrency</strong>: rejects parallel spams to protect balance</li>
                  </ul>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Action Footer */}
        <div
          style={{
            padding: '16px 24px',
            borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            background: 'rgba(0, 0, 0, 0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Sparkles size={14} color="var(--accent)" />
            <span style={{ fontSize: '12px', color: 'var(--text-3)' }}>
              Explore the UI tree without burning Nebius credits:
            </span>
          </div>

          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              onClick={() => {
                onClose();
                onSimulate(preset);
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                padding: '9px 16px',
                borderRadius: '8px',
                background: 'rgba(99, 102, 241, 0.15)',
                border: '1px solid var(--accent)',
                color: 'var(--text-1)',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.2s',
              }}
            >
              <Play size={14} fill="var(--accent)" color="var(--accent)" /> Simulate Tree in UI (0 Cost)
            </button>

            <button
              onClick={() => {
                onClose();
                onConfigureCloudRun(preset);
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                padding: '9px 16px',
                borderRadius: '8px',
                background: 'rgba(255, 255, 255, 0.06)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                color: 'var(--text-2)',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              <Settings2 size={14} /> Configure as Real Run
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
