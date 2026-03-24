use chrono::Utc;
use uuid::Uuid;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::models::Property;

impl Database {
    pub fn set_property(
        &self,
        entity_id: &Uuid,
        entity_type: &str,
        key: &str,
        value: &str,
        value_type: &str,
        actor: &str,
    ) -> Result<Property> {
        let now = Utc::now();
        let id = Uuid::now_v7();

        // Upsert: insert or update on conflict
        self.conn.execute(
            "INSERT INTO properties (id, entity_id, entity_type, key, value, value_type, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(entity_id, key) DO UPDATE SET value = ?5, value_type = ?6, updated_at = ?8",
            rusqlite::params![
                id.to_string(),
                entity_id.to_string(),
                entity_type,
                key,
                value,
                value_type,
                now.to_rfc3339(),
                now.to_rfc3339(),
            ],
        )?;

        let prop = Property {
            id,
            entity_id: *entity_id,
            entity_type: entity_type.to_string(),
            key: key.to_string(),
            value: Some(value.to_string()),
            value_type: value_type.to_string(),
            created_at: now,
            updated_at: now,
        };

        self.emit_event("property.set", entity_id, "property", &prop, actor)?;
        Ok(prop)
    }

    pub fn get_properties(&self, entity_id: &Uuid) -> Result<Vec<Property>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, entity_id, entity_type, key, value, value_type, created_at, updated_at
             FROM properties WHERE entity_id = ?1 ORDER BY key",
        )?;
        let rows = stmt.query_map(rusqlite::params![entity_id.to_string()], |row| {
            row_to_property(row)
        })?;
        let mut props = Vec::new();
        for row in rows {
            props.push(row.map_err(Error::Database)?);
        }
        Ok(props)
    }

    /// Get properties for a block including inherited properties from parent blocks.
    /// Walks up the parent_id chain collecting properties. Child properties override parent ones.
    pub fn get_inherited_properties(&self, block_id: &Uuid) -> Result<Vec<Property>> {
        let mut all_props: std::collections::HashMap<String, Property> = std::collections::HashMap::new();
        let mut current_id = Some(*block_id);
        let mut depth = 0;

        while let Some(id) = current_id {
            if depth > 20 { break; } // Safety limit

            let props = self.get_properties(&id)?;
            for prop in props {
                // Only insert if not already set by a child (child overrides parent)
                if !all_props.contains_key(&prop.key) {
                    all_props.insert(prop.key.clone(), prop);
                }
            }

            // Walk up to parent
            let parent: Option<String> = self.conn.query_row(
                "SELECT parent_id FROM blocks WHERE id = ?1",
                rusqlite::params![id.to_string()],
                |row| row.get(0),
            ).ok().flatten();

            current_id = parent.and_then(|p| Uuid::parse_str(&p).ok());
            depth += 1;
        }

        let mut result: Vec<Property> = all_props.into_values().collect();
        result.sort_by(|a, b| a.key.cmp(&b.key));
        Ok(result)
    }

    pub fn delete_property(&self, entity_id: &Uuid, key: &str, actor: &str) -> Result<bool> {
        self.emit_event(
            "property.deleted",
            entity_id,
            "property",
            &serde_json::json!({"entity_id": entity_id.to_string(), "key": key}),
            actor,
        )?;
        let count = self.conn.execute(
            "DELETE FROM properties WHERE entity_id = ?1 AND key = ?2",
            rusqlite::params![entity_id.to_string(), key],
        )?;
        Ok(count > 0)
    }
}

fn row_to_property(row: &rusqlite::Row<'_>) -> rusqlite::Result<Property> {
    let id_str: String = row.get(0)?;
    let entity_id_str: String = row.get(1)?;
    let created_str: String = row.get(6)?;
    let updated_str: String = row.get(7)?;

    Ok(Property {
        id: Uuid::parse_str(&id_str).unwrap_or_default(),
        entity_id: Uuid::parse_str(&entity_id_str).unwrap_or_default(),
        entity_type: row.get(2)?,
        key: row.get(3)?,
        value: row.get(4)?,
        value_type: row.get(5)?,
        created_at: chrono::DateTime::parse_from_rfc3339(&created_str)
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .unwrap_or_else(|_| chrono::Utc::now()),
        updated_at: chrono::DateTime::parse_from_rfc3339(&updated_str)
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .unwrap_or_else(|_| chrono::Utc::now()),
    })
}
