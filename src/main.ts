import { Application, Graphics, Text, TextStyle, Container } from "pixi.js";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";

// --- Types ---
interface GraphNode {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  parentId: string | null;
  depth: number;
  exports: string[];
}

interface GraphEdge {
  source: string;
  target: string;
  kind: string;
  symbols: string[];
}

interface ProjectGraph {
  rootPath: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  fileIndex: Record<string, string>;
}

interface VisNode {
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
  label: Text;
}

// --- Colors ---
const KIND_COLORS: Record<string, number> = {
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

const KIND_SIZES: Record<string, number> = {
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

// --- State ---
let graph: ProjectGraph | null = null;
let app: Application | null = null;
let world: Container | null = null;
let visNodes: Map<string, VisNode> = new Map();
let treeEdgeGfx: Graphics | null = null;
let importEdgeGfx: Graphics | null = null;
let activeCategory: string | null = null;

// Zoom/pan
let scale = 1;
let offX = 0;
let offY = 0;

// Canvas drag
let canvasDragging = false;
let canvasStartX = 0;
let canvasStartY = 0;

// (node drag removed)

// --- Init ---
async function init() {
  const el = document.getElementById("canvas-container")!;
  const pixiApp = new Application();
  await pixiApp.init({
    resizeTo: el,
    background: 0x111128,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });
  el.appendChild(pixiApp.canvas);
  app = pixiApp;

  world = new Container();
  pixiApp.stage.addChild(world);

  const canvas = pixiApp.canvas as HTMLCanvasElement;

  canvas.addEventListener("pointerdown", (e) => {
    canvasDragging = true;
    canvasStartX = e.clientX;
    canvasStartY = e.clientY;
  });

  window.addEventListener("pointermove", (e) => {
    if (canvasDragging) {
      offX += e.clientX - canvasStartX;
      offY += e.clientY - canvasStartY;
      canvasStartX = e.clientX;
      canvasStartY = e.clientY;
      applyTransform();
    }
  });

  window.addEventListener("pointerup", () => {
    if (canvasDragging) {
      canvasDragging = false;
      canvas.style.cursor = "default";
    }
  });

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY > 0 ? 0.85 : 1.15;
    const ns = Math.max(0.1, Math.min(1, scale * factor));
    offX = mx - (mx - offX) * (ns / scale);
    offY = my - (my - offY) * (ns / scale);
    scale = ns;
    applyTransform();
    // Hide edges during zoom for performance (if toggle off)
    if (!edgesOnZoom) {
      if (treeEdgeGfx) treeEdgeGfx.visible = false;
      if (importEdgeGfx) importEdgeGfx.visible = false;
      if (edgeDebounce) clearTimeout(edgeDebounce);
      edgeDebounce = setTimeout(() => {
        if (treeEdgeGfx) treeEdgeGfx.visible = true;
        if (importEdgeGfx) importEdgeGfx.visible = true;
      }, 150);
    }
    updateVisibility();
  }, { passive: false });

  setupMenus();
  setupSettings();
  setupSearch();
  initMinimap();
  initCodePanel();
  await tryAutoOpen();
}

function setupMenus() {
  listen("menu-open-folder", async () => {
    const selected = await open({ directory: true });
    if (selected) await openProjectPath(selected as string);
  });
  listen<string>("menu-open-recent", async (event) => {
    await openProjectPath(event.payload);
  });
  document.getElementById("info-close")!.addEventListener("click", () => {
    document.getElementById("info-panel")!.classList.remove("visible");
    clearHighlight();
  });

  // Prevent canvas events when clicking on panels
  ["settings-panel", "info-panel"].forEach((id) => {
    document.getElementById(id)!.addEventListener("pointerdown", (e) => e.stopPropagation());
  });

  // Make panels draggable by their handles
  makeDraggable("settings-panel");
  makeDraggable("info-panel");
}

function makeDraggable(panelId: string) {
  const panel = document.getElementById(panelId)!;
  const handle = panel.querySelector(".drag-handle") as HTMLElement;
  if (!handle) return;

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let panelStartX = 0;
  let panelStartY = 0;

  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    panelStartX = panel.offsetLeft;
    panelStartY = panel.offsetTop;
    panel.style.right = "auto";
    panel.style.left = panelStartX + "px";
    panel.style.top = panelStartY + "px";
    handle.setPointerCapture(e.pointerId);
  });

  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    e.preventDefault();
    panel.style.left = (panelStartX + e.clientX - startX) + "px";
    panel.style.top = (panelStartY + e.clientY - startY) + "px";
  });

  handle.addEventListener("pointerup", () => {
    dragging = false;
  });

  handle.addEventListener("lostpointercapture", () => {
    dragging = false;
  });
}

async function tryAutoOpen() {
  const last = await invoke<string>("get_last_project");
  if (last) { await openProjectPath(last); return; }
  showWelcome();
}

async function showWelcome() {
  document.getElementById("welcome")!.style.display = "block";
  const recents = await invoke<string[]>("get_recent_projects");
  const el = document.getElementById("welcome-recents")!;
  if (recents.length === 0) {
    el.innerHTML = `<p style="color:#505070;font-size:13px;">File → Open Folder to get started</p>`;
    return;
  }
  el.innerHTML = "";
  recents.forEach((path) => {
    const name = path.split("/").pop() || path;
    const item = document.createElement("div");
    item.className = "welcome-item";
    item.innerHTML = `📂 ${name}<span class="hint">${path}</span>`;
    item.addEventListener("click", () => openProjectPath(path));
    el.appendChild(item);
  });
}

function applyTransform() {
  if (!world) return;
  world.x = offX;
  world.y = offY;
  world.scale.set(scale);
  updateMinimap();
}

let visibilityTimer: ReturnType<typeof setTimeout> | null = null;

function updateVisibility() {
  if (visibilityTimer) clearTimeout(visibilityTimer);
  visibilityTimer = setTimeout(updateVisibilityNow, 50);
}

function updateVisibilityNow() {
  const total = visNodes.size;
  let visibleCount = 0;
  let labelsShown = 0;

  // Scale-based font override
  const effectiveFontSize = scale < 0.25 ? 2.5 : fontSizeMultiplier;

  // Update scale display
  const scaleEl = document.getElementById("val-scale");
  if (scaleEl) scaleEl.textContent = scale.toFixed(2);

  // All nodes always visible
  visNodes.forEach((vn) => {
    vn.container.visible = true;
    visibleCount++;
  });

  // Labels always visible
  visNodes.forEach((vn) => {
    vn.label.visible = true;
    labelsShown++;
    vn.label.parent.scale.set(effectiveFontSize);
    vn.circle.scale.set(nodeSizeMultiplier);
  });

  // Update stats
  const visEl = document.getElementById("val-visible");
  if (visEl) visEl.textContent = `${visibleCount} / ${total}`;
  const labelsEl = document.getElementById("val-labels");
  if (labelsEl) labelsEl.textContent = `${labelsShown} / ${visibleCount}`;
}

// --- Open project ---
async function openProjectPath(path: string) {
  document.getElementById("welcome")!.style.display = "none";
  const loadingEl = document.getElementById("loading")!;
  loadingEl.textContent = "Scanning project...";
  loadingEl.style.display = "block";
  try {
    graph = await invoke<ProjectGraph>("scan_project", { rootPath: path });
    loadingEl.style.display = "none";
    renderCategoryList();
    showStats();
    // Render all nodes by default
    renderFolderTree("", graph.nodes);
  } catch (e) {
    loadingEl.textContent = `Error: ${e}`;
  }
}

// --- Categories ---
function renderCategoryList() {
  if (!graph) return;

  // Build 3-level tree: group / category / sub-folder
  const catMap = new Map<string, GraphNode[]>();
  graph.nodes.forEach((n) => {
    const parts = n.id.split("/");
    const key = parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0];
    if (!catMap.has(key)) catMap.set(key, []);
    catMap.get(key)!.push(n);
  });

  const list = document.getElementById("category-list")!;
  list.innerHTML = "";

  // "All" item at top
  const allItem = document.createElement("div");
  allItem.className = "cat-item active";
  allItem.innerHTML = `<span>All</span><span class="cat-count">${graph.nodes.length}</span>`;
  allItem.addEventListener("click", () => {
    document.querySelectorAll(".cat-item").forEach((e) => e.classList.remove("active"));
    allItem.classList.add("active");
    activeCategory = null;
    renderFolderTree("", graph!.nodes);
  });
  list.appendChild(allItem);

  let lastGroup = "";

  const sorted = Array.from(catMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  sorted.forEach(([key, nodes]) => {
    const parts = key.split("/");
    const group = parts[0];
    const label = parts[parts.length - 1];

    if (group !== lastGroup) {
      const g = document.createElement("div");
      g.className = "cat-group";
      g.textContent = group;
      list.appendChild(g);
      lastGroup = group;
    }

    // Category item
    const item = document.createElement("div");
    item.className = "cat-item";
    const caret = `<span style="font-size:9px;display:inline-block;width:12px;vertical-align:middle">▶</span>`;
    item.innerHTML = `<span>${caret} ${label}</span><span class="cat-count">${nodes.length}</span>`;

    const subContainer = document.createElement("div");
    subContainer.style.display = "none";

    let expanded = false;
    item.addEventListener("click", () => {
      expanded = !expanded;
      subContainer.style.display = expanded ? "block" : "none";
      const caretEl = item.querySelector("span span") as HTMLElement;
      if (caretEl) caretEl.textContent = expanded ? "▼" : "▶";

      document.querySelectorAll(".cat-item").forEach((e) => e.classList.remove("active"));
      item.classList.add("active");
      activeCategory = key;
      renderFolderTree(key, nodes);

      if (expanded) buildSubFolders(key, nodes, subContainer);
    });

    list.appendChild(item);
    list.appendChild(subContainer);
  });
}

function buildSubFolders(catKey: string, nodes: GraphNode[], container: HTMLElement) {
  container.innerHTML = "";

  // Build nested sub-folder tree
  const tree = new Map<string, { nodes: GraphNode[]; children: Map<string, any> }>();

  nodes.forEach((n) => {
    const rel = n.id.startsWith(catKey + "/") ? n.id.slice(catKey.length + 1) : n.id;
    const parts = rel.split("/");
    if (parts.length <= 1) return; // root-level file, skip

    let current = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (!current.has(seg)) {
        current.set(seg, { nodes: [], children: new Map() });
      }
      const entry = current.get(seg)!;
      if (i === parts.length - 2) {
        entry.nodes.push(n);
      }
      current = entry.children;
    }
  });

  function renderLevel(map: Map<string, { nodes: GraphNode[]; children: Map<string, any> }>, parentKey: string, depth: number) {
    const sorted = Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    sorted.forEach(([name, entry]) => {
      const fullKey = parentKey + "/" + name;
      const allNodes = collectNodes(entry);
      const count = allNodes.length;

      const item = document.createElement("div");
      item.className = "cat-item";
      item.style.paddingLeft = `${14 + depth * 14}px`;
      item.style.fontSize = "12px";

      const hasChildren = entry.children.size > 0;
      const caret = hasChildren
        ? `<span style="font-size:8px;display:inline-block;width:12px;vertical-align:middle">▶</span>`
        : `<span style="width:12px;display:inline-block"></span>`;
      item.innerHTML = `<span>${caret} ${name}</span><span class="cat-count">${count}</span>`;

      const subDiv = document.createElement("div");
      subDiv.style.display = "none";
      let exp = false;

      item.addEventListener("click", (e) => {
        e.stopPropagation();
        activeCategory = catKey;
        renderFolderTree(fullKey, allNodes);

        if (hasChildren) {
          exp = !exp;
          subDiv.style.display = exp ? "block" : "none";
          const c = item.querySelector("span span") as HTMLElement;
          if (c) c.textContent = exp ? "▼" : "▶";
          if (exp && subDiv.children.length === 0) {
            renderLevel(entry.children, fullKey, depth + 1);
          }
        }
      });

      container.appendChild(item);
      if (hasChildren) {
        container.appendChild(subDiv);
        // Recursive: render into subDiv
        const origContainer = container;
        const renderInto = (m: Map<string, any>, pk: string, d: number) => {
          const s = Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
          s.forEach(([n2, e2]) => {
            const fk = pk + "/" + n2;
            const an = collectNodes(e2);
            const c2 = an.length;
            const hc = e2.children.size > 0;

            const it = document.createElement("div");
            it.className = "cat-item";
            it.style.paddingLeft = `${14 + d * 14}px`;
            it.style.fontSize = "12px";
            const cr = hc
              ? `<span style="font-size:8px;display:inline-block;width:12px;vertical-align:middle">▶</span>`
              : `<span style="width:12px;display:inline-block"></span>`;
            it.innerHTML = `<span>${cr} ${n2}</span><span class="cat-count">${c2}</span>`;

            const sd = document.createElement("div");
            sd.style.display = "none";
            let ex = false;

            it.addEventListener("click", (ev) => {
              ev.stopPropagation();
              activeCategory = catKey;
              renderFolderTree(fk, an);
              if (hc) {
                ex = !ex;
                sd.style.display = ex ? "block" : "none";
                const cc = it.querySelector("span span") as HTMLElement;
                if (cc) cc.textContent = ex ? "▼" : "▶";
                if (ex && sd.children.length === 0) renderInto(e2.children, fk, d + 1);
              }
            });

            subDiv.appendChild(it);
            if (hc) subDiv.appendChild(sd);
          });
        };
        // Will be called on expand
        const origRenderLevel = renderLevel;
        item.addEventListener("click", () => {
          if (exp && subDiv.children.length === 0) {
            renderInto(entry.children, fullKey, depth + 1);
          }
        });
      }
    });
  }

  function collectNodes(entry: { nodes: GraphNode[]; children: Map<string, any> }): GraphNode[] {
    const result = [...entry.nodes];
    entry.children.forEach((child) => {
      result.push(...collectNodes(child));
    });
    return result;
  }

  renderLevel(tree, catKey, 1);
}

// --- Folder tree layout ---
interface DirNode {
  id: string;
  name: string;
  isDir: boolean;
  kind?: string;
  node?: GraphNode;
  children: DirNode[];
}

function buildDirTree(nodes: GraphNode[], catKey: string): DirNode {
  const rootName = catKey ? catKey.split("/").pop()! : "root";
  const root: DirNode = { id: catKey || "__root__", name: rootName, isDir: true, children: [] };
  const dirMap = new Map<string, DirNode>();
  dirMap.set("", root);

  const sorted = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  sorted.forEach((node) => {
    const rel = catKey && node.id.startsWith(catKey + "/") ? node.id.slice(catKey.length + 1) : node.id;
    const parts = rel.split("/");

    let path = "";
    let parent = root;
    for (let i = 0; i < parts.length - 1; i++) {
      path += (path ? "/" : "") + parts[i];
      if (!dirMap.has(path)) {
        const dir: DirNode = { id: path, name: parts[i], isDir: true, children: [] };
        dirMap.set(path, dir);
        parent.children.push(dir);
      }
      parent = dirMap.get(path)!;
    }

    parent.children.push({
      id: node.id,
      name: node.name,
      isDir: false,
      kind: node.kind,
      node,
      children: [],
    });
  });

  return root;
}

// Lay out tree: horizontal tree, parent on left, children on right
// Layout settings (adjustable via UI)
let H_GAP = 750;
let V_GAP = 65;
let nodeSizeMultiplier = 1;
let fontSizeMultiplier = 1.8;
let depthOverride = 99; // manual depth cap
let showEdges = true;
let edgesOnZoom = true;
let edgeDebounce: ReturnType<typeof setTimeout> | null = null;

function layoutTree(dir: DirNode, x: number, yStart: number): { nodes: Array<{ dn: DirNode; x: number; y: number }>; height: number } {
  const result: Array<{ dn: DirNode; x: number; y: number }> = [];

  if (dir.children.length === 0) {
    result.push({ dn: dir, x, y: yStart });
    return { nodes: result, height: V_GAP };
  }

  let childY = yStart;
  const childResults: Array<{ nodes: Array<{ dn: DirNode; x: number; y: number }>; height: number }> = [];

  dir.children.forEach((child) => {
    const sub = layoutTree(child, x + H_GAP, childY);
    childResults.push(sub);
    childY += sub.height;
  });

  const totalHeight = childY - yStart;

  // Parent at vertical center of children
  const firstChildY = childResults[0].nodes[0].y;
  const lastChildY = childResults[childResults.length - 1].nodes[0].y;
  const parentY = (firstChildY + lastChildY) / 2;

  result.push({ dn: dir, x, y: parentY });
  childResults.forEach((cr) => result.push(...cr.nodes));

  return { nodes: result, height: totalHeight };
}

function renderFolderTree(catKey: string, nodes: GraphNode[]) {
  if (!world || !app || !graph) return;
  lastRenderedCatKey = catKey;
  lastRenderedNodes = nodes;
  world.removeChildren();
  visNodes.clear();

  const tree = buildDirTree(nodes, catKey);
  const layout = layoutTree(tree, 50, 50);

  // Edges at bottom, nodes on top
  treeEdgeGfx = new Graphics();
  importEdgeGfx = new Graphics();
  const nodeLayer = new Container();

  // Order matters: first added = behind
  world.addChild(treeEdgeGfx);
  world.addChild(importEdgeGfx);
  world.addChild(nodeLayer);

  // Create visual nodes
  layout.nodes.forEach(({ dn, x, y }) => {
    const kind = dn.isDir ? "dir" : (dn.kind || "util");
    const size = KIND_SIZES[kind] || 5;
    const color = KIND_COLORS[kind] || 0x4a6fa5;

    const cont = new Container();
    cont.x = x;
    cont.y = y;

    const circle = new Graphics();
    circle.circle(0, 0, size);
    circle.fill({ color, alpha: 0.9 });
    circle.eventMode = "static";
    circle.cursor = "pointer";

    circle.on("pointerdown", (e) => {
      e.stopPropagation();
      if (dn.node) onNodeClick(dn.node);
    });

    circle.on("pointerover", () => {
      const vn = visNodes.get(dn.id);
      if (vn) highlightHover(vn.id);
    });

    circle.on("pointerout", () => {
      clearHover();
    });

    cont.addChild(circle);

    const label = new Text({
      text: dn.name,
      style: new TextStyle({
        fontSize: dn.isDir ? 18 : 14,
        fill: dn.isDir ? 0x8080a0 : 0xb0b0d0,
        fontFamily: "-apple-system, sans-serif",
        fontWeight: dn.isDir ? "600" : "400",
      }),
    });

    // Label container with background (scales together)
    const labelContainer = new Container();
    labelContainer.x = size + 5;
    labelContainer.y = 0;

    label.x = 0;
    label.anchor.set(0, 0.5);
    label.y = 0;

    labelContainer.addChild(label);

    // Measure and add background
    const bounds = label.getLocalBounds();
    const pad = 3;
    const labelBg = new Graphics();
    labelBg.rect(-pad, bounds.y - pad, bounds.width + pad * 2, bounds.height + pad * 2);
    labelBg.fill({ color: 0x111128 });
    labelContainer.addChildAt(labelBg, 0); // bg behind text

    labelContainer.eventMode = "static";
    labelContainer.cursor = "pointer";
    labelContainer.on("pointerover", () => {
      const vn = visNodes.get(dn.id);
      if (vn) highlightHover(vn.id);
    });
    labelContainer.on("pointerout", () => {
      clearHover();
    });
    labelContainer.on("pointerdown", (e) => {
      e.stopPropagation();
      if (dn.node) onNodeClick(dn.node);
    });
    cont.addChild(labelContainer);

    nodeLayer.addChild(cont);

    const vn: VisNode = {
      id: dn.id,
      name: dn.name,
      kind,
      isDir: dn.isDir,
      node: dn.node,
      x, y,
      parentId: null,
      children: dn.children.map((c) => c.id),
      container: cont,
      circle,
      label,
    };

    // Set parent references
    dn.children.forEach((child) => {
      // Will be set after all nodes created
    });

    visNodes.set(dn.id, vn);
  });

  // Set parentId
  layout.nodes.forEach(({ dn }) => {
    dn.children.forEach((child) => {
      const cvn = visNodes.get(child.id);
      if (cvn) cvn.parentId = dn.id;
    });
  });

  redrawEdges();
  centerView();
  updateVisibility();
  updateMinimap();
  visNodes.forEach((vn) => {
    vn.circle.scale.set(nodeSizeMultiplier);
    vn.label.parent.scale.set(fontSizeMultiplier);
  });
  // Update zone display
  const zoneEl = document.getElementById("val-zone");
  if (zoneEl) zoneEl.textContent = ZONES[zi]?.name || "-";
}

function redrawEdges() {
  if (!graph) return;

  // Tree structure edges (parent → child)
  if (treeEdgeGfx) {
    treeEdgeGfx.clear();
    visNodes.forEach((vn) => {
      if (!vn.parentId) return;
      const parent = visNodes.get(vn.parentId);
      if (!parent) return;

      const pSize = KIND_SIZES[parent.kind] || 5;

      // Smooth bezier curve from parent to child
      const startX = parent.x + pSize + 2;
      const startY = parent.y;
      const endX = vn.x - (KIND_SIZES[vn.kind] || 5) - 2;
      const endY = vn.y;
      const cpOffset = (endX - startX) * 0.5;

      treeEdgeGfx!.moveTo(startX, startY);
      treeEdgeGfx!.bezierCurveTo(
        startX + cpOffset, startY,
        endX - cpOffset, endY,
        endX, endY
      );

      const isTreeHover = hoveredId && (vn.id === hoveredId || vn.parentId === hoveredId);
      treeEdgeGfx!.stroke({ width: isTreeHover ? 1.5 : 1, color: 0xffffff, alpha: isTreeHover ? 0.4 : 0.2 });
    });
  }

  // Import edges
  if (importEdgeGfx && graph) {
    importEdgeGfx.clear();
    const nodeIds = new Set(Array.from(visNodes.keys()));
    graph.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target)).forEach((edge) => {
      const from = visNodes.get(edge.source);
      const to = visNodes.get(edge.target);
      if (!from || !to || from.isDir || to.isDir) return;

      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const mx = (from.x + to.x) / 2;
      const my = (from.y + to.y) / 2;
      const curvature = Math.min(dist * 0.15, 40);
      const cpx = mx + (-dy / dist) * curvature;
      const cpy = my + (dx / dist) * curvature;

      importEdgeGfx!.moveTo(from.x, from.y);
      importEdgeGfx!.quadraticCurveTo(cpx, cpy, to.x, to.y);

      const isHovered = hoveredId && (edge.source === hoveredId || edge.target === hoveredId);
      importEdgeGfx!.stroke({
        width: isHovered ? 1.5 : 0.6,
        color: isHovered ? 0xffffff : 0x4a4a6a,
        alpha: isHovered ? 0.7 : 0.12,
      });
    });
  }

  // Force z-order: edges behind nodes
  if (world && treeEdgeGfx && importEdgeGfx) {
    world.setChildIndex(treeEdgeGfx, 0);
    world.setChildIndex(importEdgeGfx, 1);
  }
}

function centerView() {
  if (skipCenterView) return;
  if (!app || visNodes.size === 0) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  visNodes.forEach((vn) => {
    minX = Math.min(minX, vn.x);
    minY = Math.min(minY, vn.y);
    maxX = Math.max(maxX, vn.x);
    maxY = Math.max(maxY, vn.y);
  });
  const gw = maxX - minX || 1;
  const gh = maxY - minY || 1;
  const cw = app.screen.width;
  const ch = app.screen.height;
  scale = 0.2;
  offX = cw / 2 - ((minX + maxX) / 2) * scale;
  offY = ch / 2 - ((minY + maxY) / 2) * scale;
  applyTransform();
}

// --- Interaction ---
function onNodeClick(node: GraphNode) {
  highlightConnections(node.id);
  showCodePanel(node);
}

function clearHighlight() {
  visNodes.forEach((vn) => {
    vn.container.alpha = 1;
  });
  redrawEdges();
}

let hoveredId: string | null = null;

function highlightHover(nodeId: string) {
  hoveredId = nodeId;

  // Brighten connected node labels
  const connected = new Set<string>([nodeId]);
  if (graph) {
    graph.edges.forEach((e) => {
      if (e.source === nodeId) connected.add(e.target);
      if (e.target === nodeId) connected.add(e.source);
    });
  }
  // Also add tree parent and all descendants
  const vn = visNodes.get(nodeId);
  if (vn) {
    if (vn.parentId) connected.add(vn.parentId);
    // Recursively collect all descendants
    const collectChildren = (id: string) => {
      const node = visNodes.get(id);
      if (!node) return;
      node.children.forEach((c) => {
        connected.add(c);
        collectChildren(c);
      });
    };
    collectChildren(nodeId);
  }

  visNodes.forEach((v, id) => {
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

function clearHover() {
  hoveredId = null;
  visNodes.forEach((v) => {
    (v.label.style as TextStyle).fill = v.isDir ? 0x8080a0 : 0xb0b0d0;
    v.label.alpha = 1;
  });
  redrawEdges();
}

function highlightConnections(nodeId: string) {
  if (!graph || !importEdgeGfx) return;

  const connected = new Set<string>([nodeId]);
  graph.edges.forEach((e) => {
    if (e.source === nodeId) connected.add(e.target);
    if (e.target === nodeId) connected.add(e.source);
  });

  visNodes.forEach((vn, id) => {
    vn.container.alpha = connected.has(id) ? 1 : 0.15;
  });

  // Redraw import edges with highlight
  importEdgeGfx.clear();
  const nodeIds = new Set(Array.from(visNodes.keys()));
  graph.edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target)).forEach((edge) => {
    const from = visNodes.get(edge.source);
    const to = visNodes.get(edge.target);
    if (!from || !to || from.isDir || to.isDir) return;

    const isHL = edge.source === nodeId || edge.target === nodeId;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const mx = (from.x + to.x) / 2;
    const my = (from.y + to.y) / 2;
    const curvature = Math.min(dist * 0.15, 40);
    const cpx = mx + (-dy / dist) * curvature;
    const cpy = my + (dx / dist) * curvature;

    importEdgeGfx!.moveTo(from.x, from.y);
    importEdgeGfx!.quadraticCurveTo(cpx, cpy, to.x, to.y);
    importEdgeGfx!.stroke({
      width: isHL ? 2 : 0.4,
      color: isHL ? 0xe94560 : 0x3a3a5a,
      alpha: isHL ? 0.9 : 0.03,
    });
  });

  // Force z-order
  if (world && treeEdgeGfx && importEdgeGfx) {
    world.setChildIndex(treeEdgeGfx, 0);
    world.setChildIndex(importEdgeGfx, 1);
  }
}

function showInfoPanel(node: GraphNode) {
  const panel = document.getElementById("info-panel")!;
  document.getElementById("info-name")!.textContent = node.name;

  const kindEl = document.getElementById("info-kind")!;
  kindEl.textContent = node.kind;
  kindEl.style.background = `#${(KIND_COLORS[node.kind] || 0x4a4a6a).toString(16).padStart(6, "0")}`;

  const relPath = graph ? node.filePath.replace(graph.rootPath + "/", "") : node.filePath;
  document.getElementById("info-path")!.textContent = relPath;

  if (graph) {
    const incoming = graph.edges.filter((e) => e.target === node.id);
    const outgoing = graph.edges.filter((e) => e.source === node.id);

    let html = "";
    if (outgoing.length > 0) {
      html += `<p style="margin-top:8px;font-weight:600;font-size:12px;">Imports (${outgoing.length})</p><ul>`;
      outgoing.forEach((e) => {
        const t = graph!.nodes.find((n) => n.id === e.target);
        html += `<li data-id="${e.target}">${t?.name || e.target} <span style="color:#505070">${e.symbols.join(", ")}</span></li>`;
      });
      html += "</ul>";
    }
    if (incoming.length > 0) {
      html += `<p style="margin-top:8px;font-weight:600;font-size:12px;">Used by (${incoming.length})</p><ul>`;
      incoming.forEach((e) => {
        const s = graph!.nodes.find((n) => n.id === e.source);
        html += `<li data-id="${e.source}">${s?.name || e.source}</li>`;
      });
      html += "</ul>";
    }
    if (node.exports.length > 0) {
      html += `<p style="margin-top:8px;font-weight:600;font-size:12px;">Exports</p><ul>`;
      node.exports.forEach((exp) => { html += `<li>${exp}</li>`; });
      html += "</ul>";
    }

    const refsEl = document.getElementById("info-refs")!;
    refsEl.innerHTML = html;
    refsEl.querySelectorAll("li[data-id]").forEach((li) => {
      li.addEventListener("click", () => {
        const id = (li as HTMLElement).dataset.id!;
        const target = graph!.nodes.find((n) => n.id === id);
        if (target) onNodeClick(target);
      });
    });
  }
  panel.classList.add("visible");
}

function showStats() {
  if (!graph) return;
  const el = document.getElementById("stats")!;
  const counts = new Map<string, number>();
  graph.nodes.forEach((n) => counts.set(n.kind, (counts.get(n.kind) || 0) + 1));
  let html = `<div>${graph.nodes.length} nodes · ${graph.edges.length} edges</div>`;
  counts.forEach((c, k) => { html += `<div>${k}: ${c}</div>`; });
  el.innerHTML = html;
}

// --- Settings ---
let lastRenderedCatKey = "";
let lastRenderedNodes: GraphNode[] = [];

function setupSettings() {
  const toggle = document.getElementById("settings-toggle")!;
  const panel = document.getElementById("settings-panel")!;
  toggle.addEventListener("click", () => panel.classList.toggle("visible"));

  loadSettings();

  function bind(sliderId: string, valId: string, onChange: (v: number) => void) {
    const slider = document.getElementById(sliderId) as HTMLInputElement;
    const valEl = document.getElementById(valId)!;
    let timer: ReturnType<typeof setTimeout> | null = null;
    slider.addEventListener("input", () => {
      valEl.textContent = slider.value;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => onChange(parseFloat(slider.value)), 100);
    });
  }

  bind("slider-hgap", "val-hgap", (v) => { H_GAP = v; rerender(); });
  bind("slider-vgap", "val-vgap", (v) => { V_GAP = v; rerender(); });
  bind("slider-nsize", "val-nsize", (v) => {
    nodeSizeMultiplier = v;
    visNodes.forEach((vn) => { vn.circle.scale.set(v); });
  });
  bind("slider-fsize", "val-fsize", (v) => {
    fontSizeMultiplier = v;
    visNodes.forEach((vn) => { vn.label.parent.scale.set(v); });
  });
  document.getElementById("toggle-edges")!.addEventListener("change", (e) => {
    edgesOnZoom = (e.target as HTMLInputElement).checked;
  });

  document.getElementById("save-settings")!.addEventListener("click", () => {
    const settings = { hGap: H_GAP, vGap: V_GAP, nodeSize: nodeSizeMultiplier, fontSize: fontSizeMultiplier, depthVisibility: depthOverride };
    localStorage.setItem("cgv-settings", JSON.stringify(settings));
    const btn = document.getElementById("save-settings")!;
    btn.textContent = "✅ Saved!";
    setTimeout(() => { btn.textContent = "💾 Save"; }, 1500);
  });

  document.getElementById("copy-settings")!.addEventListener("click", () => {
    const all = {
      currentScale: parseFloat(scale.toFixed(3)),
      hGap: H_GAP,
      vGap: V_GAP,
      nodeSize: nodeSizeMultiplier,
      fontSize: fontSizeMultiplier,
      depth: depthOverride,
    };
    navigator.clipboard.writeText(JSON.stringify(all, null, 2)).then(() => {
      const b = document.getElementById("copy-settings")!;
      b.textContent = "✅ Copied!";
      setTimeout(() => { b.textContent = "📋 Copy"; }, 1500);
    });
  });
}

function loadSettings() {
  try {
    const raw = localStorage.getItem("cgv-settings");
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s.hGap) { H_GAP = s.hGap; setSlider("slider-hgap", "val-hgap", s.hGap); }
    if (s.vGap) { V_GAP = s.vGap; setSlider("slider-vgap", "val-vgap", s.vGap); }
    if (s.nodeSize) { nodeSizeMultiplier = s.nodeSize; setSlider("slider-nsize", "val-nsize", s.nodeSize); }
    if (s.fontSize) { fontSizeMultiplier = s.fontSize; setSlider("slider-fsize", "val-fsize", s.fontSize); }
    if (s.depthVisibility) { depthOverride = s.depthVisibility; setSlider("slider-depth", "val-depth", s.depthVisibility); }
  } catch {}
}

function setSlider(sliderId: string, valId: string, value: number) {
  const slider = document.getElementById(sliderId) as HTMLInputElement;
  const valEl = document.getElementById(valId);
  if (slider) slider.value = String(value);
  if (valEl) valEl.textContent = String(value);
}

let skipCenterView = false;

function rerender() {
  if (lastRenderedNodes.length > 0) {
    skipCenterView = true;
    const prevScale = scale;
    const prevOffX = offX;
    const prevOffY = offY;
    renderFolderTree(lastRenderedCatKey, lastRenderedNodes);
    scale = prevScale;
    offX = prevOffX;
    offY = prevOffY;
    applyTransform();
    skipCenterView = false;
  }
}

// --- Code Viewer ---
async function showCodePanel(node: GraphNode) {
  const panel = document.getElementById("code-panel")!;
  const pathEl = document.getElementById("code-file-path")!;
  const contentEl = document.getElementById("code-content")!;

  const relPath = graph ? node.filePath.replace(graph.rootPath + "/", "") : node.filePath;
  pathEl.textContent = relPath;
  contentEl.textContent = "Loading...";
  panel.classList.add("visible");
  updateCodeInfo(node);

  try {
    const source = await invoke<string>("read_file", { filePath: node.filePath });
    const lines = source.split("\n");
    contentEl.innerHTML = lines.map((line, i) => {
      const highlighted = highlightSyntax(line);
      return `<span class="line-num">${i + 1}</span>${highlighted}`;
    }).join("\n");
  } catch (e) {
    contentEl.textContent = `Error: ${e}`;
  }
}

function highlightSyntax(line: string): string {
  let s = line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Comments (// ...)
  s = s.replace(/(\/\/.*)$/, '<span style="color:#629755;font-style:italic">$1</span>');

  // Strings (double, single, backtick) — simple, non-greedy
  s = s.replace(/(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;|`[^`]*?`)/g, '<span style="color:#6A8759">$1</span>');
  // Also handle actual quotes that survived escaping
  s = s.replace(/("[^"]*?"|'[^']*?')/g, '<span style="color:#6A8759">$1</span>');

  // Keywords
  const keywords = /\b(import|export|from|const|let|var|function|return|if|else|switch|case|default|break|continue|for|while|do|try|catch|finally|throw|new|typeof|instanceof|in|of|class|extends|implements|interface|type|enum|async|await|yield|as|is|readonly|public|private|protected|static|abstract|override|declare|module|namespace|void|null|undefined|true|false)\b/g;
  s = s.replace(keywords, '<span style="color:#CC7832">$1</span>');

  // Types / Components (PascalCase)
  s = s.replace(/\b([A-Z][a-zA-Z0-9]+)\b/g, '<span style="color:#A9B7C6">$1</span>');

  // Numbers
  s = s.replace(/\b(\d+\.?\d*)\b/g, '<span style="color:#6897BB">$1</span>');

  // JSX tags
  s = s.replace(/(&lt;\/?)([\w.]+)/g, '$1<span style="color:#E8BF6A">$2</span>');

  // Decorators / @ annotations
  s = s.replace(/@(\w+)/g, '<span style="color:#BBB529">@$1</span>');

  return s;
}

function initCodePanel() {
  document.getElementById("code-close")!.addEventListener("click", () => {
    document.getElementById("code-panel")!.classList.remove("visible");
    clearHighlight();
  });

  // Tab switching
  document.querySelectorAll(".code-info-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".code-info-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      if (currentInfoNode) renderCodeInfoTab((tab as HTMLElement).dataset.tab!, currentInfoNode);
    });
  });
}

let currentInfoNode: GraphNode | null = null;

function updateCodeInfo(node: GraphNode) {
  currentInfoNode = node;
  // Default to api tab
  document.querySelectorAll(".code-info-tab").forEach((t) => t.classList.remove("active"));
  document.querySelector('.code-info-tab[data-tab="imports"]')!.classList.add("active");
  renderCodeInfoTab("imports", node);
}

function renderCodeInfoTab(tab: string, node: GraphNode) {
  const el = document.getElementById("code-info-content")!;
  if (!graph) return;

  const relPath = node.filePath.replace(graph.rootPath + "/", "");
  const incoming = graph.edges.filter((e) => e.target === node.id);
  const outgoing = graph.edges.filter((e) => e.source === node.id);

  if (tab === "imports") {
    if (outgoing.length === 0) { el.innerHTML = "<div style='color:#505070'>No imports</div>"; return; }
    el.innerHTML = "<ul>" + outgoing.map((e) => {
      const t = graph!.nodes.find((n) => n.id === e.target);
      return `<li data-id="${e.target}"><span style="color:${getKindColorHex(t?.kind)}">${t?.name || e.target}</span> <span style="color:#505070">${e.symbols.join(", ")}</span></li>`;
    }).join("") + "</ul>";
    bindInfoLinks(el);
  } else if (tab === "usedby") {
    if (incoming.length === 0) { el.innerHTML = "<div style='color:#505070'>Not used by any file</div>"; return; }
    el.innerHTML = "<ul>" + incoming.map((e) => {
      const s = graph!.nodes.find((n) => n.id === e.source);
      return `<li data-id="${e.source}"><span style="color:${getKindColorHex(s?.kind)}">${s?.name || e.source}</span></li>`;
    }).join("") + "</ul>";
    bindInfoLinks(el);
  } else if (tab === "exports") {
    if (node.exports.length === 0) { el.innerHTML = "<div style='color:#505070'>No exports</div>"; return; }
    el.innerHTML = "<ul>" + node.exports.map((exp) => `<li>${exp}</li>`).join("") + "</ul>";
  }
}

function bindInfoLinks(el: HTMLElement) {
  el.querySelectorAll("li[data-id]").forEach((li) => {
    li.addEventListener("click", () => {
      const id = (li as HTMLElement).dataset.id!;
      const target = graph!.nodes.find((n) => n.id === id);
      if (target) onNodeClick(target);
    });
  });
}

function getKindColorHex(kind?: string): string {
  const colors: Record<string, string> = {
    page: "#e94560", component: "#3a86c8", hook: "#8338ec", apiHook: "#06d6a0",
    store: "#f77f00", util: "#4a6fa5", constant: "#6a6a8a", type: "#8a6a9a", dir: "#505070",
  };
  return colors[kind || ""] || "#a0a0c0";
}

// --- Minimap ---
let minimapCanvas: HTMLCanvasElement | null = null;
let minimapCtx: CanvasRenderingContext2D | null = null;
let graphBounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 };

function initMinimap() {
  minimapCanvas = document.getElementById("minimap-canvas") as HTMLCanvasElement;
  minimapCtx = minimapCanvas.getContext("2d");

  const container = document.getElementById("minimap")!;
  const resizeMinimap = () => {
    minimapCanvas!.width = container.clientWidth;
    minimapCanvas!.height = container.clientHeight;
    updateMinimap();
  };
  resizeMinimap();
  window.addEventListener("resize", resizeMinimap);

  container.addEventListener("pointerdown", onMinimapClick);
  container.addEventListener("pointermove", (e) => {
    if (e.buttons === 1) onMinimapClick(e);
  });
}

function onMinimapClick(e: PointerEvent) {
  if (!app || !minimapCanvas) return;
  const rect = minimapCanvas.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const clickY = e.clientY - rect.top;

  const w = minimapCanvas.width;
  const h = minimapCanvas.height;
  const gw = graphBounds.maxX - graphBounds.minX || 1;
  const gh = graphBounds.maxY - graphBounds.minY || 1;

  const graphAspect = gw / gh;
  const mapAspect = w / h;
  let drawW: number, drawH: number, drawX: number, drawY: number;
  if (graphAspect > mapAspect) {
    drawW = w; drawH = w / graphAspect; drawX = 0; drawY = (h - drawH) / 2;
  } else {
    drawH = h; drawW = h * graphAspect; drawX = (w - drawW) / 2; drawY = 0;
  }

  // Convert minimap click to world coordinate
  const worldX = graphBounds.minX + ((clickX * (w / rect.width) - drawX) / drawW) * gw;
  const worldY = graphBounds.minY + ((clickY * (h / rect.height) - drawY) / drawH) * gh;

  offX = app.screen.width / 2 - worldX * scale;
  offY = app.screen.height / 2 - worldY * scale;
  applyTransform();
}

function updateMinimap() {
  if (!minimapCtx || !minimapCanvas || visNodes.size === 0 || !app) return;

  const ctx = minimapCtx;
  const w = minimapCanvas.width;
  const h = minimapCanvas.height;

  // Compute graph bounds
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  visNodes.forEach((vn) => {
    minX = Math.min(minX, vn.x);
    minY = Math.min(minY, vn.y);
    maxX = Math.max(maxX, vn.x);
    maxY = Math.max(maxY, vn.y);
  });
  const pad = 50;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  graphBounds = { minX, minY, maxX, maxY };

  const gw = maxX - minX || 1;
  const gh = maxY - minY || 1;

  // Fit graph into minimap preserving aspect ratio
  const graphAspect = gw / gh;
  const mapAspect = w / h;
  let drawW: number, drawH: number, drawX: number, drawY: number;
  if (graphAspect > mapAspect) {
    drawW = w;
    drawH = w / graphAspect;
    drawX = 0;
    drawY = (h - drawH) / 2;
  } else {
    drawH = h;
    drawW = h * graphAspect;
    drawX = (w - drawW) / 2;
    drawY = 0;
  }

  ctx.clearRect(0, 0, w, h);

  // Draw nodes as dots
  visNodes.forEach((vn) => {
    const px = drawX + ((vn.x - minX) / gw) * drawW;
    const py = drawY + ((vn.y - minY) / gh) * drawH;
    ctx.fillStyle = vn.isDir ? "#505070" : "#3a86c8";
    ctx.fillRect(px, py, 1.5, 1.5);
  });

  // Draw viewport rectangle
  const vpLeft = drawX + ((-offX / scale - minX) / gw) * drawW;
  const vpTop = drawY + ((-offY / scale - minY) / gh) * drawH;
  const vpW = (app.screen.width / scale) / gw * drawW;
  const vpH = (app.screen.height / scale) / gh * drawH;

  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.lineWidth = 1;
  ctx.strokeRect(vpLeft, vpTop, vpW, vpH);
}

// --- Search ---
let searchResults: VisNode[] = [];
let searchIndex = -1;

function setupSearch() {
  const bar = document.getElementById("search-bar")!;
  const input = document.getElementById("search-input") as HTMLInputElement;
  const info = document.getElementById("search-info")!;

  // Cmd+F to open
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "f") {
      e.preventDefault();
      bar.classList.add("visible");
      input.focus();
      input.select();
    }
    if (e.key === "Escape") {
      // Close any open panel
      const info = document.getElementById("info-panel")!;
      const settings = document.getElementById("settings-panel")!;
      const search = document.getElementById("search-bar")!;
      const code = document.getElementById("code-panel")!;
      if (search.classList.contains("visible")) {
        e.preventDefault();
        closeSearch();
      } else if (code.classList.contains("visible")) {
        e.preventDefault();
        code.classList.remove("visible");
        clearHighlight();
      } else if (info.classList.contains("visible")) {
        e.preventDefault();
        info.classList.remove("visible");
        clearHighlight();
      } else if (settings.classList.contains("visible")) {
        e.preventDefault();
        settings.classList.remove("visible");
      } else {
        // Nothing open — still prevent fullscreen exit
        e.preventDefault();
      }
    }
    // Arrow keys when search is open
    if (bar.classList.contains("visible") && searchResults.length > 0) {
      if (e.key === "ArrowDown" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        navigateSearch(1);
      }
      if (e.key === "ArrowUp" || (e.key === "Enter" && e.shiftKey)) {
        e.preventDefault();
        navigateSearch(-1);
      }
    }
  });

  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  input.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const query = input.value.trim().toLowerCase();
    if (!query) {
      searchResults = [];
      searchIndex = -1;
      info.textContent = "";
      clearSearchHighlight();
      return;
    }

    searchResults = [];
    const isPathSearch = query.includes("/") || query.includes(".ts");
    visNodes.forEach((vn) => {
      const target = isPathSearch ? vn.id.toLowerCase() : vn.name.toLowerCase();
      if (target.includes(query)) {
        searchResults.push(vn);
      }
    });

    // If nothing rendered yet, search all graph nodes
    if (searchResults.length === 0 && graph) {
      const matches = graph.nodes.filter((n) => {
        const target = isPathSearch ? n.id.toLowerCase() : n.name.toLowerCase();
        return target.includes(query);
      });
      info.textContent = matches.length > 0 ? `${matches.length} in project (select a category)` : "No results";
      searchIndex = -1;
      clearSearchHighlight();
      return;
    }

    if (searchResults.length > 0) {
      searchIndex = 0;
      info.textContent = `1 / ${searchResults.length}`;
      applySearchHighlight();
      if (isPathSearch) {
        if (searchResults.length <= 500) {
          showSearchResultsList(searchResults, 0);
        } else {
          // Too many results — show count, don't render list
          hideSearchResultsList();
          info.textContent = `${searchResults.length} results (type more to filter)`;
          searchIndex = -1;
          return;
        }
      } else {
        hideSearchResultsList();
      }
      focusSearchResult(true);
    } else {
      searchIndex = -1;
      info.textContent = "No results";
      clearSearchHighlight();
      hideSearchResultsList();
    }
    }, 250); // debounce 250ms
  });

  document.getElementById("search-next")!.addEventListener("click", () => navigateSearch(1));
  document.getElementById("search-prev")!.addEventListener("click", () => navigateSearch(-1));
  document.getElementById("search-close-btn")!.addEventListener("click", closeSearch);
}

function navigateSearch(dir: number) {
  if (searchResults.length === 0) return;
  searchIndex = (searchIndex + dir + searchResults.length) % searchResults.length;
  document.getElementById("search-info")!.textContent = `${searchIndex + 1} / ${searchResults.length}`;
  applySearchHighlight();
  updateSearchListActive(searchIndex);
  focusSearchResult(false); // navigate: keep zoom
}

function applySearchHighlight() {
  // Reset all labels
  visNodes.forEach((vn) => {
    (vn.label.style as TextStyle).fill = vn.isDir ? 0x8080a0 : 0xb0b0d0;
  });

  // Highlight matches
  searchResults.forEach((vn, i) => {
    if (i === searchIndex) {
      (vn.label.style as TextStyle).fill = 0xffcc00; // current: yellow
    } else {
      (vn.label.style as TextStyle).fill = 0xf0a040; // other matches: orange
    }
  });
}

function clearSearchHighlight() {
  visNodes.forEach((vn) => {
    (vn.label.style as TextStyle).fill = vn.isDir ? 0x8080a0 : 0xb0b0d0;
  });
}

function focusSearchResult(adjustZoom: boolean) {
  if (searchIndex < 0 || searchIndex >= searchResults.length || !app) return;
  const vn = searchResults[searchIndex];
  if (adjustZoom) {
    scale = 0.47;
  }
  offX = app.screen.width / 2 - vn.x * scale;
  offY = app.screen.height / 2 - vn.y * scale;
  applyTransform();
  updateVisibility();
  vn.label.visible = true;
}

function closeSearch() {
  document.getElementById("search-bar")!.classList.remove("visible");
  searchResults = [];
  searchIndex = -1;
  document.getElementById("search-info")!.textContent = "";
  clearSearchHighlight();
  hideSearchResultsList();
}

function showSearchResultsList(results: VisNode[], activeIdx: number) {
  const list = document.getElementById("search-results-list")!;
  list.innerHTML = "";
  list.classList.add("visible");

  const ITEM_H = 28;
  const totalH = results.length * ITEM_H;

  // Virtual scroll container
  const spacer = document.createElement("div");
  spacer.style.height = totalH + "px";
  spacer.style.position = "relative";
  list.appendChild(spacer);

  let lastStart = -1;

  function renderVisible() {
    const scrollTop = list.scrollTop;
    const viewH = list.clientHeight;
    const start = Math.max(0, Math.floor(scrollTop / ITEM_H) - 2);
    const end = Math.min(results.length, Math.ceil((scrollTop + viewH) / ITEM_H) + 2);

    if (start === lastStart) return;
    lastStart = start;

    // Remove old items
    spacer.querySelectorAll(".search-result-item").forEach((el) => el.remove());

    for (let i = start; i < end; i++) {
      const vn = results[i];
      const item = document.createElement("div");
      item.className = "search-result-item" + (i === activeIdx ? " active" : "");
      item.style.position = "absolute";
      item.style.top = (i * ITEM_H) + "px";
      item.style.left = "0";
      item.style.right = "0";
      item.style.height = ITEM_H + "px";
      item.dataset.idx = String(i);
      item.innerHTML = `<span class="search-result-name">${vn.name}</span><span class="search-result-path">${vn.id}</span>`;
      item.addEventListener("click", () => {
        searchIndex = i;
        document.getElementById("search-info")!.textContent = `${i + 1} / ${results.length}`;
        applySearchHighlight();
        updateSearchListActive(i);
        focusSearchResult(true);
        if (vn.node) onNodeClick(vn.node);
      });
      spacer.appendChild(item);
    }
  }

  list.addEventListener("scroll", renderVisible);
  renderVisible();

  // Scroll active into view
  if (activeIdx >= 0) {
    list.scrollTop = activeIdx * ITEM_H - list.clientHeight / 2;
  }
}

function hideSearchResultsList() {
  document.getElementById("search-results-list")!.classList.remove("visible");
}

function updateSearchListActive(idx: number) {
  const ITEM_H = 28;
  const list = document.getElementById("search-results-list")!;
  // Update active class on visible items
  list.querySelectorAll(".search-result-item").forEach((el) => {
    const i = parseInt((el as HTMLElement).dataset.idx || "-1");
    el.classList.toggle("active", i === idx);
  });
  // Scroll into view
  const targetTop = idx * ITEM_H;
  if (targetTop < list.scrollTop || targetTop > list.scrollTop + list.clientHeight - ITEM_H) {
    list.scrollTop = targetTop - list.clientHeight / 2;
  }
}

// --- Start ---
init();
