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
        let key = validate_property_key(key)?;
        let key = key.as_str();
        self.check_property_entity(entity_id, entity_type)?;
        let value_type = self.checked_value_type(key, value, value_type)?;
        let value_type = value_type.as_str();

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
        let count = self.conn.execute(
            "DELETE FROM properties WHERE entity_id = ?1 AND key = ?2",
            rusqlite::params![entity_id.to_string(), key],
        )?;
        // Emit only after the delete succeeds, and only if a row actually went
        // away — emitting first (or unconditionally) logged deletions that never
        // happened, corrupting the event/undo log. Mirrors remove_alias.
        if count > 0 {
            self.emit_event(
                "property.deleted",
                entity_id,
                "property",
                &serde_json::json!({"entity_id": entity_id.to_string(), "key": key}),
                actor,
            )?;
        }
        Ok(count > 0)
    }
}

/// Entity kinds a property can hang off.
pub const PROPERTY_ENTITY_TYPES: &[&str] = &["page", "block"];

/// Accepted `value_type`s. `text`/`string` are synonyms; `checkbox` is a boolean.
pub const PROPERTY_VALUE_TYPES: &[&str] = &[
    "text", "string", "number", "date", "boolean", "checkbox", "url", "email", "select", "tag",
    "page",
];

const MAX_PROPERTY_KEY_LEN: usize = 128;

/// A property key as stored: trimmed, non-empty, single-line, no `::` (the
/// inline `key:: value` separator), at most 128 characters.
pub fn validate_property_key(key: &str) -> Result<String> {
    let key = key.trim();
    if key.is_empty() {
        return Err(Error::InvalidInput("Property key cannot be empty".into()));
    }
    if key.chars().count() > MAX_PROPERTY_KEY_LEN {
        return Err(Error::InvalidInput(format!(
            "Property key is too long (max {MAX_PROPERTY_KEY_LEN} characters)"
        )));
    }
    if key.chars().any(char::is_control) {
        return Err(Error::InvalidInput(
            "Property key cannot contain line breaks or control characters".into(),
        ));
    }
    if key.contains("::") {
        return Err(Error::InvalidInput(format!("Property key '{key}' cannot contain '::'")));
    }
    Ok(key.to_string())
}

/// Does `value` parse as `value_type`? Untyped kinds (text, url, tag, …) accept anything.
fn value_matches_type(value: &str, value_type: &str) -> bool {
    let v = value.trim();
    match value_type {
        "number" => v.parse::<f64>().is_ok_and(f64::is_finite),
        "date" => {
            chrono::NaiveDate::parse_from_str(v, "%Y-%m-%d").is_ok()
                || chrono::DateTime::parse_from_rfc3339(v).is_ok()
        }
        "boolean" | "checkbox" => matches!(v, "true" | "false"),
        _ => true,
    }
}

impl Database {
    fn check_property_entity(&self, entity_id: &Uuid, entity_type: &str) -> Result<()> {
        if !PROPERTY_ENTITY_TYPES.contains(&entity_type) {
            return Err(Error::InvalidInput(format!(
                "Unknown entity type '{entity_type}' (expected page or block)"
            )));
        }
        let id = entity_id.to_string();
        let exists = |table: &str| -> Result<bool> {
            Ok(self.conn.query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id = ?1)"),
                rusqlite::params![id],
                |r| r.get::<_, bool>(0),
            )?)
        };
        let (table, other_table, label, other_label) = if entity_type == "page" {
            ("pages", "blocks", "Page", "block")
        } else {
            ("blocks", "pages", "Block", "page")
        };
        if exists(table)? {
            return Ok(());
        }
        if exists(other_table)? {
            return Err(Error::InvalidInput(format!(
                "{entity_id} is a {other_label}, not a {entity_type}"
            )));
        }
        Err(Error::NotFound(format!("{label} {entity_id}")))
    }

    /// The value type to store, checked against the key's declared schema (if
    /// any) and the value. An untyped `text` request adopts the schema's type.
    fn checked_value_type(&self, key: &str, value: &str, value_type: &str) -> Result<String> {
        if !PROPERTY_VALUE_TYPES.contains(&value_type) {
            return Err(Error::InvalidInput(format!(
                "Unknown property value type '{value_type}' (expected one of: {})",
                PROPERTY_VALUE_TYPES.join(", ")
            )));
        }
        let schema: Option<(String, Option<String>)> = self
            .conn
            .query_row(
                "SELECT value_type, options FROM property_schemas WHERE name = ?1",
                rusqlite::params![key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })?;
        let mut effective = value_type.to_string();
        if let Some((declared, options)) = schema {
            if value_type == "text" || value_type == "string" {
                effective = declared.clone();
            } else if declared != value_type && !matches!(declared.as_str(), "text" | "string") {
                return Err(Error::InvalidInput(format!(
                    "Property '{key}' is declared as {declared}, not {value_type}"
                )));
            }
            if effective == "select" {
                if let Some(opts) = options.as_deref().map(parse_options).filter(|o| !o.is_empty()) {
                    if !opts.iter().any(|o| o == value.trim()) {
                        return Err(Error::InvalidInput(format!(
                            "'{value}' is not an allowed value for '{key}' (expected one of: {})",
                            opts.join(", ")
                        )));
                    }
                }
            }
        }
        if !value_matches_type(value, &effective) {
            let hint = match effective.as_str() {
                "date" => " (expected YYYY-MM-DD)",
                "boolean" | "checkbox" => " (expected true or false)",
                _ => "",
            };
            return Err(Error::InvalidInput(format!(
                "'{value}' is not a valid {effective} for '{key}'{hint}"
            )));
        }
        Ok(effective)
    }
}

/// Schema options: a JSON array of strings, or a comma-separated list.
fn parse_options(raw: &str) -> Vec<String> {
    if let Ok(v) = serde_json::from_str::<Vec<String>>(raw) {
        return v.into_iter().map(|s| s.trim().to_string()).collect();
    }
    raw.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
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

#[cfg(test)]
mod tests {
    use crate::db::Database;
    use uuid::Uuid;

    // delete_property used to emit "property.deleted" BEFORE the DELETE, and
    // unconditionally — logging deletions that never happened.
    #[test]
    fn test_delete_missing_property_emits_no_event() {
        let db = Database::open_in_memory().unwrap();
        let entity = Uuid::now_v7();

        let deleted = db.delete_property(&entity, "nope", "user").unwrap();
        assert!(!deleted, "deleting a missing key reports false");

        let events = db
            .get_events(None, Some(&["property.deleted"]), None)
            .unwrap();
        assert!(events.is_empty(), "no event for a delete that did nothing");
    }

    #[test]
    fn test_delete_existing_property_emits_one_event() {
        let db = Database::open_in_memory().unwrap();
        let entity = db.create_page("P", None, false, None, "user").unwrap().id;
        db.set_property(&entity, "page", "status", "draft", "text", "user")
            .unwrap();

        assert!(db.delete_property(&entity, "status", "user").unwrap());

        let events = db
            .get_events(None, Some(&["property.deleted"]), None)
            .unwrap();
        assert_eq!(events.len(), 1);

        // A second delete of the same key must not log another event.
        assert!(!db.delete_property(&entity, "status", "user").unwrap());
        let events = db
            .get_events(None, Some(&["property.deleted"]), None)
            .unwrap();
        assert_eq!(events.len(), 1, "no duplicate event for a no-op delete");
    }

    fn setup() -> (Database, Uuid, Uuid) {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("P", None, false, None, "user").unwrap();
        let block = db.create_block(&page.id, "a", None, None, "user").unwrap();
        (db, page.id, block.id)
    }

    fn err(r: crate::error::Result<crate::models::Property>) -> String {
        r.expect_err("expected an error").to_string()
    }

    #[test]
    fn test_set_property_validates_key() {
        let (db, page, _) = setup();
        assert!(err(db.set_property(&page, "page", "", "v", "text", "u")).contains("cannot be empty"));
        assert!(err(db.set_property(&page, "page", "   ", "v", "text", "u")).contains("cannot be empty"));
        assert!(err(db.set_property(&page, "page", "a\nb", "v", "text", "u")).contains("line breaks"));
        assert!(err(db.set_property(&page, "page", "a::b", "v", "text", "u")).contains("'::'"));
        assert!(err(db.set_property(&page, "page", &"k".repeat(129), "v", "text", "u")).contains("too long"));
        // Stored trimmed; ':' and spaces inside a key are fine (clipper uses `tag:x`).
        assert_eq!(db.set_property(&page, "page", "  due date ", "v", "text", "u").unwrap().key, "due date");
        db.set_property(&page, "page", "tag:rust", "rust", "tag", "u").unwrap();
        let keys: Vec<_> = db.get_properties(&page).unwrap().into_iter().map(|p| p.key).collect();
        assert_eq!(keys, ["due date", "tag:rust"]);
        // Empty VALUES stay allowed for untyped properties.
        db.set_property(&page, "page", "e", "", "text", "u").unwrap();
    }

    #[test]
    fn test_set_property_checks_entity() {
        let (db, page, block) = setup();
        let ghost = Uuid::now_v7();
        assert_eq!(err(db.set_property(&ghost, "block", "k", "v", "text", "u")), format!("Not found: Block {ghost}"));
        assert_eq!(err(db.set_property(&ghost, "page", "k", "v", "text", "u")), format!("Not found: Page {ghost}"));
        assert!(err(db.set_property(&block, "page", "k", "v", "text", "u")).contains("is a block, not a page"));
        assert!(err(db.set_property(&page, "block", "k", "v", "text", "u")).contains("is a page, not a block"));
        assert!(err(db.set_property(&block, "banana", "k", "v", "text", "u")).contains("Unknown entity type 'banana'"));
        assert!(db.get_properties(&block).unwrap().is_empty());
        assert!(db.get_properties(&ghost).unwrap().is_empty());
        db.set_property(&block, "block", "k", "v", "text", "u").unwrap();
    }

    #[test]
    fn test_set_property_checks_value_type() {
        let (db, page, _) = setup();
        db.set_property(&page, "page", "n", " 42.5 ", "number", "u").unwrap();
        db.set_property(&page, "page", "d", "2026-01-02", "date", "u").unwrap();
        db.set_property(&page, "page", "b", "true", "boolean", "u").unwrap();
        db.set_property(&page, "page", "c", "false", "checkbox", "u").unwrap();
        db.set_property(&page, "page", "w", "anything", "url", "u").unwrap();
        assert!(err(db.set_property(&page, "page", "bad", "not-a-number", "number", "u")).contains("not a valid number"));
        assert!(err(db.set_property(&page, "page", "bad", "NaN", "number", "u")).contains("not a valid number"));
        assert!(err(db.set_property(&page, "page", "bad", "2026-13-40", "date", "u")).contains("expected YYYY-MM-DD"));
        assert!(err(db.set_property(&page, "page", "bad", "yes", "boolean", "u")).contains("true or false"));
        assert!(err(db.set_property(&page, "page", "x", "v", "made-up-type", "u")).contains("Unknown property value type"));
        let keys: Vec<_> = db.get_properties(&page).unwrap().into_iter().map(|p| p.key).collect();
        assert_eq!(keys, ["b", "c", "d", "n", "w"]);
    }

    #[test]
    fn test_set_property_follows_declared_schema() {
        let (db, page, _) = setup();
        db.define_property_schema("rating", "number", None, false, None, None, "u").unwrap();
        db.define_property_schema("status", "select", Some(r#"["todo","done"]"#), false, None, None, "u").unwrap();
        db.define_property_schema("size", "select", Some("S, M, L"), false, None, None, "u").unwrap();
        // An untyped ("text") write adopts the declared type…
        assert_eq!(db.set_property(&page, "page", "rating", "5", "text", "u").unwrap().value_type, "number");
        // …and is validated against it.
        assert!(err(db.set_property(&page, "page", "rating", "five", "text", "u")).contains("not a valid number"));
        assert!(err(db.set_property(&page, "page", "rating", "2026-01-01", "date", "u")).contains("declared as number, not date"));
        db.set_property(&page, "page", "status", "done", "text", "u").unwrap();
        assert!(err(db.set_property(&page, "page", "status", "maybe", "select", "u")).contains("not an allowed value"));
        db.set_property(&page, "page", "size", "M", "text", "u").unwrap();
        assert!(err(db.set_property(&page, "page", "size", "XL", "text", "u")).contains("S, M, L"));
    }
}
