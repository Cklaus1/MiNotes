use chrono::Utc;
use serde::Serialize;
use uuid::Uuid;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::models::{Block, Event};

impl Database {
    /// Emit an event for any mutation. Called internally by repo methods.
    pub(crate) fn emit_event<T: Serialize>(
        &self,
        event_type: &str,
        entity_id: &Uuid,
        entity_type: &str,
        payload: &T,
        actor: &str,
    ) -> Result<()> {
        let now = Utc::now();
        let payload_json = serde_json::to_value(payload)?;
        self.conn.execute(
            "INSERT INTO events (event_type, entity_id, entity_type, payload, actor, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                event_type,
                entity_id.to_string(),
                entity_type,
                payload_json.to_string(),
                actor,
                now.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    /// Query events with optional filters.
    pub fn get_events(
        &self,
        since_id: Option<i64>,
        types: Option<&[&str]>,
        limit: Option<i64>,
    ) -> Result<Vec<Event>> {
        let limit = limit.unwrap_or(50);
        let mut sql = String::from(
            "SELECT id, event_type, entity_id, entity_type, payload, actor, created_at FROM events WHERE 1=1",
        );
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(since) = since_id {
            sql.push_str(" AND id > ?");
            params.push(Box::new(since));
        }

        if let Some(type_list) = types {
            if !type_list.is_empty() {
                let placeholders: Vec<String> = type_list.iter().enumerate().map(|(i, _)| format!("?{}", params.len() + i + 1)).collect();
                sql.push_str(&format!(" AND event_type IN ({})", placeholders.join(",")));
                for t in type_list {
                    params.push(Box::new(t.to_string()));
                }
            }
        }

        sql.push_str(" ORDER BY id DESC LIMIT ?");
        params.push(Box::new(limit));

        let mut stmt = self.conn.prepare(&sql)?;
        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let rows = stmt.query_map(param_refs.as_slice(), |row| {
            row_to_event(row)
        })?;

        let mut events = Vec::new();
        for row in rows {
            events.push(row.map_err(Error::Database)?);
        }
        Ok(events)
    }

    /// Undo the most recent user-level event by reversing its mutation.
    /// Returns the undone event's ID, or None if nothing to undo.
    ///
    /// Derived events (`link.*`, emitted as a side effect of block writes) and
    /// `undo.*` records are skipped. The original event is marked `undone=1`
    /// rather than deleted so the audit log stays intact and a future `redo` can
    /// find it. The whole undo is atomic.
    ///
    /// An event that can no longer be reversed (a block deletion whose page has
    /// since been deleted) must not wedge the undo stack: it is marked `undone`
    /// with an `undo.skipped` record carrying the reason, and an
    /// `InvalidInput("Cannot undo ...")` error is returned for the caller to
    /// surface. The NEXT `undo_last` call proceeds with the previous event.
    pub fn undo_last(&self, actor: &str) -> Result<Option<i64>> {
        let mut skipped: Option<(Event, String)> = None;
        let out = self.undo_last_inner(actor, &mut skipped)?;
        if let Some((event, reason)) = skipped {
            self.tx(|| {
                self.emit_event(
                    "undo.skipped",
                    &event.entity_id,
                    &event.entity_type,
                    &serde_json::json!({
                        "event_id": event.id,
                        "event_type": event.event_type,
                        "reason": reason,
                    }),
                    actor,
                )?;
                self.conn.execute(
                    "UPDATE events SET undone = 1 WHERE id = ?1",
                    rusqlite::params![event.id],
                )?;
                Ok(())
            })?;
            return Err(Error::InvalidInput(format!(
                "Cannot undo {}: {reason}. It was skipped; undo again to continue with the previous action",
                event.event_type
            )));
        }
        Ok(out)
    }

    fn undo_last_inner(&self, actor: &str, skipped: &mut Option<(Event, String)>) -> Result<Option<i64>> {
        self.tx(|| {
            let event = {
                let mut stmt = self.conn.prepare(
                    "SELECT id, event_type, entity_id, entity_type, payload, actor, created_at
                     FROM events
                     WHERE event_type NOT LIKE 'undo.%'
                       AND event_type NOT LIKE 'link.%'
                       AND undone = 0
                     ORDER BY id DESC LIMIT 1",
                )?;
                let mut rows = stmt.query([])?;
                match rows.next()? {
                    Some(row) => row_to_event(row).map_err(Error::Database)?,
                    None => return Ok(None),
                }
            };

            let event_id = event.id;
            let entity_id = event.entity_id;

            match event.event_type.as_str() {
                "block.created" => {
                    // Undo create = delete (with any children added since).
                    self.delete_block_subtree_raw(&entity_id)?;
                }
                "block.deleted" => {
                    // Undo delete = recreate the block, then its descendants
                    // root-first, with original parent/position.
                    let root: Option<Block> = serde_json::from_value(event.payload.clone()).ok();
                    let subtree: Vec<Block> = event
                        .payload
                        .get("subtree")
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .unwrap_or_default();
                    if let Some(root) = root {
                        let page_exists: bool = self.conn.query_row(
                            "SELECT EXISTS(SELECT 1 FROM pages WHERE id = ?1)",
                            rusqlite::params![root.page_id.to_string()],
                            |row| row.get(0),
                        )?;
                        if !page_exists {
                            *skipped = Some((
                                event.clone(),
                                format!("page {} no longer exists", root.page_id),
                            ));
                            return Ok(None);
                        }
                        let mut restored = Vec::new();
                        for b in std::iter::once(&root).chain(subtree.iter()) {
                            if self.restore_block_row(b)? {
                                restored.push(b);
                            }
                        }
                        // Re-derive link rows once every block (incl. ref targets) exists.
                        for b in restored {
                            self.sync_block_links(&b.id, &b.content, actor)?;
                        }
                    }
                }
                "block.updated" => {
                    // Undo update = restore the prior content carried in the payload.
                    // (Events written before this field existed can't be reversed.)
                    if let Some(prev) = event.payload.get("previous_content").and_then(|v| v.as_str()) {
                        let n = self.conn.execute(
                            "UPDATE blocks SET content = ?1, updated_at = ?2 WHERE id = ?3",
                            rusqlite::params![prev, Utc::now().to_rfc3339(), entity_id.to_string()],
                        )?;
                        if n > 0 {
                            self.sync_block_links(&entity_id, prev, actor)?;
                        }
                    }
                }
                "page.created" => {
                    self.conn.execute(
                        "DELETE FROM properties WHERE entity_id = ?1
                            OR entity_id IN (SELECT id FROM blocks WHERE page_id = ?1)",
                        rusqlite::params![entity_id.to_string()],
                    )?;
                    self.conn.execute(
                        "DELETE FROM pages WHERE id = ?1",
                        rusqlite::params![entity_id.to_string()],
                    )?;
                }
                _ => {}
            }

            self.emit_event(
                &format!("undo.{}", event.event_type),
                &entity_id,
                &event.entity_type,
                &event.payload,
                actor,
            )?;
            self.conn.execute(
                "UPDATE events SET undone = 1 WHERE id = ?1",
                rusqlite::params![event_id],
            )?;
            Ok(Some(event_id))
        })
    }

    /// Re-insert a deleted block row. A parent that no longer exists (or is on
    /// another page) degrades to root level. Returns false if the page is gone
    /// or the block already exists.
    fn restore_block_row(&self, b: &Block) -> Result<bool> {
        let page_exists: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM pages WHERE id = ?1)",
            rusqlite::params![b.page_id.to_string()],
            |row| row.get(0),
        )?;
        if !page_exists {
            return Err(Error::InvalidInput(format!(
                "Cannot undo delete: page {} no longer exists",
                b.page_id
            )));
        }
        let parent = match b.parent_id {
            Some(p) => {
                let ok: bool = self.conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM blocks WHERE id = ?1 AND page_id = ?2)",
                    rusqlite::params![p.to_string(), b.page_id.to_string()],
                    |row| row.get(0),
                )?;
                ok.then(|| p.to_string())
            }
            None => None,
        };
        let n = self.conn.execute(
            "INSERT OR IGNORE INTO blocks (id, page_id, parent_id, position, content, format, collapsed, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                b.id.to_string(),
                b.page_id.to_string(),
                parent,
                b.position,
                b.content,
                b.format,
                b.collapsed as i32,
                b.created_at.to_rfc3339(),
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(n > 0)
    }
}

fn row_to_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<Event> {
    let id_str: String = row.get(2)?;
    let payload_str: String = row.get(4)?;
    let created_str: String = row.get(6)?;

    Ok(Event {
        id: row.get(0)?,
        event_type: row.get(1)?,
        entity_id: Uuid::parse_str(&id_str).unwrap_or_default(),
        entity_type: row.get(3)?,
        payload: serde_json::from_str(&payload_str).unwrap_or(serde_json::Value::Null),
        actor: row.get(5)?,
        created_at: chrono::DateTime::parse_from_rfc3339(&created_str)
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .unwrap_or_else(|_| chrono::Utc::now()),
    })
}

#[cfg(test)]
mod tests {
    use crate::db::Database;

    // (a) Undo skips derived link.* events and undoes the user's block creation.
    #[test]
    fn test_undo_skips_derived_link_events() {
        let db = Database::open_in_memory().unwrap();
        let t = db.create_page("T", None, false, None, "user").unwrap();
        let src = db.create_page("Src", None, false, None, "user").unwrap();
        let b = db.create_block(&src.id, "see [[T]]", None, None, "user").unwrap();
        db.undo_last("user").unwrap().unwrap();
        assert!(db.get_block(&b.id).unwrap().is_none(), "block creation undone");
        assert!(db.get_backlinks(&t.id).unwrap().is_empty());
    }

    // (c) Undoing an update restores the previous content (and its links).
    #[test]
    fn test_undo_block_update_restores_content() {
        let db = Database::open_in_memory().unwrap();
        let t = db.create_page("T", None, false, None, "user").unwrap();
        let src = db.create_page("Src", None, false, None, "user").unwrap();
        let b = db.create_block(&src.id, "see [[T]]", None, None, "user").unwrap();
        db.update_block(&b.id, Some("no link now"), "user").unwrap();
        assert!(db.get_backlinks(&t.id).unwrap().is_empty());
        db.undo_last("user").unwrap().unwrap();
        assert_eq!(db.get_block(&b.id).unwrap().unwrap().content, "see [[T]]");
        assert_eq!(db.get_backlinks(&t.id).unwrap().len(), 1);
    }

    // (b) Undoing a cascaded delete restores parent before children with the
    // original parent_id/position, in a single undo step.
    #[test]
    fn test_undo_cascaded_delete_restores_hierarchy() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("P", None, false, None, "user").unwrap();
        let a = db.create_block(&page.id, "A", None, Some(3.0), "user").unwrap();
        let b = db.create_block(&page.id, "B", Some(&a.id), Some(2.0), "user").unwrap();
        let c = db.create_block(&page.id, "C", Some(&b.id), Some(7.0), "user").unwrap();
        let d = db.create_block(&page.id, "D", Some(&a.id), Some(1.0), "user").unwrap();
        db.delete_block(&a.id, "user").unwrap();
        assert!(db.get_page_blocks(&page.id).unwrap().is_empty());

        db.undo_last("user").unwrap().unwrap();
        let get = |id| db.get_block(id).unwrap().unwrap();
        assert_eq!(get(&a.id).parent_id, None);
        assert_eq!(get(&a.id).position, 3.0);
        assert_eq!(get(&b.id).parent_id, Some(a.id));
        assert_eq!(get(&b.id).position, 2.0);
        assert_eq!(get(&c.id).parent_id, Some(b.id));
        assert_eq!(get(&c.id).position, 7.0);
        assert_eq!(get(&d.id).parent_id, Some(a.id));
    }

    // (d) Delete events are emitted only after the delete succeeds.
    #[test]
    fn test_delete_block_event_after_delete() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("P", None, false, None, "user").unwrap();
        let a = db.create_block(&page.id, "A", None, None, "user").unwrap();
        db.conn
            .execute_batch("CREATE TRIGGER boom BEFORE DELETE ON blocks BEGIN SELECT RAISE(ABORT, 'x'); END;")
            .unwrap();
        assert!(db.delete_block(&a.id, "user").is_err());
        let n: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM events WHERE event_type = 'block.deleted'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn test_undo_nothing() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(db.undo_last("user").unwrap(), None);
    }

    // An undo that can't be applied (its page was permanently deleted) is
    // reported once, marked undone with a reason, and does NOT block the stack:
    // the next undo proceeds with the previous action.
    #[test]
    fn test_undo_skips_unrestorable_block_delete() {
        let db = Database::open_in_memory().unwrap();
        let keep = db.create_page("Keep", None, false, None, "user").unwrap();
        let kb = db.create_block(&keep.id, "keep me", None, None, "user").unwrap();
        db.update_block(&kb.id, Some("edited"), "user").unwrap();
        let gone = db.create_page("Gone", None, false, None, "user").unwrap();
        let gb = db.create_block(&gone.id, "x", None, None, "user").unwrap();
        db.delete_block(&gb.id, "user").unwrap();
        db.permanently_delete_page(&gone.id, "user").unwrap();
        // Newest undoable event is page.deleted (a no-op undo); then block.deleted.
        db.undo_last("user").unwrap().unwrap();

        let err = db.undo_last("user").unwrap_err().to_string();
        assert!(err.contains("no longer exists"), "{err}");
        let (undone, skipped): (i64, i64) = db
            .conn
            .query_row(
                "SELECT (SELECT undone FROM events WHERE event_type = 'block.deleted'),
                        (SELECT COUNT(*) FROM events WHERE event_type = 'undo.skipped')",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((undone, skipped), (1, 1));

        // Not stuck: the next undos walk on (block.created of the gone page's
        // block is harmless, then page.created of Gone, then Keep's edit).
        let mut restored = false;
        for _ in 0..4 {
            db.undo_last("user").unwrap();
            if db.get_block(&kb.id).unwrap().map(|b| b.content == "keep me").unwrap_or(false) {
                restored = true;
                break;
            }
        }
        assert!(restored, "earlier edit was undone after the skipped event");
    }
}
