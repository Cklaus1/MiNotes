use chrono::Utc;
use uuid::Uuid;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::models::CssSnippet;

impl Database {
    pub fn add_snippet(
        &self,
        name: &str,
        css: &str,
        source: &str,
        actor: &str,
    ) -> Result<CssSnippet> {
        let now = Utc::now();
        let id = Uuid::now_v7();

        self.conn.execute(
            "INSERT INTO css_snippets (id, name, css, enabled, source, created_at)
             VALUES (?1, ?2, ?3, 1, ?4, ?5)",
            rusqlite::params![
                id.to_string(),
                name,
                css,
                source,
                now.to_rfc3339(),
            ],
        )?;

        let snippet = CssSnippet {
            id,
            name: name.to_string(),
            css: css.to_string(),
            enabled: true,
            source: source.to_string(),
            created_at: now,
        };

        self.emit_event("snippet.created", &snippet.id, "css_snippet", &snippet, actor)?;
        Ok(snippet)
    }

    pub fn list_snippets(&self) -> Result<Vec<CssSnippet>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, css, enabled, source, created_at FROM css_snippets ORDER BY name",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(CssSnippet {
                id: row.get::<_, String>(0)?.parse().unwrap_or_default(),
                name: row.get(1)?,
                css: row.get(2)?,
                enabled: row.get::<_, i64>(3)? != 0,
                source: row.get(4)?,
                created_at: row
                    .get::<_, String>(5)?
                    .parse()
                    .unwrap_or_else(|_| Utc::now()),
            })
        })?;
        let mut result = Vec::new();
        for r in rows {
            result.push(r?);
        }
        Ok(result)
    }

    pub fn toggle_snippet(&self, name: &str) -> Result<CssSnippet> {
        let count = self.conn.execute(
            "UPDATE css_snippets SET enabled = CASE WHEN enabled = 1 THEN 0 ELSE 1 END WHERE name = ?1",
            rusqlite::params![name],
        )?;
        if count == 0 {
            return Err(Error::NotFound(format!("CSS snippet '{name}'")));
        }
        self.get_snippet_by_name(name)
    }

    pub fn delete_snippet(&self, name: &str) -> Result<bool> {
        let count = self.conn.execute(
            "DELETE FROM css_snippets WHERE name = ?1",
            rusqlite::params![name],
        )?;
        Ok(count > 0)
    }

    pub fn get_enabled_snippets(&self) -> Result<Vec<CssSnippet>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, css, enabled, source, created_at FROM css_snippets WHERE enabled = 1 ORDER BY name",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(CssSnippet {
                id: row.get::<_, String>(0)?.parse().unwrap_or_default(),
                name: row.get(1)?,
                css: row.get(2)?,
                enabled: row.get::<_, i64>(3)? != 0,
                source: row.get(4)?,
                created_at: row
                    .get::<_, String>(5)?
                    .parse()
                    .unwrap_or_else(|_| Utc::now()),
            })
        })?;
        let mut result = Vec::new();
        for r in rows {
            result.push(r?);
        }
        Ok(result)
    }

    pub fn update_snippet_css(&self, name: &str, css: &str) -> Result<CssSnippet> {
        let count = self.conn.execute(
            "UPDATE css_snippets SET css = ?1 WHERE name = ?2",
            rusqlite::params![css, name],
        )?;
        if count == 0 {
            return Err(Error::NotFound(format!("CSS snippet '{name}'")));
        }
        self.get_snippet_by_name(name)
    }

    fn get_snippet_by_name(&self, name: &str) -> Result<CssSnippet> {
        self.conn
            .query_row(
                "SELECT id, name, css, enabled, source, created_at FROM css_snippets WHERE name = ?1",
                rusqlite::params![name],
                |row| {
                    Ok(CssSnippet {
                        id: row.get::<_, String>(0)?.parse().unwrap_or_default(),
                        name: row.get(1)?,
                        css: row.get(2)?,
                        enabled: row.get::<_, i64>(3)? != 0,
                        source: row.get(4)?,
                        created_at: row
                            .get::<_, String>(5)?
                            .parse()
                            .unwrap_or_else(|_| Utc::now()),
                    })
                },
            )
            .map_err(|_| Error::NotFound(format!("CSS snippet '{name}'")))
    }
}
