import { TextStyle, Graphics } from "pixi.js";
import { state, KIND_SIZES, VisNode } from "./state";

export function onNodeClick(node: import("./state").GraphNode) {
  highlightConnections(node.id);
  // showCodePanel is called from main — avoid circular dep
  (window as any).__showCodePanel?.(node);
}

export function clearHighlight() {
  state.focusedId = null;
  state.visNodes.forEach((vn) => {
    vn.circle.alpha = 1;
    vn.label.alpha = 1;
    (vn.label.style as TextStyle).fill = vn.isDir ? 0x8080a0 : 0xb0b0d0;
  });
  if (state.importEdgeGfx) state.importEdgeGfx.clear();
  redrawEdges();
}

export function highlightHover(nodeId: string) {
  state.hoveredId = nodeId;

  const connected = new Set<string>([nodeId]);
  if (state.graph) {
    state.graph.edges.forEach((e) => {
      if (e.source === nodeId) connected.add(e.target);
      if (e.target === nodeId) connected.add(e.source);
    });
  }
  const vn = state.visNodes.get(nodeId);
  if (vn) {
    if (vn.parentId) connected.add(vn.parentId);
    const collectChildren = (id: string) => {
      const node = state.visNodes.get(id);
      if (!node) return;
      node.children.forEach((c) => { connected.add(c); collectChildren(c); });
    };
    collectChildren(nodeId);
  }

  state.visNodes.forEach((v, id) => {
    if (connected.has(id)) {
      (v.label.style as TextStyle).fill = 0xffffff;
      v.label.alpha = 0.8;
    } else {
      (v.label.style as TextStyle).fill = v.isDir ? 0x8080a0 : 0xb0b0d0;
      v.label.alpha = 1;
    }
  });

  redrawEdges();
}

export function clearHover() {
  state.hoveredId = null;
  if (state.focusedId) {
    highlightConnections(state.focusedId);
  } else {
    state.visNodes.forEach((v) => {
      (v.label.style as TextStyle).fill = v.isDir ? 0x8080a0 : 0xb0b0d0;
      v.label.alpha = 1;
    });
    redrawEdges();
  }
}

export function highlightConnections(nodeId: string) {
  if (!state.graph) return;
  state.focusedId = nodeId;

  const connected = new Set<string>([nodeId]);
  state.graph.edges.forEach((e) => {
    if (e.source === nodeId) connected.add(e.target);
    if (e.target === nodeId) connected.add(e.source);
  });
  const vn = state.visNodes.get(nodeId);
  if (vn) {
    let parentId = vn.parentId;
    while (parentId) {
      connected.add(parentId);
      const p = state.visNodes.get(parentId);
      parentId = p?.parentId || null;
    }
    const collectChildren = (id: string) => {
      const node = state.visNodes.get(id);
      if (!node) return;
      node.children.forEach((c) => { connected.add(c); collectChildren(c); });
    };
    collectChildren(nodeId);
  }

  state.visNodes.forEach((v, id) => {
    const dim = connected.has(id) ? 1 : 0.5;
    v.circle.alpha = dim;
    v.label.alpha = dim;
    if (connected.has(id)) {
      (v.label.style as TextStyle).fill = 0x5BA0D0;
    }
  });

  // Redraw tree edges with highlight
  if (state.treeEdgeGfx) {
    state.treeEdgeGfx.clear();
    state.visNodes.forEach((v) => {
      if (!v.parentId) return;
      const parent = state.visNodes.get(v.parentId);
      if (!parent) return;
      const isConn = connected.has(v.id) && connected.has(v.parentId!);
      drawTreeEdge(v, parent, isConn ? 0x5BA0D0 : 0xffffff, isConn ? 0.6 : 0.08, isConn ? 1.5 : 1);
    });
  }

  // Draw used-by edges
  if (state.importEdgeGfx && state.graph) {
    state.importEdgeGfx.clear();
    state.graph.edges.filter((e) => e.target === nodeId).forEach((edge) => {
      const from = state.visNodes.get(edge.source);
      const to = state.visNodes.get(edge.target);
      if (!from || !to) return;

      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const mx = (from.x + to.x) / 2;
      const my = (from.y + to.y) / 2;
      const curvature = Math.min(dist * 0.15, 40);
      const cpx = mx + (-dy / dist) * curvature;
      const cpy = my + (dx / dist) * curvature;

      state.importEdgeGfx!.moveTo(from.x, from.y);
      state.importEdgeGfx!.quadraticCurveTo(cpx, cpy, to.x, to.y);
      state.importEdgeGfx!.stroke({ width: 1.5, color: 0x5BA0D0, alpha: 0.6 });
    });
  }
}

export function drawTreeEdge(vn: VisNode, parent: VisNode, color: number, alpha: number, width: number) {
  if (!state.treeEdgeGfx) return;
  const pSize = KIND_SIZES[parent.kind] || 5;
  const startX = parent.x + pSize + 2;
  const startY = parent.y;
  const endX = vn.x - (KIND_SIZES[vn.kind] || 5) - 2;
  const endY = vn.y;
  const cpOffset = (endX - startX) * 0.5;
  state.treeEdgeGfx.moveTo(startX, startY);
  state.treeEdgeGfx.bezierCurveTo(startX + cpOffset, startY, endX - cpOffset, endY, endX, endY);
  state.treeEdgeGfx.stroke({ width, color, alpha });
}

export function redrawEdges() {
  if (!state.graph) return;

  if (state.treeEdgeGfx) {
    state.treeEdgeGfx.clear();
    state.visNodes.forEach((vn) => {
      if (!vn.parentId) return;
      const parent = state.visNodes.get(vn.parentId);
      if (!parent) return;
      const isTreeHover = state.hoveredId && (vn.id === state.hoveredId || vn.parentId === state.hoveredId);
      drawTreeEdge(vn, parent, 0xffffff, isTreeHover ? 0.4 : 0.2, isTreeHover ? 1.5 : 1);
    });
  }
}
