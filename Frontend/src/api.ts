import type { PatchNode, Run, RunCreate } from './types';

const BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function createRun(payload: RunCreate): Promise<Run> {
  const res = await fetch(`${BASE}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => res.statusText);
    throw new Error(`POST /runs failed (${res.status}): ${txt}`);
  }
  return res.json();
}

export async function getRun(runId: string): Promise<Run> {
  const res = await fetch(`${BASE}/runs/${runId}`);
  if (!res.ok) throw new Error(`GET /runs/${runId} failed: ${res.status}`);
  return res.json();
}

export async function getTree(runId: string): Promise<PatchNode[]> {
  const res = await fetch(`${BASE}/runs/${runId}/tree`);
  if (!res.ok) throw new Error(`GET /runs/${runId}/tree failed: ${res.status}`);
  return res.json();
}

export async function listRuns(): Promise<Run[]> {
  const res = await fetch(`${BASE}/runs`);
  if (!res.ok) throw new Error(`GET /runs failed: ${res.status}`);
  return res.json();
}

export function pollUntilComplete(
  runId: string,
  onUpdate: (run: Run, nodes: PatchNode[]) => void,
  intervalMs = 1500,
  maxConsecutiveErrors = 4,
): { promise: Promise<void>; cancel: () => void } {
  let cancelled = false;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let consecutiveErrors = 0;

  const promise = new Promise<void>((resolve, reject) => {
    const tick = async () => {
      if (cancelled) return resolve();
      try {
        const [run, nodes] = await Promise.all([getRun(runId), getTree(runId)]);
        if (cancelled) return resolve();
        consecutiveErrors = 0;
        onUpdate(run, nodes);
        if (run.status === 'complete' || run.status === 'failed') {
          resolve();
        } else {
          timerId = setTimeout(tick, intervalMs);
        }
      } catch (e) {
        if (cancelled) return resolve();
        consecutiveErrors += 1;
        if (consecutiveErrors >= maxConsecutiveErrors) {
          reject(e);
        } else {
          const backoff = Math.min(intervalMs * Math.pow(1.5, consecutiveErrors), 6000);
          timerId = setTimeout(tick, backoff);
        }
      }
    };
    tick();
  });

  return {
    promise,
    cancel: () => {
      cancelled = true;
      if (timerId) clearTimeout(timerId);
    },
  };
}
