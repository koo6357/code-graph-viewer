use std::path::Path;
use streaming_iterator::StreamingIterator;
use tree_sitter::{Language, Parser, Query, QueryCursor};

/// Parsed info from a single file
#[derive(Debug, Clone)]
pub struct FileInfo {
    pub imports: Vec<ImportInfo>,
    pub exports: Vec<String>,
    pub default_export: Option<String>,
    pub has_jsx: bool,
    pub route_navigations: Vec<String>,
    pub store_accesses: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ImportInfo {
    pub source: String,
    pub symbols: Vec<String>,
    pub is_default: bool,
}

fn get_ts_language(path: &Path) -> Language {
    match path.extension().and_then(|e| e.to_str()) {
        Some("tsx") => tree_sitter_typescript::LANGUAGE_TSX.into(),
        _ => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
    }
}

pub fn parse_file(path: &Path, source: &str) -> Option<FileInfo> {
    let lang = get_ts_language(path);
    let mut parser = Parser::new();
    parser.set_language(&lang).ok()?;
    let tree = parser.parse(source, None)?;
    let root = tree.root_node();

    let imports = extract_imports(&lang, &root, source.as_bytes());
    let exports = extract_exports(&lang, &root, source.as_bytes());
    let default_export = extract_default_export(&lang, &root, source.as_bytes());
    let has_jsx = detect_jsx(&lang, &root, source.as_bytes());
    let route_navigations = extract_route_navigations(source);
    let store_accesses = extract_store_accesses(source);

    Some(FileInfo {
        imports,
        exports,
        default_export,
        has_jsx,
        route_navigations,
        store_accesses,
    })
}

fn extract_imports(lang: &Language, root: &tree_sitter::Node, source: &[u8]) -> Vec<ImportInfo> {
    let query_str = r#"(import_statement source: (string) @source)"#;
    let query = match Query::new(lang, query_str) {
        Ok(q) => q,
        Err(_) => return Vec::new(),
    };

    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&query, *root, source);
    let mut imports = Vec::new();

    while let Some(m) = matches.next() {
        for cap in m.captures {
            let source_text = cap.node.utf8_text(source).unwrap_or_default();
            let source_clean = source_text.trim_matches(|c| c == '"' || c == '\'');

            let import_node = cap.node.parent().unwrap();
            let import_text = import_node.utf8_text(source).unwrap_or_default();

            let (symbols, is_default) = extract_import_symbols(import_text);

            imports.push(ImportInfo {
                source: source_clean.to_string(),
                symbols,
                is_default,
            });
        }
    }

    imports
}

fn extract_import_symbols(import_text: &str) -> (Vec<String>, bool) {
    let mut symbols = Vec::new();
    let mut is_default = false;

    if let Some(start) = import_text.find('{') {
        if let Some(end) = import_text.find('}') {
            let named = &import_text[start + 1..end];
            for sym in named.split(',') {
                let sym = sym.trim();
                if sym.is_empty() {
                    continue;
                }
                let name = sym.split(" as ").next().unwrap_or(sym).trim();
                if !name.is_empty() {
                    symbols.push(name.to_string());
                }
            }
        }
    }

    let parts: Vec<&str> = import_text.split_whitespace().collect();
    if parts.len() >= 4 && parts[0] == "import" && parts[2] == "from" {
        let name = parts[1];
        if name != "{" && name != "*" && name != "type" {
            symbols.insert(0, name.to_string());
            is_default = true;
        }
    }

    (symbols, is_default)
}

fn extract_exports(lang: &Language, root: &tree_sitter::Node, source: &[u8]) -> Vec<String> {
    let query_str = r#"
        (export_statement
            declaration: [
                (lexical_declaration (variable_declarator name: (identifier) @name))
                (function_declaration name: (identifier) @name)
                (type_alias_declaration name: (type_identifier) @name)
                (interface_declaration name: (type_identifier) @name)
            ]
        )
    "#;

    let query = match Query::new(lang, query_str) {
        Ok(q) => q,
        Err(_) => return Vec::new(),
    };

    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&query, *root, source);
    let mut exports = Vec::new();

    while let Some(m) = matches.next() {
        for cap in m.captures {
            let name = cap.node.utf8_text(source).unwrap_or_default();
            exports.push(name.to_string());
        }
    }

    exports
}

fn extract_default_export(
    lang: &Language,
    root: &tree_sitter::Node,
    source: &[u8],
) -> Option<String> {
    let query_str = r#"(export_statement "default" value: (identifier) @name)"#;
    let query = Query::new(lang, query_str).ok()?;
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&query, *root, source);

    if let Some(m) = matches.next() {
        if let Some(cap) = m.captures.first() {
            return Some(cap.node.utf8_text(source).unwrap_or_default().to_string());
        }
    }

    None
}

fn detect_jsx(lang: &Language, root: &tree_sitter::Node, source: &[u8]) -> bool {
    let query_str = r#"(jsx_element) @jsx"#;
    if let Ok(query) = Query::new(lang, query_str) {
        let mut cursor = QueryCursor::new();
        let mut matches = cursor.matches(&query, *root, source);
        return matches.next().is_some();
    }
    false
}

fn extract_route_navigations(source: &str) -> Vec<String> {
    let mut navs = Vec::new();
    let patterns = [
        "history.push(",
        "history.replace(",
        "navigate.closeAndPush(",
        "navigate.push(",
        "navigate.open(",
    ];

    for line in source.lines() {
        let trimmed = line.trim();
        for pat in &patterns {
            if trimmed.contains(pat) {
                if let Some(start) = trimmed.find(pat) {
                    let after = &trimmed[start + pat.len()..];
                    if let Some(path) = extract_string_arg(after) {
                        navs.push(path);
                    }
                }
            }
        }
    }

    navs
}

fn extract_store_accesses(source: &str) -> Vec<String> {
    let mut stores = Vec::new();
    for line in source.lines() {
        let trimmed = line.trim();
        let words: Vec<&str> = trimmed
            .split(|c: char| !c.is_alphanumeric() && c != '_')
            .collect();
        for word in words {
            if (word.ends_with("Store") || word.ends_with("store"))
                && word.len() > 5
                && trimmed.contains(&format!("{}(", word))
            {
                if !stores.contains(&word.to_string()) {
                    stores.push(word.to_string());
                }
            }
        }
    }
    stores
}

fn extract_string_arg(s: &str) -> Option<String> {
    let s = s.trim();
    if s.starts_with('`') {
        if let Some(end) = s[1..].find('`') {
            return Some(s[1..end + 1].to_string());
        }
    }
    let quote = s.chars().next()?;
    if quote == '"' || quote == '\'' {
        if let Some(end) = s[1..].find(quote) {
            return Some(s[1..end + 1].to_string());
        }
    }
    None
}
