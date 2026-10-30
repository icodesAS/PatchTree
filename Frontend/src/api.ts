import type { PatchNode, Run, RunCreate } from './types';

const isVercel =
  typeof window !== 'undefined' &&
  (window.location.hostname.endsWith('vercel.app') ||
    (window.location.protocol.startsWith('http') &&
      !['localhost', '127.0.0.1'].includes(window.location.hostname) &&
      !import.meta.env.DEV));

export const BASE = isVercel
  ? '/api'
  : (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/+$/, '');

export function getApiBaseUrl(): string {
  if (typeof window !== 'undefined' && BASE.startsWith('/')) {
    return `${window.location.origin}${BASE}`;
  }
  return BASE;
}

export class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
  }
}

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function createRun(payload: RunCreate): Promise<Run> {
  const res = await fetch(`${BASE}/runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-PatchTree-Client': 'patchtree-web-v1',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => res.statusText);
    let msg = txt;
    try {
      const parsed = JSON.parse(txt);
      if (typeof parsed?.detail === 'string') msg = parsed.detail;
    } catch { /* non-JSON body */ }
    throw new HttpError(msg || `POST /runs failed (${res.status})`, res.status);
  }
  return res.json();
}

export async function getRun(runId: string): Promise<Run> {
  const res = await fetch(`${BASE}/runs/${runId}`);
  if (!res.ok) throw new HttpError(`GET /runs/${runId} failed: ${res.status}`, res.status);
  return res.json();
}

export async function getTree(runId: string): Promise<PatchNode[]> {
  const res = await fetch(`${BASE}/runs/${runId}/tree`);
  if (!res.ok) throw new HttpError(`GET /runs/${runId}/tree failed: ${res.status}`, res.status);
  return res.json();
}

export async function listRuns(clientId?: string): Promise<Run[]> {
  const url = clientId ? `${BASE}/runs?client_id=${encodeURIComponent(clientId)}` : `${BASE}/runs`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET /runs failed: ${res.status}`);
  return res.json();
}

export function pollUntilComplete(
  runId: string,
  onUpdate: (run: Run, nodes: PatchNode[]) => void,
  intervalMs = 1500,
  maxConsecutiveErrors = 6,
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
