use chrono::Utc;
use uuid::Uuid;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::links::{extract_links, ParsedLink};
use crate::models::Block;

impl Database {
    /// Sync the links table for a block by parsing its content for [[page links]] and ((block refs)).
    fn sync_block_links(&self, block_id: &Uuid, content: &str, actor: &str) -> Result<()> {
        // Remove old links from this block
        self.conn.execute(
            "DELETE FROM links WHERE from_block = ?1",
            rusqlite::params![block_id.to_string()],
        )?;

        let parsed = extract_links(content);
        for link in parsed {
            match link {
                ParsedLink::PageLink(title) => {
                    // Bug #32: do NOT auto-create a page for every [[link]] on save.
                    // The editor saves on blur/debounce, so a typo (or an intermediate
                    // keystroke like `[[M]]`) would permanently pollute the page list.
                    // Only record a link to a page that already exists; pages are
                    // created on explicit navigation (frontend), and `create_page`
                    // backfills any link rows that were waiting on it.
                    if let Some(p) = self.get_page_by_title(&title)? {
                        self.create_link(block_id, Some(&p.id), None, "reference", actor)?;
                    }
                }
                ParsedLink::BlockRef(target_id) => {
                    self.create_link(block_id, None, Some(&target_id), "reference", actor)?;
                }
            }
        }
        Ok(())
    }

    /// Backfill `links` rows for a newly-created page: scan existing blocks for
    /// `[[Title]]` references to it and create the link rows that `sync_block_links`
    /// skipped while the page did not yet exist (Bug #32). Keeps backlinks correct
    /// regardless of whether the page was created manually, via navigation, or sync.
    pub(crate) fn backfill_links_for_page(&self, title: &str, page_id: &Uuid, actor: &str) -> Result<()> {
        // Coarse LIKE pre-filter on the bracketed form, then verify by parsing.
        let needle = format!("[[{title}");
        let pattern = format!("%{}%", needle.replace('%', "\\%").replace('_', "\\_"));
        let mut stmt = self.conn.prepare(
            "SELECT id, content FROM blocks WHERE content LIKE ?1 ESCAPE '\\'",
        )?;
        let candidates: Vec<(String, String)> = stmt
            .query_map(rusqlite::params![pattern], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        for (block_id_str, content) in candidates {
            let Ok(block_id) = Uuid::parse_str(&block_id_str) else { continue };
            for link in extract_links(&content) {
                if let ParsedLink::PageLink(t) = link {
                    if t.eq_ignore_ascii_case(title) {
                        // Avoid duplicate rows if one already exists.
                        let exists: bool = self.conn.query_row(
                            "SELECT COUNT(*) > 0 FROM links WHERE from_block = ?1 AND to_page = ?2",
                            rusqlite::params![block_id.to_string(), page_id.to_string()],
                            |row| row.get(0),
                        )?;
                        if !exists {
                            self.create_link(&block_id, Some(page_id), None, "reference", actor)?;
                        }
                    }
                }
            }
        }
        Ok(())
    }
    pub fn create_block(
        &self,
        page_id: &Uuid,
        content: &str,
        parent_id: Option<&Uuid>,
        position: Option<f64>,
        actor: &str,
    ) -> Result<Block> {
        self.create_block_with_id(Uuid::now_v7(), page_id, content, parent_id, position, actor)
    }

    /// Create a block with a caller-supplied id. Used by sync import to preserve
    /// stable block identity across the export→import round-trip (Bug #1).
    pub(crate) fn create_block_with_id(
        &self,
        id: Uuid,
        page_id: &Uuid,
        content: &str,
        parent_id: Option<&Uuid>,
        position: Option<f64>,
        actor: &str,
    ) -> Result<Block> {
        let now = Utc::now();

        let pos = match position {
            Some(p) => p,
            None => {
                let parent_str = parent_id.map(|p| p.to_string());
                let max: Option<f64> = self.conn.query_row(
                    "SELECT MAX(position) FROM blocks WHERE page_id = ?1 AND parent_id IS ?2",
                    rusqlite::params![page_id.to_string(), parent_str],
                    |row| row.get(0),
                )?;
                max.unwrap_or(0.0) + 1.0
            }
        };

        self.conn.execute(
            "INSERT INTO blocks (id, page_id, parent_id, position, content, format, collapsed, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'markdown', 0, ?6, ?7)",
            rusqlite::params![
                id.to_string(),
                page_id.to_string(),
                parent_id.map(|p| p.to_string()),
                pos,
                content,
                now.to_rfc3339(),
                now.to_rfc3339(),
            ],
        )?;

        let block = Block {
            id,
            page_id: *page_id,
            parent_id: parent_id.copied(),
            position: pos,
            content: content.to_string(),
            format: "markdown".to_string(),
            collapsed: false,
            created_at: now,
            updated_at: now,
        };

        self.emit_event("block.created", &block.id, "block", &block, actor)?;
        self.sync_block_links(&block.id, content, actor)?;
        Ok(block)
    }

    pub fn get_block(&self, id: &Uuid) -> Result<Option<Block>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, page_id, parent_id, position, content, format, collapsed, created_at, updated_at
             FROM blocks WHERE id = ?1",
        )?;
        let mut rows = stmt.query(rusqlite::params![id.to_string()])?;
        match rows.next()? {
            Some(row) => Ok(Some(row_to_block(row)?)),
            None => Ok(None),
        }
    }

    pub fn update_block(&self, id: &Uuid, content: Option<&str>, actor: &str) -> Result<Block> {
        let now = Utc::now();

        if let Some(c) = content {
            self.conn.execute(
                "UPDATE blocks SET content = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![c, now.to_rfc3339(), id.to_string()],
            )?;
        }

        let block = self
            .get_block(id)?
            .ok_or_else(|| Error::NotFound(format!("Block {id}")))?;
        self.emit_event("block.updated", &block.id, "block", &block, actor)?;
        if content.is_some() {
            self.sync_block_links(&block.id, &block.content, actor)?;
        }
        Ok(block)
    }

    pub fn delete_block(&self, id: &Uuid, actor: &str) -> Result<bool> {
        // Cascade: delete children first
        let children = self.get_children(id)?;
        for child in &children {
            self.delete_block(&child.id, actor)?;
        }
        if let Some(ref block) = self.get_block(id)? {
            self.emit_event("block.deleted", &block.id, "block", block, actor)?;
        }
        // Bug #29: clean up this block's properties (no FK from properties → blocks).
        self.conn.execute(
            "DELETE FROM properties WHERE entity_id = ?1",
            rusqlite::params![id.to_string()],
        )?;
        let count = self
            .conn
            .execute("DELETE FROM blocks WHERE id = ?1", rusqlite::params![id.to_string()])?;
        Ok(count > 0)
    }

    pub fn move_block(&self, id: &Uuid, new_parent: &Uuid, position: f64, actor: &str) -> Result<Block> {
        let now = Utc::now();
        let count = self.conn.execute(
            "UPDATE blocks SET parent_id = ?1, position = ?2, updated_at = ?3 WHERE id = ?4",
            rusqlite::params![new_parent.to_string(), position, now.to_rfc3339(), id.to_string()],
        )?;
        if count == 0 {
            return Err(Error::NotFound(format!("Block {id}")));
        }
        let block = self
            .get_block(id)?
            .ok_or_else(|| Error::NotFound(format!("Block {id}")))?;
        self.emit_event("block.moved", &block.id, "block", &block, actor)?;
        Ok(block)
    }

    /// Reorder a block within its current parent (or move to a new parent).
    /// parent_id can be None to move to root level.
    pub fn reorder_block(&self, id: &Uuid, parent_id: Option<&Uuid>, position: f64, actor: &str) -> Result<Block> {
        let now = Utc::now();
        let parent_str = parent_id.map(|p| p.to_string());
        let count = self.conn.execute(
            "UPDATE blocks SET parent_id = ?1, position = ?2, updated_at = ?3 WHERE id = ?4",
            rusqlite::params![parent_str, position, now.to_rfc3339(), id.to_string()],
        )?;
        if count == 0 {
            return Err(Error::NotFound(format!("Block {id}")));
        }
        let block = self
            .get_block(id)?
            .ok_or_else(|| Error::NotFound(format!("Block {id}")))?;
        self.emit_event("block.reordered", &block.id, "block", &block, actor)?;
        Ok(block)
    }

    pub fn get_children(&self, parent_id: &Uuid) -> Result<Vec<Block>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, page_id, parent_id, position, content, format, collapsed, created_at, updated_at
             FROM blocks WHERE parent_id = ?1 ORDER BY position",
        )?;
        let rows = stmt.query_map(rusqlite::params![parent_id.to_string()], |row| {
            row_to_block_sqlite(row)
        })?;
        let mut blocks = Vec::new();
        for row in rows {
            blocks.push(row.map_err(Error::Database)?);
        }
        Ok(blocks)
    }

    /// Change a block's parent (or set to root by passing None).
    pub fn reparent_block(&self, id: &Uuid, parent_id: Option<&Uuid>, actor: &str) -> Result<Block> {
        let now = Utc::now();
        let count = self.conn.execute(
            "UPDATE blocks SET parent_id = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![
                parent_id.map(|u| u.to_string()),
                now.to_rfc3339(),
                id.to_string()
            ],
        )?;
        if count == 0 {
            return Err(Error::NotFound(format!("Block {id}")));
        }
        let block = self.get_block(id)?
            .ok_or_else(|| Error::NotFound(format!("Block {id}")))?;
        self.emit_event("block.reparented", &block.id, "block", &block, actor)?;
        Ok(block)
    }

    pub fn get_page_blocks(&self, page_id: &Uuid) -> Result<Vec<Block>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, page_id, parent_id, position, content, format, collapsed, created_at, updated_at
             FROM blocks WHERE page_id = ?1 ORDER BY position",
        )?;
        let rows = stmt.query_map(rusqlite::params![page_id.to_string()], |row| {
            row_to_block_sqlite(row)
        })?;
        let mut blocks = Vec::new();
        for row in rows {
            blocks.push(row.map_err(Error::Database)?);
        }
        Ok(blocks)
    }
}

fn row_to_block(row: &rusqlite::Row<'_>) -> Result<Block> {
    Ok(row_to_block_sqlite(row)?)
}

fn row_to_block_sqlite(row: &rusqlite::Row<'_>) -> rusqlite::Result<Block> {
    let id_str: String = row.get(0)?;
    let page_id_str: String = row.get(1)?;
    let parent_id_str: Option<String> = row.get(2)?;
    let created_str: String = row.get(7)?;
    let updated_str: String = row.get(8)?;

    Ok(Block {
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
}

#[cfg(test)]
mod tests {
    use crate::db::Database;

    #[test]
    fn test_create_and_get_block() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("P", None, false, None, "user").unwrap();
        let block = db.create_block(&page.id, "Hello", None, None, "user").unwrap();
        assert_eq!(block.content, "Hello");
        assert_eq!(block.position, 1.0);

        let fetched = db.get_block(&block.id).unwrap().unwrap();
        assert_eq!(fetched.content, "Hello");
    }

    #[test]
    fn test_auto_increment_position() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("P", None, false, None, "user").unwrap();
        let b1 = db.create_block(&page.id, "A", None, None, "user").unwrap();
        let b2 = db.create_block(&page.id, "B", None, None, "user").unwrap();
        assert_eq!(b1.position, 1.0);
        assert_eq!(b2.position, 2.0);
    }

    #[test]
    fn test_update_block() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("P", None, false, None, "user").unwrap();
        let block = db.create_block(&page.id, "Old", None, None, "user").unwrap();
        let updated = db.update_block(&block.id, Some("New"), "user").unwrap();
        assert_eq!(updated.content, "New");
    }

    #[test]
    fn test_delete_block() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("P", None, false, None, "user").unwrap();
        let block = db.create_block(&page.id, "Del", None, None, "user").unwrap();
        assert!(db.delete_block(&block.id, "user").unwrap());
        assert!(db.get_block(&block.id).unwrap().is_none());
    }

    #[test]
    fn test_get_page_blocks() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("P", None, false, None, "user").unwrap();
        db.create_block(&page.id, "A", None, None, "user").unwrap();
        db.create_block(&page.id, "B", None, None, "user").unwrap();
        let blocks = db.get_page_blocks(&page.id).unwrap();
        assert_eq!(blocks.len(), 2);
    }

    // Bug #32: typing a [[link]] to a non-existent page must NOT auto-create it.
    #[test]
    fn test_wikilink_does_not_autocreate_page() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("Source", None, false, None, "user").unwrap();
        db.create_block(&page.id, "see [[Nonexistent Typo]]", None, None, "user").unwrap();
        assert!(db.get_page_by_title("Nonexistent Typo").unwrap().is_none());
        // And no dangling link row was created to a missing page.
        assert!(db.get_forward_links(&page.id).unwrap().is_empty());
    }

    // Bug #32: when the target page is later created, existing [[links]] backfill.
    #[test]
    fn test_wikilink_backfills_on_page_create() {
        let db = Database::open_in_memory().unwrap();
        let source = db.create_page("Source", None, false, None, "user").unwrap();
        db.create_block(&source.id, "see [[Target]]", None, None, "user").unwrap();
        assert!(db.get_forward_links(&source.id).unwrap().is_empty());

        let target = db.create_page("Target", None, false, None, "user").unwrap();
        let links = db.get_forward_links(&source.id).unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].to_page, Some(target.id));
    }
}
