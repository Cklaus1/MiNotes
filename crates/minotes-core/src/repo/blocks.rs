use chrono::Utc;
use uuid::Uuid;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::links::{extract_links, ParsedLink};
use crate::models::Block;

const BLOCK_COLS: &str =
    "id, page_id, parent_id, position, content, format, collapsed, created_at, updated_at";

impl Database {
    /// Sync the links table for a block by parsing its content for [[page links]] and ((block refs)).
    ///
    /// Callers must run this inside the same `tx` as the content write so the
    /// content and its link rows can never disagree.
    pub(crate) fn sync_block_links(&self, block_id: &Uuid, content: &str, actor: &str) -> Result<()> {
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
                    // Only record a link to a page that already exists; `create_page`
                    // backfills any link rows that were waiting on it. Resolution is
                    // case-insensitive, matching the backfill.
                    if let Some(p) = self.find_page_for_link(&title)? {
                        self.create_link(block_id, Some(&p.id), None, "reference", actor)?;
                    }
                }
                ParsedLink::BlockRef(target_id) => {
                    // A ((ref)) to a block that doesn't exist (typo, deleted, not yet
                    // synced) must not fail the save with an FK error.
                    let exists: bool = self.conn.query_row(
                        "SELECT EXISTS(SELECT 1 FROM blocks WHERE id = ?1)",
                        rusqlite::params![target_id.to_string()],
                        |row| row.get(0),
                    )?;
                    if exists {
                        self.create_link(block_id, None, Some(&target_id), "reference", actor)?;
                    }
                }
            }
        }
        Ok(())
    }

    /// Backfill `links` rows for a newly-created page: scan existing blocks for
    /// `[[Title]]` references to it and create the link rows that `sync_block_links`
    /// skipped while the page did not yet exist (Bug #32).
    pub(crate) fn backfill_links_for_page(&self, title: &str, page_id: &Uuid, actor: &str) -> Result<()> {
        // Coarse pre-filter, then verify by parsing. LIKE is ASCII case-insensitive,
        // like link resolution. When the title has indexable tokens, narrow the
        // candidates through the FTS index first instead of scanning every block.
        let needle = format!("[[{title}");
        let pattern = format!(
            "%{}%",
            needle.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
        );
        let candidates: Vec<(String, String)> = if title.chars().any(char::is_alphanumeric) {
            let fts_query = format!("\"{}\"", title.replace('"', "\"\""));
            let mut stmt = self.conn.prepare(
                "SELECT id, content FROM blocks
                 WHERE rowid IN (SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ?1)
                   AND content LIKE ?2 ESCAPE '\\'",
            )?;
            let rows = stmt
                .query_map(rusqlite::params![fts_query, pattern], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            rows
        } else {
            let mut stmt = self
                .conn
                .prepare("SELECT id, content FROM blocks WHERE content LIKE ?1 ESCAPE '\\'")?;
            let rows = stmt
                .query_map(rusqlite::params![pattern], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            rows
        };

        for (block_id_str, content) in candidates {
            let Ok(block_id) = Uuid::parse_str(&block_id_str) else { continue };
            for link in extract_links(&content) {
                let ParsedLink::PageLink(t) = link else { continue };
                if !t.eq_ignore_ascii_case(title) {
                    continue;
                }
                // Only if the link actually resolves to THIS page (an exact-case
                // match on another page wins), so backfill == sync_block_links.
                match self.find_page_for_link(&t)? {
                    Some(p) if p.id == *page_id => {}
                    _ => continue,
                }
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
        self.tx(|| {
            let now = Utc::now();

            if let Some(parent) = parent_id {
                if let Some(pp) = self.block_page_id(parent)? {
                    if pp != *page_id {
                        return Err(Error::InvalidInput(format!(
                            "Parent block {parent} is on a different page"
                        )));
                    }
                }
            }

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
        })
    }

    pub fn get_block(&self, id: &Uuid) -> Result<Option<Block>> {
        let mut stmt = self
            .conn
            .prepare(&format!("SELECT {BLOCK_COLS} FROM blocks WHERE id = ?1"))?;
        let mut rows = stmt.query(rusqlite::params![id.to_string()])?;
        match rows.next()? {
            Some(row) => Ok(Some(row_to_block(row)?)),
            None => Ok(None),
        }
    }

    fn block_page_id(&self, id: &Uuid) -> Result<Option<Uuid>> {
        let r: Option<String> = self
            .conn
            .query_row(
                "SELECT page_id FROM blocks WHERE id = ?1",
                rusqlite::params![id.to_string()],
                |row| row.get(0),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })?;
        Ok(r.and_then(|s| Uuid::parse_str(&s).ok()))
    }

    pub fn update_block(&self, id: &Uuid, content: Option<&str>, actor: &str) -> Result<Block> {
        self.tx(|| {
            let previous = self
                .get_block(id)?
                .ok_or_else(|| Error::NotFound(format!("Block {id}")))?;
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
            // Carry the prior content so `undo_last` can restore it.
            let mut payload = serde_json::to_value(&block)?;
            payload["previous_content"] = serde_json::Value::String(previous.content);
            self.emit_event("block.updated", &block.id, "block", &payload, actor)?;
            if content.is_some() {
                self.sync_block_links(&block.id, &block.content, actor)?;
            }
            Ok(block)
        })
    }

    /// Ids of `id` and all its descendants. Uses a recursive CTE with `UNION`
    /// (not `UNION ALL`) so a corrupt parent cycle terminates instead of
    /// recursing forever.
    pub(crate) fn block_subtree_ids(&self, id: &Uuid) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "WITH RECURSIVE sub(id) AS (
                 SELECT id FROM blocks WHERE id = ?1
                 UNION
                 SELECT b.id FROM blocks b JOIN sub ON b.parent_id = sub.id
             )
             SELECT id FROM sub",
        )?;
        let ids = stmt
            .query_map(rusqlite::params![id.to_string()], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(ids)
    }

    /// Snapshot a block subtree root-first (BFS; children by position), for
    /// undo payloads. Cycle-safe.
    fn block_subtree_snapshot(&self, root: &Block) -> Result<Vec<Block>> {
        let ids = self.block_subtree_ids(&root.id)?;
        let mut by_parent: std::collections::HashMap<Uuid, Vec<Block>> =
            std::collections::HashMap::new();
        for sid in &ids {
            let Ok(u) = Uuid::parse_str(sid) else { continue };
            if u == root.id {
                continue;
            }
            if let Some(b) = self.get_block(&u)? {
                if let Some(p) = b.parent_id {
                    by_parent.entry(p).or_default().push(b);
                }
            }
        }
        for v in by_parent.values_mut() {
            v.sort_by(|a, b| a.position.total_cmp(&b.position));
        }
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        seen.insert(root.id);
        let mut queue = std::collections::VecDeque::from([root.id]);
        while let Some(cur) = queue.pop_front() {
            if let Some(children) = by_parent.remove(&cur) {
                for c in children {
                    if seen.insert(c.id) {
                        queue.push_back(c.id);
                        out.push(c);
                    }
                }
            }
        }
        Ok(out)
    }

    /// Delete `id` and its whole subtree without emitting events (shared by
    /// `delete_block` and undo). Non-recursive in Rust, so even a corrupt
    /// parent cycle in a user DB cannot overflow the stack.
    pub(crate) fn delete_block_subtree_raw(&self, id: &Uuid) -> Result<usize> {
        let ids = self.block_subtree_ids(id)?;
        if ids.is_empty() {
            return Ok(0);
        }
        let json = serde_json::to_string(&ids)?;
        // Bug #29: clean up properties (no FK from properties → blocks).
        self.conn.execute(
            "DELETE FROM properties WHERE entity_id IN (SELECT value FROM json_each(?1))",
            rusqlite::params![json],
        )?;
        let n = self.conn.execute(
            "DELETE FROM blocks WHERE id IN (SELECT value FROM json_each(?1))",
            rusqlite::params![json],
        )?;
        Ok(n)
    }

    pub fn delete_block(&self, id: &Uuid, actor: &str) -> Result<bool> {
        self.tx(|| {
            let Some(block) = self.get_block(id)? else {
                return Ok(false);
            };
            // One event for the whole cascade, carrying the subtree root-first so
            // undo can restore the hierarchy (parents before children).
            let subtree = self.block_subtree_snapshot(&block)?;
            let mut payload = serde_json::to_value(&block)?;
            payload["subtree"] = serde_json::to_value(&subtree)?;

            let n = self.delete_block_subtree_raw(id)?;
            // Emit after the DELETE succeeded (repo convention).
            self.emit_event("block.deleted", &block.id, "block", &payload, actor)?;
            Ok(n > 0)
        })
    }

    /// Validate a prospective parent for block `id`: it must exist, be on the same
    /// page, and not be the block itself or one of its descendants (which would
    /// create a cycle — Bug: `reparent_block(A, Some(A))` later stack-overflowed).
    fn check_new_parent(&self, block: &Block, new_parent: &Uuid) -> Result<()> {
        if *new_parent == block.id {
            return Err(Error::InvalidInput("A block cannot be its own parent".into()));
        }
        let parent_page = self
            .block_page_id(new_parent)?
            .ok_or_else(|| Error::NotFound(format!("Block {new_parent}")))?;
        if parent_page != block.page_id {
            return Err(Error::InvalidInput(
                "Cannot move a block under a parent on a different page".into(),
            ));
        }
        // Walk up from the new parent; reject if we reach the block being moved.
        let is_descendant: bool = self.conn.query_row(
            "WITH RECURSIVE anc(id) AS (
                 SELECT ?1
                 UNION
                 SELECT b.parent_id FROM blocks b JOIN anc ON b.id = anc.id
                 WHERE b.parent_id IS NOT NULL
             )
             SELECT EXISTS(SELECT 1 FROM anc WHERE id = ?2)",
            rusqlite::params![new_parent.to_string(), block.id.to_string()],
            |row| row.get(0),
        )?;
        if is_descendant {
            return Err(Error::InvalidInput(
                "Cannot move a block under one of its own descendants".into(),
            ));
        }
        Ok(())
    }

    /// Shared implementation of move/reorder/reparent. `position: None` keeps it.
    fn set_block_parent(
        &self,
        id: &Uuid,
        parent_id: Option<&Uuid>,
        position: Option<f64>,
        event: &str,
        actor: &str,
    ) -> Result<Block> {
        self.tx(|| {
            let current = self
                .get_block(id)?
                .ok_or_else(|| Error::NotFound(format!("Block {id}")))?;
            if let Some(p) = parent_id {
                self.check_new_parent(&current, p)?;
            }
            let now = Utc::now();
            self.conn.execute(
                "UPDATE blocks SET parent_id = ?1, position = ?2, updated_at = ?3 WHERE id = ?4",
                rusqlite::params![
                    parent_id.map(|p| p.to_string()),
                    position.unwrap_or(current.position),
                    now.to_rfc3339(),
                    id.to_string()
                ],
            )?;
            let block = self
                .get_block(id)?
                .ok_or_else(|| Error::NotFound(format!("Block {id}")))?;
            self.emit_event(event, &block.id, "block", &block, actor)?;
            Ok(block)
        })
    }

    pub fn move_block(&self, id: &Uuid, new_parent: &Uuid, position: f64, actor: &str) -> Result<Block> {
        self.set_block_parent(id, Some(new_parent), Some(position), "block.moved", actor)
    }

    /// Reorder a block within its current parent (or move to a new parent).
    /// parent_id can be None to move to root level.
    pub fn reorder_block(&self, id: &Uuid, parent_id: Option<&Uuid>, position: f64, actor: &str) -> Result<Block> {
        self.set_block_parent(id, parent_id, Some(position), "block.reordered", actor)
    }

    pub fn get_children(&self, parent_id: &Uuid) -> Result<Vec<Block>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {BLOCK_COLS} FROM blocks WHERE parent_id = ?1 ORDER BY position"
        ))?;
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
        self.set_block_parent(id, parent_id, None, "block.reparented", actor)
    }

    pub fn get_page_blocks(&self, page_id: &Uuid) -> Result<Vec<Block>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {BLOCK_COLS} FROM blocks WHERE page_id = ?1 ORDER BY position"
        ))?;
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
    use crate::error::Error;

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

    fn page_with_tree(db: &Database) -> (uuid::Uuid, uuid::Uuid, uuid::Uuid, uuid::Uuid) {
        let page = db.create_page("P", None, false, None, "user").unwrap();
        let a = db.create_block(&page.id, "A", None, None, "user").unwrap();
        let b = db.create_block(&page.id, "B", Some(&a.id), None, "user").unwrap();
        let c = db.create_block(&page.id, "C", Some(&b.id), None, "user").unwrap();
        (page.id, a.id, b.id, c.id)
    }

    #[test]
    fn test_reparent_rejects_self_and_descendant() {
        let db = Database::open_in_memory().unwrap();
        let (_, a, b, c) = page_with_tree(&db);
        assert!(matches!(db.reparent_block(&a, Some(&a), "user"), Err(Error::InvalidInput(_))));
        assert!(matches!(db.reparent_block(&a, Some(&c), "user"), Err(Error::InvalidInput(_))));
        assert!(matches!(db.move_block(&a, &b, 1.0, "user"), Err(Error::InvalidInput(_))));
        assert!(matches!(db.reorder_block(&a, Some(&a), 1.0, "user"), Err(Error::InvalidInput(_))));
        // Tree unchanged, and delete still works.
        assert_eq!(db.get_block(&a).unwrap().unwrap().parent_id, None);
        assert!(db.delete_block(&a, "user").unwrap());
        assert!(db.get_block(&c).unwrap().is_none());
    }

    #[test]
    fn test_move_rejects_cross_page_parent() {
        let db = Database::open_in_memory().unwrap();
        let (_, a, _, _) = page_with_tree(&db);
        let other = db.create_page("Other", None, false, None, "user").unwrap();
        let x = db.create_block(&other.id, "X", None, None, "user").unwrap().id;
        assert!(matches!(db.move_block(&x, &a, 1.0, "user"), Err(Error::InvalidInput(_))));
        assert!(matches!(db.reorder_block(&x, Some(&a), 1.0, "user"), Err(Error::InvalidInput(_))));
        assert!(matches!(db.reparent_block(&x, Some(&a), "user"), Err(Error::InvalidInput(_))));
        assert!(db.create_block(&other.id, "Y", Some(&a), None, "user").is_err());
        assert_eq!(db.get_block(&x).unwrap().unwrap().parent_id, None);
    }

    #[test]
    fn test_legal_move_and_reorder() {
        let db = Database::open_in_memory().unwrap();
        let (_, a, b, c) = page_with_tree(&db);
        let moved = db.move_block(&c, &a, 5.0, "user").unwrap();
        assert_eq!(moved.parent_id, Some(a));
        assert_eq!(moved.position, 5.0);
        let root = db.reorder_block(&b, None, 9.0, "user").unwrap();
        assert_eq!(root.parent_id, None);
        let rp = db.reparent_block(&b, Some(&c), "user").unwrap();
        assert_eq!(rp.parent_id, Some(c));
        assert_eq!(rp.position, 9.0, "reparent keeps position");
    }

    // A pre-existing corrupt cycle in a user DB must not overflow the stack.
    #[test]
    fn test_delete_block_survives_corrupt_cycle() {
        let db = Database::open_in_memory().unwrap();
        let (_, a, b, c) = page_with_tree(&db);
        db.conn
            .execute("UPDATE blocks SET parent_id = ?1 WHERE id = ?2", rusqlite::params![c.to_string(), a.to_string()])
            .unwrap();
        db.conn
            .execute("UPDATE blocks SET parent_id = ?1 WHERE id = ?1", rusqlite::params![b.to_string()])
            .ok();
        assert!(db.delete_block(&a, "user").unwrap());
        assert!(db.get_block(&a).unwrap().is_none());
    }

    #[test]
    fn test_dangling_block_ref_does_not_fail_or_drop_links() {
        let db = Database::open_in_memory().unwrap();
        let target = db.create_page("Target", None, false, None, "user").unwrap();
        let src = db.create_page("Src", None, false, None, "user").unwrap();
        let b = db.create_block(&src.id, "see [[Target]]", None, None, "user").unwrap();
        assert_eq!(db.get_backlinks(&target.id).unwrap().len(), 1);

        let missing = uuid::Uuid::now_v7();
        let updated = db
            .update_block(&b.id, Some(&format!("see [[Target]] and (({missing}))")), "user")
            .unwrap();
        assert!(updated.content.contains(&missing.to_string()));
        assert_eq!(db.get_backlinks(&target.id).unwrap().len(), 1, "backlink kept");
        // Creating with a dangling ref is fine too.
        db.create_block(&src.id, &format!("(({missing}))"), None, None, "user").unwrap();
    }

    // Content write + link sync are atomic: if link sync fails, content is not saved.
    #[test]
    fn test_update_block_atomic_with_link_sync() {
        let db = Database::open_in_memory().unwrap();
        let target = db.create_page("Target", None, false, None, "user").unwrap();
        let src = db.create_page("Src", None, false, None, "user").unwrap();
        let b = db.create_block(&src.id, "see [[Target]]", None, None, "user").unwrap();
        db.conn
            .execute_batch(
                "CREATE TRIGGER boom BEFORE INSERT ON links BEGIN SELECT RAISE(ABORT, 'injected'); END;",
            )
            .unwrap();
        assert!(db.update_block(&b.id, Some("new [[Target]]"), "user").is_err());
        assert_eq!(db.get_block(&b.id).unwrap().unwrap().content, "see [[Target]]");
        assert_eq!(db.get_backlinks(&target.id).unwrap().len(), 1, "old links intact");
        // create_block likewise leaves nothing behind.
        assert!(db.create_block(&src.id, "x [[Target]]", None, None, "user").is_err());
        assert_eq!(db.get_page_blocks(&src.id).unwrap().len(), 1);
        assert!(db.conn.is_autocommit());
    }

    #[test]
    fn test_delete_block_atomic() {
        let db = Database::open_in_memory().unwrap();
        let (page, a, _, _) = page_with_tree(&db);
        db.conn
            .execute_batch(
                "CREATE TRIGGER boom BEFORE DELETE ON blocks WHEN old.content = 'A'
                 BEGIN SELECT RAISE(ABORT, 'injected'); END;",
            )
            .unwrap();
        assert!(db.delete_block(&a, "user").is_err());
        assert_eq!(db.get_page_blocks(&page).unwrap().len(), 3, "children not half-deleted");
    }

    // Link resolution is case-insensitive in BOTH sync and backfill, so a link
    // created by backfill survives the next edit.
    #[test]
    fn test_link_case_insensitive_consistent() {
        let db = Database::open_in_memory().unwrap();
        let src = db.create_page("Src", None, false, None, "user").unwrap();
        let b = db.create_block(&src.id, "see [[project alpha]]", None, None, "user").unwrap();
        let target = db.create_page("Project Alpha", None, false, None, "user").unwrap();
        assert_eq!(db.get_backlinks(&target.id).unwrap().len(), 1, "backfilled");
        db.update_block(&b.id, Some("see [[project alpha]] again"), "user").unwrap();
        assert_eq!(db.get_backlinks(&target.id).unwrap().len(), 1, "kept after edit");
        db.create_block(&src.id, "[[PROJECT ALPHA|alias]]", None, None, "user").unwrap();
        assert_eq!(db.get_backlinks(&target.id).unwrap().len(), 2);
        // Exact title lookups (page identity) stay exact.
        assert!(db.get_page_by_title("project alpha").unwrap().is_none());
    }

    // Backfill pre-filters via FTS but still finds titles with punctuation or
    // no indexable tokens.
    #[test]
    fn test_backfill_punctuation_titles() {
        let db = Database::open_in_memory().unwrap();
        let src = db.create_page("Src", None, false, None, "user").unwrap();
        db.create_block(&src.id, "a [[C++]] b", None, None, "user").unwrap();
        db.create_block(&src.id, "a [[???]] b", None, None, "user").unwrap();
        db.create_block(&src.id, "a [[100%_done]] b", None, None, "user").unwrap();
        for t in ["C++", "???", "100%_done"] {
            let p = db.create_page(t, None, false, None, "user").unwrap();
            assert_eq!(db.get_backlinks(&p.id).unwrap().len(), 1, "{t}");
        }
    }
}
