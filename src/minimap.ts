import { state } from "./state";

export function initMinimap() {
  state.minimapCanvas = document.getElementById("minimap-canvas") as HTMLCanvasElement;
  state.minimapCtx = state.minimapCanvas.getContext("2d");

  const container = document.getElementById("minimap")!;
  const resizeMinimap = () => {
    state.minimapCanvas!.width = container.clientWidth;
    state.minimapCanvas!.height = container.clientHeight;
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
  if (!state.app || !state.minimapCanvas) return;
  const rect = state.minimapCanvas.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const clickY = e.clientY - rect.top;

  const w = state.minimapCanvas.width;
  const h = state.minimapCanvas.height;
  const gw = state.graphBounds.maxX - state.graphBounds.minX || 1;
  const gh = state.graphBounds.maxY - state.graphBounds.minY || 1;

  const graphAspect = gw / gh;
  const mapAspect = w / h;
  let drawW: number, drawH: number, drawX: number, drawY: number;
  if (graphAspect > mapAspect) {
    drawW = w; drawH = w / graphAspect; drawX = 0; drawY = (h - drawH) / 2;
  } else {
    drawH = h; drawW = h * graphAspect; drawX = (w - drawW) / 2; drawY = 0;
  }

  const worldX = state.graphBounds.minX + ((clickX * (w / rect.width) - drawX) / drawW) * gw;
  const worldY = state.graphBounds.minY + ((clickY * (h / rect.height) - drawY) / drawH) * gh;

  state.offX = state.app.screen.width / 2 - worldX * state.scale;
  state.offY = state.app.screen.height / 2 - worldY * state.scale;
  applyTransformForMinimap();
}

function applyTransformForMinimap() {
  if (!state.world) return;
  state.world.x = state.offX;
  state.world.y = state.offY;
  state.world.scale.set(state.scale);
  updateMinimap();
}

export function updateMinimap() {
  if (!state.minimapCtx || !state.minimapCanvas || state.visNodes.size === 0 || !state.app) return;

  const ctx = state.minimapCtx;
  const w = state.minimapCanvas.width;
  const h = state.minimapCanvas.height;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  state.visNodes.forEach((vn) => {
    minX = Math.min(minX, vn.x);
    minY = Math.min(minY, vn.y);
    maxX = Math.max(maxX, vn.x);
    maxY = Math.max(maxY, vn.y);
  });
  const pad = 50;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  state.graphBounds = { minX, minY, maxX, maxY };

  const gw = maxX - minX || 1;
  const gh = maxY - minY || 1;

  const graphAspect = gw / gh;
  const mapAspect = w / h;
  let drawW: number, drawH: number, drawX: number, drawY: number;
  if (graphAspect > mapAspect) {
    drawW = w; drawH = w / graphAspect; drawX = 0; drawY = (h - drawH) / 2;
  } else {
    drawH = h; drawW = h * graphAspect; drawX = (w - drawW) / 2; drawY = 0;
  }

  ctx.clearRect(0, 0, w, h);

  state.visNodes.forEach((vn) => {
    const px = drawX + ((vn.x - minX) / gw) * drawW;
    const py = drawY + ((vn.y - minY) / gh) * drawH;
    ctx.fillStyle = vn.isDir ? "#505070" : "#3a86c8";
    ctx.fillRect(px, py, 1.5, 1.5);
  });

  const vpLeft = drawX + ((-state.offX / state.scale - minX) / gw) * drawW;
  const vpTop = drawY + ((-state.offY / state.scale - minY) / gh) * drawH;
  const vpW = (state.app.screen.width / state.scale) / gw * drawW;
  const vpH = (state.app.screen.height / state.scale) / gh * drawH;

  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.lineWidth = 1;
  ctx.strokeRect(vpLeft, vpTop, vpW, vpH);
}
