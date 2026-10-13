use std::path::Path;

use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::Connection;

use crate::crypto::DataKey;
use crate::error::{Error, Result};

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
    tokenize='unicode61 remove_diacritics 2'
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
    // ── Import / attachments ──
    /// Where this database's attachment store lives when it can't be derived
    /// from the file path (in-memory databases, tests). See `attachments_dir`.
    pub(crate) attachments_override: std::cell::RefCell<Option<std::path::PathBuf>>,
    /// Opened with a data key (SQLCipher). Attachments then live inside the
    /// database, never as files (PRD-encryption §4.5).
    pub(crate) encrypted: bool,
    // ── End import ──
}

impl Database {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        let db = Self { conn, attachments_override: Default::default(), encrypted: false };
        db.init()?;
        Ok(db)
    }

    /// Open an existing database without writing to it (a notebook another
    /// MiNotes instance has open). No schema setup or migrations run, and
    /// `query_only` makes any write fail instead of changing the file.
    pub fn open_read_only(path: &Path) -> Result<Self> {
        Self::open_read_only_with_timeout(path, 5000)
    }

    /// [`open_read_only`](Self::open_read_only) with a chosen busy timeout (ms).
    /// Cross-notebook search uses a short one: a notebook that is busy is skipped,
    /// not waited for.
    pub fn open_read_only_with_timeout(path: &Path, busy_timeout_ms: u32) -> Result<Self> {
        use rusqlite::OpenFlags;
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.execute_batch(&format!(
            "PRAGMA busy_timeout={busy_timeout_ms}; PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;"
        ))?;
        Ok(Self { conn, attachments_override: Default::default(), encrypted: false })
    }

    /// Was this database opened with a data key (an encrypted notebook)?
    pub fn is_encrypted(&self) -> bool {
        self.encrypted
    }

    /// Is this connection read-only (see [`open_read_only`](Self::open_read_only))?
    pub fn is_read_only(&self) -> bool {
        self.conn
            .query_row("PRAGMA query_only", [], |r| r.get::<_, i64>(0))
            .map(|v| v != 0)
            .unwrap_or(false)
    }

    /// Open an existing encrypted (SQLCipher) database with its data key.
    ///
    /// The key is handed to SQLCipher before the first statement, and the file is
    /// opened without `SQLITE_OPEN_CREATE`: a wrong path must not become an empty
    /// new database. A key that does not match is [`Error::KeyMismatch`] — the
    /// passphrase itself was already checked by the key slot (`crypto`).
    pub fn open_encrypted(path: &Path, key: &DataKey) -> Result<Self> {
        use rusqlite::OpenFlags;
        if !path.is_file() {
            return Err(Error::NotFound(format!("{} not found", path.display())));
        }
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        apply_key(&conn, key)?;
        let db = Self { conn, attachments_override: Default::default(), encrypted: true };
        db.init()?;
        Ok(db)
    }

    /// Create a new encrypted database at `path` (which must not exist).
    pub fn create_encrypted(path: &Path, key: &DataKey) -> Result<Self> {
        if path.exists() {
            return Err(Error::AlreadyExists(format!("{} already exists", path.display())));
        }
        let conn = Connection::open(path)?;
        apply_key(&conn, key)?;
        let db = Self { conn, attachments_override: Default::default(), encrypted: true };
        db.init()?;
        Ok(db)
    }

    /// [`open_read_only_with_timeout`](Self::open_read_only_with_timeout) for an
    /// encrypted database.
    pub fn open_read_only_encrypted(path: &Path, key: &DataKey, busy_timeout_ms: u32) -> Result<Self> {
        use rusqlite::OpenFlags;
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        apply_key(&conn, key)?;
        conn.execute_batch(&format!(
            "PRAGMA busy_timeout={busy_timeout_ms}; PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY;"
        ))?;
        Ok(Self { conn, attachments_override: Default::default(), encrypted: true })
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        let db = Self { conn, attachments_override: Default::default(), encrypted: false };
        db.init()?;
        Ok(db)
    }

    /// Run `f` atomically.
    ///
    /// The OUTERMOST call (the connection is in autocommit mode) opens a
    /// `BEGIN IMMEDIATE` transaction: it takes the write lock up front, so a
    /// body that reads before it writes can't be failed by another connection
    /// committing in between. (A deferred transaction has to upgrade its read
    /// snapshot to a write lock, and in WAL mode that fails at once with
    /// `SQLITE_BUSY_SNAPSHOT` — `busy_timeout` doesn't apply.) Waiting for the
    /// lock honours `busy_timeout` plus a bounded retry of the `BEGIN` alone
    /// (see [`begin_immediate`](Self::begin_immediate)); `f` never re-runs.
    ///
    /// Nested calls (and calls inside a transaction a caller opened with `BEGIN`)
    /// use a SAVEPOINT, so repo functions that call each other (e.g.
    /// `trash_folder` → `remove_favorite`) can each use `tx`.
    ///
    /// On `Ok` the transaction is committed / the savepoint RELEASEd; on `Err`
    /// (or a panic) it is rolled back so no partial state is left behind.
    pub fn tx<T>(&self, f: impl FnOnce() -> Result<T>) -> Result<T> {
        if self.conn.is_autocommit() {
            self.begin_immediate()?;
            let mut guard = TxGuard { conn: &self.conn, kind: TxKind::Outer, done: false };
            return match f() {
                Ok(v) => {
                    self.conn.execute_batch("COMMIT")?; // on failure the guard rolls back
                    guard.done = true;
                    Ok(v)
                }
                Err(e) => {
                    guard.rollback();
                    Err(e)
                }
            };
        }
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let name = format!("minotes_sp_{}", COUNTER.fetch_add(1, Ordering::Relaxed));
        self.conn.execute_batch(&format!("SAVEPOINT {name}"))?;
        let mut guard = TxGuard { conn: &self.conn, kind: TxKind::Savepoint(&name), done: false };
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

    /// Begin the outermost transaction of [`tx`](Self::tx).
    ///
    /// `BEGIN IMMEDIATE` waits up to `busy_timeout` for another writer. If it
    /// still reports busy (a long writer, or SQLite returning busy without
    /// calling the busy handler, e.g. during WAL recovery) it is retried a
    /// bounded number of times. Only the `BEGIN` is retried — nothing has run
    /// yet, so that is always safe; a transaction body is never re-run.
    ///
    /// A read-only connection can't take the write lock and only reads, so it
    /// gets a deferred `BEGIN`.
    fn begin_immediate(&self) -> Result<()> {
        const MAX_ATTEMPTS: u32 = 3;
        const MAX_TOTAL: std::time::Duration = std::time::Duration::from_secs(12);
        if self.conn.is_readonly(rusqlite::MAIN_DB).unwrap_or(false) {
            self.conn.execute_batch("BEGIN DEFERRED")?;
            return Ok(());
        }
        let started = std::time::Instant::now();
        let mut attempt = 1;
        loop {
            match self.conn.execute_batch("BEGIN IMMEDIATE") {
                Ok(()) => return Ok(()),
                Err(e) if is_busy(&e) && attempt < MAX_ATTEMPTS && started.elapsed() < MAX_TOTAL => {
                    std::thread::sleep(std::time::Duration::from_millis(50 * u64::from(attempt)));
                    attempt += 1;
                }
                Err(e) => return Err(e.into()),
            }
        }
    }

    /// Execute a read-only SQL query and return results as JSON.
    /// Only a single read-only SELECT-style statement is allowed.
    pub fn run_query(&self, sql: &str) -> Result<serde_json::Value> {
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
        // First: even switching to WAL needs a lock, and must wait for another
        // connection instead of failing with "database is locked".
        self.conn.execute_batch("PRAGMA busy_timeout=5000;")?;  // 5s
        self.conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        self.conn.execute_batch("PRAGMA synchronous=FULL;")?;
        self.conn.execute_batch("PRAGMA foreign_keys=ON;")?;
        self.conn.execute_batch("PRAGMA cache_size=-20000;")?;   // 20 MB
        self.conn.execute_batch("PRAGMA mmap_size=134217728;")?; // 128 MB
        self.conn.execute_batch("PRAGMA temp_store=MEMORY;")?;
        // Schema code (triggers, views, defaults) may only use innocuous
        // functions/virtual tables: a database file can come from elsewhere
        // (an imported zip, a synced folder). The FTS5 triggers still work.
        self.conn.execute_batch("PRAGMA trusted_schema=OFF;")?;
        self.conn.execute_batch(SCHEMA)?;
        self.conn.execute_batch(FTS_SCHEMA)?;
        self.run_migrations()?;
        self.migrate_whiteboards()?;
        self.migrate_notebook_links()?;
        // ── Import / attachments ──
        self.migrate_attachments()?;
        self.migrate_import_runs()?;
        // ── End import ──
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
            // v4: (a) search matches word PREFIXES while typing; the porter stemmer
            // broke that (`runn` matched nothing: `running` was indexed as `run`),
            // so the FTS index is rebuilt with plain unicode61 (accents still
            // folded). (b) a trashed page whose title is taken by a new page keeps
            // its original title here, for display and restore.
            (4, "DROP TABLE IF EXISTS blocks_fts;
                 CREATE VIRTUAL TABLE blocks_fts USING fts5(
                     content, content='blocks', content_rowid='rowid',
                     tokenize='unicode61 remove_diacritics 2');
                 INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild');
                 ALTER TABLE trash ADD COLUMN original_title TEXT;"),
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

/// `SQLITE_BUSY` with any extended code (`_SNAPSHOT`, `_RECOVERY`, `_TIMEOUT`).
pub(crate) fn is_busy(e: &rusqlite::Error) -> bool {
    matches!(e, rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::DatabaseBusy)
}

enum TxKind<'a> {
    /// The `BEGIN IMMEDIATE` transaction of an outermost `tx`.
    Outer,
    Savepoint(&'a str),
}

/// Rolls a transaction / savepoint back on drop unless it was committed /
/// released (covers panics too).
struct TxGuard<'a> {
    conn: &'a Connection,
    kind: TxKind<'a>,
    done: bool,
}

impl TxGuard<'_> {
    fn rollback(&mut self) {
        if !self.done {
            self.done = true;
            // Errors ignored: SQLite may already have rolled the whole txn back
            // (e.g. SQLITE_FULL), in which case there is nothing left to undo.
            let _ = match self.kind {
                TxKind::Outer => self.conn.execute_batch("ROLLBACK"),
                TxKind::Savepoint(name) => {
                    self.conn.execute_batch(&format!("ROLLBACK TO {name}; RELEASE {name}"))
                }
            };
        }
    }
}

impl Drop for TxGuard<'_> {
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

/// Key a fresh connection (before any other statement) and prove the key reads
/// the file. Uses `sqlite3_key_v2` with SQLCipher's raw-key literal `x'…'` from a
/// zeroizing buffer — no SQL text with the key in it.
pub(crate) fn apply_key(conn: &Connection, key: &DataKey) -> Result<()> {
    let lit = key.sqlcipher_literal();
    let rc = unsafe {
        rusqlite::ffi::sqlite3_key_v2(
            conn.handle(),
            c"main".as_ptr(),
            lit.as_ptr() as *const std::ffi::c_void,
            lit.len() as std::ffi::c_int,
        )
    };
    if rc != rusqlite::ffi::SQLITE_OK {
        return Err(Error::InvalidInput(format!("Could not set the database key (code {rc})")));
    }
    // SQLCipher only notices a wrong key on the first read.
    match conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0)) {
        Ok(_) => Ok(()),
        Err(rusqlite::Error::SqliteFailure(f, _)) if f.code == rusqlite::ErrorCode::NotADatabase => {
            Err(Error::KeyMismatch)
        }
        Err(e) => Err(e.into()),
    }
}

/// Is `path` a plain (unencrypted) SQLite file? A SQLCipher file starts with its
/// random salt instead of the `SQLite format 3` header. (An empty file is a new
/// plain database.)
pub fn is_plaintext_sqlite(path: &Path) -> bool {
    use std::io::Read;
    if std::fs::metadata(path).map(|m| m.len() == 0).unwrap_or(false) {
        return true;
    }
    let mut hdr = [0u8; 16];
    std::fs::File::open(path).and_then(|mut f| f.read_exact(&mut hdr)).is_ok() && &hdr == b"SQLite format 3\0"
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

    fn two_connections() -> (tempfile::TempDir, Database, Database) {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("c3.db");
        let a = Database::open(&path).unwrap();
        let b = Database::open(&path).unwrap();
        (tmp, a, b)
    }

    // C-3: A's transaction reads, B commits a write, A writes. With a deferred
    // transaction A's write failed at once with SQLITE_BUSY_SNAPSHOT; the
    // outermost tx now holds the write lock from BEGIN IMMEDIATE, so B waits
    // for A (busy_timeout) and both writes land.
    #[test]
    fn test_tx_read_then_write_survives_concurrent_commit() {
        let (_t, a, b) = two_connections();
        let page = a.create_page("P", None, false, None, "user").unwrap();
        let page_id = page.id;
        let b_path = b.conn.path().unwrap().to_string();
        drop(b);
        let (to_b, b_go) = std::sync::mpsc::channel::<()>();
        let (b_done_tx, b_done) = std::sync::mpsc::channel::<std::time::Duration>();
        let writer = std::thread::spawn(move || {
            let b = Database::open(Path::new(&b_path)).unwrap();
            b_go.recv().unwrap();
            let t0 = std::time::Instant::now();
            b.create_block(&page_id, "from B", None, None, "cli").unwrap();
            b_done_tx.send(t0.elapsed()).unwrap();
        });
        a.tx(|| {
            let n: i64 = a.conn.query_row("SELECT COUNT(*) FROM blocks", [], |r| r.get(0))?;
            assert_eq!(n, 0);
            to_b.send(()).unwrap();
            // Give B time to try its commit while A is between read and write.
            std::thread::sleep(std::time::Duration::from_millis(300));
            a.create_block(&page_id, "from A", None, None, "user")?;
            Ok(())
        })
        .expect("A's read-then-write must not fail with SQLITE_BUSY");
        let waited = b_done.recv().unwrap();
        writer.join().unwrap();
        assert!(waited >= std::time::Duration::from_millis(200), "B waited for A's lock: {waited:?}");
        let contents: Vec<String> = a.get_page_blocks(&page_id).unwrap().into_iter().map(|b| b.content).collect();
        assert_eq!(contents.len(), 2, "{contents:?}");
    }

    // The CLI-style scenario: another connection commits between the app's
    // edits; every next edit (a read-then-write tx) succeeds.
    #[test]
    fn test_concurrent_cli_writer_does_not_fail_app_edits() {
        let (_t, app, cli) = two_connections();
        let page = app.create_page("P", None, false, None, "user").unwrap();
        let blk = app.create_block(&page.id, "v0", None, None, "user").unwrap();
        for i in 0..20 {
            cli.create_block(&page.id, &format!("cli {i}"), None, None, "cli").unwrap();
            app.update_block(&blk.id, Some(&format!("v{}", i + 1)), "user").unwrap();
        }
        // Interleaved from two threads, too.
        let path = cli.conn.path().unwrap().to_string();
        let pid = page.id;
        let h = std::thread::spawn(move || {
            let c = Database::open(Path::new(&path)).unwrap();
            for i in 0..50 {
                c.create_block(&pid, &format!("t {i}"), None, None, "cli").unwrap();
            }
        });
        for i in 0..50 {
            app.update_block(&blk.id, Some(&format!("w{i}")), "user").unwrap();
        }
        h.join().unwrap();
        assert_eq!(app.get_page_blocks(&page.id).unwrap().len(), 71);
    }

    // A failed BEGIN IMMEDIATE (lock held past busy_timeout) runs nothing and
    // leaves the connection usable; a nested tx still uses a savepoint.
    #[test]
    fn test_tx_busy_begin_runs_nothing() {
        let (_t, a, b) = two_connections();
        a.conn.execute_batch("PRAGMA busy_timeout=50").unwrap();
        b.conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        let mut ran = false;
        let r: Result<()> = a.tx(|| {
            ran = true;
            Ok(())
        });
        assert!(matches!(&r, Err(crate::error::Error::Database(e)) if is_busy(e)), "{r:?}");
        assert!(!ran, "the body must not run without the lock");
        assert!(a.conn.is_autocommit());
        b.conn.execute_batch("COMMIT").unwrap();
        a.tx(|| {
            assert!(!a.conn.is_autocommit());
            a.tx(|| Ok(()))
        })
        .unwrap();
        assert!(a.conn.is_autocommit());
    }

    // Read-only connections (another instance's notebook) can still use tx for
    // reads, and have a busy timeout.
    #[test]
    fn test_read_only_tx_and_busy_timeout() {
        let (t, a, _b) = two_connections();
        a.create_page("P", None, false, None, "user").unwrap();
        let ro = Database::open_read_only(&t.path().join("c3.db")).unwrap();
        let n = ro.tx(|| Ok(ro.list_pages(None)?.len())).unwrap();
        assert_eq!(n, 1);
        let ms: i64 = ro.conn.query_row("PRAGMA busy_timeout", [], |r| r.get(0)).unwrap();
        assert_eq!(ms, 5000);
        let ms: i64 = a.conn.query_row("PRAGMA busy_timeout", [], |r| r.get(0)).unwrap();
        assert_eq!(ms, 5000);
    }

    // v4 migrates an existing v3 database: FTS rebuilt without porter (prefix
    // search works on existing blocks) and trash gains original_title.
    #[test]
    fn test_v4_migration_from_v3() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page("P", None, false, None, "user").unwrap();
        db.create_block(&p.id, "running late", None, None, "user").unwrap();
        db.conn
            .execute_batch(
                "DROP TABLE blocks_fts;
                 CREATE VIRTUAL TABLE blocks_fts USING fts5(content, content='blocks',
                     content_rowid='rowid', tokenize='porter unicode61');
                 INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild');
                 DROP TABLE trash;
                 CREATE TABLE trash (page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
                                     deleted_at TEXT NOT NULL);
                 PRAGMA user_version = 3;",
            )
            .unwrap();
        assert!(db.search("runn", None).unwrap().is_empty(), "porter index: prefix broken");
        db.run_migrations().unwrap();
        assert_eq!(db.search("runn", None).unwrap().len(), 1);
        db.trash_page(&p.id).unwrap();
        db.create_page("P", None, false, None, "user").unwrap();
        assert_eq!(db.list_trash().unwrap()[0].title, "P");
    }

    // ── Encryption (PRD-encryption §4.1) ──

    fn file_contains(path: &Path, needle: &[u8]) -> bool {
        std::fs::read(path).map(|b| b.windows(needle.len()).any(|w| w == needle)).unwrap_or(false)
    }

    #[test]
    fn encrypted_database_has_no_plaintext_on_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("enc.minotes");
        let key = DataKey::generate();
        {
            let db = Database::create_encrypted(&path, &key).unwrap();
            let p = db.create_page("Zebra Title Marker", None, false, None, "user").unwrap();
            db.create_block(&p.id, "quokka block marker", None, None, "user").unwrap();
            // Search (FTS5) works on the encrypted database.
            assert_eq!(db.search("quokka", None).unwrap().len(), 1);
            // While open: the WAL holds the recent pages — encrypted too.
            for f in ["enc.minotes", "enc.minotes-wal"] {
                for m in [&b"Zebra Title Marker"[..], b"quokka block marker"] {
                    assert!(!file_contains(&tmp.path().join(f), m), "{f} leaks {}", String::from_utf8_lossy(m));
                }
            }
        }
        assert!(!is_plaintext_sqlite(&path));
        for m in [&b"Zebra Title Marker"[..], b"quokka block marker"] {
            assert!(!file_contains(&path, m));
        }
        // Reopens with the key; the data and the schema version are there.
        let db = Database::open_encrypted(&path, &key).unwrap();
        assert_eq!(db.list_pages(Some(10)).unwrap()[0].title, "Zebra Title Marker");
        let v: i64 = db.conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert!(v >= 4);
    }

    #[test]
    fn wrong_key_is_a_key_mismatch_not_corruption() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("enc.minotes");
        drop(Database::create_encrypted(&path, &DataKey::generate()).unwrap());
        let e = Database::open_encrypted(&path, &DataKey::generate()).err().unwrap();
        assert!(matches!(e, Error::KeyMismatch), "{e:?}");
        assert!(Database::open_read_only_encrypted(&path, &DataKey::generate(), 100).is_err());
        // The plain opener cannot read it either (and does not damage it).
        assert!(Database::open(&path).is_err());
        assert!(!is_plaintext_sqlite(&path));
    }

    #[test]
    fn open_encrypted_never_creates_a_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("missing.minotes");
        assert!(matches!(Database::open_encrypted(&path, &DataKey::generate()), Err(Error::NotFound(_))));
        assert!(!path.exists());
        drop(Database::create_encrypted(&tmp.path().join("x"), &DataKey::generate()).unwrap());
        assert!(Database::create_encrypted(&tmp.path().join("x"), &DataKey::generate()).is_err());
    }

    #[test]
    fn plaintext_databases_are_unchanged_by_sqlcipher() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("plain.db");
        let db = Database::open(&path).unwrap();
        db.create_page("Plain page", None, false, None, "user").unwrap();
        drop(db);
        assert!(is_plaintext_sqlite(&path), "no key → standard SQLite format");
        // Opening a plaintext file with a key is a mismatch, not a silent re-key.
        assert!(matches!(Database::open_encrypted(&path, &DataKey::generate()), Err(Error::KeyMismatch)));
        assert!(is_plaintext_sqlite(&path));
        assert_eq!(Database::open(&path).unwrap().list_pages(Some(10)).unwrap().len(), 1);
    }

    #[test]
    fn read_only_encrypted_connection_reads_but_cannot_write() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("enc.minotes");
        let key = DataKey::generate();
        let db = Database::create_encrypted(&path, &key).unwrap();
        db.create_page("Readable", None, false, None, "user").unwrap();
        let ro = Database::open_read_only_encrypted(&path, &key, 1000).unwrap();
        assert_eq!(ro.list_pages(Some(10)).unwrap().len(), 1);
        assert!(ro.is_read_only());
        assert!(ro.create_page("Nope", None, false, None, "user").is_err());
    }

    #[test]
    fn run_query_refuses_key_pragmas() {
        let tmp = tempfile::tempdir().unwrap();
        let key = DataKey::generate();
        let db = Database::create_encrypted(&tmp.path().join("enc.minotes"), &key).unwrap();
        for q in [
            "PRAGMA key = 'x'",
            "PRAGMA rekey = 'x'",
            "PRAGMA hexkey = '00'",
            "PRAGMA cipher_compatibility = 3",
            "PRAGMA cipher_settings",
            "ATTACH DATABASE 'other.db' AS o KEY ''",
        ] {
            assert!(db.run_query(q).is_err(), "{q} must be refused");
        }
        // Still keyed and readable afterwards.
        assert!(db.run_query("SELECT count(*) AS n FROM pages").is_ok());
    }
}
