import { state, KIND_COLORS } from "./state";

export function relId(id: string): string {
  if (state.graph && id.startsWith(state.graph.rootPath)) {
    return id.slice(state.graph.rootPath.length + 1);
  }
  return id;
}

export function getKindColorHex(kind?: string): string {
  const colors: Record<string, string> = {
    page: "#e94560", component: "#3a86c8", hook: "#8338ec", apiHook: "#06d6a0",
    store: "#f77f00", util: "#4a6fa5", constant: "#6a6a8a", type: "#8a6a9a", dir: "#505070",
  };
  return colors[kind || ""] || "#a0a0c0";
}
