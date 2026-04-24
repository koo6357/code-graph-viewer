mod cache;
mod graph;
mod parser;
mod scanner;

use cache::{diff_files, get_mtime, load_cache, save_cache, ProjectCache};
use graph::{EdgeKind, GraphEdge, GraphNode, NodeKind, ProjectGraph};
use rayon::prelude::*;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::Emitter;
use tauri::Manager;

/// Classify a file into a NodeKind based on its path and content
fn classify_node(path: &Path, file_info: &parser::FileInfo) -> NodeKind {
    let file_name = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    // API hooks: useGetXxx, usePostXxx, usePutXxx, usePatchXxx, useDeleteXxx
    if file_name.starts_with("useGet")
        || file_name.starts_with("usePost")
        || file_name.starts_with("usePut")
        || file_name.starts_with("usePatch")
        || file_name.starts_with("useDelete")
    {
        return NodeKind::ApiHook;
    }

    // Hooks: useXxx
    if file_name.starts_with("use") && file_name.chars().nth(3).map_or(false, |c| c.is_uppercase())
    {
        return NodeKind::Hook;
    }

    // Store files
    if file_name.contains("store") || file_name.contains("Store") {
        return NodeKind::Store;
    }

    // Constants
    if file_name == "constants" || file_name == "constant" || file_name.ends_with("Constants") {
        return NodeKind::Constant;
    }

    // Type files
    if file_name == "types" || file_name == "type" || file_name.ends_with(".type") {
        return NodeKind::Type;
    }

    // Components (has JSX)
    if file_info.has_jsx {
        // Check if it's likely a page (index.tsx in a page-like directory)
        let parent_name = path
            .parent()
            .and_then(|p| p.file_name())
            .unwrap_or_default()
            .to_string_lossy();

        if file_name == "index"
            && (parent_name.chars().next().map_or(false, |c| c.is_uppercase())
                || parent_name == "pages")
        {
            return NodeKind::Page;
        }

        return NodeKind::Component;
    }

    NodeKind::Util
}

/// Resolve an import source to an absolute file path
/// Load path aliases from tsconfig.json (and extended configs)
fn load_tsconfig_paths(root: &Path) -> HashMap<String, Vec<String>> {
    let mut paths = HashMap::new();
    let mut base_url = root.to_path_buf();

    // Try tsconfig.json, then tsconfig.*.json
    let candidates = ["tsconfig.json", "tsconfig.app.json", "tsconfig.base.json"];
    for name in &candidates {
        let tsconfig_path = root.join(name);
        if let Ok(content) = std::fs::read_to_string(&tsconfig_path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(opts) = json.get("compilerOptions") {
                    if let Some(bu) = opts.get("baseUrl").and_then(|v| v.as_str()) {
                        base_url = root.join(bu);
                    }
                    if let Some(p) = opts.get("paths").and_then(|v| v.as_object()) {
                        for (alias, targets) in p {
                            if let Some(arr) = targets.as_array() {
                                let resolved: Vec<String> = arr
                                    .iter()
                                    .filter_map(|v| v.as_str())
                                    .map(|s| {
                                        let clean = s.replace("/*", "");
                                        base_url.join(&clean).to_string_lossy().to_string()
                                    })
                                    .collect();
                                let alias_clean = alias.replace("/*", "");
                                paths.insert(alias_clean, resolved);
                            }
                        }
                    }
                }
                // Check extends
                if let Some(extends) = json.get("extends").and_then(|v| v.as_str()) {
                    let ext_path = root.join(extends);
                    if let Some(parent) = ext_path.parent() {
                        let parent_paths = load_tsconfig_paths(parent);
                        for (k, v) in parent_paths {
                            paths.entry(k).or_insert(v);
                        }
                    }
                }
            }
        }
    }

    paths
}

fn resolve_import(source: &str, from_file: &Path, root: &Path, alias_paths: &HashMap<String, Vec<String>>) -> Option<PathBuf> {
    // Skip bare external packages (no @ prefix, no relative)
    if !source.starts_with('.') && !source.starts_with('@') && !source.contains('/') {
        return None;
    }

    // Relative imports
    if source.starts_with('.') {
        let dir = from_file.parent()?;
        let resolved = dir.join(source);
        let result = try_resolve_file(&resolved);
        if result.is_none() {
        }
        return result;
    }

    // Alias imports — try tsconfig paths first
    let mut best_match: Option<(&str, &Vec<String>, &str)> = None;
    for (alias, targets) in alias_paths {
        if source.starts_with(alias.as_str()) {
            let rest = &source[alias.len()..];
            let rest = rest.strip_prefix('/').unwrap_or(rest);
            if best_match.is_none() || alias.len() > best_match.unwrap().0.len() {
                best_match = Some((alias.as_str(), targets, rest));
            }
        }
    }

    if let Some((alias, targets, rest)) = best_match {
        for target_base in targets {
            let candidate = if rest.is_empty() {
                PathBuf::from(target_base)
            } else {
                PathBuf::from(target_base).join(rest)
            };
            if let Some(resolved) = try_resolve_file(&candidate) {
                return Some(resolved);
            }
        }
    }

    // Monorepo: try node_modules symlink resolve
    let node_modules = root.join("node_modules");
    let parts: Vec<&str> = source.splitn(3, '/').collect();
    if parts.len() >= 2 && parts[0].starts_with('@') {
        let pkg_link = node_modules.join(parts[0]).join(parts[1]);
        if pkg_link.exists() {
            // Read symlink target (one level), resolve relative to node_modules/@scope/
            let real_dir = if pkg_link.is_symlink() {
                let target = std::fs::read_link(&pkg_link).ok()?;
                if target.is_relative() {
                    pkg_link.parent()?.join(&target)
                } else {
                    target
                }
            } else {
                pkg_link.clone()
            };
            // Canonicalize using root as base to stay within project
            let real_dir = if real_dir.starts_with("..") || real_dir.is_relative() {
                std::fs::canonicalize(&real_dir).unwrap_or(real_dir)
            } else {
                real_dir
            };

            let rest = if parts.len() > 2 { parts[2] } else { "" };
            let candidates = if rest.is_empty() {
                vec![real_dir.join("src"), real_dir.clone()]
            } else {
                vec![real_dir.join("src").join(rest), real_dir.join(rest)]
            };
            for candidate in &candidates {
                if let Some(resolved) = try_resolve_file(candidate) {
                    // Ensure resolved path is under root
                    if resolved.starts_with(root) {
                        return Some(resolved);
                    } else {
                    }
                }
            }
        } else {
        }
    } else {
    }

    None
}

fn try_resolve_file(base: &Path) -> Option<PathBuf> {
    let extensions = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
    for ext in &extensions {
        let candidate = PathBuf::from(format!("{}{}", base.display(), ext));
        if candidate.exists() {
            // Canonicalize to resolve .. and symlinks
            return std::fs::canonicalize(&candidate).ok();
        }
    }
    None
}

/// Build the full project graph (with cache support)
fn build_graph(root: &Path) -> ProjectGraph {
    let files = scanner::scan_project(root);
    // Canonicalize root for consistent path comparison
    let canon_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let root_str = root.to_string_lossy().to_string();
    let alias_paths = load_tsconfig_paths(root);
    eprintln!("[tsconfig] loaded {} path aliases", alias_paths.len());

    // Check cache
    let cached = load_cache(&root_str);
    let (files_to_parse, deleted_ids) = if let Some(ref c) = cached {
        let (reparse, deleted) = diff_files(root, &files, &c.file_mtimes);
        eprintln!(
            "[cache] {} cached, {} changed, {} deleted, {} total",
            c.file_mtimes.len(),
            reparse.len(),
            deleted.len(),
            files.len()
        );
        (reparse, deleted)
    } else {
        eprintln!("[cache] no cache, parsing all {} files", files.len());
        (files.clone(), Vec::new())
    };

    // Parse changed files in parallel
    let new_parsed: Vec<(PathBuf, parser::FileInfo)> = files_to_parse
        .par_iter()
        .filter_map(|path| {
            let source = std::fs::read_to_string(path).ok()?;
            let info = parser::parse_file(path, &source)?;
            Some((path.clone(), info))
        })
        .collect();

    // If we have cache, merge: keep unchanged nodes, replace changed, remove deleted
    // For simplicity in edge resolution, we rebuild all edges (edges depend on full graph)
    // But we reuse parsed FileInfo for unchanged files from... we don't cache FileInfo.
    // So: if cache hit and few changes, we still need all FileInfo for edge building.
    // Strategy: parse only changed files, but for edge building re-parse is needed.
    // Better strategy: cache the full graph, only re-parse changed files and rebuild their nodes+edges.

    // For now: if <10% changed, use incremental. Otherwise full rebuild.
    let use_incremental = cached.is_some() && files_to_parse.len() < files.len() / 10;

    if use_incremental {
        let mut graph = cached.unwrap().graph;

        // Remove deleted nodes and their edges
        let deleted_set: std::collections::HashSet<String> = deleted_ids.into_iter().collect();
        graph.nodes.retain(|n| !deleted_set.contains(&n.id));
        graph.edges.retain(|e| !deleted_set.contains(&e.source) && !deleted_set.contains(&e.target));
        graph.file_index.retain(|_, id| !deleted_set.contains(id));

        // Remove old nodes for changed files
        let changed_ids: std::collections::HashSet<String> = new_parsed
            .iter()
            .map(|(p, _)| {
                p.strip_prefix(root)
                    .unwrap_or(p)
                    .to_string_lossy()
                    .to_string()
            })
            .collect();

        graph.nodes.retain(|n| !changed_ids.contains(&n.id));
        graph.edges.retain(|e| !changed_ids.contains(&e.source));
        graph.file_index.retain(|_, id| !changed_ids.contains(id));

        // Add new/changed nodes
        for (path, info) in &new_parsed {
            let node = build_node(root, path, info);
            graph.file_index.insert(node.file_path.clone(), node.id.clone());
            graph.nodes.push(node);
        }

        // Rebuild edges for changed files
        for (path, info) in &new_parsed {
            let rel_path = path.strip_prefix(root).unwrap_or(path);
            let source_id = rel_path.to_string_lossy().to_string();
            build_edges_for_file(&source_id, path, info, root, &canon_root, &graph.file_index, &graph.nodes, &mut graph.edges, &alias_paths);
        }

        // Update mtime cache
        let mut mtimes: HashMap<String, u64> = files
            .iter()
            .map(|f| {
                let rel = f.strip_prefix(root).unwrap_or(f).to_string_lossy().to_string();
                let mt = get_mtime(f);
                (rel, mt)
            })
            .collect();

        save_cache(&ProjectCache {
            root_path: root_str,
            graph: graph.clone(),
            file_mtimes: mtimes,
        });

        return graph;
    }

    // Full rebuild
    let all_parsed: Vec<(PathBuf, parser::FileInfo)> = if new_parsed.len() == files.len() {
        new_parsed
    } else {
        // Need to parse everything
        files
            .par_iter()
            .filter_map(|path| {
                let source = std::fs::read_to_string(path).ok()?;
                let info = parser::parse_file(path, &source)?;
                Some((path.clone(), info))
            })
            .collect()
    };

    let mut graph = ProjectGraph::new(root_str.clone());

    // Create nodes
    for (path, info) in &all_parsed {
        let node = build_node(root, path, info);
        graph.add_node(node);
    }

    // Create edges
    let file_index = graph.file_index.clone();
    // Debug: print sample file_index keys
    for (path, info) in &all_parsed {
        let rel_path = path.strip_prefix(root).unwrap_or(path);
        let source_id = rel_path.to_string_lossy().to_string();
        build_edges_for_file(&source_id, path, info, root, &canon_root, &file_index, &graph.nodes, &mut graph.edges, &alias_paths);
    }

    // Save cache
    let mtimes: HashMap<String, u64> = files
        .iter()
        .map(|f| {
            let rel = f.strip_prefix(root).unwrap_or(f).to_string_lossy().to_string();
            (rel, get_mtime(f))
        })
        .collect();

    save_cache(&ProjectCache {
        root_path: root_str,
        graph: graph.clone(),
        file_mtimes: mtimes,
    });

    graph
}

fn build_node(root: &Path, path: &Path, info: &parser::FileInfo) -> GraphNode {
    let rel_path = path.strip_prefix(root).unwrap_or(path);
    let id = rel_path.to_string_lossy().to_string();

    let file_stem = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let name = if file_stem == "index" {
        path.parent()
            .and_then(|p| p.file_name())
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
    } else {
        file_stem
    };

    let kind = classify_node(path, info);
    let parent_id = rel_path.parent().map(|p| p.to_string_lossy().to_string()).filter(|p| !p.is_empty());
    let depth = rel_path.components().count() as u32 - 1;

    let mut exports = info.exports.clone();
    if let Some(ref def) = info.default_export {
        if !exports.contains(def) {
            exports.push(def.clone());
        }
    }

    GraphNode { id, name, kind, file_path: path.to_string_lossy().to_string(), parent_id, depth, exports }
}

fn build_edges_for_file(
    source_id: &str,
    path: &Path,
    info: &parser::FileInfo,
    root: &Path,
    canon_root: &Path,
    file_index: &HashMap<String, String>,
    _nodes: &[GraphNode],
    edges: &mut Vec<GraphEdge>,
    alias_paths: &HashMap<String, Vec<String>>,
) {
    // Import edges only — store access is already captured via imports
    for import in &info.imports {
        if let Some(resolved) = resolve_import(&import.source, path, root, alias_paths) {
            // resolved is canonicalized, strip canon_root to match file_index keys
            let target_id = resolved.to_string_lossy().to_string();
            if file_index.contains_key(&target_id) {
                edges.push(GraphEdge {
                    source: source_id.to_string(),
                    target: target_id,
                    kind: EdgeKind::Import,
                    symbols: import.symbols.clone(),
                });
            }
        }
    }
}

#[tauri::command]
fn scan_project(root_path: String) -> Result<ProjectGraph, String> {
    let root = Path::new(&root_path);
    if !root.exists() {
        return Err(format!("Path does not exist: {}", root_path));
    }
    // Save to recent projects
    let _ = add_recent_project(&root_path);
    save_last_project(&root_path);
    Ok(build_graph(root))
}

#[tauri::command]
fn read_file(file_path: String) -> Result<String, String> {
    std::fs::read_to_string(&file_path).map_err(|e| format!("Failed to read file: {}", e))
}

// --- Recent projects ---

fn data_dir() -> PathBuf {
    let dir = dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("code-graph-viewer");
    std::fs::create_dir_all(&dir).ok();
    dir
}

fn recent_projects_path() -> PathBuf {
    data_dir().join("recent-projects.json")
}

fn last_project_path() -> PathBuf {
    data_dir().join("last-project.txt")
}

fn save_last_project(path: &str) {
    let _ = std::fs::write(last_project_path(), path);
}

fn add_recent_project(path: &str) -> Result<(), String> {
    let file = recent_projects_path();
    let mut list: Vec<String> = std::fs::read_to_string(&file)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    list.retain(|p| p != path);
    list.insert(0, path.to_string());
    list.truncate(10);

    let json = serde_json::to_string(&list).map_err(|e| e.to_string())?;
    std::fs::write(&file, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_recent_projects() -> Vec<String> {
    let file = recent_projects_path();
    std::fs::read_to_string(&file)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Returns the last opened project path, or empty string
#[tauri::command]
fn get_last_project() -> String {
    std::fs::read_to_string(last_project_path())
        .unwrap_or_default()
        .trim()
        .to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![scan_project, read_file, get_recent_projects, get_last_project])
        .setup(|app| {
            use tauri::menu::{MenuBuilder, SubmenuBuilder, MenuItemBuilder, PredefinedMenuItem};

            // Recent projects submenu
            let recents = get_recent_projects();
            let mut recent_sub = SubmenuBuilder::new(app, "Open Recent");
            for (i, path) in recents.iter().enumerate() {
                let name = path.rsplit('/').next().unwrap_or(path);
                let item = MenuItemBuilder::with_id(
                    format!("recent_{}", i),
                    format!("{} — {}", name, path),
                ).build(app)?;
                recent_sub = recent_sub.item(&item);
            }
            let recent_submenu = recent_sub.build()?;

            let open_folder = MenuItemBuilder::with_id("open_folder", "Open Folder...")
                .accelerator("CmdOrCtrl+O")
                .build(app)?;

            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&open_folder)
                .item(&recent_submenu)
                .separator()
                .item(&PredefinedMenuItem::quit(app, None)?)
                .build()?;

            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .item(&PredefinedMenuItem::copy(app, None)?)
                .item(&PredefinedMenuItem::select_all(app, None)?)
                .build()?;

            let menu = MenuBuilder::new(app)
                .item(&file_menu)
                .item(&edit_menu)
                .build()?;

            app.set_menu(menu)?;

            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();
            if id == "open_folder" {
                // Emit event to webview
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("menu-open-folder", ());
                }
            } else if id.starts_with("recent_") {
                if let Ok(idx) = id.replace("recent_", "").parse::<usize>() {
                    let recents = get_recent_projects();
                    if let Some(path) = recents.get(idx) {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.emit("menu-open-recent", path.clone());
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
