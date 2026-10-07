//! Whiteboard storage.
//!
//! Each whiteboard block has content `{{whiteboard:<id>}}`; its drawing data
//! (strokes, notes, images, ...) is stored here as an opaque JSON string keyed
//! by that id. Previously this lived only in the webview's localStorage.

use std::collections::HashSet;

use chrono::Utc;
use rusqlite::OptionalExtension;
use serde::Serialize;

use crate::db::Database;
use crate::error::{Error, Result};

const WHITEBOARDS_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS whiteboards (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
";

/// A stored whiteboard.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Whiteboard {
    pub id: String,
    pub data: String,
    pub updated_at: String,
}

fn validate_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 200
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(Error::InvalidInput(format!("invalid whiteboard id: {id:?}")));
    }
    Ok(())
}

impl Database {
    /// Idempotent migration: create the whiteboards table if missing.
    pub fn migrate_whiteboards(&self) -> Result<()> {
        self.conn.execute_batch(WHITEBOARDS_SCHEMA)?;
        Ok(())
    }

    /// Fetch a whiteboard by id. Returns `None` if it has never been saved.
    pub fn get_whiteboard(&self, id: &str) -> Result<Option<Whiteboard>> {
        validate_id(id)?;
        let wb = self
            .conn
            .query_row(
                "SELECT id, data, updated_at FROM whiteboards WHERE id = ?1",
                [id],
                |row| {
                    Ok(Whiteboard {
                        id: row.get(0)?,
                        data: row.get(1)?,
                        updated_at: row.get(2)?,
                    })
                },
            )
            .optional()?;
        Ok(wb)
    }

    /// Insert or replace a whiteboard's data. `data` must be valid JSON.
    pub fn save_whiteboard(&self, id: &str, data: &str) -> Result<Whiteboard> {
        validate_id(id)?;
        serde_json::from_str::<serde_json::Value>(data)?;
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO whiteboards (id, data, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
            rusqlite::params![id, data, now],
        )?;
        Ok(Whiteboard {
            id: id.to_string(),
            data: data.to_string(),
            updated_at: now,
        })
    }

    /// Delete a whiteboard. Returns true if a row was removed.
    pub fn delete_whiteboard(&self, id: &str) -> Result<bool> {
        validate_id(id)?;
        let n = self
            .conn
            .execute("DELETE FROM whiteboards WHERE id = ?1", [id])?;
        Ok(n > 0)
    }

    /// List all stored whiteboard ids.
    pub fn list_whiteboard_ids(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT id FROM whiteboards ORDER BY id")?;
        let ids = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(ids)
    }

    /// Insert/replace a board keeping the caller's `updated_at` (sync import: the
    /// timestamp travels with the board so devices agree on which copy is newer).
    pub(crate) fn put_whiteboard_raw(&self, id: &str, data: &str, updated_at: &str) -> Result<()> {
        validate_id(id)?;
        serde_json::from_str::<serde_json::Value>(data)?;
        self.conn.execute(
            "INSERT INTO whiteboards (id, data, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
            rusqlite::params![id, data, updated_at],
        )?;
        Ok(())
    }

    /// Whiteboard ids referenced by the blocks of `page_ids`.
    pub(crate) fn whiteboards_on_pages(&self, page_ids: &[uuid::Uuid]) -> Result<HashSet<String>> {
        let ids: Vec<String> = page_ids.iter().map(|p| p.to_string()).collect();
        let json = serde_json::to_string(&ids)?;
        let mut stmt = self.conn.prepare(
            "SELECT content FROM blocks
             WHERE page_id IN (SELECT value FROM json_each(?1)) AND content LIKE '%{{whiteboard:%'",
        )?;
        let mut out = HashSet::new();
        for content in stmt.query_map([json], |r| r.get::<_, String>(0))? {
            out.extend(whiteboard_refs(&content?));
        }
        Ok(out)
    }

    /// Delete whiteboards nothing can reach any more. Returns the deleted ids.
    ///
    /// A board is KEPT while it is referenced by
    /// (a) any block's content — live, trashed and archived pages alike (they all
    ///     keep their rows in `blocks`), or a template's content;
    /// (b) any not-yet-undone event whose undo would bring that content back: a
    ///     `block.deleted` payload (root + whole subtree) or a `block.updated`
    ///     `previous_content`. `undo_last` could restore such a block, and it
    ///     must find its drawing. (A deletion whose page is gone since is still
    ///     counted — conservative; undo skips it, but the page could return.)
    ///
    /// This is why deleting a block never deletes its board; boards are only
    /// collected here (after empty-trash / permanent deletes).
    ///
    /// Copying a whiteboard block copies its `{{whiteboard:<id>}}` marker, so two
    /// blocks can share ONE board (edits show in both). That sharing is left as
    /// is; references are counted per id, so the board lives while either exists.
    pub fn gc_whiteboards(&self) -> Result<Vec<String>> {
        self.tx(|| {
            let mut referenced: HashSet<String> = HashSet::new();
            for sql in [
                "SELECT content FROM blocks WHERE content LIKE '%{{whiteboard:%'",
                "SELECT content FROM templates WHERE content LIKE '%{{whiteboard:%'",
                // Undo of block.deleted re-inserts the root + subtree carried in
                // the payload.
                "SELECT payload FROM events
                  WHERE undone = 0 AND event_type = 'block.deleted'
                    AND payload LIKE '%{{whiteboard:%'",
                // Undo of block.updated restores `previous_content`.
                "SELECT json_extract(payload, '$.previous_content') FROM events
                  WHERE undone = 0 AND event_type = 'block.updated' AND json_valid(payload)
                    AND json_extract(payload, '$.previous_content') LIKE '%{{whiteboard:%'",
                // (block.created / page.* undos never bring content back; a
                // page.deleted payload carries only the page row.)
            ] {
                let mut stmt = self.conn.prepare(sql)?;
                for text in stmt.query_map([], |r| r.get::<_, String>(0))? {
                    referenced.extend(whiteboard_refs(&text?));
                }
            }
            let mut deleted = Vec::new();
            for id in self.list_whiteboard_ids()? {
                if !referenced.contains(&id) {
                    self.conn.execute("DELETE FROM whiteboards WHERE id = ?1", [&id])?;
                    deleted.push(id);
                }
            }
            Ok(deleted)
        })
    }

    /// Best-effort GC after a permanent delete: a GC problem must never fail
    /// (or roll back) the delete itself.
    pub(crate) fn gc_whiteboards_quietly(&self) {
        if let Err(e) = self.gc_whiteboards() {
            eprintln!("[minotes] whiteboard GC failed: {e}");
        }
    }
}

/// Every whiteboard id referenced as `{{whiteboard:<id>}}` anywhere in `text`
/// (block content, or a raw JSON event payload — the marker needs no escaping).
pub fn whiteboard_refs(text: &str) -> Vec<String> {
    const OPEN: &str = "{{whiteboard:";
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find(OPEN) {
        rest = &rest[i + OPEN.len()..];
        let end = rest
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
            .unwrap_or(rest.len());
        let id = &rest[..end];
        if !id.is_empty() && id.len() <= 200 && rest[end..].starts_with("}}") {
            out.push(id.to_string());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_and_get_roundtrip() {
        let db = Database::open_in_memory().unwrap();
        assert!(db.get_whiteboard("wb-1").unwrap().is_none());
        db.save_whiteboard("wb-1", r#"{"strokes":[]}"#).unwrap();
        let wb = db.get_whiteboard("wb-1").unwrap().unwrap();
        assert_eq!(wb.data, r#"{"strokes":[]}"#);
        db.save_whiteboard("wb-1", r#"{"strokes":[1]}"#).unwrap();
        assert_eq!(
            db.get_whiteboard("wb-1").unwrap().unwrap().data,
            r#"{"strokes":[1]}"#
        );
        assert_eq!(db.list_whiteboard_ids().unwrap(), vec!["wb-1".to_string()]);
    }

    #[test]
    fn rejects_invalid_json_and_ids() {
        let db = Database::open_in_memory().unwrap();
        assert!(db.save_whiteboard("wb-1", "not json").is_err());
        assert!(db.save_whiteboard("", "{}").is_err());
        assert!(db.save_whiteboard("a b", "{}").is_err());
        assert!(db.get_whiteboard("../x").is_err());
    }

    #[test]
    fn delete_and_idempotent_migration() {
        let db = Database::open_in_memory().unwrap();
        db.migrate_whiteboards().unwrap();
        db.migrate_whiteboards().unwrap();
        db.save_whiteboard("abc_1", "{}").unwrap();
        assert!(db.delete_whiteboard("abc_1").unwrap());
        assert!(!db.delete_whiteboard("abc_1").unwrap());
    }

    #[test]
    fn test_whiteboard_refs_parser() {
        assert_eq!(whiteboard_refs("{{whiteboard:abc-1}}"), vec!["abc-1"]);
        assert_eq!(
            whiteboard_refs(r#"{"content":"{{whiteboard:a_b}}","subtree":[{"content":"x {{whiteboard:z9}} y"}]}"#),
            vec!["a_b", "z9"]
        );
        assert!(whiteboard_refs("{{whiteboard:}} {{whiteboard:a b}} {{whiteboard:x").is_empty());
    }

    // GC keeps boards referenced by live / trashed / archived pages, by an
    // undo-able deletion, and by a copied block sharing the board; it removes a
    // board once nothing (incl. undo) can reach it.
    #[test]
    fn test_gc_whiteboards_respects_pages_and_undo() {
        let db = Database::open_in_memory().unwrap();
        let live = db.create_page("Live", None, false, None, "user").unwrap();
        let trashed = db.create_page("Trashed", None, false, None, "user").unwrap();
        let archived = db.create_page("Archived", None, false, None, "user").unwrap();
        db.create_block(&live.id, "{{whiteboard:wb-live}}", None, None, "user").unwrap();
        db.create_block(&trashed.id, "{{whiteboard:wb-trash}}", None, None, "user").unwrap();
        db.create_block(&archived.id, "{{whiteboard:wb-arch}}", None, None, "user").unwrap();
        // A copied block shares a board with the original.
        let orig = db.create_block(&live.id, "{{whiteboard:wb-shared}}", None, None, "user").unwrap();
        db.create_block(&live.id, "{{whiteboard:wb-shared}}", None, None, "user").unwrap();
        // A deleted block whose deletion can still be undone.
        let del = db.create_block(&live.id, "{{whiteboard:wb-undo}}", None, None, "user").unwrap();
        // A block edited away from a board: undoing the edit brings it back.
        let upd = db.create_block(&live.id, "{{whiteboard:wb-prev}}", None, None, "user").unwrap();
        db.update_block(&upd.id, Some("plain text now"), "user").unwrap();
        for id in ["wb-live", "wb-trash", "wb-arch", "wb-shared", "wb-undo", "wb-orphan", "wb-prev"] {
            db.save_whiteboard(id, r#"{"strokes":[1]}"#).unwrap();
        }
        db.trash_page(&trashed.id).unwrap();
        db.archive_page(&archived.id).unwrap();
        db.delete_block(&del.id, "user").unwrap();
        db.delete_block(&orig.id, "user").unwrap();

        assert_eq!(db.gc_whiteboards().unwrap(), vec!["wb-orphan".to_string()]);
        let mut left = db.list_whiteboard_ids().unwrap();
        left.sort();
        assert_eq!(left, vec!["wb-arch", "wb-live", "wb-prev", "wb-shared", "wb-trash", "wb-undo"]);

        // Undo brings the deleted block back — with its drawing.
        db.undo_last("user").unwrap().unwrap(); // orig
        db.undo_last("user").unwrap().unwrap(); // del
        assert!(db.get_block(&del.id).unwrap().is_some());
        assert!(db.get_whiteboard("wb-undo").unwrap().is_some());

        // Emptying the trash purges the trashed page and its (now orphan) board.
        assert_eq!(db.empty_trash("user").unwrap(), 1);
        assert!(db.get_whiteboard("wb-trash").unwrap().is_none());
        assert!(db.get_whiteboard("wb-live").unwrap().is_some());
        assert!(db.get_whiteboard("wb-arch").unwrap().is_some());
    }

    // permanently_delete_page collects the page's boards (no undo can restore
    // blocks of a purged page through page.deleted), but keeps a board another
    // page still shares.
    #[test]
    fn test_permanent_delete_collects_boards() {
        let db = Database::open_in_memory().unwrap();
        let a = db.create_page("A", None, false, None, "user").unwrap();
        let b = db.create_page("B", None, false, None, "user").unwrap();
        db.create_block(&a.id, "{{whiteboard:only-a}}", None, None, "user").unwrap();
        db.create_block(&a.id, "{{whiteboard:shared}}", None, None, "user").unwrap();
        db.create_block(&b.id, "{{whiteboard:shared}}", None, None, "user").unwrap();
        db.save_whiteboard("only-a", "{}").unwrap();
        db.save_whiteboard("shared", "{}").unwrap();
        db.trash_page(&a.id).unwrap();
        db.permanently_delete_page(&a.id, "user").unwrap();
        assert!(db.get_whiteboard("only-a").unwrap().is_none());
        assert!(db.get_whiteboard("shared").unwrap().is_some());
    }
}
