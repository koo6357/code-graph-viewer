import { state } from "./state";
import { relId } from "./utils";

export function setupSettings() {
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

  bind("slider-hgap", "val-hgap", (v) => { state.H_GAP = v; rerender(); });
  bind("slider-vgap", "val-vgap", (v) => { state.V_GAP = v; rerender(); });
  bind("slider-nsize", "val-nsize", (v) => {
    state.nodeSizeMultiplier = v;
    state.visNodes.forEach((vn) => { vn.circle.scale.set(v); });
  });
  bind("slider-fsize", "val-fsize", (v) => {
    state.fontSizeMultiplier = v;
    state.visNodes.forEach((vn) => { vn.label.parent.scale.set(v); });
  });

  document.getElementById("toggle-edges")!.addEventListener("change", (e) => {
    state.edgesOnZoom = (e.target as HTMLInputElement).checked;
  });

  document.getElementById("toggle-packages")!.addEventListener("change", (e) => {
    state.showPackages = (e.target as HTMLInputElement).checked;
    if (state.lastRenderedNodes.length > 0) {
      // Trigger rerender via event
      (window as any).__renderFolderTree?.(state.lastRenderedCatKey, state.lastRenderedNodes);
    }
  });

  document.getElementById("save-settings")!.addEventListener("click", () => {
    const settings = { hGap: state.H_GAP, vGap: state.V_GAP, nodeSize: state.nodeSizeMultiplier, fontSize: state.fontSizeMultiplier, depthVisibility: state.depthOverride };
    localStorage.setItem("cgv-settings", JSON.stringify(settings));
    const btn = document.getElementById("save-settings")!;
    btn.textContent = "✅ Saved!";
    setTimeout(() => { btn.textContent = "💾 Save"; }, 1500);
  });

  document.getElementById("copy-settings")!.addEventListener("click", () => {
    const all = {
      currentScale: parseFloat(state.scale.toFixed(3)),
      hGap: state.H_GAP,
      vGap: state.V_GAP,
      nodeSize: state.nodeSizeMultiplier,
      fontSize: state.fontSizeMultiplier,
      depth: state.depthOverride,
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
    if (s.hGap) { state.H_GAP = s.hGap; setSlider("slider-hgap", "val-hgap", s.hGap); }
    if (s.vGap) { state.V_GAP = s.vGap; setSlider("slider-vgap", "val-vgap", s.vGap); }
    if (s.nodeSize) { state.nodeSizeMultiplier = s.nodeSize; setSlider("slider-nsize", "val-nsize", s.nodeSize); }
    if (s.fontSize) { state.fontSizeMultiplier = s.fontSize; setSlider("slider-fsize", "val-fsize", s.fontSize); }
    if (s.depthVisibility) { state.depthOverride = s.depthVisibility; }
  } catch {}
}

export function setSlider(sliderId: string, valId: string, value: number) {
  const slider = document.getElementById(sliderId) as HTMLInputElement;
  const valEl = document.getElementById(valId);
  if (slider) slider.value = String(value);
  if (valEl) valEl.textContent = String(value);
}

function rerender() {
  if (state.lastRenderedNodes.length > 0) {
    state.skipCenterView = true;
    const prevScale = state.scale;
    const prevOffX = state.offX;
    const prevOffY = state.offY;
    (window as any).__renderFolderTree?.(state.lastRenderedCatKey, state.lastRenderedNodes);
    state.scale = prevScale;
    state.offX = prevOffX;
    state.offY = prevOffY;
    if (state.world) {
      state.world.x = state.offX;
      state.world.y = state.offY;
      state.world.scale.set(state.scale);
    }
    state.skipCenterView = false;
  }
}

export function showStats() {
  if (!state.graph) return;
  const el = document.getElementById("stats")!;
  const counts = new Map<string, number>();
  state.graph.nodes.forEach((n) => counts.set(n.kind, (counts.get(n.kind) || 0) + 1));
  let html = `<div>${state.graph.nodes.length} nodes · ${state.graph.edges.length} edges</div>`;
  counts.forEach((c, k) => { html += `<div>${k}: ${c}</div>`; });
  el.innerHTML = html;
}
