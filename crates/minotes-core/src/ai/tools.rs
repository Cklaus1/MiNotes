//! Read-only tools over the notebook (agentic retrieval).
//!
//! Every tool is filtered through the run's `ResolvedScope`; pages outside it
//! behave exactly as if they did not exist. Every block id a tool returns is
//! recorded in `seen`, which is what citation validation checks against.

use std::collections::HashSet;

use chrono::{Duration, Utc};
use serde_json::{json, Value};
use uuid::Uuid;

use super::scope::ResolvedScope;
use crate::db::Database;
use crate::models::Block;
use crate::repo::ai_suggestions::parse_pending_todo;

const MAX_BLOCK_CHARS: usize = 1500;

/// Tool definitions in OpenAI function-calling format (stable order: part of
/// the cached prompt prefix).
pub fn definitions() -> Vec<Value> {
    fn tool(name: &str, description: &str, params: Value) -> Value {
        json!({"type": "function", "function": {"name": name, "description": description, "parameters": params}})
    }
    vec![
        tool(
            "search",
            "Full-text search over the user's notes. Returns matching blocks (block_id, page_title, content). Use short keyword queries; try synonyms if nothing comes back.",
            json!({"type": "object", "properties": {
                "query": {"type": "string", "description": "Keywords to search for"},
                "limit": {"type": "integer", "description": "Max results (default 10, max 25)"}
            }, "required": ["query"], "additionalProperties": false}),
        ),
        tool(
            "get_page",
            "Get one page with all its blocks (outline order, parent_id gives nesting).",
            json!({"type": "object", "properties": {
                "title_or_id": {"type": "string", "description": "Page title (or alias) or page id"}
            }, "required": ["title_or_id"], "additionalProperties": false}),
        ),
        tool(
            "get_blocks",
            "Get specific blocks by id.",
            json!({"type": "object", "properties": {
                "ids": {"type": "array", "items": {"type": "string"}, "description": "Block ids (max 50)"}
            }, "required": ["ids"], "additionalProperties": false}),
        ),
        tool(
            "backlinks",
            "Blocks on other pages that link to a page with [[Page]].",
            json!({"type": "object", "properties": {
                "page": {"type": "string", "description": "Page title or id"}
            }, "required": ["page"], "additionalProperties": false}),
        ),
        tool(
            "list_pages",
            "List pages, most recently updated first, optionally filtered by a title substring.",
            json!({"type": "object", "properties": {
                "filter": {"type": "string", "description": "Case-insensitive title substring"},
                "limit": {"type": "integer", "description": "Max pages (default 50, max 200)"}
            }, "additionalProperties": false}),
        ),
        tool(
            "recent",
            "Blocks edited in the last N days, newest first.",
            json!({"type": "object", "properties": {
                "days": {"type": "integer", "description": "Look-back window in days (default 7, max 365)"}
            }, "additionalProperties": false}),
        ),
        tool(
            "todos",
            "Open (pending) TODO items with their block ids.",
            json!({"type": "object", "properties": {}, "additionalProperties": false}),
        ),
    ]
}

pub fn tool_names() -> Vec<String> {
    definitions()
        .iter()
        .filter_map(|t| t["function"]["name"].as_str().map(String::from))
        .collect()
}

const STOPWORDS: &[&str] = &[
    "the", "and", "for", "what", "when", "where", "which", "who", "whom", "why", "how", "did", "does",
    "was", "were", "are", "is", "about", "with", "that", "this", "these", "those", "from", "have", "has",
    "had", "our", "your", "you", "they", "them", "their", "there", "any", "all", "can", "could", "would",
    "should", "will", "into", "onto", "over", "under", "notes", "note", "tell", "know", "find", "show",
    "list", "give", "please", "decide", "decided", "something", "some",
];

/// Significant search terms of a natural-language question (used by `search`
/// to widen phrase matches, and by the no-tools retrieval fallback).
pub fn keywords(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for w in text.split(|c: char| !c.is_alphanumeric() && c != '-' && c != '_') {
        let w = w.trim_matches('-').to_lowercase();
        if w.chars().count() < 3 || STOPWORDS.contains(&w.as_str()) || out.contains(&w) {
            continue;
        }
        out.push(w);
        if out.len() >= 8 {
            break;
        }
    }
    out
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let t: String = s.chars().take(max).collect();
        format!("{t}…")
    }
}

pub struct NoteTools<'a> {
    db: &'a Database,
    scope: &'a ResolvedScope,
    /// Block ids returned by tools so far (citation whitelist).
    pub seen: HashSet<Uuid>,
}

impl<'a> NoteTools<'a> {
    pub fn new(db: &'a Database, scope: &'a ResolvedScope) -> Self {
        Self { db, scope, seen: HashSet::new() }
    }

    fn block_json(&mut self, b: &Block) -> Value {
        self.seen.insert(b.id);
        let title = self.scope.page(&b.page_id).map(|p| p.title.clone()).unwrap_or_default();
        json!({
            "block_id": b.id.to_string(),
            "page_id": b.page_id.to_string(),
            "page_title": title,
            "content": truncate(&b.content, MAX_BLOCK_CHARS),
            "updated_at": b.updated_at.to_rfc3339(),
        })
    }

    fn resolve_page(&self, title_or_id: &str) -> Option<Uuid> {
        let t = title_or_id.trim().trim_start_matches("[[").trim_end_matches("]]");
        if let Ok(id) = Uuid::parse_str(t) {
            return self.scope.contains(&id).then_some(id);
        }
        let by_title = self.db.get_page_by_title(t).ok().flatten().map(|p| p.id);
        let found = by_title.or_else(|| {
            // Case-insensitive title match within scope.
            let lower = t.to_lowercase();
            self.scope.pages().find(|p| p.title.to_lowercase() == lower).map(|p| p.id)
        });
        found.filter(|id| self.scope.contains(id))
    }

    /// Run one tool. Errors are returned as `Err(message)` and should be sent
    /// back to the model as an error tool result (never panics on bad input).
    pub fn execute(&mut self, name: &str, args: &Value) -> Result<Value, String> {
        match name {
            "search" => {
                let query = args["query"].as_str().ok_or("`query` (string) is required")?;
                let limit = args["limit"].as_i64().unwrap_or(10).clamp(1, 25) as usize;
                self.search(query, limit)
            }
            "get_page" => {
                let t = args["title_or_id"].as_str().ok_or("`title_or_id` (string) is required")?;
                let id = self.resolve_page(t).ok_or("No page with that title or id in the notes you can access.")?;
                let meta = self.scope.page(&id).cloned().ok_or("page not found")?;
                let blocks = self.db.get_page_blocks(&id).map_err(|e| e.to_string())?;
                let total = blocks.len();
                let items: Vec<Value> = blocks
                    .iter()
                    .take(300)
                    .map(|b| {
                        let mut v = self.block_json(b);
                        if let Some(p) = b.parent_id {
                            v["parent_id"] = json!(p.to_string());
                        }
                        v
                    })
                    .collect();
                Ok(json!({"page_id": id.to_string(), "title": meta.title, "is_journal": meta.is_journal,
                          "block_count": total, "blocks": items}))
            }
            "get_blocks" => {
                let ids = args["ids"].as_array().ok_or("`ids` (array of strings) is required")?;
                let mut out = Vec::new();
                for v in ids.iter().take(50) {
                    let s = v.as_str().unwrap_or_default();
                    let block = Uuid::parse_str(s)
                        .ok()
                        .and_then(|id| self.db.get_block(&id).ok().flatten())
                        .filter(|b| self.scope.contains(&b.page_id));
                    match block {
                        Some(b) => out.push(self.block_json(&b)),
                        None => out.push(json!({"block_id": s, "error": "not found"})),
                    }
                }
                Ok(json!({"blocks": out}))
            }
            "backlinks" => {
                let t = args["page"].as_str().ok_or("`page` (string) is required")?;
                let id = self.resolve_page(t).ok_or("No page with that title or id in the notes you can access.")?;
                let links = self.db.get_backlinks(&id).map_err(|e| e.to_string())?;
                let mut out = Vec::new();
                let mut dedupe = HashSet::new();
                for l in links {
                    if !dedupe.insert(l.from_block) {
                        continue;
                    }
                    if let Some(b) = self.db.get_block(&l.from_block).ok().flatten() {
                        if self.scope.contains(&b.page_id) {
                            out.push(self.block_json(&b));
                        }
                    }
                    if out.len() >= 50 {
                        break;
                    }
                }
                Ok(json!({"page_id": id.to_string(), "backlinks": out}))
            }
            "list_pages" => {
                let filter = args["filter"].as_str().unwrap_or("").to_lowercase();
                let limit = args["limit"].as_i64().unwrap_or(50).clamp(1, 200) as usize;
                let mut pages: Vec<_> = self
                    .scope
                    .pages()
                    .filter(|p| filter.is_empty() || p.title.to_lowercase().contains(&filter))
                    .collect();
                pages.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                let total = pages.len();
                let items: Vec<Value> = pages
                    .into_iter()
                    .take(limit)
                    .map(|p| json!({"page_id": p.id.to_string(), "title": p.title,
                                    "is_journal": p.is_journal, "updated_at": p.updated_at.to_rfc3339()}))
                    .collect();
                Ok(json!({"total": total, "pages": items}))
            }
            "recent" => {
                let days = args["days"].as_i64().unwrap_or(7).clamp(1, 365);
                let since = Utc::now() - Duration::days(days);
                let mut blocks = self.scoped_blocks()?;
                blocks.retain(|b| b.updated_at >= since && !b.content.trim().is_empty());
                blocks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                let items: Vec<Value> = blocks.iter().take(50).map(|b| self.block_json(b)).collect();
                Ok(json!({"days": days, "blocks": items}))
            }
            "todos" => {
                let mut items = Vec::new();
                for b in self.scoped_blocks()? {
                    for line in b.content.lines() {
                        if let Some(text) = parse_pending_todo(line) {
                            let mut v = self.block_json(&b);
                            v["todo"] = json!(text);
                            items.push(v);
                            break;
                        }
                    }
                    if items.len() >= 100 {
                        break;
                    }
                }
                Ok(json!({"todos": items}))
            }
            other => Err(format!("Unknown tool `{other}`. Available: {}", tool_names().join(", "))),
        }
    }

    fn scoped_blocks(&self) -> Result<Vec<Block>, String> {
        let mut out = Vec::new();
        for p in self.scope.pages() {
            out.extend(self.db.get_page_blocks(&p.id).map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    /// Phrase match first, then per-keyword matches ranked by how many terms hit.
    pub fn search(&mut self, query: &str, limit: usize) -> Result<Value, String> {
        let mut scored: Vec<(Block, usize)> = Vec::new();
        let push = |b: Block, score: usize, scored: &mut Vec<(Block, usize)>| {
            if let Some(e) = scored.iter_mut().find(|(x, _)| x.id == b.id) {
                e.1 += score;
            } else {
                scored.push((b, score));
            }
        };
        let in_scope = |b: &Block| self.scope.contains(&b.page_id);
        for b in self.db.search(query, Some(500)).map_err(|e| e.to_string())? {
            if in_scope(&b) {
                push(b, 100, &mut scored);
            }
        }
        let terms = keywords(query);
        if terms.len() > 1 || scored.is_empty() {
            for t in &terms {
                for b in self.db.search(t, Some(300)).map_err(|e| e.to_string())? {
                    if in_scope(&b) {
                        push(b, 1, &mut scored);
                    }
                }
            }
        }
        scored.sort_by(|a, b| b.1.cmp(&a.1));
        let items: Vec<Value> = scored.iter().take(limit).map(|(b, _)| self.block_json(b)).collect();
        Ok(json!({"query": query, "results": items}))
    }
}
