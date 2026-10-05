use std::path::Path;

use std::sync::atomic::{AtomicU64, Ordering};

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
    -- v2 migration adds: undone INTEGER NOT NULL DEFAULT 0
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

CREATE TABLE IF NOT EXISTS plugins (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    version     TEXT NOT NULL DEFAULT '0.1.0',
    description TEXT,
    author      TEXT,
    enabled     INTEGER NOT NULL DEFAULT 1,
    permissions TEXT,
    config      TEXT,
    entry_point TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plugin_storage (
    plugin_name TEXT NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT,
    PRIMARY KEY(plugin_name, key)
);

CREATE TABLE IF NOT EXISTS highlights (
    id          TEXT PRIMARY KEY,
    pdf_path    TEXT NOT NULL,
    page_num    INTEGER NOT NULL,
    x           REAL NOT NULL,
    y           REAL NOT NULL,
    width       REAL NOT NULL,
    height      REAL NOT NULL,
    color       TEXT NOT NULL DEFAULT 'yellow',
    text        TEXT,
    note        TEXT,
    block_id    TEXT REFERENCES blocks(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_highlights_pdf ON highlights(pdf_path);

CREATE TABLE IF NOT EXISTS sync_state (
    page_id     TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
    doc_bytes   BLOB NOT NULL,
    peer_state  BLOB,
    last_sync   TEXT,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS css_snippets (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    css         TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    source      TEXT NOT NULL DEFAULT 'custom',
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trash (
    page_id     TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
    deleted_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS folder_trash (
    folder_id   TEXT PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE,
    deleted_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS archive (
    page_id     TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
    archived_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS folder_archive (
    folder_id   TEXT PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE,
    archived_at TEXT NOT NULL
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

    /// Run `f` atomically inside a SQLite SAVEPOINT.
    ///
    /// On `Ok` the savepoint is RELEASEd (committing if it was the outermost
    /// transaction); on `Err` (or a panic) it is rolled back so no partial state
    /// is left behind. Savepoints nest correctly, so repo functions that call
    /// each other (e.g. `trash_folder` → `remove_favorite`) can each use `tx`,
    /// and it also composes with an outer `BEGIN`/savepoint opened by a caller.
    pub fn tx<T>(&self, f: impl FnOnce() -> Result<T>) -> Result<T> {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let name = format!("minotes_sp_{}", COUNTER.fetch_add(1, Ordering::Relaxed));
        self.conn.execute_batch(&format!("SAVEPOINT {name}"))?;
        let mut guard = SavepointGuard { conn: &self.conn, name: &name, done: false };
        match f() {
            Ok(v) => {
                self.conn.execute_batch(&format!("RELEASE {name}"))?;
                guard.done = true;
                Ok(v)
            }
            Err(e) => {
                guard.rollback();
                Err(e)
            }
        }
    }

    /// Execute a read-only SQL query and return results as JSON.
    /// Only a single read-only SELECT-style statement is allowed.
    pub fn run_query(&self, sql: &str) -> Result<serde_json::Value> {
        use crate::error::Error;
        let trimmed = sql.trim();

        // All checks below are LEXICAL and happen before any `prepare`: some
        // PRAGMAs (e.g. `foreign_keys=OFF`) take effect at compile time, so even
        // preparing a statement to inspect it is unsafe.
        if first_keyword(trimmed).is_empty() {
            return Err(Error::InvalidInput("Empty query".to_string()));
        }
        if has_multiple_statements(trimmed) {
            return Err(Error::InvalidInput(
                "Only a single statement is allowed".to_string(),
            ));
        }

        // `sqlite3_stmt_readonly()` is true for transaction-control statements,
        // ATTACH/DETACH and connection-state PRAGMAs, which can leave the shared
        // connection in an open transaction or create arbitrary files. Reject them
        // by leading keyword before trusting `readonly()`.
        // Look through `EXPLAIN [QUERY PLAN]`: pragmas apply at compile time even
        // under EXPLAIN.
        let mut body = trimmed;
        let mut keyword = first_keyword(body).to_ascii_uppercase();
        while keyword == "EXPLAIN" || keyword == "QUERY" || keyword == "PLAN" {
            body = first_keyword_rest(body);
            keyword = first_keyword(body).to_ascii_uppercase();
        }
        let trimmed_body = body;
        const FORBIDDEN: &[&str] = &[
            "BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE", "ATTACH",
            "DETACH", "VACUUM", "REINDEX", "ANALYZE",
        ];
        if FORBIDDEN.contains(&keyword.as_str()) {
            return Err(Error::InvalidInput(format!("{keyword} statements are not allowed")));
        }
        if keyword == "PRAGMA" && !is_safe_pragma(trimmed_body) {
            return Err(Error::InvalidInput(
                "Only read-only introspection PRAGMAs are allowed".to_string(),
            ));
        }
        if !self.conn.is_autocommit() {
            return Err(Error::InvalidInput(
                "Cannot run queries while a transaction is open".to_string(),
            ));
        }

        let stmt = self.conn.prepare(trimmed)?;
        // Bug #27: ask SQLite whether the prepared statement is actually read-only,
        // instead of a string-prefix check (which both rejects legitimate read-only
        // `WITH`/`EXPLAIN` queries and is an unsound allowlist). `readonly()` is true
        // only for statements that cannot modify the database.
        if !stmt.readonly() {
            return Err(crate::error::Error::InvalidInput(
                "Only read-only queries are allowed".to_string(),
            ));
        }

        let mut stmt = stmt;
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
        drop(stmt);
        // Belt and braces: whatever slipped past the checks above must not leave
        // the shared connection inside a transaction.
        if !self.conn.is_autocommit() {
            let _ = self.conn.execute_batch("ROLLBACK");
            return Err(crate::error::Error::InvalidInput(
                "Query left a transaction open; rolled back".to_string(),
            ));
        }

        Ok(serde_json::json!({
            "columns": col_names,
            "rows": results,
        }))
    }

    fn init(&self) -> Result<()> {
        self.conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        self.conn.execute_batch("PRAGMA synchronous=FULL;")?;
        self.conn.execute_batch("PRAGMA foreign_keys=ON;")?;
        self.conn.execute_batch("PRAGMA cache_size=-20000;")?;   // 20 MB
        self.conn.execute_batch("PRAGMA mmap_size=134217728;")?; // 128 MB
        self.conn.execute_batch("PRAGMA temp_store=MEMORY;")?;
        self.conn.execute_batch("PRAGMA busy_timeout=5000;")?;  // 5s
        self.conn.execute_batch(SCHEMA)?;
        self.conn.execute_batch(FTS_SCHEMA)?;
        self.run_migrations()?;
        self.migrate_whiteboards()?;
        Ok(())
    }

    /// Sequential schema migrations. Each migration runs once per database,
    /// in order, gated by `PRAGMA user_version`. Add new migrations to the
    /// end of this list with the next sequential version number; never
    /// renumber or remove existing entries.
    fn run_migrations(&self) -> Result<()> {
        const MIGRATIONS: &[(i64, &str)] = &[
            // v1: initial baseline — schema above is canonical, nothing to do.
            (1, ""),
            // v2: undone flag on events so undo doesn't destroy history.
            (2, "ALTER TABLE events ADD COLUMN undone INTEGER NOT NULL DEFAULT 0;"),
            // v3: indexes for case-insensitive title/alias link resolution and
            // highlight→block lookups. Idempotent.
            (3, "CREATE INDEX IF NOT EXISTS idx_pages_title_nocase ON pages(title COLLATE NOCASE);
                 CREATE INDEX IF NOT EXISTS idx_aliases_alias_nocase ON page_aliases(alias COLLATE NOCASE);
                 CREATE INDEX IF NOT EXISTS idx_highlights_block ON highlights(block_id);"),
        ];

        let current: i64 = self
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap_or(0);

        for &(version, sql) in MIGRATIONS {
            if version > current {
                if !sql.is_empty() {
                    self.conn.execute_batch(sql)?;
                }
                self.conn
                    .execute_batch(&format!("PRAGMA user_version = {version};"))?;
            }
        }
        Ok(())
    }
}

/// Rolls a savepoint back on drop unless it was released (covers panics too).
struct SavepointGuard<'a> {
    conn: &'a Connection,
    name: &'a str,
    done: bool,
}

impl SavepointGuard<'_> {
    fn rollback(&mut self) {
        if !self.done {
            self.done = true;
            // Errors ignored: SQLite may already have rolled the whole txn back
            // (e.g. SQLITE_FULL), in which case the savepoint no longer exists.
            let _ = self
                .conn
                .execute_batch(&format!("ROLLBACK TO {0}; RELEASE {0}", self.name));
        }
    }
}

impl Drop for SavepointGuard<'_> {
    fn drop(&mut self) {
        self.rollback();
    }
}

/// First SQL keyword, skipping leading whitespace and `--` / `/* */` comments.
fn first_keyword(sql: &str) -> &str {
    let mut s = sql;
    loop {
        s = s.trim_start();
        if let Some(rest) = s.strip_prefix("--") {
            s = rest.split_once('\n').map(|(_, r)| r).unwrap_or("");
        } else if let Some(rest) = s.strip_prefix("/*") {
            s = rest.split_once("*/").map(|(_, r)| r).unwrap_or("");
        } else {
            break;
        }
    }
    let end = s
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or(s.len());
    &s[..end]
}

/// True if `sql` contains a top-level `;` followed by anything other than
/// whitespace, comments or further semicolons. Understands string literals,
/// quoted identifiers and comments so `SELECT ';'` is a single statement.
fn has_multiple_statements(sql: &str) -> bool {
    let b = sql.as_bytes();
    let mut i = 0;
    let mut seen_end = false;
    while i < b.len() {
        let c = b[i];
        match c {
            b'-' if b.get(i + 1) == Some(&b'-') => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
                continue;
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i < b.len() && !(b[i] == b'*' && b.get(i + 1) == Some(&b'/')) {
                    i += 1;
                }
                i += 2;
                continue;
            }
            _ if c.is_ascii_whitespace() => {}
            b';' => seen_end = true,
            _ if seen_end => return true,
            b'\'' | b'"' | b'`' | b'[' => {
                let close = if c == b'[' { b']' } else { c };
                i += 1;
                while i < b.len() {
                    if b[i] == close {
                        // Doubled quote is an escape inside the literal.
                        if close != b']' && b.get(i + 1) == Some(&close) {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    false
}

/// PRAGMAs that only read schema/metadata and never change connection or DB state.
fn is_safe_pragma(sql: &str) -> bool {
    if sql.contains('=') {
        return false;
    }
    const SAFE: &[&str] = &[
        "table_info", "table_xinfo", "table_list", "index_list", "index_info",
        "index_xinfo", "foreign_key_list", "foreign_key_check", "integrity_check",
        "quick_check", "user_version", "schema_version", "page_count", "page_size",
        "freelist_count", "compile_options", "function_list", "pragma_list",
        "collation_list", "database_list",
    ];
    let lower = sql.to_ascii_lowercase();
    let after = first_keyword_rest(&lower);
    let name_part = after
        .split(|c: char| c == '(' || c == ';' || c.is_whitespace())
        .next()
        .unwrap_or("");
    // Allow an optional `schema.` qualifier.
    let name = name_part.rsplit('.').next().unwrap_or("");
    // Argument-taking forms are fine for the introspection pragmas above except
    // user_version/schema_version (setter form uses `=`, already rejected).
    SAFE.contains(&name)
}

/// Text after the first keyword (comments skipped), left-trimmed.
fn first_keyword_rest(sql: &str) -> &str {
    let kw = first_keyword(sql);
    // `first_keyword` returns a subslice of `sql`; compute its end offset.
    let start = kw.as_ptr() as usize - sql.as_ptr() as usize;
    sql[start + kw.len()..].trim_start()
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

    #[test]
    fn test_run_query_allows_select() {
        let db = Database::open_in_memory().unwrap();
        let r = db.run_query("SELECT 1 AS one").unwrap();
        assert_eq!(r["rows"][0]["one"], 1);
        assert!(db.run_query("WITH x AS (SELECT 2 AS v) SELECT v FROM x;").is_ok());
        assert!(db.run_query("PRAGMA table_info(pages)").is_ok());
        assert!(db.run_query("SELECT 1; ").is_ok(), "trailing semicolon is fine");
    }

    #[test]
    fn test_run_query_rejects_transaction_control() {
        let db = Database::open_in_memory().unwrap();
        for sql in [
            "BEGIN", "begin transaction", "  -- c\nBEGIN IMMEDIATE", "/* x */ BEGIN",
            "COMMIT", "END", "ROLLBACK", "SAVEPOINT x", "RELEASE x", "VACUUM",
        ] {
            assert!(db.run_query(sql).is_err(), "{sql} must be rejected");
            assert!(db.conn.is_autocommit(), "{sql} left a transaction open");
        }
        // A later edit is durable (not trapped in a dangling transaction).
        db.create_page("After", None, false, None, "user").unwrap();
        assert!(db.conn.is_autocommit());
    }

    #[test]
    fn test_run_query_rejects_attach_detach() {
        let dir = std::env::temp_dir().join(format!("minotes_attach_{}.db", std::process::id()));
        let path = dir.to_string_lossy().to_string();
        let db = Database::open_in_memory().unwrap();
        assert!(db.run_query(&format!("ATTACH DATABASE '{path}' AS evil")).is_err());
        assert!(!dir.exists(), "ATTACH must not create files");
        assert!(db.run_query("DETACH DATABASE evil").is_err());
    }

    #[test]
    fn test_run_query_rejects_state_pragmas_and_writes() {
        let db = Database::open_in_memory().unwrap();
        assert!(db.run_query("PRAGMA foreign_keys=OFF").is_err());
        assert!(db.run_query("PRAGMA foreign_keys(0)").is_err());
        assert!(db.run_query("PRAGMA journal_mode = DELETE").is_err());
        assert!(db.run_query("PRAGMA user_version = 99").is_err());
        assert!(db.run_query("DELETE FROM pages").is_err());
        assert!(db.run_query("EXPLAIN PRAGMA foreign_keys=OFF").is_err());
        assert!(db.run_query("EXPLAIN QUERY PLAN BEGIN").is_err());
        assert!(db.run_query("EXPLAIN QUERY PLAN SELECT * FROM pages").is_ok());
        let fk: i64 = db.conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap();
        assert_eq!(fk, 1);
    }

    #[test]
    fn test_run_query_rejects_multiple_statements() {
        let db = Database::open_in_memory().unwrap();
        assert!(db.run_query("SELECT 1; DELETE FROM pages").is_err());
        assert!(db.run_query("SELECT 1; BEGIN").is_err());
        assert!(db.run_query("SELECT 1; PRAGMA foreign_keys=OFF").is_err());
        let fk: i64 = db.conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap();
        assert_eq!(fk, 1, "second statement must never be compiled");
        assert!(db.run_query("").is_err());
        assert!(db.run_query("-- only a comment").is_err());
        assert!(db.run_query("SELECT ';' AS s -- trailing ; comment").is_ok());
        assert!(db.conn.is_autocommit());
    }

    #[test]
    fn test_tx_rolls_back_on_error_and_nests() {
        let db = Database::open_in_memory().unwrap();
        let r: Result<()> = db.tx(|| {
            db.create_page("A", None, false, None, "user")?;
            Err(crate::error::Error::InvalidInput("boom".into()))
        });
        assert!(r.is_err());
        assert!(db.get_page_by_title("A").unwrap().is_none());
        assert!(db.conn.is_autocommit());

        // Inner failure caught by the outer closure: only the inner work is undone.
        db.tx(|| {
            db.create_page("Outer", None, false, None, "user")?;
            let inner: Result<()> = db.tx(|| {
                db.create_page("Inner", None, false, None, "user")?;
                Err(crate::error::Error::InvalidInput("inner".into()))
            });
            assert!(inner.is_err());
            Ok(())
        })
        .unwrap();
        assert!(db.get_page_by_title("Outer").unwrap().is_some());
        assert!(db.get_page_by_title("Inner").unwrap().is_none());
        assert!(db.conn.is_autocommit());
    }
}
