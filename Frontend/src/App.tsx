import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap,
  type Node as RFNode, type Edge, type NodeTypes,
  Handle, Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  GitBranch, Zap, DollarSign, Clock, Percent,
  Shield, Plus, CheckCircle, Loader, History,
} from 'lucide-react';
import type { PatchNode, Run, RunCreate } from './types';
import { mockData } from './mockData';
import { checkHealth, createRun, getRun, getTree, pollUntilComplete } from './api';
import { computeLayout, resetLayoutCache, NODE_W, NODE_H } from './layout';
import NewRunModal from './components/NewRunModal';
import ReportModal from './components/ReportModal';
import NodeInspector from './components/NodeInspector';
import HistorySidebar from './components/HistorySidebar';
import './App.css';

// ── Branch config ─────────────────────────────────────────────────────────────
const BRANCH_COLORS: Record<string, string> = {
  root: '#6366f1', search: '#3b82f6', stability: '#10b981',
  adversarial: '#f59e0b', full_suite: '#8b5cf6',
};
const BRANCH_LABELS: Record<string, string> = {
  root: 'Root', search: 'Search', stability: 'Stability',
  adversarial: 'Adversarial', full_suite: 'Full Suite',
};

// ── Pipeline stages ───────────────────────────────────────────────────────────
const STAGES = [
  { id: 'root',        label: 'Reproduce Bug' },
  { id: 'search',      label: 'Search (4 branches)' },
  { id: 'stability',   label: 'Stability (5 forks)' },
  { id: 'adversarial', label: 'Adversarial (2 forks)' },
  { id: 'full_suite',  label: 'Full Suite' },
  { id: 'report',      label: 'Ultra Report' },
];

function stageFromNodes(nodes: PatchNode[], runStatus: string): number {
  const types = new Set(nodes.map((n) => n.branch_type));
  if (runStatus === 'complete' || runStatus === 'failed') return 6;
  if (types.has('full_suite')) return 5;
  if (types.has('adversarial')) return 4;
  if (types.has('stability')) return 3;
  if (types.has('search')) return 2;
  if (types.has('root')) return 1;
  return 0;
}

// ── Custom node card ──────────────────────────────────────────────────────────
function PatchNodeCard({ data }: { data: Record<string, unknown> }) {
  const node = data.patchNode as PatchNode;
  const isWinner = data.isWinner as boolean;
  const isSelected = data.isSelected as boolean;
  const color = BRANCH_COLORS[node.branch_type] ?? '#6b7280';
  const isUltra = (node.model_used ?? '').toLowerCase().includes('ultra');

  const isRunning = node.test_result == null || node.status === 'pending' || node.status === 'running';
  const isPass = node.test_result === 'pass';
  const isError = node.test_result === 'error' || node.test_result === 'timeout';

  const modelShort = node.model_used && node.model_used !== 'none'
    ? node.model_used.split('/').pop()?.slice(0, 24)
    : 'No model';

  const totalTokens = (node.tokens_in ?? 0) + (node.tokens_out ?? 0);

  return (
    <>
      <Handle type="target" position={Position.Top}
        style={{ background: color, border: 'none', width: 8, height: 8 }} />
      <div
        className={`pnode${isSelected ? ' pnode--selected' : ''}${isWinner ? ' pnode--winner' : ''}${isUltra ? ' pnode--ultra' : ''}${isRunning ? ' pnode--running' : ''}`}
        style={{ '--branch-color': color } as React.CSSProperties}
      >
        {isWinner && <div className="pnode__winner-badge">{isUltra ? '🏆 Winner ⚡ ULTRA' : '🏆 Winner'}</div>}
        {isUltra && !isWinner && <div className="pnode__ultra-badge">⚡ ULTRA 550B</div>}
        
        <div className="pnode__header">
          <span className="pnode__type">{BRANCH_LABELS[node.branch_type]}</span>
          <span className={`pnode__badge ${
            isRunning ? 'pnode__badge--running' : isPass ? 'pnode__badge--pass' : isError ? 'pnode__badge--error' : 'pnode__badge--fail'
          }`}>
            {isRunning ? (
              <span className="flex-center"><Loader size={9} className="spin" /> RUNNING</span>
            ) : isPass ? (
              '✓ PASS'
            ) : isError ? (
              '⚠ ERROR'
            ) : (
              '✗ FAIL'
            )}
          </span>
        </div>

        <div className="pnode__model" title={node.model_used}>
          {modelShort}
        </div>

        {node.branch_type === 'stability' && node.stability_runs != null && (
          <div className="pnode__stability">{node.stability_passes}/{node.stability_runs} ✓</div>
        )}
        {node.branch_type === 'adversarial' && (
          <div className={`pnode__stability ${isPass ? '' : 'pnode__stability--fail'}`}>
            {isRunning ? '⚔️ Probing patch…' : isPass ? '🛡 Survived' : '💥 Broke patch'}
          </div>
        )}

        {totalTokens > 0 && (
          <div className="pnode__tokens">
            <Zap size={9} />
            <span>{totalTokens} tok</span>
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Bottom}
        style={{ background: color, border: 'none', width: 8, height: 8 }} />
    </>
  );
}

const nodeTypes: NodeTypes = { patchNode: PatchNodeCard };

// ── Pipeline stepper ──────────────────────────────────────────────────────────
function PipelineStepper({ currentStage, elapsed }: { currentStage: number; elapsed: number }) {
  return (
    <div className="stepper">
      {STAGES.map((s, i) => {
        const done = i < currentStage;
        const active = i === currentStage;
        return (
          <div key={s.id} className={`step ${done ? 'step--done' : active ? 'step--active' : ''}`}>
            <div className="step__icon">
              {done ? <CheckCircle size={13} /> : active ? <Loader size={13} className="spin" /> : <span>{i + 1}</span>}
            </div>
            <span className="step__label">{s.label}</span>
            {i < STAGES.length - 1 && <div className="step__line" />}
          </div>
        );
      })}
      {elapsed > 0 && (
        <div className="stepper__timer"><Clock size={12} />{elapsed}s</div>
      )}
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [run, setRun] = useState<Run | null>(null);
  const [patchNodes, setPatchNodes] = useState<PatchNode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showNewRun, setShowNewRun] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [backendOnline, setBackendOnline] = useState(false);
  const [offlineBanner, setOfflineBanner] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [startTs, setStartTs] = useState<number | null>(null);

  const pollCancelRef = useRef<(() => void) | null>(null);

  // Health check on mount + every 10s
  useEffect(() => {
    const ping = async () => setBackendOnline(await checkHealth());
    ping();
    const t = setInterval(ping, 10000);
    return () => clearInterval(t);
  }, []);

  // Elapsed timer while running
  useEffect(() => {
    if (!loading || startTs == null) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startTs) / 1000)), 1000);
    return () => clearInterval(t);
  }, [loading, startTs]);

  const syncUrlAndStorage = useCallback((runId: string) => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('run', runId);
      window.history.replaceState(null, '', url.toString());
      localStorage.setItem('patchtree_active_run_id', runId);
    } catch {}
  }, []);

  const loadMock = useCallback(() => {
    if (pollCancelRef.current) {
      pollCancelRef.current();
      pollCancelRef.current = null;
    }
    resetLayoutCache();
    setRun(mockData.run);
    setPatchNodes(mockData.nodes);
    setSelectedId(null);
    setOfflineBanner(false);
    setShowNewRun(false);
    syncUrlAndStorage(mockData.run.run_id);
  }, [syncUrlAndStorage]);

  const selectRun = useCallback(async (runId: string) => {
    if (pollCancelRef.current) {
      pollCancelRef.current();
      pollCancelRef.current = null;
    }
    resetLayoutCache();
    setSelectedId(null);
    syncUrlAndStorage(runId);

    if (runId === 'demo-run-001' || runId === 'mock-001') {
      loadMock();
      return;
    }

    setLoading(true);
    try {
      const [fetchedRun, treeNodes] = await Promise.all([getRun(runId), getTree(runId)]);
      setRun(fetchedRun);
      setPatchNodes(treeNodes);
      setOfflineBanner(false);

      if (fetchedRun.status === 'running') {
        const { promise, cancel } = pollUntilComplete(runId, (r, ns) => {
          setRun(r);
          setPatchNodes(ns);
        });
        pollCancelRef.current = cancel;
        await promise;
      }
    } catch (err) {
      console.warn('Failed to load selected run:', err);
      setOfflineBanner(true);
    } finally {
      setLoading(false);
      pollCancelRef.current = null;
    }
  }, [loadMock, syncUrlAndStorage]);

  // Restore run from URL or localStorage on initial mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const targetId = params.get('run') || localStorage.getItem('patchtree_active_run_id');
    if (targetId) {
      selectRun(targetId);
    }
  }, [selectRun]);

  const startRun = useCallback(async (payload: RunCreate) => {
    if (pollCancelRef.current) {
      pollCancelRef.current();
      pollCancelRef.current = null;
    }
    resetLayoutCache();
    setShowNewRun(false);
    setLoading(true);
    setStartTs(Date.now());
    setElapsed(0);
    setRun(null);
    setPatchNodes([]);
    setSelectedId(null);
    try {
      const newRun = await createRun(payload);
      setRun(newRun);
      syncUrlAndStorage(newRun.run_id);
      const { promise, cancel } = pollUntilComplete(newRun.run_id, (r, ns) => {
        setRun(r);
        setPatchNodes(ns);
      });
      pollCancelRef.current = cancel;
      await promise;
    } catch (e) {
      setOfflineBanner(true);
    } finally {
      setLoading(false);
      setStartTs(null);
      pollCancelRef.current = null;
    }
  }, [syncUrlAndStorage]);

  // Build RF nodes/edges via dagre layout
  const { rfNodes, rfEdges } = useMemo(() => {
    if (patchNodes.length === 0) return { rfNodes: [], rfEdges: [] };
    const layout = computeLayout(patchNodes);
    const rfNodes: RFNode[] = patchNodes.map((n) => {
      const pos = layout.get(n.node_id) ?? { x: 0, y: 0 };
      return {
        id: n.node_id, type: 'patchNode', position: pos,
        data: { patchNode: n, isWinner: n.node_id === run?.winner_node_id, isSelected: n.node_id === selectedId },
        style: { width: NODE_W, height: NODE_H },
      };
    });
    const rfEdges: Edge[] = patchNodes
      .filter((n) => n.parent_node_id)
      .map((n) => {
        const isRunning = n.test_result == null || n.status === 'pending' || n.status === 'running';
        const isPass = n.test_result === 'pass';
        const isFail = n.test_result === 'fail';

        let strokeColor = BRANCH_COLORS[n.branch_type] ?? 'var(--border-subtle, #334155)';
        if (isPass) strokeColor = 'var(--pass, #10b981)';
        else if (isFail) strokeColor = 'var(--fail, #ef4444)';
        else if (isRunning) strokeColor = 'var(--accent, #6366f1)';

        return {
          id: `e-${n.parent_node_id}-${n.node_id}`,
          source: n.parent_node_id!,
          target: n.node_id,
          type: 'smoothstep',
          style: {
            stroke: strokeColor,
            strokeWidth: isPass ? 2.5 : 2,
            filter: isPass
              ? 'drop-shadow(0 0 4px rgba(16, 185, 129, 0.45))'
              : isRunning
              ? 'drop-shadow(0 0 4px rgba(99, 102, 241, 0.4))'
              : undefined,
          },
          animated: isRunning || isPass,
        };
      });
    return { rfNodes, rfEdges };
  }, [patchNodes, selectedId, run?.winner_node_id]);

  const selectedNode = patchNodes.find((n) => n.node_id === selectedId) ?? null;
  const onNodeClick = useCallback((_: unknown, node: RFNode) => {
    setSelectedId((prev) => (prev === node.id ? null : node.id));
  }, []);
  const currentStage = stageFromNodes(patchNodes, run?.status ?? '');

  return (
    <div className="app">
      {/* ── Top Bar ── */}
      <header className="topbar">
        <div className="topbar__brand">
          <GitBranch size={20} className="topbar__icon" />
          <span className="topbar__title">PatchTree</span>
          <span className={`conn-badge ${backendOnline ? 'conn-badge--on' : 'conn-badge--off'}`}>
            {backendOnline ? '🟢 Connected' : '🔴 Offline'}
          </span>
        </div>

        {run && (
          <div className="topbar__telemetry">
            <div className="telemetry__item">
              <Zap size={13} />
              <span className={`telemetry__status telemetry__status--${run.status}`}>{run.status.toUpperCase()}</span>
            </div>
            {run.total_cost_usd != null && (
              <div className="telemetry__item"><DollarSign size={13} /><span>${run.total_cost_usd.toFixed(4)}</span></div>
            )}
            {run.total_wall_time_seconds != null && (
              <div className="telemetry__item"><Clock size={13} /><span>{run.total_wall_time_seconds.toFixed(1)}s</span></div>
            )}
            {run.confidence_score != null && (
              <div className="telemetry__item telemetry__item--highlight">
                <Percent size={13} />
                <span>{Math.round(run.confidence_score <= 1 ? run.confidence_score * 100 : run.confidence_score)}%</span>
              </div>
            )}
          </div>
        )}

        <div className="topbar__controls">
          <button className="btn btn--secondary" onClick={() => setShowHistory(true)} title="View run history">
            <History size={14} /> History
          </button>
          {(run?.confidence_report || run?.status === 'complete' || run?.status === 'failed') && (
            <button className="btn btn--ghost" onClick={() => setShowReport(true)}>
              <Shield size={14} /> View Report
            </button>
          )}
          <button className="btn btn--primary" onClick={() => setShowNewRun(true)} disabled={loading}>
            <Plus size={14} /> New Run
          </button>
        </div>
      </header>

      {/* ── Offline banner ── */}
      {offlineBanner && (
        <div className="offline-banner">
          ⚠ Backend not detected at <code>{import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000'}</code>. Ensure the FastAPI server is running.
        </div>
      )}

      {/* ── Pipeline stepper (only while running) ── */}
      {(loading || (run && patchNodes.length > 0)) && (
        <PipelineStepper currentStage={currentStage} elapsed={loading ? elapsed : 0} />
      )}

      {/* ── Legend ── */}
      {patchNodes.length > 0 && (
        <div className="legend">
          {Object.entries(BRANCH_LABELS).map(([type, label]) => (
            <div key={type} className="legend__item">
              <span className="legend__dot" style={{ background: BRANCH_COLORS[type] }} />{label}
            </div>
          ))}
          <div className="legend__item">
            <span className="legend__dot legend__dot--animated" />Animated = PASS
          </div>
        </div>
      )}

      {/* ── Canvas ── */}
      <main className="canvas-wrap">
        {patchNodes.length === 0 ? (
          <div className="empty-state">
            <GitBranch size={52} className="empty-state__icon" />
            <h2>No run loaded</h2>
            {loading ? (
              <p><Loader size={16} className="spin" /> Pipeline executing…</p>
            ) : (
              <p>
                Click <strong>+ New Run</strong> to initiate an automated patch repair on a GitHub repository,<br />
                or explore previous executions from <strong>History</strong>.
              </p>
            )}
          </div>
        ) : (
          <ReactFlow
            nodes={rfNodes} edges={rfEdges} nodeTypes={nodeTypes}
            onNodeClick={onNodeClick} fitView fitViewOptions={{ padding: 0.15 }}
            minZoom={0.25} maxZoom={2} proOptions={{ hideAttribution: true }}
          >
            <Background color="#1e293b" gap={24} />
            <Controls style={{ background: '#1e293b', borderColor: '#334155' }} />
            <MiniMap
              nodeColor={(n) => BRANCH_COLORS[(n.data as { patchNode: PatchNode }).patchNode?.branch_type] ?? '#6b7280'}
              style={{ background: '#0f172a', borderColor: '#334155' }}
            />
          </ReactFlow>
        )}
        {selectedNode && <NodeInspector node={selectedNode} onClose={() => setSelectedId(null)} />}
      </main>

      {/* ── Modals ── */}
      {showHistory && (
        <HistorySidebar
          currentRunId={run?.run_id}
          onSelectRun={selectRun}
          onClose={() => setShowHistory(false)}
        />
      )}
      {showNewRun && (
        <NewRunModal
          backendOnline={backendOnline}
          onSubmit={startRun}
          onClose={() => setShowNewRun(false)}
        />
      )}
      {showReport && run && <ReportModal run={run} onClose={() => setShowReport(false)} />}
    </div>
  );
}
