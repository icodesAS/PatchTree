import dagre from 'dagre';
import type { PatchNode } from './types';

export const NODE_W = 220;
export const NODE_H = 100;

// Coordinate cache so existing nodes don't jump on incremental updates
const layoutCache = new Map<string, { x: number; y: number }>();

export function resetLayoutCache() {
  layoutCache.clear();
}

export function computeLayout(nodes: PatchNode[]): Map<string, { x: number; y: number }> {
  if (nodes.length === 0) {
    layoutCache.clear();
    return new Map();
  }

  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: 'TB',
    ranksep: 80,
    nodesep: 36,
    marginx: 50,
    marginy: 50,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) {
    g.setNode(n.node_id, { width: NODE_W, height: NODE_H });
  }
  for (const n of nodes) {
    if (n.parent_node_id) {
      g.setEdge(n.parent_node_id, n.node_id);
    }
  }

  dagre.layout(g);

  const pos = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    const nodeInfo = g.node(n.node_id);
    if (nodeInfo) {
      const targetX = Math.round(nodeInfo.x - NODE_W / 2);
      const targetY = Math.round(nodeInfo.y - NODE_H / 2);
      pos.set(n.node_id, { x: targetX, y: targetY });
      layoutCache.set(n.node_id, { x: targetX, y: targetY });
    }
  }

  return pos;
}
