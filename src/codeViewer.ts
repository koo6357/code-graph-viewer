import { invoke } from "@tauri-apps/api/core";
import { TextStyle } from "pixi.js";
import { state, GraphNode } from "./state";
import { relId, getKindColorHex } from "./utils";
import { onNodeClick } from "./highlight";

export async function showCodePanel(node: GraphNode) {
  const panel = document.getElementById("code-panel")!;
  const pathEl = document.getElementById("code-file-path")!;
  const contentEl = document.getElementById("code-content")!;

  const relPath = state.graph ? node.filePath.replace(state.graph.rootPath + "/", "") : node.filePath;
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
  const s = line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const regex = /(\/\/.*$)|(\/\*.*?\*\/)|("[^"]*"|'[^']*'|`[^`]*`)|(=&gt;)|(&lt;\/?)\s*([A-Z][a-zA-Z0-9.]*)|(&lt;\/?)\s*([a-z][a-zA-Z0-9.-]*)|(&lt;\/?|\/?&gt;)|(\b(?:import|export|from|const|let|var|function|return|if|else|switch|case|default|break|continue|for|while|do|try|catch|finally|throw|new|typeof|instanceof|in|of|class|extends|implements|interface|type|enum|async|await|yield|as|is|readonly|public|private|protected|static|abstract|override|declare|void|null|undefined|true|false)\b)|(\b[a-z_$][a-zA-Z0-9_$]*)\s*(?=\()|(\b[A-Z][a-zA-Z0-9]*\b)|(\b\d+\.?\d*\b)/g;

  let lastIndex = 0;
  let match;
  let result = "";

  while ((match = regex.exec(s)) !== null) {
    if (match.index > lastIndex) result += s.slice(lastIndex, match.index);

    if (match[1]) result += `<span style="color:#7A7E85;font-style:italic">${match[1]}</span>`;
    else if (match[2]) result += `<span style="color:#7A7E85;font-style:italic">${match[2]}</span>`;
    else if (match[3]) result += `<span style="color:#6AAB73">${match[3]}</span>`;
    else if (match[4]) result += `<span style="color:#C5C8C6">${match[4]}</span>`;
    else if (match[5] && match[6]) result += `<span style="color:#CF8E6D">${match[5]}</span><span style="color:#6FAFBD">${match[6]}</span>`;
    else if (match[7] && match[8]) result += `<span style="color:#CF8E6D">${match[7]}</span><span style="color:#CF8E6D">${match[8]}</span>`;
    else if (match[9]) result += `<span style="color:#CF8E6D">${match[9]}</span>`;
    else if (match[10]) result += `<span style="color:#CF8E6D">${match[10]}</span>`;
    else if (match[11]) result += `<span style="color:#56A8F5">${match[11]}</span>`;
    else if (match[12]) result += `<span style="color:#6FAFBD">${match[12]}</span>`;
    else if (match[13]) result += `<span style="color:#2AACB8">${match[13]}</span>`;

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < s.length) result += s.slice(lastIndex);
  return result;
}

export function initCodePanel() {
  document.getElementById("code-close")!.addEventListener("click", () => {
    document.getElementById("code-panel")!.classList.remove("visible");
    (window as any).__clearHighlight?.();
  });

  document.querySelectorAll(".code-info-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".code-info-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      if (state.currentInfoNode) renderCodeInfoTab((tab as HTMLElement).dataset.tab!, state.currentInfoNode);
    });
  });
}

function updateCodeInfo(node: GraphNode) {
  state.currentInfoNode = node;
  document.querySelectorAll(".code-info-tab").forEach((t) => t.classList.remove("active"));
  document.querySelector('.code-info-tab[data-tab="usedby"]')!.classList.add("active");
  renderCodeInfoTab("usedby", node);
}

function renderCodeInfoTab(tab: string, node: GraphNode) {
  const el = document.getElementById("code-info-content")!;
  if (!state.graph) return;

  const relPath = node.filePath.replace(state.graph.rootPath + "/", "");
  const incoming = state.graph.edges.filter((e) => e.target === node.id);
  const outgoing = state.graph.edges.filter((e) => e.source === node.id);

  if (tab === "info") {
    el.innerHTML = `
      <div><span style="color:#606080">ID:</span> <span style="font-size:11px">${node.id}</span></div>
      <div><span style="color:#606080">Kind:</span> <span style="color:${getKindColorHex(node.kind)}">${node.kind}</span></div>
      <div><span style="color:#606080">Path:</span> ${relPath}</div>
      <div><span style="color:#606080">Imports:</span> ${outgoing.length} · <span style="color:#606080">Used by:</span> ${incoming.length} · <span style="color:#606080">Exports:</span> ${node.exports.length}</div>
    `;
  } else if (tab === "usedby") {
    if (incoming.length === 0) { el.innerHTML = "<div style='color:#505070'>Not used by any file</div>"; return; }
    el.innerHTML = "<ul>" + incoming.map((e) => {
      const s = state.graph!.nodes.find((n) => n.id === e.source);
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
      const target = state.graph!.nodes.find((n) => n.id === id);
      if (target) {
        onNodeClick(target);
        focusOnNode(id);
      }
    });
  });
}

function focusOnNode(nodeId: string) {
  const vn = state.visNodes.get(nodeId);
  if (!vn || !state.app) return;
  state.offX = state.app.screen.width / 2 - vn.x * state.scale;
  state.offY = state.app.screen.height / 2 - vn.y * state.scale;
  if (state.world) {
    state.world.x = state.offX;
    state.world.y = state.offY;
    state.world.scale.set(state.scale);
  }
}
