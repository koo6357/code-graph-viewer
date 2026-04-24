import { Application, Graphics, Container, TextStyle } from "pixi.js";

// --- Types ---
export interface GraphNode {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  parentId: string | null;
  depth: number;
  exports: string[];
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: string;
  symbols: string[];
}

export interface ProjectGraph {
  rootPath: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  fileIndex: Record<string, string>;
}

export interface VisNode {
  id: string;
  name: string;
  kind: string;
  isDir: boolean;
  node?: GraphNode;
  x: number;
  y: number;
  parentId: string | null;
  children: string[];
  container: Container;
  circle: Graphics;
  label: import("pixi.js").Text;
}

export interface DirNode {
  id: string;
  name: string;
  isDir: boolean;
  kind?: string;
  node?: GraphNode;
  children: DirNode[];
}

// --- Constants ---
export const DRAG_THRESHOLD = 5;

export const KIND_COLORS: Record<string, number> = {
  dir: 0x505070,
  page: 0xe94560,
  component: 0x3a86c8,
  hook: 0x8338ec,
  apiHook: 0x06d6a0,
  store: 0xf77f00,
  util: 0x4a6fa5,
  constant: 0x6a6a8a,
  type: 0x8a6a9a,
};

export const KIND_SIZES: Record<string, number> = {
  dir: 6,
  page: 8,
  component: 5,
  hook: 6,
  apiHook: 6,
  store: 7,
  util: 4,
  constant: 4,
  type: 4,
};

// --- Mutable State ---
export const state = {
  graph: null as ProjectGraph | null,
  app: null as Application | null,
  world: null as Container | null,
  visNodes: new Map<string, VisNode>(),
  treeEdgeGfx: null as Graphics | null,
  importEdgeGfx: null as Graphics | null,
  activeCategory: null as string | null,

  // Zoom/pan
  scale: 1,
  offX: 0,
  offY: 0,

  // Canvas drag
  canvasDragging: false,
  canvasStartX: 0,
  canvasStartY: 0,

  // Layout settings
  H_GAP: 750,
  V_GAP: 65,
  nodeSizeMultiplier: 1,
  fontSizeMultiplier: 1.8,
  depthOverride: 99,
  edgesOnZoom: true,
  edgeDebounce: null as ReturnType<typeof setTimeout> | null,
  showPackages: true,

  // Highlight
  hoveredId: null as string | null,
  focusedId: null as string | null,

  // Visibility
  visibilityTimer: null as ReturnType<typeof setTimeout> | null,

  // Rerender
  lastRenderedCatKey: "",
  lastRenderedNodes: [] as GraphNode[],
  skipCenterView: false,

  // Code viewer
  currentInfoNode: null as GraphNode | null,

  // Minimap
  minimapCanvas: null as HTMLCanvasElement | null,
  minimapCtx: null as CanvasRenderingContext2D | null,
  graphBounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },

  // Search
  searchResults: [] as VisNode[],
  searchIndex: -1,
};
