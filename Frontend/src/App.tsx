import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  ReactFlow,
  Controls,
  useReactFlow,
  useStore,
  type Node as RFNode,
  type Edge,
  type NodeTypes,
  type EdgeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { LayoutList, Plus, Command, Settings, Search } from 'lucide-react';
import type { PatchNode, Run, RunCreate } from './types';
import { mockData } from './mockData';
import { nodeNames } from './nodeNames';
import { checkHealth, createRun, getRun, getTree, pollUntilComplete, HttpError } from './api';
import { computeLayout, resetLayoutCache, NODE_W, NODE_H } from './layout';
import NewRunModal from './components/NewRunModal';
import ReportModal from './components/ReportModal';
import NodeInspector from './components/NodeInspector';
import HistorySidebar from './components/HistorySidebar';
import SettingsModal from './components/SettingsModal';
import PNode from './components/PNode';
import ParticleEdge from './components/ParticleEdge';
import Launchpad from './components/Launchpad';
import { PRESETS, type PresetDef } from './presets';
import TopBar from './components/TopBar';
import './styles/tokens.css';
import './App.css';

interface StageItem {
  id: string;
  label: string;
}

function stageFromNodes(nodes: PatchNode[], runStatus: string, hasFullSuite: boolean): number {
  const reportIdx = hasFullSuite ? 5 : 4;
  if (runStatus === 'complete') return reportIdx + 1;

  const hasSuite = hasFullSuite && nodes.some((n) => n.branch_type === 'full_suite');
  const hasAdversarial = nodes.some((n) => n.branch_type === 'adversarial');
  const hasStability = nodes.some((n) => n.branch_type === 'stability');
  const searchNodes = nodes.filter((n) => n.branch_type === 'search');
  const rootReproduced = nodes.some(
    (n) => n.branch_type === 'root' && n.status === 'done' && n.test_result === 'fail',
  );

  if (hasSuite) return runStatus === 'failed' ? 4 : 5;
  if (hasAdversarial) return runStatus === 'failed' ? 3 : 4;
  if (hasStability) {
    const anyStable = searchNodes.some((n) => n.is_stable);
    return runStatus === 'failed' || !anyStable ? 2 : 3;
  }
  if (searchNodes.length > 0) {
    const anyPass = searchNodes.some((n) => n.test_result === 'pass');
    return runStatus === 'failed' || !anyPass ? 1 : 2;
  }
  if (rootReproduced) return 1;
  return 0;
}

function getOrCreateClientId(): string {
  try {
    let cid = localStorage.getItem('patchtree_client_id');
    if (!cid) {
      cid =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : 'client-' + Math.random().toString(36).substring(2, 12);
      localStorage.setItem('patchtree_client_id', cid);
    }
    return cid;
  } catch {
    return 'anon-client';
  }
}

const nodeTypes: NodeTypes = { patchNode: PNode };
const edgeTypes: EdgeTypes = { particle: ParticleEdge };

const PHASE_LABELS: Record<string, string> = {
  root: 'Reproduce',
  search: 'Search',
  stability: 'Stability',
  adversarial: 'Adversarial',
  full_suite: 'Full suite',
};

// Labels pinned to the left edge; vertical position follows the zoom/pan of each phase row.
function PhaseLabels({ nodes }: { nodes: RFNode[] }) {
  const ty = useStore((s) => s.transform[1]);
  const zoom = useStore((s) => s.transform[2]);
  const rows = new Map<string, number>();
  for (const n of nodes) {
    const t = (n.data as { patchNode?: PatchNode }).patchNode?.branch_type;
    if (t && (!rows.has(t) || n.position.y < rows.get(t)!)) rows.set(t, n.position.y);
  }
  return (
    <div className="phase-labels-col" aria-hidden="true">
      {[...rows].map(([t, y]) => (
        <span
          key={t}
          className="phase-labels-col__item"
          style={{ top: y * zoom + ty + (NODE_H * zoom) / 2 - 10 }}
        >
          {PHASE_LABELS[t]}
        </span>
      ))}
    </div>
  );
}
function CanvasAutoFit({
  runId,
  nodeCount,
  focusPhase,
  nodes,
}: {
  runId?: string;
  nodeCount: number;
  focusPhase: string | null;
  nodes: RFNode[];
}) {
  const { fitView } = useReactFlow();
  const prevCount = useRef(0);

  useEffect(() => {
    if (nodeCount > 0 && (nodeCount !== prevCount.current || nodeCount === 1)) {
      prevCount.current = nodeCount;
      const t = setTimeout(() => {
        fitView({ padding: 0.2, duration: 150 });
      }, 60);
      return () => clearTimeout(t);
    }
  }, [runId, nodeCount, fitView]);

  useEffect(() => {
    if (!focusPhase || nodes.length === 0) return;
    const matching = nodes.filter((n) => {
      const pn = (n.data as { patchNode?: PatchNode }).patchNode;
      return pn?.branch_type === focusPhase;
    });
    if (matching.length > 0) {
      fitView({ nodes: matching, padding: 0.35, duration: 150 });
    } else {
      fitView({ padding: 0.2, duration: 150 });
    }
  }, [focusPhase, nodes, fitView]);

  return null;
}

interface PaletteAction {
  id: string;
  label: string;
  shortcut?: string;
}

export default function App() {
  const [run, setRun] = useState<Run | null>(null);
  const [patchNodes, setPatchNodes] = useState<PatchNode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showNewRun, setShowNewRun] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [backendOnline, setBackendOnline] = useState(false);
  const [offlineBanner, setOfflineBanner] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [startTs, setStartTs] = useState<number | null>(null);
  const [initialModalValues, setInitialModalValues] = useState<Partial<RunCreate>>({});
  const [focusPhase, setFocusPhase] = useState<string | null>(null);

  const pollCancelRef = useRef<(() => void) | null>(null);

  const pingBackend = useCallback(async () => {
    const ok = await checkHealth();
    setBackendOnline(ok);
    if (ok) setOfflineBanner(false);
    return ok;
  }, []);

  useEffect(() => {
    const t = setInterval(pingBackend, 10000);
    const first = setTimeout(pingBackend, 0);
    return () => {
      clearInterval(t);
      clearTimeout(first);
    };
  }, [pingBackend]);

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
      /* ignore */
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

  const selectRun = useCallback(
    async (runId: string) => {
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
            hypothesis: `Cloning ${fetchedRun.repo_url} and running reproduction test...`,
            patch_diff: '',
            test_command: fetchedRun.target_test || 'pytest',
            test_result: null,
            test_output:
              'Running reproduction command in clean cloud VM:\n$ ' +
              (fetchedRun.target_test || 'pytest'),
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
        if (err instanceof HttpError && err.status === 404) {
          try {
            localStorage.removeItem('patchtree_active_run_id');
            const cleanUrl = new URL(window.location.href);
            cleanUrl.searchParams.delete('run');
            window.history.replaceState(
              null,
              '',
              cleanUrl.pathname + (cleanUrl.search ? cleanUrl.search : ''),
            );
          } catch {
            /* ignore */
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
    },
    [loadMock, syncUrlAndStorage],
  );

  const resetToHome = useCallback(() => {
    if (pollCancelRef.current) {
      pollCancelRef.current();
      pollCancelRef.current = null;
    }
    resetLayoutCache();
    setRun(null);
    setPatchNodes([]);
    setSelectedId(null);
    setShowReport(false);
    try {
      localStorage.removeItem('patchtree_active_run_id');
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete('run');
      window.history.replaceState(null, '', cleanUrl.pathname);
    } catch {
      /* ignore */
    }
  }, []);

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

  const startRun = useCallback(
    async (payload: RunCreate) => {
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

      const initialRootNode: PatchNode = {
        node_id: 'root-init',
        run_id: 'pending',
        parent_node_id: null,
        branch_type: 'root',
        hypothesis: `Cloning ${payload.repo_url.split('/').slice(-2).join('/')} and running reproduction test...`,
        patch_diff: '',
        test_command: payload.target_test,
        test_result: null,
        test_output: 'Starting cloud sandbox...\n$ ' + payload.target_test,
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
      } catch (err) {
        const isOnline = await checkHealth();
        setOfflineBanner(!isOnline);
        const errMsg = err instanceof Error ? err.message : 'Failed to start verification run.';
        setPatchNodes((prev) =>
          prev.map((n) =>
            n.node_id === 'root-init'
              ? {
                  ...n,
                  status: 'done',
                  test_result: 'error',
                  hypothesis: 'Run dispatch rejected',
                  test_output: errMsg,
                }
              : n,
          ),
        );
      } finally {
        setLoading(false);
        setStartTs(null);
        pollCancelRef.current = null;
      }
    },
    [syncUrlAndStorage],
  );

  const hasFullSuite = Boolean(
    run?.full_suite_test ||
      (run?.full_suite_result && run.full_suite_result !== 'skipped') ||
      patchNodes.some((n) => n.branch_type === 'full_suite'),
  );

  const stages: StageItem[] = useMemo(
    () => [
      { id: 'root', label: 'Reproduce' },
      { id: 'search', label: 'Search (4 branches)' },
      { id: 'stability', label: 'Stability (5 forks)' },
      { id: 'adversarial', label: 'Adversarial (2 forks)' },
      ...(hasFullSuite ? [{ id: 'full_suite', label: 'Full suite' }] : []),
      { id: 'report', label: 'Report' },
    ],
    [hasFullSuite],
  );

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

  const { rfNodes, rfEdges } = useMemo(() => {
    if (patchNodes.length === 0) return { rfNodes: [], rfEdges: [] };
    const layout = computeLayout(patchNodes);

    const counters: Record<string, number> = {};

    const rfNodes: RFNode[] = patchNodes.map((n, i) => {
      const pos = layout.get(n.node_id) ?? { x: 0, y: 0 };
      const isWinner = n.node_id === run?.winner_node_id;
      const bType = n.branch_type || 'search';
      const siblingIndex = counters[bType] ?? 0;
      counters[bType] = siblingIndex + 1;

      return {
        id: n.node_id,
        type: 'patchNode',
        position: pos,
        data: {
          patchNode: n,
          isWinner,
          isSelected: n.node_id === selectedId,
          siblingIndex,
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
        const isFail = n.test_result === 'fail' || n.test_result === 'error';
        const isWinningEdge =
          winningPathIds.has(n.node_id) && winningPathIds.has(n.parent_node_id!);

        let state: 'running' | 'winner' | 'done' | 'failed' | 'idle' = 'idle';
        if (isWinningEdge && run?.winner_node_id) {
          state = 'winner';
        } else if (isRunning) {
          state = 'running';
        } else if (isFail) {
          state = 'failed';
        } else if (isPass) {
          state = 'done';
        }

        return {
          id: `e-${n.parent_node_id}-${n.node_id}`,
          source: n.parent_node_id!,
          target: n.node_id,
          type: 'particle',
          data: { state },
        };
      });

    return { rfNodes, rfEdges };
  }, [patchNodes, selectedId, run?.winner_node_id, winningPathIds]);

  const selectedNode = patchNodes.find((n) => n.node_id === selectedId) ?? null;
  const onNodeClick = useCallback((_: unknown, node: RFNode) => {
    setSelectedId((prev) => (prev === node.id ? null : node.id));
  }, []);
  const currentStage = stageFromNodes(patchNodes, run?.status ?? '', hasFullSuite);

  const handleCustomRepo = useCallback((repoUrl: string) => {
    const normalized =
      repoUrl && /^github\.com\//i.test(repoUrl.trim())
        ? `https://${repoUrl.trim()}`
        : repoUrl.trim();
    setInitialModalValues({
      repo_url: normalized,
      bug_description: '',
      target_test: 'pytest',
      full_suite_test: '',
    });
    setShowNewRun(true);
  }, []);

  const handleConfigurePreset = useCallback((preset: PresetDef) => {
    setInitialModalValues({
      repo_url: preset.repo,
      bug_description: preset.bugDesc,
      target_test: preset.testCmd,
      full_suite_test: preset.fullSuiteCmd || '',
    });
    setShowNewRun(true);
  }, []);

  const handleSelectPhase = useCallback(
    (phaseId: string) => {
      if (phaseId === 'report') {
        if (run) setShowReport(true);
        return;
      }
      setFocusPhase(phaseId);
      setTimeout(() => setFocusPhase(null), 250);
    },
    [run],
  );

  const paletteActions: PaletteAction[] = [
    { id: 'new-run', label: 'New run', shortcut: 'N' },
    { id: 'history', label: 'Open history' },
    { id: 'settings', label: 'Open settings', shortcut: ',' },
    { id: 'demo-run', label: 'Open demo run (example/pricing-service)' },
    ...PRESETS.map((p) => ({ id: 'preset-' + p.id, label: 'Load example: ' + p.title })),
  ];

  const runPaletteAction = useCallback((id: string) => {
    setShowPalette(false);
    if (id === 'new-run') {
      setInitialModalValues({});
      setShowNewRun(true);
    } else if (id === 'history') setShowHistory(true);
    else if (id === 'settings') setShowSettings(true);
    else if (id === 'demo-run') loadMock();
    else {
      const preset = PRESETS.find((p) => 'preset-' + p.id === id);
      if (preset) handleConfigurePreset(preset);
    }
  }, [loadMock, handleConfigurePreset]);
  const paletteQ = paletteQuery.trim().toLowerCase();
  const filteredActions = paletteQ
    ? paletteActions.filter((a) => a.label.toLowerCase().includes(paletteQ))
    : paletteActions;

  // Global keyboard shortcuts (Section 11.1)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInput =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setShowPalette((v) => !v);
        setPaletteQuery('');
        setPaletteIndex(0);
        return;
      }

      if (e.key === 'Escape') {
        if (showPalette) {
          setShowPalette(false);
          return;
        }
        if (showNewRun) {
          setShowNewRun(false);
          return;
        }
        if (showReport) {
          setShowReport(false);
          return;
        }
        if (showHistory) {
          setShowHistory(false);
          return;
        }
        if (showSettings) {
          setShowSettings(false);
          return;
        }
        if (selectedId) {
          setSelectedId(null);
          return;
        }
      }

      if (!isInput && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key.toLowerCase() === 'n') {
          if (!showNewRun && !showPalette && !showSettings) {
            e.preventDefault();
            setInitialModalValues({});
            setShowNewRun(true);
          }
        } else if (e.key === ',') {
          if (!showSettings && !showPalette && !showNewRun) {
            e.preventDefault();
            setShowSettings(true);
          }
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showPalette, showNewRun, showReport, showHistory, showSettings, selectedId]);

  const isHome = !run && !loading && patchNodes.length === 0;

  return (
    <div className="app-shell">
      <TopBar
        loading={loading}
        run={run}
        elapsed={elapsed}
        liveCost={patchNodes.reduce((s, n) => s + (n.estimated_cost_usd ?? 0), 0)}
        stages={stages}
        currentStage={currentStage}
        hasNodes={patchNodes.length > 0}
        onHome={resetToHome}
        onHistory={() => setShowHistory(true)}
        onReport={() => setShowReport(true)}
        onNewRun={() => {
          setInitialModalValues({});
          setShowNewRun(true);
        }}
        onSelectPhase={handleSelectPhase}
      />

      <div className="app-body">
        <aside className="left-rail" aria-label="Workspace navigation">
          <div className="left-rail__top">
            <button
              type="button"
              className={`rail-btn ${isHome ? 'is-active' : ''}`}
              onClick={resetToHome}
              aria-label="Runs"
              title="Runs"
            >
              <LayoutList size={16} strokeWidth={1.5} />
            </button>
            <button
              type="button"
              className={`rail-btn ${showNewRun ? 'is-active' : ''}`}
              onClick={() => {
                setInitialModalValues({});
                setShowNewRun(true);
              }}
              aria-label="New run (N)"
              title="New run (N)"
            >
              <Plus size={16} strokeWidth={1.5} />
            </button>
            <button
              type="button"
              className={`rail-btn ${showPalette ? 'is-active' : ''}`}
              onClick={() => {
                setPaletteQuery('');
                setPaletteIndex(0);
                setShowPalette(true);
              }}
              aria-label="Command palette (Ctrl+K)"
              title="Command palette (Ctrl+K)"
            >
              <Command size={16} strokeWidth={1.5} />
            </button>
          </div>

          <div className="left-rail__bottom">
            <button
              type="button"
              className={`rail-btn ${showSettings ? 'is-active' : ''}`}
              onClick={() => setShowSettings(true)}
              aria-label="Settings (,)"
              title="Settings (,)"
            >
              <Settings size={16} strokeWidth={1.5} />
            </button>
          </div>
        </aside>

        <main className="app-main">
          {offlineBanner && (
            <div className="offline-banner" role="alert">
              <span>
                Could not reach the backend at{' '}
                <code>{import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000'}</code>. Check
                that it is running and try again.
              </span>
              <button type="button" className="btn btn--secondary btn--xs" onClick={pingBackend}>
                Try again
              </button>
            </div>
          )}

          {isHome ? (
            <Launchpad
              onCustomRepo={handleCustomRepo}
              onConfigurePreset={handleConfigurePreset}
              onSelectRun={selectRun}
              onOpenHistory={() => setShowHistory(true)}
            />
          ) : (
            <div className="tree-workspace">
              <div className="tree-canvas-wrap">
                <ReactFlow
                  nodes={rfNodes}
                  edges={rfEdges}
                  nodeTypes={nodeTypes}
                  edgeTypes={edgeTypes}
                  onNodeClick={onNodeClick}
                  fitView
                  fitViewOptions={{ padding: 0.2 }}
                  nodesDraggable={false}
                  nodesConnectable={false}
                  elementsSelectable
                  minZoom={0.4}
                  maxZoom={1.5}
                  proOptions={{ hideAttribution: true }}
                  defaultEdgeOptions={{
                    type: 'smoothstep',
                    style: { stroke: '#3A3A3A', strokeWidth: 1 },
                  }}
                >
                  <CanvasAutoFit
                    runId={run?.run_id}
                    nodeCount={rfNodes.length}
                    focusPhase={focusPhase}
                    nodes={rfNodes}
                  />
                  <PhaseLabels nodes={rfNodes} />
                  <Controls showInteractive={true} position="bottom-left" />
                </ReactFlow>
              </div>

              {selectedNode && (
                <NodeInspector key={selectedNode.node_id} node={selectedNode} name={nodeNames(patchNodes).get(selectedNode.node_id) ?? ''} onClose={() => setSelectedId(null)} />
              )}
            </div>
          )}
        </main>
      </div>

      <footer className="statusbar" aria-label="Status bar">
        <div className="statusbar__left">
          <span className="statusbar__item">
            <span className="status-dot" data-status={backendOnline ? 'pass' : 'fail'} />
            <span>Backend: {backendOnline ? 'Connected' : 'Offline'}</span>
          </span>
        </div>
        <div className="statusbar__right">
          <span className="statusbar__item mono">v0.1.0</span>
          <button
            type="button"
            className="statusbar__cmd-btn"
            onClick={() => {
              setPaletteQuery('');
              setPaletteIndex(0);
              setShowPalette(true);
            }}
          >
            Press <kbd>Ctrl+K</kbd> for commands
          </button>
        </div>
      </footer>

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

      {showReport && run && (
        <ReportModal run={run} nodes={patchNodes} onClose={() => setShowReport(false)} />
      )}

      {showPalette && (
        <div className="modal-overlay" onClick={() => setShowPalette(false)}>
          <div
            className="palette"
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setPaletteIndex((i) => (filteredActions.length ? (i + 1) % filteredActions.length : 0));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setPaletteIndex((i) =>
                  filteredActions.length ? (i - 1 + filteredActions.length) % filteredActions.length : 0,
                );
              } else if (e.key === 'Enter' && filteredActions[paletteIndex]) {
                e.preventDefault();
                runPaletteAction(filteredActions[paletteIndex].id);
              }
            }}
          >
            <div className="palette__search">
              <Search size={15} strokeWidth={1.5} className="palette__search-icon" />
              <input
                type="text"
                autoFocus
                className="palette__input"
                placeholder="Type a command..."
                value={paletteQuery}
                onChange={(e) => {
                  setPaletteQuery(e.target.value);
                  setPaletteIndex(0);
                }}
              />
              <kbd className="palette__esc">Esc</kbd>
            </div>
            <div
              className="palette__list"
              role="listbox"
              onClick={(e) => {
                const id = (e.target as HTMLElement).closest('[data-id]')?.getAttribute('data-id');
                if (id) runPaletteAction(id);
              }}
            >
              {filteredActions.length === 0 ? (
                <div className="palette__empty">No matching commands.</div>
              ) : (
                filteredActions.map((act, idx) => (
                  <button
                    key={act.id}
                    type="button"
                    role="option"
                    aria-selected={idx === paletteIndex}
                    className={`palette__row ${idx === paletteIndex ? 'is-selected' : ''}`}
                    onMouseEnter={() => setPaletteIndex(idx)}
                    data-id={act.id}
                  >
                    <span>{act.label}</span>
                    {act.shortcut && <kbd>{act.shortcut}</kbd>}
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}
      {showSettings && (
        <SettingsModal
          isOpen={showSettings}
          onClose={() => setShowSettings(false)}
          backendOnline={backendOnline}
          onPingBackend={pingBackend}
        />
      )}
    </div>
  );
}
