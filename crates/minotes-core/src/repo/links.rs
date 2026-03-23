use chrono::Utc;
use uuid::Uuid;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::models::Link;

impl Database {
    pub fn create_link(
        &self,
        from_block: &Uuid,
        to_page: Option<&Uuid>,
        to_block: Option<&Uuid>,
        link_type: &str,
        actor: &str,
    ) -> Result<Link> {
        let now = Utc::now();
        let id = Uuid::now_v7();

        self.conn.execute(
            "INSERT INTO links (id, from_block, to_page, to_block, link_type, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                id.to_string(),
                from_block.to_string(),
                to_page.map(|p| p.to_string()),
                to_block.map(|b| b.to_string()),
                link_type,
                now.to_rfc3339(),
            ],
        )?;

        let link = Link {
            id,
            from_block: *from_block,
            to_page: to_page.copied(),
            to_block: to_block.copied(),
            link_type: link_type.to_string(),
            created_at: now,
        };

        self.emit_event("link.created", &link.id, "link", &link, actor)?;
        Ok(link)
    }

    pub fn get_backlinks(&self, page_id: &Uuid) -> Result<Vec<Link>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, from_block, to_page, to_block, link_type, created_at
             FROM links WHERE to_page = ?1 ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map(rusqlite::params![page_id.to_string()], |row| {
            row_to_link(row)
        })?;
        let mut links = Vec::new();
        for row in rows {
            links.push(row.map_err(Error::Database)?);
        }
        Ok(links)
    }

    /// Find blocks that mention a page's title in their content but are NOT
    /// already linked to it via [[wiki links]]. Returns blocks from other pages only.
    pub fn get_unlinked_references(&self, page_id: &Uuid) -> Result<Vec<crate::models::Block>> {
        // Get the page title
        let page = self.get_page(page_id)?
            .ok_or_else(|| Error::NotFound(format!("Page {page_id}")))?;
        let title = &page.title;

        // Get block IDs that already link to this page
        let backlinks = self.get_backlinks(page_id)?;
        let linked_block_ids: std::collections::HashSet<Uuid> =
            backlinks.iter().map(|l| l.from_block).collect();

        // Search for blocks containing the page title (case-insensitive LIKE)
        let pattern = format!("%{}%", title.replace('%', "\\%").replace('_', "\\_"));
        let mut stmt = self.conn.prepare(
            "SELECT id, page_id, parent_id, position, content, format, collapsed, created_at, updated_at
             FROM blocks
             WHERE content LIKE ?1 ESCAPE '\\'
               AND page_id != ?2
             ORDER BY created_at DESC
             LIMIT 50",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![pattern, page_id.to_string()],
            |row| {
                let id_str: String = row.get(0)?;
                let page_id_str: String = row.get(1)?;
                let parent_id_str: Option<String> = row.get(2)?;
                let created_str: String = row.get(7)?;
                let updated_str: String = row.get(8)?;
                Ok(crate::models::Block {
                    id: Uuid::parse_str(&id_str).unwrap_or_default(),
                    page_id: Uuid::parse_str(&page_id_str).unwrap_or_default(),
                    parent_id: parent_id_str.and_then(|s| Uuid::parse_str(&s).ok()),
                    position: row.get(3)?,
                    content: row.get(4)?,
                    format: row.get(5)?,
                    collapsed: row.get::<_, i32>(6)? != 0,
                    created_at: chrono::DateTime::parse_from_rfc3339(&created_str)
                        .map(|dt| dt.with_timezone(&chrono::Utc))
                        .unwrap_or_else(|_| chrono::Utc::now()),
                    updated_at: chrono::DateTime::parse_from_rfc3339(&updated_str)
                        .map(|dt| dt.with_timezone(&chrono::Utc))
                        .unwrap_or_else(|_| chrono::Utc::now()),
                })
            },
        )?;

        let mut results = Vec::new();
        for row in rows {
            let block = row.map_err(Error::Database)?;
            // Exclude blocks that already have a [[link]] to this page
            if !linked_block_ids.contains(&block.id) {
                // Extra check: make sure it's not a [[Title]] link (which would already be tracked)
                let bracket_link = format!("[[{}]]", title);
                if !block.content.contains(&bracket_link) {
                    results.push(block);
                }
            }
        }
        Ok(results)
    }

    pub fn get_forward_links(&self, page_id: &Uuid) -> Result<Vec<Link>> {
        let mut stmt = self.conn.prepare(
            "SELECT l.id, l.from_block, l.to_page, l.to_block, l.link_type, l.created_at
             FROM links l JOIN blocks b ON l.from_block = b.id
             WHERE b.page_id = ?1 ORDER BY l.created_at DESC",
        )?;
        let rows = stmt.query_map(rusqlite::params![page_id.to_string()], |row| {
            row_to_link(row)
        })?;
        let mut links = Vec::new();
        for row in rows {
            links.push(row.map_err(Error::Database)?);
        }
        Ok(links)
    }
}

fn row_to_link(row: &rusqlite::Row<'_>) -> rusqlite::Result<Link> {
    let id_str: String = row.get(0)?;
    let from_str: String = row.get(1)?;
    let to_page_str: Option<String> = row.get(2)?;
    let to_block_str: Option<String> = row.get(3)?;
    let created_str: String = row.get(5)?;

    Ok(Link {
        id: Uuid::parse_str(&id_str).unwrap_or_default(),
        from_block: Uuid::parse_str(&from_str).unwrap_or_default(),
        to_page: to_page_str.and_then(|s| Uuid::parse_str(&s).ok()),
        to_block: to_block_str.and_then(|s| Uuid::parse_str(&s).ok()),
        link_type: row.get(4)?,
        created_at: chrono::DateTime::parse_from_rfc3339(&created_str)
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .unwrap_or_else(|_| chrono::Utc::now()),
    })
}
