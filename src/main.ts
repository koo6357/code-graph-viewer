import { Application, Graphics, Text, TextStyle, Container } from "pixi.js";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";

import { state, GraphNode, DirNode, KIND_COLORS, KIND_SIZES, DRAG_THRESHOLD } from "./state";
import { relId } from "./utils";
import { onNodeClick, clearHighlight, highlightHover, clearHover, redrawEdges, drawTreeEdge } from "./highlight";
import { initMinimap, updateMinimap } from "./minimap";
import { setupSettings, showStats } from "./settings";
import { setupSearch } from "./search";
import { showCodePanel, initCodePanel } from "./codeViewer";

// --- Wire up cross-module callbacks ---
(window as any).__showCodePanel = showCodePanel;
(window as any).__clearHighlight = clearHighlight;
(window as any).__renderFolderTree = renderFolderTree;

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
  state.app = pixiApp;

  state.world = new Container();
  pixiApp.stage.addChild(state.world);

  const canvas = pixiApp.canvas as HTMLCanvasElement;

  canvas.addEventListener("pointerdown", (e) => {
    state.canvasDragging = true;
    state.canvasStartX = e.clientX;
    state.canvasStartY = e.clientY;
  });

  window.addEventListener("pointermove", (e) => {
    if (state.canvasDragging) {
      state.offX += e.clientX - state.canvasStartX;
      state.offY += e.clientY - state.canvasStartY;
      state.canvasStartX = e.clientX;
      state.canvasStartY = e.clientY;
      applyTransform();
    }
  });

  window.addEventListener("pointerup", () => {
    if (state.canvasDragging) {
      state.canvasDragging = false;
      canvas.style.cursor = "default";
    }
  });

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY > 0 ? 0.85 : 1.15;
    const ns = Math.max(0.1, Math.min(1, state.scale * factor));
    state.offX = mx - (mx - state.offX) * (ns / state.scale);
    state.offY = my - (my - state.offY) * (ns / state.scale);
    state.scale = ns;
    applyTransform();
    if (!state.edgesOnZoom) {
      if (state.treeEdgeGfx) state.treeEdgeGfx.visible = false;
      if (state.edgeDebounce) clearTimeout(state.edgeDebounce);
      state.edgeDebounce = setTimeout(() => {
        if (state.treeEdgeGfx) state.treeEdgeGfx.visible = true;
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

// --- Menus ---
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

  ["settings-panel", "info-panel"].forEach((id) => {
    document.getElementById(id)!.addEventListener("pointerdown", (e) => e.stopPropagation());
  });

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

  handle.addEventListener("pointerup", () => { dragging = false; });
  handle.addEventListener("lostpointercapture", () => { dragging = false; });
}

// --- Auto open ---
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

// --- Transform ---
function applyTransform() {
  if (!state.world) return;
  state.world.x = state.offX;
  state.world.y = state.offY;
  state.world.scale.set(state.scale);
  updateMinimap();
}

function updateVisibility() {
  if (state.visibilityTimer) clearTimeout(state.visibilityTimer);
  state.visibilityTimer = setTimeout(updateVisibilityNow, 50);
}

function updateVisibilityNow() {
  const total = state.visNodes.size;
  let visibleCount = 0;
  let labelsShown = 0;
  const effectiveFontSize = state.scale < 0.25 ? 2.5 : state.fontSizeMultiplier;

  const scaleEl = document.getElementById("val-scale");
  if (scaleEl) scaleEl.textContent = state.scale.toFixed(2);

  state.visNodes.forEach((vn) => {
    vn.container.visible = true;
    vn.label.visible = true;
    vn.label.parent.scale.set(effectiveFontSize);
    vn.circle.scale.set(state.nodeSizeMultiplier);
    visibleCount++;
    labelsShown++;
  });

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
    state.graph = await invoke("scan_project", { rootPath: path });
    loadingEl.style.display = "none";
    renderCategoryList();
    showStats();
    renderFolderTree("", state.graph!.nodes);
  } catch (e) {
    loadingEl.textContent = `Error: ${e}`;
  }
}

// --- Categories ---
function renderCategoryList() {
  if (!state.graph) return;

  const catMap = new Map<string, GraphNode[]>();
  state.graph.nodes.forEach((n) => {
    const rel = relId(n.id);
    const parts = rel.split("/");
    const key = parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0];
    if (!catMap.has(key)) catMap.set(key, []);
    catMap.get(key)!.push(n);
  });

  const list = document.getElementById("category-list")!;
  list.innerHTML = "";

  const allItem = document.createElement("div");
  allItem.className = "cat-item active";
  allItem.innerHTML = `<span>All</span><span class="cat-count">${state.graph.nodes.length}</span>`;
  allItem.addEventListener("click", () => {
    document.querySelectorAll(".cat-item").forEach((e) => e.classList.remove("active"));
    allItem.classList.add("active");
    state.activeCategory = null;
    renderFolderTree("", state.graph!.nodes);
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
      state.activeCategory = key;
      renderFolderTree(key, nodes);

      if (expanded) buildSubFolders(key, nodes, subContainer);
    });

    list.appendChild(item);
    list.appendChild(subContainer);
  });
}

function buildSubFolders(catKey: string, nodes: GraphNode[], container: HTMLElement) {
  container.innerHTML = "";

  const tree = new Map<string, { nodes: GraphNode[]; children: Map<string, any> }>();
  nodes.forEach((n) => {
    const nRel = relId(n.id);
    const rel = nRel.startsWith(catKey + "/") ? nRel.slice(catKey.length + 1) : nRel;
    const parts = rel.split("/");
    if (parts.length <= 1) return;

    let current = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (!current.has(seg)) current.set(seg, { nodes: [], children: new Map() });
      const entry = current.get(seg)!;
      if (i === parts.length - 2) entry.nodes.push(n);
      current = entry.children;
    }
  });

  function collectNodes(entry: { nodes: GraphNode[]; children: Map<string, any> }): GraphNode[] {
    const result = [...entry.nodes];
    entry.children.forEach((child) => result.push(...collectNodes(child)));
    return result;
  }

  function renderLevel(map: Map<string, { nodes: GraphNode[]; children: Map<string, any> }>, parentKey: string, depth: number, parentEl: HTMLElement) {
    const sorted = Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    sorted.forEach(([name, entry]) => {
      const fullKey = parentKey + "/" + name;
      const allNodes = collectNodes(entry);
      const hasChildren = entry.children.size > 0;

      const item = document.createElement("div");
      item.className = "cat-item";
      item.style.paddingLeft = `${14 + depth * 14}px`;
      item.style.fontSize = "12px";
      const caret = hasChildren
        ? `<span style="font-size:8px;display:inline-block;width:12px;vertical-align:middle">▶</span>`
        : `<span style="width:12px;display:inline-block"></span>`;
      item.innerHTML = `<span>${caret} ${name}</span><span class="cat-count">${allNodes.length}</span>`;

      const subDiv = document.createElement("div");
      subDiv.style.display = "none";
      let exp = false;

      item.addEventListener("click", (e) => {
        e.stopPropagation();
        state.activeCategory = catKey;
        renderFolderTree(fullKey, allNodes);
        if (hasChildren) {
          exp = !exp;
          subDiv.style.display = exp ? "block" : "none";
          const c = item.querySelector("span span") as HTMLElement;
          if (c) c.textContent = exp ? "▼" : "▶";
          if (exp && subDiv.children.length === 0) renderLevel(entry.children, fullKey, depth + 1, subDiv);
        }
      });

      parentEl.appendChild(item);
      if (hasChildren) parentEl.appendChild(subDiv);
    });
  }

  renderLevel(tree, catKey, 1, container);
}

// --- Tree layout ---
function buildDirTree(nodes: GraphNode[], catKey: string): DirNode {
  const rootName = catKey ? catKey.split("/").pop()! : "root";
  const root: DirNode = { id: catKey || "__root__", name: rootName, isDir: true, children: [] };
  const dirMap = new Map<string, DirNode>();
  dirMap.set("", root);

  const sorted = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  sorted.forEach((node) => {
    const nodeRel = relId(node.id);
    const rel = catKey && nodeRel.startsWith(catKey + "/") ? nodeRel.slice(catKey.length + 1) : nodeRel;
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

    parent.children.push({ id: node.id, name: node.name, isDir: false, kind: node.kind, node, children: [] });
  });

  return root;
}

function layoutTree(dir: DirNode, x: number, yStart: number): { nodes: Array<{ dn: DirNode; x: number; y: number }>; height: number } {
  const result: Array<{ dn: DirNode; x: number; y: number }> = [];

  if (dir.children.length === 0) {
    result.push({ dn: dir, x, y: yStart });
    return { nodes: result, height: state.V_GAP };
  }

  let childY = yStart;
  const childResults: Array<{ nodes: Array<{ dn: DirNode; x: number; y: number }>; height: number }> = [];

  dir.children.forEach((child) => {
    const sub = layoutTree(child, x + state.H_GAP, childY);
    childResults.push(sub);
    childY += sub.height;
  });

  const totalHeight = childY - yStart;
  const firstChildY = childResults[0].nodes[0].y;
  const lastChildY = childResults[childResults.length - 1].nodes[0].y;
  const parentY = (firstChildY + lastChildY) / 2;

  result.push({ dn: dir, x, y: parentY });
  childResults.forEach((cr) => result.push(...cr.nodes));

  return { nodes: result, height: totalHeight };
}

function renderFolderTree(catKey: string, nodes: GraphNode[]) {
  if (!state.world || !state.app || !state.graph) return;
  state.lastRenderedCatKey = catKey;
  state.lastRenderedNodes = nodes;
  state.world.removeChildren();
  state.visNodes.clear();

  let allNodes = nodes;
  if (state.showPackages && catKey !== "" && state.graph) {
    const packageNodes = state.graph.nodes.filter((n) => {
      const rel = relId(n.id);
      return rel.startsWith("packages/") && !nodes.includes(n);
    });
    if (packageNodes.length > 0) allNodes = [...nodes, ...packageNodes];
  }

  const tree = buildDirTree(allNodes, catKey || "");
  const layout = layoutTree(tree, 50, 50);

  state.treeEdgeGfx = new Graphics();
  state.importEdgeGfx = new Graphics();
  const nodeLayer = new Container();

  state.world.addChild(state.treeEdgeGfx);
  state.world.addChild(state.importEdgeGfx);
  state.world.addChild(nodeLayer);

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

    let circleDownX = 0, circleDownY = 0;
    circle.on("pointerdown", (e) => {
      e.stopPropagation();
      circleDownX = e.clientX;
      circleDownY = e.clientY;
    });
    circle.on("pointerup", (e) => {
      const dist = Math.sqrt((e.clientX - circleDownX) ** 2 + (e.clientY - circleDownY) ** 2);
      if (dist < DRAG_THRESHOLD && dn.node) onNodeClick(dn.node);
    });
    circle.on("pointerover", () => {
      const vn = state.visNodes.get(dn.id);
      if (vn) highlightHover(vn.id);
    });
    circle.on("pointerout", () => { clearHover(); });

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

    const labelContainer = new Container();
    labelContainer.x = size + 5;
    labelContainer.y = 0;
    label.x = 0;
    label.anchor.set(0, 0.5);
    label.y = 0;
    labelContainer.addChild(label);

    const bounds = label.getLocalBounds();
    const pad = 3;
    const labelBg = new Graphics();
    labelBg.rect(-pad, bounds.y - pad, bounds.width + pad * 2, bounds.height + pad * 2);
    labelBg.fill({ color: 0x111128 });
    labelContainer.addChildAt(labelBg, 0);

    labelContainer.eventMode = "static";
    labelContainer.cursor = "pointer";
    labelContainer.on("pointerover", () => {
      const vn = state.visNodes.get(dn.id);
      if (vn) highlightHover(vn.id);
    });
    labelContainer.on("pointerout", () => { clearHover(); });

    let labelDownX = 0, labelDownY = 0;
    labelContainer.on("pointerdown", (e) => {
      e.stopPropagation();
      labelDownX = e.clientX;
      labelDownY = e.clientY;
    });
    labelContainer.on("pointerup", (e) => {
      const dist = Math.sqrt((e.clientX - labelDownX) ** 2 + (e.clientY - labelDownY) ** 2);
      if (dist < DRAG_THRESHOLD && dn.node) onNodeClick(dn.node);
    });

    cont.addChild(labelContainer);
    nodeLayer.addChild(cont);

    state.visNodes.set(dn.id, {
      id: dn.id, name: dn.name, kind, isDir: dn.isDir, node: dn.node,
      x, y, parentId: null, children: dn.children.map((c) => c.id),
      container: cont, circle, label,
    });
  });

  layout.nodes.forEach(({ dn }) => {
    dn.children.forEach((child) => {
      const cvn = state.visNodes.get(child.id);
      if (cvn) cvn.parentId = dn.id;
    });
  });

  redrawEdges();
  centerView();
  updateVisibility();
  updateMinimap();
  state.visNodes.forEach((vn) => {
    vn.circle.scale.set(state.nodeSizeMultiplier);
    vn.label.parent.scale.set(state.fontSizeMultiplier);
  });
}

function centerView() {
  if (state.skipCenterView) return;
  if (!state.app || state.visNodes.size === 0) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  state.visNodes.forEach((vn) => {
    minX = Math.min(minX, vn.x);
    minY = Math.min(minY, vn.y);
    maxX = Math.max(maxX, vn.x);
    maxY = Math.max(maxY, vn.y);
  });
  state.scale = 0.2;
  state.offX = state.app.screen.width / 2 - ((minX + maxX) / 2) * state.scale;
  state.offY = state.app.screen.height / 2 - ((minY + maxY) / 2) * state.scale;
  applyTransform();
}

// --- Start ---
init();
