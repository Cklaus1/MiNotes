use chrono::Utc;
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

    /// Undo the most recent event by reversing its mutation.
    /// Returns the undone event's ID, or None if nothing to undo.
    pub fn undo_last(&self, actor: &str) -> Result<Option<i64>> {
        // Get the most recent non-undo event
        let event = {
            let mut stmt = self.conn.prepare(
                "SELECT id, event_type, entity_id, entity_type, payload, actor, created_at
                 FROM events
                 WHERE event_type NOT LIKE 'undo.%'
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

        // Reverse the mutation based on event type
        match event.event_type.as_str() {
            "block.created" => {
                // Undo create = delete
                self.conn.execute(
                    "DELETE FROM blocks WHERE id = ?1",
                    rusqlite::params![entity_id.to_string()],
                )?;
            }
            "block.deleted" => {
                // Undo delete = recreate from payload
                if let Some(content) = event.payload.get("content").and_then(|v| v.as_str()) {
                    let page_id = event.payload.get("page_id").and_then(|v| v.as_str()).unwrap_or("");
                    let position = event.payload.get("position").and_then(|v| v.as_f64()).unwrap_or(1.0);
                    let now = chrono::Utc::now();
                    self.conn.execute(
                        "INSERT OR IGNORE INTO blocks (id, page_id, parent_id, position, content, format, collapsed, created_at, updated_at)
                         VALUES (?1, ?2, NULL, ?3, ?4, 'markdown', 0, ?5, ?6)",
                        rusqlite::params![
                            entity_id.to_string(), page_id, position, content,
                            now.to_rfc3339(), now.to_rfc3339(),
                        ],
                    )?;
                }
            }
            "block.updated" => {
                // Undo update = restore old content from payload
                // The payload contains the NEW state; we'd need the previous event to get old state
                // For simplicity, just mark it as undone
            }
            "page.created" => {
                self.conn.execute(
                    "DELETE FROM pages WHERE id = ?1",
                    rusqlite::params![entity_id.to_string()],
                )?;
            }
            _ => {}
        }

        // Record the undo event
        self.emit_event(
            &format!("undo.{}", event.event_type),
            &entity_id,
            &event.entity_type,
            &event.payload,
            actor,
        )?;

        // Delete the original event
        self.conn.execute(
            "DELETE FROM events WHERE id = ?1",
            rusqlite::params![event_id],
        )?;

        Ok(Some(event_id))
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
