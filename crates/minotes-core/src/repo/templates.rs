use chrono::Utc;
use uuid::Uuid;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::models::{Block, Template};

impl Database {
    /// Create a new template.
    pub fn create_template(
        &self,
        name: &str,
        description: Option<&str>,
        content: &str,
        actor: &str,
    ) -> Result<Template> {
        let now = Utc::now();
        let id = Uuid::now_v7();

        self.conn.execute(
            "INSERT INTO templates (id, name, description, content, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                id.to_string(),
                name,
                description,
                content,
                now.to_rfc3339(),
                now.to_rfc3339(),
            ],
        ).map_err(|e| match e {
            rusqlite::Error::SqliteFailure(_, _) => {
                Error::AlreadyExists(format!("Template '{name}'"))
            }
            other => Error::Database(other),
        })?;

        let template = Template {
            id,
            name: name.to_string(),
            description: description.map(String::from),
            content: content.to_string(),
            created_at: now,
            updated_at: now,
        };

        self.emit_event("template.created", &template.id, "template", &template, actor)?;
        Ok(template)
    }

    /// Get a template by name.
    pub fn get_template(&self, name: &str) -> Result<Option<Template>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, description, content, created_at, updated_at FROM templates WHERE name = ?1",
        )?;
        let mut rows = stmt.query(rusqlite::params![name])?;
        match rows.next()? {
            Some(row) => Ok(Some(row_to_template(row)?)),
            None => Ok(None),
        }
    }

    /// List all templates.
    pub fn list_templates(&self) -> Result<Vec<Template>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, description, content, created_at, updated_at FROM templates ORDER BY name",
        )?;
        let rows = stmt.query_map([], |row| row_to_template_sqlite(row))?;

        let mut templates = Vec::new();
        for row in rows {
            templates.push(row.map_err(Error::Database)?);
        }
        Ok(templates)
    }

    /// Delete a template by name. Returns true if found and deleted.
    pub fn delete_template(&self, name: &str, actor: &str) -> Result<bool> {
        let template = self.get_template(name)?;
        if let Some(ref t) = template {
            self.emit_event("template.deleted", &t.id, "template", t, actor)?;
        }
        let count = self.conn.execute(
            "DELETE FROM templates WHERE name = ?1",
            rusqlite::params![name],
        )?;
        Ok(count > 0)
    }

    /// Apply a template to a page: split template content by newlines, each line becomes a block.
    pub fn apply_template(
        &self,
        page_id: &Uuid,
        template_name: &str,
        actor: &str,
    ) -> Result<Vec<Block>> {
        let template = self
            .get_template(template_name)?
            .ok_or_else(|| Error::NotFound(format!("Template '{template_name}'")))?;

        let lines: Vec<&str> = template.content.lines().collect();
        let mut blocks = Vec::new();

        for line in lines {
            if line.trim().is_empty() {
                continue;
            }
            let block = self.create_block(page_id, line, None, None, actor)?;
            blocks.push(block);
        }

        self.emit_event(
            "template.applied",
            page_id,
            "page",
            &serde_json::json!({ "template": template_name, "blocks_created": blocks.len() }),
            actor,
        )?;

        Ok(blocks)
    }
}

fn row_to_template(row: &rusqlite::Row<'_>) -> crate::error::Result<Template> {
    Ok(row_to_template_sqlite(row)?)
}

fn row_to_template_sqlite(row: &rusqlite::Row<'_>) -> rusqlite::Result<Template> {
    let id_str: String = row.get(0)?;
    let created_str: String = row.get(4)?;
    let updated_str: String = row.get(5)?;

    Ok(Template {
        id: Uuid::parse_str(&id_str).unwrap_or_default(),
        name: row.get(1)?,
        description: row.get(2)?,
        content: row.get(3)?,
        created_at: chrono::DateTime::parse_from_rfc3339(&created_str)
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now()),
        updated_at: chrono::DateTime::parse_from_rfc3339(&updated_str)
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now()),
    })
}

#[cfg(test)]
mod tests {
    use crate::db::Database;

    #[test]
    fn test_create_and_get_template() {
        let db = Database::open_in_memory().unwrap();
        let t = db
            .create_template("Meeting", Some("Meeting notes"), "## Agenda\n## Notes\n## Actions", "user")
            .unwrap();
        assert_eq!(t.name, "Meeting");

        let fetched = db.get_template("Meeting").unwrap().unwrap();
        assert_eq!(fetched.name, "Meeting");
        assert_eq!(fetched.description.as_deref(), Some("Meeting notes"));
    }

    #[test]
    fn test_list_templates() {
        let db = Database::open_in_memory().unwrap();
        db.create_template("A", None, "content a", "user").unwrap();
        db.create_template("B", None, "content b", "user").unwrap();
        let list = db.list_templates().unwrap();
        assert_eq!(list.len(), 2);
    }

    #[test]
    fn test_delete_template() {
        let db = Database::open_in_memory().unwrap();
        db.create_template("Del", None, "x", "user").unwrap();
        assert!(db.delete_template("Del", "user").unwrap());
        assert!(db.get_template("Del").unwrap().is_none());
    }

    #[test]
    fn test_apply_template() {
        let db = Database::open_in_memory().unwrap();
        db.create_template("T", None, "Line 1\nLine 2\nLine 3", "user")
            .unwrap();
        let page = db.create_page("P", None, false, None, "user").unwrap();
        let blocks = db.apply_template(&page.id, "T", "user").unwrap();
        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[0].content, "Line 1");
    }

    #[test]
    fn test_duplicate_template_name() {
        let db = Database::open_in_memory().unwrap();
        db.create_template("Dup", None, "x", "user").unwrap();
        assert!(db.create_template("Dup", None, "y", "user").is_err());
    }
}
