use chrono::Utc;
use uuid::Uuid;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::models::Plugin;

impl Database {
    pub fn register_plugin(
        &self,
        name: &str,
        version: &str,
        description: Option<&str>,
        author: Option<&str>,
        permissions: Option<&str>,
        entry_point: Option<&str>,
        actor: &str,
    ) -> Result<Plugin> {
        let now = Utc::now();
        let id = Uuid::now_v7();

        self.conn.execute(
            "INSERT INTO plugins (id, name, version, description, author, enabled, permissions, config, entry_point, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, NULL, ?7, ?8, ?9)",
            rusqlite::params![
                id.to_string(),
                name,
                version,
                description,
                author,
                permissions,
                entry_point,
                now.to_rfc3339(),
                now.to_rfc3339(),
            ],
        )?;

        let plugin = Plugin {
            id,
            name: name.to_string(),
            version: version.to_string(),
            description: description.map(String::from),
            author: author.map(String::from),
            enabled: true,
            permissions: permissions.map(String::from),
            config: None,
            entry_point: entry_point.map(String::from),
            created_at: now,
            updated_at: now,
        };

        self.emit_event("plugin.registered", &plugin.id, "plugin", &plugin, actor)?;
        Ok(plugin)
    }

    pub fn list_plugins(&self) -> Result<Vec<Plugin>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, version, description, author, enabled, permissions, config, entry_point, created_at, updated_at
             FROM plugins ORDER BY name",
        )?;
        let rows = stmt.query_map([], |row| row_to_plugin(row))?;
        let mut plugins = Vec::new();
        for row in rows {
            plugins.push(row.map_err(Error::Database)?);
        }
        Ok(plugins)
    }

    pub fn get_plugin(&self, name: &str) -> Result<Option<Plugin>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, version, description, author, enabled, permissions, config, entry_point, created_at, updated_at
             FROM plugins WHERE name = ?1",
        )?;
        let mut rows = stmt.query(rusqlite::params![name])?;
        match rows.next()? {
            Some(row) => Ok(Some(row_to_plugin(row)?)),
            None => Ok(None),
        }
    }

    pub fn enable_plugin(&self, name: &str) -> Result<Plugin> {
        let now = Utc::now();
        let count = self.conn.execute(
            "UPDATE plugins SET enabled = 1, updated_at = ?1 WHERE name = ?2",
            rusqlite::params![now.to_rfc3339(), name],
        )?;
        if count == 0 {
            return Err(Error::NotFound(format!("Plugin {name}")));
        }
        self.get_plugin(name)?
            .ok_or_else(|| Error::NotFound(format!("Plugin {name}")))
    }

    pub fn disable_plugin(&self, name: &str) -> Result<Plugin> {
        let now = Utc::now();
        let count = self.conn.execute(
            "UPDATE plugins SET enabled = 0, updated_at = ?1 WHERE name = ?2",
            rusqlite::params![now.to_rfc3339(), name],
        )?;
        if count == 0 {
            return Err(Error::NotFound(format!("Plugin {name}")));
        }
        self.get_plugin(name)?
            .ok_or_else(|| Error::NotFound(format!("Plugin {name}")))
    }

    pub fn update_plugin_config(&self, name: &str, config_json: &str) -> Result<Plugin> {
        let now = Utc::now();
        let count = self.conn.execute(
            "UPDATE plugins SET config = ?1, updated_at = ?2 WHERE name = ?3",
            rusqlite::params![config_json, now.to_rfc3339(), name],
        )?;
        if count == 0 {
            return Err(Error::NotFound(format!("Plugin {name}")));
        }
        self.get_plugin(name)?
            .ok_or_else(|| Error::NotFound(format!("Plugin {name}")))
    }

    pub fn uninstall_plugin(&self, name: &str) -> Result<bool> {
        // Clean up plugin storage
        self.conn.execute(
            "DELETE FROM plugin_storage WHERE plugin_name = ?1",
            rusqlite::params![name],
        )?;
        let count = self.conn.execute(
            "DELETE FROM plugins WHERE name = ?1",
            rusqlite::params![name],
        )?;
        Ok(count > 0)
    }

    // ── Plugin Storage ──

    pub fn plugin_storage_set(&self, plugin_name: &str, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO plugin_storage (plugin_name, key, value) VALUES (?1, ?2, ?3)
             ON CONFLICT(plugin_name, key) DO UPDATE SET value = excluded.value",
            rusqlite::params![plugin_name, key, value],
        )?;
        Ok(())
    }

    pub fn plugin_storage_get(&self, plugin_name: &str, key: &str) -> Result<Option<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT value FROM plugin_storage WHERE plugin_name = ?1 AND key = ?2",
        )?;
        let mut rows = stmt.query(rusqlite::params![plugin_name, key])?;
        match rows.next()? {
            Some(row) => Ok(row.get(0)?),
            None => Ok(None),
        }
    }

    pub fn plugin_storage_delete(&self, plugin_name: &str, key: &str) -> Result<bool> {
        let count = self.conn.execute(
            "DELETE FROM plugin_storage WHERE plugin_name = ?1 AND key = ?2",
            rusqlite::params![plugin_name, key],
        )?;
        Ok(count > 0)
    }
}

fn row_to_plugin(row: &rusqlite::Row<'_>) -> rusqlite::Result<Plugin> {
    let id_str: String = row.get(0)?;
    let created_str: String = row.get(9)?;
    let updated_str: String = row.get(10)?;

    Ok(Plugin {
        id: uuid::Uuid::parse_str(&id_str).unwrap_or_default(),
        name: row.get(1)?,
        version: row.get(2)?,
        description: row.get(3)?,
        author: row.get(4)?,
        enabled: row.get::<_, i32>(5)? != 0,
        permissions: row.get(6)?,
        config: row.get(7)?,
        entry_point: row.get(8)?,
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

    #[test]
    fn test_register_and_list_plugins() {
        let db = Database::open_in_memory().unwrap();
        let p = db
            .register_plugin("word-count", "1.0.0", Some("Counts words"), Some("Alice"), None, None, "user")
            .unwrap();
        assert_eq!(p.name, "word-count");
        assert!(p.enabled);

        let all = db.list_plugins().unwrap();
        assert_eq!(all.len(), 1);
    }

    #[test]
    fn test_enable_disable_plugin() {
        let db = Database::open_in_memory().unwrap();
        db.register_plugin("my-plugin", "0.1.0", None, None, None, None, "user").unwrap();

        let disabled = db.disable_plugin("my-plugin").unwrap();
        assert!(!disabled.enabled);

        let enabled = db.enable_plugin("my-plugin").unwrap();
        assert!(enabled.enabled);
    }

    #[test]
    fn test_update_config_and_uninstall() {
        let db = Database::open_in_memory().unwrap();
        db.register_plugin("cfg-test", "0.1.0", None, None, None, None, "user").unwrap();

        let updated = db.update_plugin_config("cfg-test", r#"{"theme":"dark"}"#).unwrap();
        assert_eq!(updated.config.as_deref(), Some(r#"{"theme":"dark"}"#));

        let removed = db.uninstall_plugin("cfg-test").unwrap();
        assert!(removed);

        let gone = db.get_plugin("cfg-test").unwrap();
        assert!(gone.is_none());
    }

    #[test]
    fn test_plugin_storage() {
        let db = Database::open_in_memory().unwrap();
        db.register_plugin("store-test", "0.1.0", None, None, None, None, "user").unwrap();

        db.plugin_storage_set("store-test", "counter", "42").unwrap();
        let val = db.plugin_storage_get("store-test", "counter").unwrap();
        assert_eq!(val.as_deref(), Some("42"));

        db.plugin_storage_set("store-test", "counter", "43").unwrap();
        let val = db.plugin_storage_get("store-test", "counter").unwrap();
        assert_eq!(val.as_deref(), Some("43"));

        let deleted = db.plugin_storage_delete("store-test", "counter").unwrap();
        assert!(deleted);

        let gone = db.plugin_storage_get("store-test", "counter").unwrap();
        assert!(gone.is_none());
    }

    #[test]
    fn test_uninstall_cleans_storage() {
        let db = Database::open_in_memory().unwrap();
        db.register_plugin("cleanup-test", "0.1.0", None, None, None, None, "user").unwrap();
        db.plugin_storage_set("cleanup-test", "key1", "val1").unwrap();

        db.uninstall_plugin("cleanup-test").unwrap();

        let val = db.plugin_storage_get("cleanup-test", "key1").unwrap();
        assert!(val.is_none());
    }
}
