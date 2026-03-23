use chrono::Utc;
use uuid::Uuid;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::models::Highlight;

impl Database {
    pub fn create_highlight(
        &self,
        pdf_path: &str,
        page_num: i32,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        color: &str,
        text: Option<&str>,
        note: Option<&str>,
        actor: &str,
    ) -> Result<Highlight> {
        let now = Utc::now();
        let id = Uuid::now_v7();

        let highlight = Highlight {
            id,
            pdf_path: pdf_path.to_string(),
            page_num,
            x,
            y,
            width,
            height,
            color: color.to_string(),
            text: text.map(|s| s.to_string()),
            note: note.map(|s| s.to_string()),
            block_id: None,
            created_at: now,
            updated_at: now,
        };

        self.conn.execute(
            "INSERT INTO highlights (id, pdf_path, page_num, x, y, width, height, color, text, note, block_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            rusqlite::params![
                highlight.id.to_string(),
                highlight.pdf_path,
                highlight.page_num,
                highlight.x,
                highlight.y,
                highlight.width,
                highlight.height,
                highlight.color,
                highlight.text,
                highlight.note,
                highlight.block_id.map(|u| u.to_string()),
                highlight.created_at.to_rfc3339(),
                highlight.updated_at.to_rfc3339(),
            ],
        )?;

        self.emit_event("highlight.created", &highlight.id, "highlight", &highlight, actor)?;
        Ok(highlight)
    }

    pub fn get_highlights(&self, pdf_path: &str) -> Result<Vec<Highlight>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, pdf_path, page_num, x, y, width, height, color, text, note, block_id, created_at, updated_at
             FROM highlights WHERE pdf_path = ?1 ORDER BY page_num, created_at",
        )?;

        let highlights = stmt
            .query_map([pdf_path], |row| Ok(Self::row_to_highlight(row)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(highlights)
    }

    pub fn get_highlight(&self, id: &Uuid) -> Result<Option<Highlight>> {
        let result = self.conn.query_row(
            "SELECT id, pdf_path, page_num, x, y, width, height, color, text, note, block_id, created_at, updated_at
             FROM highlights WHERE id = ?1",
            [id.to_string()],
            |row| Ok(Self::row_to_highlight(row)),
        );

        match result {
            Ok(h) => Ok(Some(h)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn update_highlight_note(&self, id: &Uuid, note: &str, actor: &str) -> Result<Highlight> {
        let now = Utc::now();

        let rows = self.conn.execute(
            "UPDATE highlights SET note = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![note, now.to_rfc3339(), id.to_string()],
        )?;

        if rows == 0 {
            return Err(Error::NotFound(format!("Highlight {id}")));
        }

        let highlight = self
            .get_highlight(id)?
            .ok_or_else(|| Error::NotFound(format!("Highlight {id}")))?;

        self.emit_event("highlight.updated", &highlight.id, "highlight", &highlight, actor)?;
        Ok(highlight)
    }

    pub fn delete_highlight(&self, id: &Uuid, actor: &str) -> Result<bool> {
        self.emit_event("highlight.deleted", id, "highlight", &serde_json::json!({"id": id.to_string()}), actor)?;
        let rows = self.conn.execute(
            "DELETE FROM highlights WHERE id = ?1",
            [id.to_string()],
        )?;
        Ok(rows > 0)
    }

    pub fn search_highlights(&self, query: &str) -> Result<Vec<Highlight>> {
        let pattern = format!("%{query}%");
        let mut stmt = self.conn.prepare(
            "SELECT id, pdf_path, page_num, x, y, width, height, color, text, note, block_id, created_at, updated_at
             FROM highlights WHERE text LIKE ?1 OR note LIKE ?1 ORDER BY created_at DESC",
        )?;

        let highlights = stmt
            .query_map([&pattern], |row| Ok(Self::row_to_highlight(row)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(highlights)
    }

    pub fn link_highlight_to_block(
        &self,
        highlight_id: &Uuid,
        block_id: &Uuid,
        actor: &str,
    ) -> Result<Highlight> {
        let now = Utc::now();

        // Verify block exists
        let exists: bool = self.conn.query_row(
            "SELECT COUNT(*) > 0 FROM blocks WHERE id = ?1",
            [block_id.to_string()],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(Error::NotFound(format!("Block {block_id}")));
        }

        let rows = self.conn.execute(
            "UPDATE highlights SET block_id = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![block_id.to_string(), now.to_rfc3339(), highlight_id.to_string()],
        )?;

        if rows == 0 {
            return Err(Error::NotFound(format!("Highlight {highlight_id}")));
        }

        let highlight = self
            .get_highlight(highlight_id)?
            .ok_or_else(|| Error::NotFound(format!("Highlight {highlight_id}")))?;

        self.emit_event("highlight.linked", &highlight.id, "highlight", &highlight, actor)?;
        Ok(highlight)
    }

    fn row_to_highlight(row: &rusqlite::Row) -> Highlight {
        let id_str: String = row.get_unwrap(0);
        let block_id_str: Option<String> = row.get_unwrap(10);
        let created_str: String = row.get_unwrap(11);
        let updated_str: String = row.get_unwrap(12);

        Highlight {
            id: Uuid::parse_str(&id_str).unwrap(),
            pdf_path: row.get_unwrap(1),
            page_num: row.get_unwrap(2),
            x: row.get_unwrap(3),
            y: row.get_unwrap(4),
            width: row.get_unwrap(5),
            height: row.get_unwrap(6),
            color: row.get_unwrap(7),
            text: row.get_unwrap(8),
            note: row.get_unwrap(9),
            block_id: block_id_str.map(|s| Uuid::parse_str(&s).unwrap()),
            created_at: chrono::DateTime::parse_from_rfc3339(&created_str)
                .unwrap()
                .with_timezone(&Utc),
            updated_at: chrono::DateTime::parse_from_rfc3339(&updated_str)
                .unwrap()
                .with_timezone(&Utc),
        }
    }
}
