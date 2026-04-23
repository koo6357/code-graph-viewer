use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NodeKind {
    Directory,
    Page,
    Component,
    Hook,
    ApiHook,
    Store,
    Util,
    Constant,
    Type,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    pub name: String,
    pub kind: NodeKind,
    pub file_path: String,
    /// Parent directory node id
    pub parent_id: Option<String>,
    /// Depth in directory tree (0 = root)
    pub depth: u32,
    /// Exported symbols from this file
    pub exports: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EdgeKind {
    Import,
    RouteNavigation,
    StoreAccess,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    pub kind: EdgeKind,
    /// Imported symbol names
    pub symbols: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGraph {
    pub root_path: String,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    /// file_path -> node id mapping
    pub file_index: HashMap<String, String>,
}

impl ProjectGraph {
    pub fn new(root_path: String) -> Self {
        Self {
            root_path,
            nodes: Vec::new(),
            edges: Vec::new(),
            file_index: HashMap::new(),
        }
    }

    pub fn add_node(&mut self, node: GraphNode) {
        self.file_index
            .insert(node.file_path.clone(), node.id.clone());
        self.nodes.push(node);
    }

    pub fn add_edge(&mut self, edge: GraphEdge) {
        self.edges.push(edge);
    }
}
