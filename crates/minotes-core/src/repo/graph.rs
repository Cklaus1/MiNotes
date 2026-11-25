use serde::Serialize;
use uuid::Uuid;

use crate::db::Database;
use crate::error::Result;

#[derive(Debug, Clone, Serialize)]
pub struct GraphNode {
    pub id: Uuid,
    pub title: String,
    pub block_count: i64,
    pub link_count: i64,
    /// The page's project (folder), for colouring and filtering the graph.
    pub folder_id: Option<Uuid>,
    /// Inline `#tags` used on the page, most used first (at most 8).
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphEdge {
    pub from_page: Uuid,
    pub to_page: Uuid,
    pub link_count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphStats {
    pub pages: i64,
    pub blocks: i64,
    pub links: i64,
    pub properties: i64,
    pub events: i64,
    pub orphan_pages: i64,
    pub journal_pages: i64,
}

impl Database {
    /// Get full graph data for visualization.
    pub fn get_graph_data(&self) -> Result<GraphData> {
        // Trashed/archived pages are not part of the visible graph: no nodes for
        // them and no edges from or to them.
        let hidden = crate::repo::trash::hidden_pages_cte();
        // Nodes: pages with block and (visible) incoming link counts
        let mut stmt = self.conn.prepare(&format!(
            "{hidden}
             SELECT p.id, p.title, p.folder_id,
                    (SELECT COUNT(*) FROM blocks WHERE page_id = p.id) as block_count,
                    (SELECT COUNT(*) FROM links l JOIN blocks b ON b.id = l.from_block
                      WHERE l.to_page = p.id
                        AND b.page_id NOT IN (SELECT id FROM hidden_pages)) as link_count
             FROM pages p
             WHERE p.id NOT IN (SELECT id FROM hidden_pages)
             ORDER BY p.title"
        ))?;
        let mut nodes: Vec<GraphNode> = stmt
            .query_map([], |row| {
                let id_str: String = row.get(0)?;
                let folder: Option<String> = row.get(2)?;
                Ok(GraphNode {
                    id: Uuid::parse_str(&id_str).unwrap_or_default(),
                    title: row.get(1)?,
                    folder_id: folder.and_then(|f| Uuid::parse_str(&f).ok()),
                    block_count: row.get(3)?,
                    link_count: row.get(4)?,
                    tags: Vec::new(),
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        // Inline #tags per page (one pass over the blocks that contain a '#').
        let mut per_page: std::collections::HashMap<String, std::collections::HashMap<String, usize>> =
            std::collections::HashMap::new();
        {
            let mut stmt = self.conn.prepare("SELECT page_id, content FROM blocks WHERE content LIKE '%#%'")?;
            let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
            for (page, content) in rows.flatten() {
                let counts = per_page.entry(page).or_default();
                for t in inline_tags(&content) {
                    *counts.entry(t).or_default() += 1;
                }
            }
        }
        for n in &mut nodes {
            if let Some(counts) = per_page.remove(&n.id.to_string()) {
                let mut v: Vec<(String, usize)> = counts.into_iter().collect();
                v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
                n.tags = v.into_iter().take(8).map(|(t, _)| t).collect();
            }
        }

        // Edges: aggregated links between pages
        let mut stmt = self.conn.prepare(&format!(
            "{hidden}
             SELECT b.page_id as from_page, l.to_page, COUNT(*) as cnt
             FROM links l
             JOIN blocks b ON l.from_block = b.id
             WHERE l.to_page IS NOT NULL
               AND b.page_id NOT IN (SELECT id FROM hidden_pages)
               AND l.to_page NOT IN (SELECT id FROM hidden_pages)
             GROUP BY b.page_id, l.to_page"
        ))?;
        let edges: Vec<GraphEdge> = stmt
            .query_map([], |row| {
                let from_str: String = row.get(0)?;
                let to_str: String = row.get(1)?;
                Ok(GraphEdge {
                    from_page: Uuid::parse_str(&from_str).unwrap_or_default(),
                    to_page: Uuid::parse_str(&to_str).unwrap_or_default(),
                    link_count: row.get(2)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(GraphData { nodes, edges })
    }

    /// Get N-hop neighbors of a page.
    pub fn get_neighbors(&self, page_id: &Uuid, depth: Option<i32>) -> Result<Vec<GraphNode>> {
        let max_depth = depth.unwrap_or(1);
        let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut frontier = vec![page_id.to_string()];
        visited.insert(page_id.to_string());

        for _ in 0..max_depth {
            let mut next_frontier = Vec::new();
            for pid in &frontier {
                // Forward links from this page
                let mut stmt = self.conn.prepare(
                    "SELECT DISTINCT l.to_page FROM links l
                     JOIN blocks b ON l.from_block = b.id
                     WHERE b.page_id = ?1 AND l.to_page IS NOT NULL",
                )?;
                let fwd: Vec<String> = stmt
                    .query_map(rusqlite::params![pid], |row| row.get::<_, String>(0))?
                    .filter_map(|r| r.ok())
                    .collect();

                // Backlinks to this page
                let mut stmt = self.conn.prepare(
                    "SELECT DISTINCT b.page_id FROM links l
                     JOIN blocks b ON l.from_block = b.id
                     WHERE l.to_page = ?1",
                )?;
                let back: Vec<String> = stmt
                    .query_map(rusqlite::params![pid], |row| row.get::<_, String>(0))?
                    .filter_map(|r| r.ok())
                    .collect();

                for neighbor in fwd.into_iter().chain(back) {
                    if visited.insert(neighbor.clone()) {
                        next_frontier.push(neighbor);
                    }
                }
            }
            if next_frontier.is_empty() {
                break;
            }
            frontier = next_frontier;
        }

        // Remove the starting page from results
        visited.remove(&page_id.to_string());

        let mut result = Vec::new();
        for pid in &visited {
            if let Ok(uuid) = Uuid::parse_str(pid) {
                if let Ok(Some(page)) = self.get_page(&uuid) {
                    let block_count: i64 = self
                        .conn
                        .query_row(
                            "SELECT COUNT(*) FROM blocks WHERE page_id = ?1",
                            rusqlite::params![pid],
                            |r| r.get(0),
                        )
                        .unwrap_or(0);
                    result.push(GraphNode {
                        id: page.id,
                        title: page.title,
                        block_count,
                        link_count: 0,
                        folder_id: page.folder_id,
                        tags: Vec::new(),
                    });
                }
            }
        }
        Ok(result)
    }

    /// Get detailed graph statistics.
    pub fn get_graph_stats(&self) -> Result<GraphStats> {
        let pages: i64 = self.conn.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0))?;
        let blocks: i64 = self.conn.query_row("SELECT COUNT(*) FROM blocks", [], |r| r.get(0))?;
        let links: i64 = self.conn.query_row("SELECT COUNT(*) FROM links", [], |r| r.get(0))?;
        let properties: i64 = self.conn.query_row("SELECT COUNT(*) FROM properties", [], |r| r.get(0))?;
        let events: i64 = self.conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?;
        let journal_pages: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM pages WHERE is_journal = 1",
            [],
            |r| r.get(0),
        )?;
        let orphan_pages: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM pages p
             WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.to_page = p.id)
             AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.page_id = p.id)",
            [],
            |r| r.get(0),
        )?;

        Ok(GraphStats {
            pages,
            blocks,
            links,
            properties,
            events,
            orphan_pages,
            journal_pages,
        })
    }
}

/// Inline `#tags` in a block's markdown, lower-cased, in order of appearance
/// (repeats kept). Same rules as the app's tag extractor (`lib/tagExtractor.ts`):
/// a tag follows the start or whitespace, starts with a letter, then letters,
/// digits, `_`, `-` and nested `/parts`; code spans and fences are skipped, and
/// hex colours (`#ff00aa`, `#f0f`) are not tags.
pub fn inline_tags(content: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_fence = false;
    for line in content.lines() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let chars: Vec<char> = line.chars().collect();
        let mut in_code = false;
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            if c == '`' {
                in_code = !in_code;
                i += 1;
                continue;
            }
            if in_code || c != '#' || (i > 0 && !chars[i - 1].is_whitespace()) {
                i += 1;
                continue;
            }
            let start = i + 1;
            if start >= chars.len() || !chars[start].is_ascii_alphabetic() {
                i += 1;
                continue;
            }
            let mut j = start;
            while j < chars.len() && (chars[j].is_ascii_alphanumeric() || matches!(chars[j], '_' | '-' | '/')) {
                j += 1;
            }
            let tag: String = chars[start..j].iter().collect::<String>().trim_end_matches('/').to_lowercase();
            i = j;
            let hexish = tag.chars().all(|c| c.is_ascii_hexdigit());
            let is_colour = hexish && (tag.len() == 6 || tag.len() == 8 || ((tag.len() == 3 || tag.len() == 4) && tag.chars().any(|c| c.is_ascii_digit())));
            if !tag.is_empty() && !is_colour {
                out.push(tag);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::inline_tags;
    use crate::db::Database;

    #[test]
    fn inline_tags_follow_the_app_rules() {
        assert_eq!(inline_tags("Ship #work and #Home/garden today"), ["work", "home/garden"]);
        assert_eq!(inline_tags("color:#fff url/#x #123 #f0f #ff00aa `#code` #ok"), ["ok"]);
        assert_eq!(inline_tags("```\n#include\n```\n#real"), ["real"]);
        assert!(inline_tags("no tags here").is_empty());
    }

    #[test]
    fn graph_nodes_carry_project_and_tags() {
        let db = Database::open_in_memory().unwrap();
        let folder = db.create_folder("Proj", None, None, None, "test").unwrap();
        let a = db.create_page("A", None, false, None, "test").unwrap();
        db.move_page_to_folder(&a.id, Some(&folder.id), "test").unwrap();
        db.create_block(&a.id, "Plan #work #work #idea", None, None, "test").unwrap();
        db.create_page("B", None, false, None, "test").unwrap();
        let g = db.get_graph_data().unwrap();
        let na = g.nodes.iter().find(|n| n.title == "A").unwrap();
        assert_eq!(na.folder_id, Some(folder.id));
        assert_eq!(na.tags, ["work", "idea"]);
        let nb = g.nodes.iter().find(|n| n.title == "B").unwrap();
        assert_eq!(nb.folder_id, None);
        assert!(nb.tags.is_empty());
    }
}
