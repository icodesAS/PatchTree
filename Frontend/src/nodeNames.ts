import type { PatchNode } from './types';

const PREFIX: Record<string, string> = { search: 'search', stability: 'stab', adversarial: 'adv' };

/** Short display name, 1-based within each phase (e.g. "search-2"). */
export function nodeName(node: PatchNode, siblingIndex: number): string {
  if (node.branch_type === 'root') return 'Reproduce';
  if (node.branch_type === 'full_suite') return 'full-suite';
  if (/^(search|stab|adv)-\d+$/i.test(node.node_id)) return node.node_id.replace(/-0+(\d+)$/, '-$1');
  return `${PREFIX[node.branch_type] ?? 'node'}-${siblingIndex + 1}`;
}

/** Map of node_id -> display name for a whole run. */
export function nodeNames(nodes: PatchNode[]): Map<string, string> {
  const counters: Record<string, number> = {};
  const out = new Map<string, string>();
  for (const n of nodes) {
    const i = counters[n.branch_type] ?? 0;
    counters[n.branch_type] = i + 1;
    out.set(n.node_id, nodeName(n, i));
  }
  return out;
}
