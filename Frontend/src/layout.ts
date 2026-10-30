import type { BranchType, PatchNode } from './types';

export const NODE_W = 232;
export const NODE_H = 72;
const GAP_X = 16;
const GAP_Y = 48;

// One row per phase, top to bottom (spec 7.2): siblings 16px apart, phases 48px apart.
const ROW_ORDER: BranchType[] = ['root', 'search', 'stability', 'adversarial', 'full_suite'];

export function resetLayoutCache() {
  /* layout is stateless; kept for call-site compatibility */
}

export function computeLayout(nodes: PatchNode[]): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  const present = ROW_ORDER.filter((t) => nodes.some((n) => n.branch_type === t));

  present.forEach((type, row) => {
    const rowNodes = nodes.filter((n) => n.branch_type === type);
    const width = rowNodes.length * NODE_W + (rowNodes.length - 1) * GAP_X;
    rowNodes.forEach((n, i) => {
      pos.set(n.node_id, {
        x: Math.round(-width / 2 + i * (NODE_W + GAP_X)),
        y: row * (NODE_H + GAP_Y),
      });
    });
  });
  return pos;
}
