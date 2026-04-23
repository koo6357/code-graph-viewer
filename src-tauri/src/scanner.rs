use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// Scan a project directory for TypeScript/TSX files
pub fn scan_project(root: &Path) -> Vec<PathBuf> {
    let skip_dirs = [
        "node_modules",
        ".git",
        "dist",
        "build",
        ".next",
        ".cache",
        "coverage",
        "__tests__",
        "__mocks__",
        ".turbo",
        ".tauri",
    ];

    WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !skip_dirs.iter().any(|d| name == *d)
        })
        .filter_map(|e| e.ok())
        .filter(|e| {
            if !e.file_type().is_file() {
                return false;
            }
            let path = e.path();
            match path.extension().and_then(|e| e.to_str()) {
                Some("ts" | "tsx") => {
                    // Skip test/spec/story files
                    let name = path.file_stem().unwrap_or_default().to_string_lossy();
                    !name.ends_with(".test")
                        && !name.ends_with(".spec")
                        && !name.ends_with(".stories")
                        && !name.ends_with(".story")
                        && !name.ends_with(".d")
                }
                _ => false,
            }
        })
        .map(|e| e.into_path())
        .collect()
}
