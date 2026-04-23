use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::graph::ProjectGraph;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectCache {
    pub root_path: String,
    pub graph: ProjectGraph,
    /// file relative path -> modified time (secs since epoch)
    pub file_mtimes: HashMap<String, u64>,
}

fn cache_dir() -> PathBuf {
    let base = dirs::cache_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("code-graph-viewer");
    std::fs::create_dir_all(&base).ok();
    base
}

fn cache_path_for(root: &str) -> PathBuf {
    // Use a simple hash of the root path as filename
    let hash = root.bytes().fold(0u64, |acc, b| acc.wrapping_mul(31).wrapping_add(b as u64));
    cache_dir().join(format!("{:016x}.json", hash))
}

pub fn load_cache(root: &str) -> Option<ProjectCache> {
    let path = cache_path_for(root);
    let data = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&data).ok()
}

pub fn save_cache(cache: &ProjectCache) {
    let path = cache_path_for(&cache.root_path);
    if let Ok(json) = serde_json::to_string(cache) {
        let _ = std::fs::write(&path, json);
    }
}

pub fn get_mtime(path: &Path) -> u64 {
    path.metadata()
        .and_then(|m| m.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH)
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Returns (files_to_reparse, deleted_file_ids)
pub fn diff_files(
    root: &Path,
    current_files: &[PathBuf],
    cached_mtimes: &HashMap<String, u64>,
) -> (Vec<PathBuf>, Vec<String>) {
    let mut to_reparse = Vec::new();
    let mut current_ids = std::collections::HashSet::new();

    for file in current_files {
        let rel = file.strip_prefix(root).unwrap_or(file);
        let id = rel.to_string_lossy().to_string();
        current_ids.insert(id.clone());

        let mtime = get_mtime(file);
        match cached_mtimes.get(&id) {
            Some(&cached_mtime) if cached_mtime == mtime => {
                // Unchanged, skip
            }
            _ => {
                // New or modified
                to_reparse.push(file.clone());
            }
        }
    }

    // Deleted files
    let deleted: Vec<String> = cached_mtimes
        .keys()
        .filter(|id| !current_ids.contains(*id))
        .cloned()
        .collect();

    (to_reparse, deleted)
}
