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
        // Nodes: pages with block and link counts
        let mut stmt = self.conn.prepare(
            "SELECT p.id, p.title,
                    (SELECT COUNT(*) FROM blocks WHERE page_id = p.id) as block_count,
                    (SELECT COUNT(*) FROM links WHERE to_page = p.id) as link_count
             FROM pages p ORDER BY p.title",
        )?;
        let nodes: Vec<GraphNode> = stmt
            .query_map([], |row| {
                let id_str: String = row.get(0)?;
                Ok(GraphNode {
                    id: Uuid::parse_str(&id_str).unwrap_or_default(),
                    title: row.get(1)?,
                    block_count: row.get(2)?,
                    link_count: row.get(3)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        // Edges: aggregated links between pages
        let mut stmt = self.conn.prepare(
            "SELECT b.page_id as from_page, l.to_page, COUNT(*) as cnt
             FROM links l
             JOIN blocks b ON l.from_block = b.id
             WHERE l.to_page IS NOT NULL
             GROUP BY b.page_id, l.to_page",
        )?;
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
