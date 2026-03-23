use chrono::Utc;
use uuid::Uuid;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::models::{PropertySchema, Class};

impl Database {
    // ── Property Schemas ──

    pub fn define_property_schema(
        &self,
        name: &str,
        value_type: &str,
        options: Option<&str>,
        required: bool,
        default_val: Option<&str>,
        class_name: Option<&str>,
        actor: &str,
    ) -> Result<PropertySchema> {
        let now = Utc::now();
        let id = Uuid::now_v7();

        self.conn.execute(
            "INSERT INTO property_schemas (id, name, value_type, options, required, default_val, class_name, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(name) DO UPDATE SET value_type = ?3, options = ?4, required = ?5, default_val = ?6, class_name = ?7",
            rusqlite::params![
                id.to_string(), name, value_type, options,
                required as i32, default_val, class_name, now.to_rfc3339(),
            ],
        )?;

        Ok(PropertySchema {
            id,
            name: name.to_string(),
            value_type: value_type.to_string(),
            options: options.map(String::from),
            required,
            default_val: default_val.map(String::from),
            class_name: class_name.map(String::from),
            created_at: now,
        })
    }

    pub fn list_property_schemas(&self, class_name: Option<&str>) -> Result<Vec<PropertySchema>> {
        let mut schemas = Vec::new();
        if let Some(cn) = class_name {
            let mut stmt = self.conn.prepare(
                "SELECT id, name, value_type, options, required, default_val, class_name, created_at
                 FROM property_schemas WHERE class_name = ?1 ORDER BY name",
            )?;
            let rows = stmt.query_map(rusqlite::params![cn], |row| row_to_schema(row))?;
            for row in rows {
                schemas.push(row.map_err(Error::Database)?);
            }
        } else {
            let mut stmt = self.conn.prepare(
                "SELECT id, name, value_type, options, required, default_val, class_name, created_at
                 FROM property_schemas ORDER BY name",
            )?;
            let rows = stmt.query_map([], |row| row_to_schema(row))?;
            for row in rows {
                schemas.push(row.map_err(Error::Database)?);
            }
        }
        Ok(schemas)
    }

    pub fn delete_property_schema(&self, name: &str) -> Result<bool> {
        let count = self.conn.execute(
            "DELETE FROM property_schemas WHERE name = ?1",
            rusqlite::params![name],
        )?;
        Ok(count > 0)
    }

    // ── Classes ──

    pub fn create_class(
        &self,
        name: &str,
        parent_class: Option<&str>,
        description: Option<&str>,
        actor: &str,
    ) -> Result<Class> {
        let now = Utc::now();
        let id = Uuid::now_v7();

        self.conn.execute(
            "INSERT INTO classes (id, name, parent_class, description, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                id.to_string(), name, parent_class, description, now.to_rfc3339(),
            ],
        )?;

        Ok(Class {
            id,
            name: name.to_string(),
            parent_class: parent_class.map(String::from),
            description: description.map(String::from),
            created_at: now,
        })
    }

    pub fn list_classes(&self) -> Result<Vec<Class>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, parent_class, description, created_at FROM classes ORDER BY name",
        )?;
        let rows = stmt.query_map([], |row| row_to_class(row))?;
        let mut classes = Vec::new();
        for row in rows {
            classes.push(row.map_err(Error::Database)?);
        }
        Ok(classes)
    }

    pub fn delete_class(&self, name: &str) -> Result<bool> {
        let count = self.conn.execute(
            "DELETE FROM classes WHERE name = ?1",
            rusqlite::params![name],
        )?;
        // Also remove schemas tied to this class
        self.conn.execute(
            "DELETE FROM property_schemas WHERE class_name = ?1",
            rusqlite::params![name],
        )?;
        Ok(count > 0)
    }

    /// Get all pages that have a property "class" matching the given class name.
    pub fn list_class_instances(&self, class_name: &str) -> Result<Vec<crate::models::Page>> {
        let mut stmt = self.conn.prepare(
            "SELECT p.id, p.title, p.icon, p.folder_id, p.position, p.is_journal, p.journal_date, p.created_at, p.updated_at
             FROM pages p
             JOIN properties pr ON pr.entity_id = p.id AND pr.key = 'class' AND pr.value = ?1
             ORDER BY p.title",
        )?;
        let rows = stmt.query_map(rusqlite::params![class_name], |row| {
            let id_str: String = row.get(0)?;
            let folder_str: Option<String> = row.get(3)?;
            let journal_date_str: Option<String> = row.get(6)?;
            let created_str: String = row.get(7)?;
            let updated_str: String = row.get(8)?;
            Ok(crate::models::Page {
                id: Uuid::parse_str(&id_str).unwrap_or_default(),
                title: row.get(1)?,
                icon: row.get(2)?,
                folder_id: folder_str.and_then(|s| Uuid::parse_str(&s).ok()),
                position: row.get(4)?,
                is_journal: row.get::<_, i32>(5)? != 0,
                journal_date: journal_date_str
                    .and_then(|s| chrono::NaiveDate::parse_from_str(&s, "%Y-%m-%d").ok()),
                created_at: chrono::DateTime::parse_from_rfc3339(&created_str)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now()),
                updated_at: chrono::DateTime::parse_from_rfc3339(&updated_str)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now()),
            })
        })?;
        let mut pages = Vec::new();
        for row in rows {
            pages.push(row.map_err(Error::Database)?);
        }
        Ok(pages)
    }
}

fn row_to_schema(row: &rusqlite::Row<'_>) -> rusqlite::Result<PropertySchema> {
    let id_str: String = row.get(0)?;
    let created_str: String = row.get(7)?;
    Ok(PropertySchema {
        id: Uuid::parse_str(&id_str).unwrap_or_default(),
        name: row.get(1)?,
        value_type: row.get(2)?,
        options: row.get(3)?,
        required: row.get::<_, i32>(4)? != 0,
        default_val: row.get(5)?,
        class_name: row.get(6)?,
        created_at: chrono::DateTime::parse_from_rfc3339(&created_str)
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now()),
    })
}

fn row_to_class(row: &rusqlite::Row<'_>) -> rusqlite::Result<Class> {
    let id_str: String = row.get(0)?;
    let created_str: String = row.get(4)?;
    Ok(Class {
        id: Uuid::parse_str(&id_str).unwrap_or_default(),
        name: row.get(1)?,
        parent_class: row.get(2)?,
        description: row.get(3)?,
        created_at: chrono::DateTime::parse_from_rfc3339(&created_str)
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now()),
    })
}
