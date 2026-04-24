import { TextStyle } from "pixi.js";
import { state, VisNode } from "./state";
import { relId } from "./utils";
import { onNodeClick } from "./highlight";
import { clearHighlight } from "./highlight";

export function setupSearch() {
  const bar = document.getElementById("search-bar")!;
  const input = document.getElementById("search-input") as HTMLInputElement;
  const info = document.getElementById("search-info")!;

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "f") {
      e.preventDefault();
      bar.classList.add("visible");
      input.focus();
      input.select();
    }
    if (e.key === "Escape") {
      const infoPanel = document.getElementById("info-panel")!;
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
      } else if (infoPanel.classList.contains("visible")) {
        e.preventDefault();
        infoPanel.classList.remove("visible");
        clearHighlight();
      } else if (settings.classList.contains("visible")) {
        e.preventDefault();
        settings.classList.remove("visible");
      } else {
        e.preventDefault();
      }
    }
    if (bar.classList.contains("visible") && state.searchResults.length > 0) {
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
        state.searchResults = [];
        state.searchIndex = -1;
        info.textContent = "";
        clearSearchHighlight();
        return;
      }

      state.searchResults = [];
      const isPathSearch = query.includes("/") || query.includes(".ts");
      state.visNodes.forEach((vn) => {
        const target = isPathSearch ? relId(vn.id).toLowerCase() : vn.name.toLowerCase();
        if (target.includes(query)) {
          state.searchResults.push(vn);
        }
      });

      if (state.searchResults.length === 0 && state.graph) {
        const matches = state.graph.nodes.filter((n) => {
          const target = isPathSearch ? relId(n.id).toLowerCase() : n.name.toLowerCase();
          return target.includes(query);
        });
        info.textContent = matches.length > 0 ? `${matches.length} in project (select a category)` : "No results";
        state.searchIndex = -1;
        clearSearchHighlight();
        return;
      }

      if (state.searchResults.length > 0) {
        state.searchIndex = 0;
        info.textContent = `1 / ${state.searchResults.length}`;
        applySearchHighlight();
        if (isPathSearch) {
          if (state.searchResults.length <= 500) {
            showSearchResultsList(state.searchResults, 0);
          } else {
            hideSearchResultsList();
            info.textContent = `${state.searchResults.length} results (type more to filter)`;
            state.searchIndex = -1;
            return;
          }
        } else {
          hideSearchResultsList();
        }
        focusSearchResult(true);
      } else {
        state.searchIndex = -1;
        info.textContent = "No results";
        clearSearchHighlight();
        hideSearchResultsList();
      }
    }, 250);
  });

  document.getElementById("search-next")!.addEventListener("click", () => navigateSearch(1));
  document.getElementById("search-prev")!.addEventListener("click", () => navigateSearch(-1));
  document.getElementById("search-close-btn")!.addEventListener("click", closeSearch);
}

function navigateSearch(dir: number) {
  if (state.searchResults.length === 0) return;
  state.searchIndex = (state.searchIndex + dir + state.searchResults.length) % state.searchResults.length;
  document.getElementById("search-info")!.textContent = `${state.searchIndex + 1} / ${state.searchResults.length}`;
  applySearchHighlight();
  updateSearchListActive(state.searchIndex);
  focusSearchResult(false);
}

function applySearchHighlight() {
  state.visNodes.forEach((vn) => {
    (vn.label.style as TextStyle).fill = vn.isDir ? 0x8080a0 : 0xb0b0d0;
  });
  state.searchResults.forEach((vn, i) => {
    if (i === state.searchIndex) {
      (vn.label.style as TextStyle).fill = 0xffcc00;
    } else {
      (vn.label.style as TextStyle).fill = 0xf0a040;
    }
  });
}

function clearSearchHighlight() {
  state.visNodes.forEach((vn) => {
    (vn.label.style as TextStyle).fill = vn.isDir ? 0x8080a0 : 0xb0b0d0;
  });
}

function focusSearchResult(adjustZoom: boolean) {
  if (state.searchIndex < 0 || state.searchIndex >= state.searchResults.length || !state.app) return;
  const vn = state.searchResults[state.searchIndex];
  if (adjustZoom) state.scale = 0.47;
  state.offX = state.app.screen.width / 2 - vn.x * state.scale;
  state.offY = state.app.screen.height / 2 - vn.y * state.scale;
  if (state.world) {
    state.world.x = state.offX;
    state.world.y = state.offY;
    state.world.scale.set(state.scale);
  }
  vn.label.visible = true;
}

function closeSearch() {
  document.getElementById("search-bar")!.classList.remove("visible");
  state.searchResults = [];
  state.searchIndex = -1;
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
      item.innerHTML = `<span class="search-result-name">${vn.name}</span><span class="search-result-path">${relId(vn.id)}</span>`;
      item.addEventListener("click", () => {
        state.searchIndex = i;
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
  list.querySelectorAll(".search-result-item").forEach((el) => {
    const i = parseInt((el as HTMLElement).dataset.idx || "-1");
    el.classList.toggle("active", i === idx);
  });
  const targetTop = idx * ITEM_H;
  if (targetTop < list.scrollTop || targetTop > list.scrollTop + list.clientHeight - ITEM_H) {
    list.scrollTop = targetTop - list.clientHeight / 2;
  }
}
