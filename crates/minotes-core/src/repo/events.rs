use chrono::{DateTime, Utc};
use serde::Serialize;
use uuid::Uuid;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::models::Event;

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

    /// Delete events older than `older_than` — but never one inside the
    /// [`EVENT_HORIZON_DAYS`] window, whatever the caller passes. Returns the
    /// number deleted.
    ///
    /// The event log is a bounded change feed, not a history. What reads it:
    /// - sync (`pages_modified_since` / `folders_modified_since`) asks "what
    ///   changed here after `t`", where `t` is the current sync cycle's export
    ///   time or the moment a mass deletion was held — both recent (a held
    ///   deletion is re-checked every cycle). Page/block edits are also visible
    ///   through `updated_at`; the events are what reveal block *deletions*.
    ///   A caller holding an older marker passes it as `older_than` to keep more.
    /// - whiteboard/attachment GC: content of blocks deleted or edited inside
    ///   the horizon stays protected (see [`gc_whiteboards`](Self::gc_whiteboards)).
    /// - `minotes events` (CLI tail/list) — best effort, no completeness promise.
    ///
    /// Run at startup and after empty-trash / permanent deletes (with GC).
    pub fn compact_events(&self, older_than: DateTime<Utc>) -> Result<usize> {
        let cutoff = older_than.min(event_horizon_start());
        Ok(self.conn.execute(
            "DELETE FROM events WHERE created_at < ?1",
            [cutoff.to_rfc3339()],
        )?)
    }

    /// [`compact_events`](Self::compact_events) at the horizon; errors are
    /// logged, never returned (housekeeping must not fail the caller).
    pub fn compact_events_quietly(&self) {
        match self.compact_events(event_horizon_start()) {
            Ok(n) if n > 0 => eprintln!("[minotes] compacted {n} events older than {EVENT_HORIZON_DAYS} days"),
            Ok(_) => {}
            Err(e) => eprintln!("[minotes] event compaction failed: {e}"),
        }
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

/// How long the event log keeps a change, and therefore how long the content of
/// a deleted or edited block keeps its whiteboard/attachment alive after the
/// block is gone (GC). Generous on purpose: the frontend's session undo restores
/// deleted blocks from its own snapshot (`restore_blocks`), and a board or file
/// it points at must still exist then — a session is far shorter than this.
/// Pages in the Trash need no horizon: their blocks keep their rows, so their
/// content protects what it references until the Trash is emptied.
pub const EVENT_HORIZON_DAYS: i64 = 30;

/// The oldest moment still inside [`EVENT_HORIZON_DAYS`].
pub fn event_horizon_start() -> DateTime<Utc> {
    Utc::now() - chrono::Duration::days(EVENT_HORIZON_DAYS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn backdate_all(db: &Database, days: i64) {
        let t = (Utc::now() - chrono::Duration::days(days)).to_rfc3339();
        db.conn.execute("UPDATE events SET created_at = ?1", [t]).unwrap();
    }

    fn count(db: &Database, sql: &str) -> i64 {
        db.conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    // Delete events are emitted only after the delete succeeds.
    #[test]
    fn test_delete_block_event_after_delete() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("P", None, false, None, "user").unwrap();
        let a = db.create_block(&page.id, "A", None, None, "user").unwrap();
        db.conn
            .execute_batch("CREATE TRIGGER boom BEFORE DELETE ON blocks BEGIN SELECT RAISE(ABORT, 'x'); END;")
            .unwrap();
        assert!(db.delete_block(&a.id, "user").is_err());
        assert_eq!(count(&db, "SELECT COUNT(*) FROM events WHERE event_type = 'block.deleted'"), 0);
    }

    // Compaction drops events older than the horizon and never one inside it,
    // even when asked to (older_than = now).
    #[test]
    fn test_compact_events_respects_horizon() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page("Old", None, false, None, "user").unwrap();
        db.create_block(&p.id, "x", None, None, "user").unwrap();
        backdate_all(&db, EVENT_HORIZON_DAYS + 5);
        let q = db.create_page("New", None, false, None, "user").unwrap();
        db.create_block(&q.id, "y", None, None, "user").unwrap();
        let total = count(&db, "SELECT COUNT(*) FROM events");

        let n = db.compact_events(Utc::now()).unwrap();
        assert_eq!(n, 2, "only the two backdated events go");
        assert_eq!(count(&db, "SELECT COUNT(*) FROM events"), total - 2);
        assert_eq!(db.compact_events(Utc::now()).unwrap(), 0, "idempotent");
        // A caller with an older sync marker keeps even more.
        backdate_all(&db, EVENT_HORIZON_DAYS + 1);
        assert_eq!(db.compact_events(Utc::now() - chrono::Duration::days(EVENT_HORIZON_DAYS + 2)).unwrap(), 0);
    }

    // Sync's change detection still works after compaction: a block deletion
    // (visible only through the event log) since the last sync is detected.
    #[test]
    fn test_sync_detects_changes_after_compaction() {
        let db = Database::open_in_memory().unwrap();
        let old = db.create_page("Old", None, false, None, "user").unwrap();
        db.create_block(&old.id, "ancient", None, None, "user").unwrap();
        let p = db.create_page("P", None, false, None, "user").unwrap();
        let b = db.create_block(&p.id, "goes away", None, None, "user").unwrap();
        backdate_all(&db, EVENT_HORIZON_DAYS + 10);
        // Make the rows look old too, so only the event can reveal the delete.
        let long_ago = (Utc::now() - chrono::Duration::days(EVENT_HORIZON_DAYS + 10)).to_rfc3339();
        db.conn.execute("UPDATE pages SET updated_at = ?1", [&long_ago]).unwrap();
        db.conn.execute("UPDATE blocks SET updated_at = ?1", [&long_ago]).unwrap();

        let last_sync = Utc::now() - chrono::Duration::hours(1);
        db.delete_block(&b.id, "user").unwrap();
        db.conn.execute("UPDATE pages SET updated_at = ?1", [&long_ago]).unwrap();

        assert!(db.compact_events(Utc::now()).unwrap() > 0);
        let modified = db.pages_modified_since(last_sync, "sync").unwrap();
        assert!(modified.contains(&p.id), "deleted block still marks its page modified");
        assert!(!modified.contains(&old.id));
    }
}
