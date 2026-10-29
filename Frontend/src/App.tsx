import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap, useReactFlow,
  type Node as RFNode, type Edge, type NodeTypes, type EdgeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { PatchNode, Run, RunCreate } from './types';
import { mockData } from './mockData';
import { checkHealth, createRun, getRun, getTree, pollUntilComplete, HttpError } from './api';
import { computeLayout, resetLayoutCache, NODE_W, NODE_H } from './layout';
import NewRunModal from './components/NewRunModal';
import ReportModal from './components/ReportModal';
import NodeInspector from './components/NodeInspector';
import HistorySidebar from './components/HistorySidebar';
import PNode from './components/PNode';
import ParticleEdge from './components/ParticleEdge';
import Launchpad, { type PresetDef } from './components/Launchpad';
import TopBar from './components/TopBar';
import CanvasLegend from './components/CanvasLegend';
import './App.css';
import './patchtree-ui.css';
import './patchtree-hud.css';

// ── Branch config ─────────────────────────────────────────────────────────────
const BRANCH_COLORS: Record<string, string> = {
  root: '#8b8cf8',
  search: '#38bdf8',
  stability: '#10b981',
  adversarial: '#fb5a3c',
  full_suite: '#a78bfa',
  ultra: '#e879f9',
};
const BRANCH_LABELS: Record<string, string> = {
  root: 'Root',
  search: 'Search',
  stability: 'Stability',
  adversarial: 'Adversarial',
  full_suite: 'Full Suite',
};

interface StageItem {
  id: string;
  label: string;
}

function stageFromNodes(nodes: PatchNode[], runStatus: string, hasFullSuite: boolean): number {
  const finalStage = hasFullSuite ? 6 : 5;
  if (runStatus === 'complete' || runStatus === 'failed') return finalStage;
  const types = new Set(nodes.map((n) => n.branch_type));
  if (hasFullSuite && types.has('full_suite')) return 5;
  if (types.has('adversarial')) return 4;
  if (types.has('stability')) return 3;
  if (types.has('root')) return 1;
  return 0;
}

function getOrCreateClientId(): string {
  try {
    let cid = localStorage.getItem('patchtree_client_id');
    if (!cid) {
      cid = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : 'client-' + Math.random().toString(36).substring(2, 12);
      localStorage.setItem('patchtree_client_id', cid);
    }
    return cid;
  } catch {
    return 'anon-client';
  }
}

const nodeTypes: NodeTypes = { patchNode: PNode };
const edgeTypes: EdgeTypes = { particle: ParticleEdge };

function CanvasAutoFit({ runId, nodeCount }: { runId?: string; nodeCount: number }) {
  const { fitView } = useReactFlow();
  const prevCount = useRef(0);

  useEffect(() => {
    if (nodeCount > 0 && (nodeCount !== prevCount.current || nodeCount === 1)) {
      prevCount.current = nodeCount;
      const t = setTimeout(() => {
        fitView({ padding: 0.22, duration: 400 });
      }, 100);
      return () => clearTimeout(t);
    }
  }, [runId, nodeCount, fitView]);

  return null;
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
  const [initialModalValues, setInitialModalValues] = useState<Partial<RunCreate>>({});

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
    } catch {
      /* ignore storage/URL sync errors */
    }
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
      if (treeNodes && treeNodes.length > 0) {
        setPatchNodes(treeNodes);
      } else if (fetchedRun.status === 'running') {
        const initialRootNode: PatchNode = {
          node_id: 'root-init',
          run_id: runId,
          parent_node_id: null,
          branch_type: 'root',
          hypothesis: `Cloning ${fetchedRun.repo_url} & executing reproduction test...`,
          patch_diff: '',
          test_command: fetchedRun.target_test || 'pytest',
          test_result: null,
          test_output: 'Sandbox microVM executing reproduction command:\n$ ' + (fetchedRun.target_test || 'pytest'),
          model_used: 'none',
          status: 'running',
        };
        setPatchNodes([initialRootNode]);
        setSelectedId('root-init');
      } else {
        setPatchNodes([]);
      }
      setOfflineBanner(false);

      if (fetchedRun.status === 'running') {
        const { promise, cancel } = pollUntilComplete(runId, (r, ns) => {
          setRun(r);
          if (ns && ns.length > 0) {
            setPatchNodes(ns);
          }
        });
        pollCancelRef.current = cancel;
        await promise;
      }
    } catch (err: unknown) {
      console.warn('Failed to load selected run:', err);
      if (err instanceof HttpError && err.status === 404) {
        try {
          localStorage.removeItem('patchtree_active_run_id');
          const cleanUrl = new URL(window.location.href);
          cleanUrl.searchParams.delete('run');
          window.history.replaceState(null, '', cleanUrl.pathname + (cleanUrl.search ? cleanUrl.search : ''));
        } catch {
          // ignore
        }
        setRun(null);
        setPatchNodes([]);
        setOfflineBanner(false);
      } else {
        const isOnline = await checkHealth();
        setOfflineBanner(!isOnline);
      }
    } finally {
      setLoading(false);
      pollCancelRef.current = null;
    }
  }, [loadMock, syncUrlAndStorage]);

  const resetToHome = useCallback(() => {
    if (pollCancelRef.current) {
      pollCancelRef.current();
      pollCancelRef.current = null;
    }
    resetLayoutCache();
    setRun(null);
    setPatchNodes([]);
    setSelectedId(null);
    try {
      localStorage.removeItem('patchtree_active_run_id');
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete('run');
      window.history.replaceState(null, '', cleanUrl.pathname);
    } catch {
      /* ignore URL/storage cleanup errors */
    }
  }, []);

  // Restore run ONLY when explicitly passed in URL query param (?run=...)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const targetId = params.get('run');
    if (targetId) {
      let active = true;
      (async () => {
        if (active) await selectRun(targetId);
      })();
      return () => {
        active = false;
      };
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

    // Instant UI feedback: spawn live placeholder Root node so screen shifts to canvas immediately
    const initialRootNode: PatchNode = {
      node_id: 'root-init',
      run_id: 'pending',
      parent_node_id: null,
      branch_type: 'root',
      hypothesis: `Initializing cloud sandbox for ${payload.repo_url.split('/').slice(-2).join('/')} & executing reproduction test...`,
      patch_diff: '',
      test_command: payload.target_test,
      test_result: null,
      test_output: 'Sandbox container spawning...\nExecuting reproduction command:\n$ ' + payload.target_test,
      model_used: 'none',
      status: 'running',
    };
    setPatchNodes([initialRootNode]);
    setSelectedId('root-init');

    try {
      const clientId = getOrCreateClientId();
      const newRun = await createRun({ ...payload, client_id: clientId });
      setRun(newRun);
      setOfflineBanner(false);
      syncUrlAndStorage(newRun.run_id);
      const { promise, cancel } = pollUntilComplete(newRun.run_id, (r, ns) => {
        setRun(r);
        if (ns && ns.length > 0) {
          setPatchNodes(ns);
        }
      });
      pollCancelRef.current = cancel;
      await promise;
    } catch {
      const isOnline = await checkHealth();
      setOfflineBanner(!isOnline);
    } finally {
      setLoading(false);
      setStartTs(null);
      pollCancelRef.current = null;
    }
  }, [syncUrlAndStorage]);

  // Determine whether this run includes a full suite command/branch
  const hasFullSuite = Boolean(
    run?.full_suite_test ||
    run?.full_suite_result ||
    patchNodes.some((n) => n.branch_type === 'full_suite')
  );

  const stages: StageItem[] = useMemo(() => [
    { id: 'root',        label: 'Reproduce Bug' },
    { id: 'search',      label: 'Search (4 branches)' },
    { id: 'stability',   label: 'Stability (5 forks)' },
    { id: 'adversarial', label: 'Adversarial (2 forks)' },
    ...(hasFullSuite ? [{ id: 'full_suite', label: 'Full Suite' }] : []),
    { id: 'report',      label: 'Ultra Report' },
  ], [hasFullSuite]);

  const activeLabels = useMemo(() => {
    if (hasFullSuite) return BRANCH_LABELS;
    const { full_suite: _, ...rest } = BRANCH_LABELS;
    return rest;
  }, [hasFullSuite]);

  // Ancestors of winner for primary golden spine
  const winnerNodeId = run?.winner_node_id;
  const winningPathIds = useMemo(() => {
    if (!winnerNodeId) return new Set<string>();
    const set = new Set<string>();
    let curr: string | undefined = winnerNodeId;
    while (curr) {
      set.add(curr);
      const parent = patchNodes.find((p) => p.node_id === curr)?.parent_node_id;
      curr = parent ?? undefined;
    }
    return set;
  }, [winnerNodeId, patchNodes]);

  // Active verification nodes: root, winning search branch, and all verification tests (stability, adversarial, full_suite)
  const activeNodeIds = useMemo(() => {
    if (!winnerNodeId) return new Set(patchNodes.map((n) => n.node_id));
    const set = new Set<string>();
    let curr: string | undefined = winnerNodeId;
    while (curr) {
      set.add(curr);
      const parent = patchNodes.find((p) => p.node_id === curr)?.parent_node_id;
      curr = parent ?? undefined;
    }
    for (const n of patchNodes) {
      if (
        n.parent_node_id === winnerNodeId ||
        n.branch_type === 'stability' ||
        n.branch_type === 'adversarial' ||
        n.branch_type === 'full_suite'
      ) {
        set.add(n.node_id);
      }
    }
    return set;
  }, [winnerNodeId, patchNodes]);

  // Build RF nodes/edges via dagre layout
  const { rfNodes, rfEdges } = useMemo(() => {
    if (patchNodes.length === 0) return { rfNodes: [], rfEdges: [] };
    const layout = computeLayout(patchNodes);
    const hasWinner = Boolean(run?.winner_node_id);

    const rfNodes: RFNode[] = patchNodes.map((n, i) => {
      const pos = layout.get(n.node_id) ?? { x: 0, y: 0 };
      const isWinner = n.node_id === run?.winner_node_id;
      const isDimmed = hasWinner && !activeNodeIds.has(n.node_id);
      return {
        id: n.node_id,
        type: 'patchNode',
        position: pos,
        data: {
          patchNode: n,
          isWinner,
          isSelected: n.node_id === selectedId,
          isDimmed,
          index: i,
        },
        style: { width: NODE_W, height: NODE_H },
      };
    });

    const rfEdges: Edge[] = patchNodes
      .filter((n) => n.parent_node_id)
      .map((n) => {
        const isRunning = n.test_result == null || n.status === 'pending' || n.status === 'running';
        const isPass = n.test_result === 'pass';
        const isFail = n.test_result === 'fail';
        const isWinningEdge =
          (winningPathIds.has(n.node_id) && winningPathIds.has(n.parent_node_id!)) ||
          (n.parent_node_id === run?.winner_node_id);

        let state: 'running' | 'winner' | 'done' | 'failed' | 'idle' = 'idle';
        if (isWinningEdge && run?.winner_node_id) {
          state = 'winner';
        } else if (isRunning) {
          state = 'running';
        } else if (isPass) {
          state = 'done';
        } else if (isFail) {
          state = 'failed';
        }

        return {
          id: `e-${n.parent_node_id}-${n.node_id}`,
          source: n.parent_node_id!,
          target: n.node_id,
          type: 'particle',
          data: { state },
          className: hasWinner && !activeNodeIds.has(n.node_id) ? 'is-dim' : undefined,
        };
      });

    return { rfNodes, rfEdges };
  }, [patchNodes, selectedId, run?.winner_node_id, winningPathIds, activeNodeIds]);

  const selectedNode = patchNodes.find((n) => n.node_id === selectedId) ?? null;
  const onNodeClick = useCallback((_: unknown, node: RFNode) => {
    setSelectedId((prev) => (prev === node.id ? null : node.id));
  }, []);
  const currentStage = stageFromNodes(patchNodes, run?.status ?? '', hasFullSuite);

  const handleCustomRepo = useCallback((repoUrl: string) => {
    setInitialModalValues({
      repo_url: repoUrl,
      bug_description: '',
      target_test: 'pytest',
      full_suite_test: '',
    });
    setShowNewRun(true);
  }, []);

  const handleSimulatePreset = useCallback(() => {
    loadMock();
  }, [loadMock]);

  const handleConfigurePreset = useCallback((preset: PresetDef) => {
    setInitialModalValues({
      repo_url: preset.repo,
      bug_description: preset.bugDesc,
      target_test: preset.testCmd,
      full_suite_test: preset.fullSuiteCmd || '',
    });
    setShowNewRun(true);
  }, []);

  return (
    <div className="app">
      {/* ── Top Bar HUD ── */}
      <TopBar
        backendOnline={backendOnline}
        loading={loading}
        run={run}
        elapsed={elapsed}
        stages={stages}
        currentStage={currentStage}
        hasNodes={patchNodes.length > 0}
        onHome={resetToHome}
        onHistory={() => setShowHistory(true)}
        onReport={() => setShowReport(true)}
        onNewRun={() => setShowNewRun(true)}
      />

      {/* ── Offline banner ── */}
      {offlineBanner && (
        <div className="offline-banner">
          ⚠ Backend not detected at <code>{import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000'}</code>. Ensure the FastAPI server is running.
        </div>
      )}

      {/* ── Canvas ── */}
      <main className="canvas-wrap pt-canvas" data-run={patchNodes.length === 0 ? 'empty' : loading ? 'running' : 'done'}>
        {!run && !loading && patchNodes.length === 0 ? (
          <Launchpad
            onCustomRepo={handleCustomRepo}
            onSimulatePreset={handleSimulatePreset}
            onConfigurePreset={handleConfigurePreset}
          />
        ) : (
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodeClick={onNodeClick}
            fitView
            fitViewOptions={{ padding: 0.18 }}
            minZoom={0.25}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
          >
            <CanvasAutoFit runId={run?.run_id} nodeCount={rfNodes.length} />
            <Background color="#151b28" gap={24} />
            <Controls style={{ background: '#0e121b', borderColor: '#1e2638' }} />
            <MiniMap
              nodeColor={(n) => BRANCH_COLORS[(n.data as { patchNode: PatchNode }).patchNode?.branch_type] ?? '#6b7280'}
              style={{ background: '#07090e', borderColor: '#1e2638' }}
            />
            {patchNodes.length > 0 && <CanvasLegend colors={BRANCH_COLORS} labels={activeLabels} />}
          </ReactFlow>
        )}
        {selectedNode && <NodeInspector node={selectedNode} onClose={() => setSelectedId(null)} />}
      </main>

      {/* ── Modals ── */}
      {showHistory && (
        <HistorySidebar
          currentRunId={run?.run_id}
          clientId={getOrCreateClientId()}
          onSelectRun={selectRun}
          onClose={() => setShowHistory(false)}
        />
      )}
      {showNewRun && (
        <NewRunModal
          backendOnline={backendOnline}
          onSubmit={startRun}
          onClose={() => {
            setShowNewRun(false);
            setInitialModalValues({});
          }}
          initialValues={initialModalValues}
        />
      )}
      {showReport && run && <ReportModal run={run} onClose={() => setShowReport(false)} />}
    </div>
  );
}
