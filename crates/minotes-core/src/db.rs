use std::path::Path;

use rusqlite::Connection;

use crate::error::Result;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS folders (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    parent_id   TEXT REFERENCES folders(id) ON DELETE CASCADE,
    icon        TEXT,
    color       TEXT,
    position    REAL NOT NULL DEFAULT 0,
    collapsed   INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE(name, parent_id)
);

CREATE TABLE IF NOT EXISTS pages (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL UNIQUE,
    icon        TEXT,
    folder_id   TEXT REFERENCES folders(id) ON DELETE SET NULL,
    position    REAL NOT NULL DEFAULT 0,
    is_journal  INTEGER NOT NULL DEFAULT 0,
    journal_date TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blocks (
    id          TEXT PRIMARY KEY,
    page_id     TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    parent_id   TEXT REFERENCES blocks(id) ON DELETE SET NULL,
    position    REAL NOT NULL,
    content     TEXT NOT NULL,
    format      TEXT NOT NULL DEFAULT 'markdown',
    collapsed   INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS links (
    id          TEXT PRIMARY KEY,
    from_block  TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    to_page     TEXT REFERENCES pages(id) ON DELETE CASCADE,
    to_block    TEXT REFERENCES blocks(id) ON DELETE CASCADE,
    link_type   TEXT NOT NULL DEFAULT 'reference',
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS properties (
    id          TEXT PRIMARY KEY,
    entity_id   TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT,
    value_type  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE(entity_id, key)
);

CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type  TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    payload     TEXT NOT NULL,
    actor       TEXT NOT NULL DEFAULT 'user',
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
CREATE INDEX IF NOT EXISTS idx_pages_folder ON pages(folder_id);
CREATE INDEX IF NOT EXISTS idx_blocks_page_id ON blocks(page_id);
CREATE INDEX IF NOT EXISTS idx_blocks_parent_id ON blocks(parent_id);
CREATE INDEX IF NOT EXISTS idx_links_from_block ON links(from_block);
CREATE INDEX IF NOT EXISTS idx_links_to_page ON links(to_page);
CREATE INDEX IF NOT EXISTS idx_links_to_block ON links(to_block);
CREATE INDEX IF NOT EXISTS idx_properties_entity ON properties(entity_id);
CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);

CREATE TABLE IF NOT EXISTS cards (
    id          TEXT PRIMARY KEY,
    block_id    TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    card_type   TEXT NOT NULL DEFAULT 'basic',
    due         TEXT NOT NULL,
    stability   REAL NOT NULL DEFAULT 0.0,
    difficulty  REAL NOT NULL DEFAULT 0.0,
    reps        INTEGER NOT NULL DEFAULT 0,
    lapses      INTEGER NOT NULL DEFAULT 0,
    state       TEXT NOT NULL DEFAULT 'new',
    last_review TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(due);
CREATE INDEX IF NOT EXISTS idx_cards_block ON cards(block_id);

CREATE TABLE IF NOT EXISTS favorites (
    page_id     TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
    position    REAL NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS page_aliases (
    id          TEXT PRIMARY KEY,
    page_id     TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    alias       TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aliases_page ON page_aliases(page_id);

CREATE TABLE IF NOT EXISTS templates (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    description TEXT,
    content     TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS property_schemas (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    value_type  TEXT NOT NULL DEFAULT 'text',
    options     TEXT,
    required    INTEGER NOT NULL DEFAULT 0,
    default_val TEXT,
    class_name  TEXT,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schemas_class ON property_schemas(class_name);

CREATE TABLE IF NOT EXISTS classes (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    parent_class TEXT,
    description TEXT,
    created_at  TEXT NOT NULL
);
";

const FTS_SCHEMA: &str = "
CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
    content,
    content='blocks',
    content_rowid='rowid',
    tokenize='porter unicode61'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS blocks_ai AFTER INSERT ON blocks BEGIN
    INSERT INTO blocks_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS blocks_ad AFTER DELETE ON blocks BEGIN
    INSERT INTO blocks_fts(blocks_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS blocks_au AFTER UPDATE OF content ON blocks BEGIN
    INSERT INTO blocks_fts(blocks_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    INSERT INTO blocks_fts(rowid, content) VALUES (new.rowid, new.content);
END;
";

pub struct Database {
    pub conn: Connection,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        let db = Self { conn };
        db.init()?;
        Ok(db)
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        let db = Self { conn };
        db.init()?;
        Ok(db)
    }

    /// Execute a read-only SQL query and return results as JSON.
    /// Only SELECT statements are allowed.
    pub fn run_query(&self, sql: &str) -> Result<serde_json::Value> {
        let trimmed = sql.trim();
        if !trimmed.to_uppercase().starts_with("SELECT") {
            return Err(crate::error::Error::InvalidInput(
                "Only SELECT queries are allowed".to_string(),
            ));
        }

        let mut stmt = self.conn.prepare(trimmed)?;
        let col_count = stmt.column_count();
        let col_names: Vec<String> = (0..col_count)
            .map(|i| stmt.column_name(i).unwrap_or("?").to_string())
            .collect();

        let rows = stmt.query_map([], |row| {
            let mut obj = serde_json::Map::new();
            for i in 0..col_count {
                let val: rusqlite::types::Value = row.get(i)?;
                let json_val = match val {
                    rusqlite::types::Value::Null => serde_json::Value::Null,
                    rusqlite::types::Value::Integer(n) => serde_json::Value::Number(n.into()),
                    rusqlite::types::Value::Real(f) => {
                        serde_json::Number::from_f64(f)
                            .map(serde_json::Value::Number)
                            .unwrap_or(serde_json::Value::Null)
                    }
                    rusqlite::types::Value::Text(s) => serde_json::Value::String(s),
                    rusqlite::types::Value::Blob(b) => {
                        serde_json::Value::String(format!("<blob {} bytes>", b.len()))
                    }
                };
                obj.insert(col_names[i].clone(), json_val);
            }
            Ok(serde_json::Value::Object(obj))
        })?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(crate::error::Error::Database)?);
        }

        Ok(serde_json::json!({
            "columns": col_names,
            "rows": results,
        }))
    }

    fn init(&self) -> Result<()> {
        self.conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        self.conn.execute_batch("PRAGMA foreign_keys=ON;")?;
        self.conn.execute_batch(SCHEMA)?;
        self.conn.execute_batch(FTS_SCHEMA)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_open_in_memory() {
        let db = Database::open_in_memory().unwrap();
        let count: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn test_fts_table_exists() {
        let db = Database::open_in_memory().unwrap();
        let count: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'blocks_fts'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }
}
