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
