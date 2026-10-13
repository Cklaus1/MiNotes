//! Cross-notebook search and links (PRD-notebooks §9 Q3).
//!
//! **Search.** Other notebooks are opened strictly read-only
//! ([`Database::open_read_only_with_timeout`]: `SQLITE_OPEN_READ_ONLY`, no schema
//! setup, no migrations, `query_only`, a short busy timeout) and never through the
//! notebook lock. Each is searched with the same FTS search as the open notebook,
//! capped per notebook and by a total time budget. Notebooks that can't be read
//! (folder missing, busy, locked, broken) are reported as [`Skipped`], never an
//! error.
//!
//! **Links.** `[[Notebook::Page title]]` (see [`crate::links::split_notebook_link`])
//! points at a page in another notebook, named by its registry name
//! (case-insensitive). Link sync records each one in the `notebook_links` table
//! with the target notebook's key and page id once they resolve, so renaming the
//! target page or notebook keeps the link working. Such links never create a row
//! in `links` (no local page, nothing in the local graph, no backlinks) and never
//! create a page anywhere. No cross-notebook backlinks in v1.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::models::{Block, Page};
use crate::notebook::{self, Notebook, NotebookInfo};

/// Block hits per notebook.
pub const DEFAULT_PER_NOTEBOOK: i64 = 10;
/// Page-title hits per notebook.
pub const DEFAULT_PAGE_MATCHES: i64 = 5;
/// Total time for searching the other notebooks; the rest are skipped.
pub const DEFAULT_BUDGET: Duration = Duration::from_millis(2500);
/// A notebook that is busy for longer than this is skipped, not waited for.
pub const BUSY_TIMEOUT_MS: u32 = 200;

// ── Opening another notebook ──

/// Why a notebook was left out of a cross-notebook search or link lookup.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    /// Its folder (or database) is missing: unplugged drive, moved folder.
    Unavailable,
    /// Encrypted and not unlocked ("not searchable while locked").
    Locked,
    /// Another program holds it exclusively.
    Busy,
    /// The database could not be read (damaged, not a MiNotes database, …).
    Error,
    /// The time budget ran out before it was searched.
    Timeout,
}

impl SkipReason {
    /// Short, user-facing reason: "Skipped: Work (not available)".
    pub fn label(&self) -> &'static str {
        match self {
            SkipReason::Unavailable => "not available",
            SkipReason::Locked => "locked",
            SkipReason::Busy => "busy",
            SkipReason::Error => "could not be read",
            SkipReason::Timeout => "took too long",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Skipped {
    pub notebook_key: String,
    pub notebook_name: String,
    pub reason: SkipReason,
    /// `reason.label()`, for clients that just print it.
    pub label: String,
    /// Technical detail (the SQLite error, …); may be empty.
    pub detail: String,
}

impl Skipped {
    fn new(nb: &Notebook, reason: SkipReason, detail: impl Into<String>) -> Skipped {
        Skipped {
            notebook_key: nb.key.clone(),
            notebook_name: nb.name.clone(),
            reason,
            label: reason.label().to_string(),
            detail: detail.into(),
        }
    }
}

/// Same database file? (Canonical paths when both exist.)
pub fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

/// Can another notebook read this one right now?
///
/// An encrypted notebook (PRD-encryption) is "not searchable while locked" — it is
/// skipped with [`SkipReason::Locked`] unless it is unlocked in this process (the
/// unlocked-key cache in [`crate::encryption`]).
pub fn readable(nb: &Notebook) -> std::result::Result<(), SkipReason> {
    if !nb.available() {
        return Err(SkipReason::Unavailable);
    }
    if let Some(root) = nb.root() {
        let encrypted = std::fs::read_to_string(root.join(notebook::META_FILE))
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .is_some_and(|v| v.get("encryption").is_some_and(|e| !e.is_null()));
        if encrypted && crate::encryption::unlocked_key(&nb.key).is_none() {
            return Err(SkipReason::Locked);
        }
    }
    Ok(())
}

fn classify(e: &Error) -> SkipReason {
    if let Error::Database(rusqlite::Error::SqliteFailure(f, _)) = e {
        if matches!(f.code, rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) {
            return SkipReason::Busy;
        }
    }
    SkipReason::Error
}

/// Open another notebook's database read-only: never migrates, never writes,
/// never takes the notebook lock; gives up quickly if it is busy.
pub fn open_read_only(nb: &Notebook, busy_timeout_ms: u32) -> std::result::Result<Database, Skipped> {
    readable(nb).map_err(|r| Skipped::new(nb, r, ""))?;
    let db = nb
        .open_read_only(busy_timeout_ms)
        .map_err(|e| Skipped::new(nb, classify(&e), e.to_string()))?;
    // Touch the schema now, so a busy or damaged file is reported here.
    db.conn
        .query_row("SELECT count(*) FROM (SELECT 1 FROM pages LIMIT 1)", [], |r| r.get::<_, i64>(0))
        .map_err(|e| {
            let e = Error::Database(e);
            Skipped::new(nb, classify(&e), e.to_string())
        })?;
    Ok(db)
}

/// Every known notebook except the one whose database is `current_db`.
pub fn other_notebooks(current_db: Option<&Path>) -> Vec<Notebook> {
    notebook::list()
        .into_iter()
        .filter(|i| current_db.is_none_or(|c| !same_file(Path::new(&i.db_path), c)))
        .filter_map(|i| notebook::resolve(&i.key).ok())
        .collect()
}

/// The registered notebook whose database is `db_path` (to label results).
pub fn notebook_for_db(db_path: &Path) -> Option<Notebook> {
    notebook::list()
        .into_iter()
        .find(|i| same_file(Path::new(&i.db_path), db_path))
        .and_then(|i| notebook::resolve(&i.key).ok())
}

/// A notebook by its display name, case-insensitively (an exact-case match
/// wins). Several with the same name: the available, most recently opened one.
pub fn find_notebook_by_name(name: &str) -> Option<Notebook> {
    pick_by_name(&notebook::list(), name).and_then(|i| notebook::resolve(&i.key).ok())
}

fn pick_by_name<'a>(all: &'a [NotebookInfo], name: &str) -> Option<&'a NotebookInfo> {
    let name = name.trim();
    let mut hits: Vec<&NotebookInfo> = all.iter().filter(|n| n.name == name).collect();
    if hits.is_empty() {
        hits = all.iter().filter(|n| n.name.to_lowercase() == name.to_lowercase()).collect();
    }
    hits.sort_by(|a, b| b.available.cmp(&a.available).then(b.last_opened.cmp(&a.last_opened)));
    hits.first().copied()
}

// ── Search ──

#[derive(Debug, Clone)]
pub struct SearchOptions {
    pub per_notebook: i64,
    pub page_matches: i64,
    pub budget: Duration,
    pub busy_timeout_ms: u32,
}

impl Default for SearchOptions {
    fn default() -> Self {
        SearchOptions {
            per_notebook: DEFAULT_PER_NOTEBOOK,
            page_matches: DEFAULT_PAGE_MATCHES,
            budget: DEFAULT_BUDGET,
            busy_timeout_ms: BUSY_TIMEOUT_MS,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PageHit {
    pub id: Uuid,
    pub title: String,
    pub is_journal: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BlockHit {
    pub block: Block,
    pub page_title: String,
}

/// One notebook's hits, labelled.
#[derive(Debug, Clone, Serialize)]
pub struct NotebookResults {
    pub notebook_key: String,
    pub notebook_name: String,
    /// The notebook the caller has open.
    pub current: bool,
    pub pages: Vec<PageHit>,
    pub blocks: Vec<BlockHit>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CrossSearch {
    pub query: String,
    /// Notebooks with at least one hit, in search order.
    pub results: Vec<NotebookResults>,
    pub skipped: Vec<Skipped>,
    pub elapsed_ms: u64,
}

fn like_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

impl Database {
    /// Pages whose title contains `query` (case-insensitive for ASCII), trashed
    /// and archived pages left out. Read-only.
    pub fn search_page_titles(&self, query: &str, limit: i64) -> Result<Vec<PageHit>> {
        let q = query.trim();
        if limit <= 0 {
            return Ok(Vec::new());
        }
        // An empty query lists pages (link autocomplete right after `[[Work::`).
        let pattern = if q.is_empty() { "%".to_string() } else { format!("%{}%", like_escape(q)) };
        let sql = format!(
            "{}
             SELECT id, title, is_journal FROM pages
             WHERE title LIKE ?1 ESCAPE '\\' AND id NOT IN (SELECT id FROM hidden_pages)
             ORDER BY (title = ?2 COLLATE NOCASE) DESC, updated_at DESC
             LIMIT ?3",
            crate::repo::trash::hidden_pages_cte()
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params![pattern, q, limit],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)? != 0)),
        )?;
        let mut out = Vec::new();
        for row in rows {
            let (id, title, is_journal) = row?;
            if let Ok(id) = Uuid::parse_str(&id) {
                out.push(PageHit { id, title, is_journal });
            }
        }
        Ok(out)
    }

    /// The FTS block search with each block's page title. Read-only.
    pub fn search_with_pages(&self, query: &str, limit: i64) -> Result<Vec<BlockHit>> {
        let blocks = self.search(query, Some(limit))?;
        let ids: Vec<Uuid> = blocks.iter().map(|b| b.id).collect();
        let titles: HashMap<Uuid, String> = self
            .get_blocks_with_pages(&ids)?
            .into_iter()
            .map(|b| (b.block.id, b.page_title))
            .collect();
        Ok(blocks
            .into_iter()
            .map(|b| {
                let page_title = titles.get(&b.id).cloned().unwrap_or_default();
                BlockHit { block: b, page_title }
            })
            .collect())
    }
}

/// Search one (already open) notebook: title matches and block matches.
pub fn search_db(db: &Database, nb: &Notebook, current: bool, query: &str, opts: &SearchOptions) -> Result<NotebookResults> {
    Ok(NotebookResults {
        notebook_key: nb.key.clone(),
        notebook_name: nb.name.clone(),
        current,
        pages: db.search_page_titles(query, opts.page_matches)?,
        blocks: db.search_with_pages(query, opts.per_notebook)?,
    })
}

/// Search `notebooks` (none of them the caller's open one) read-only, in order,
/// within `opts.budget`. Notebooks without hits are left out of `results`.
pub fn search_notebooks(notebooks: &[Notebook], query: &str, opts: &SearchOptions) -> CrossSearch {
    let start = Instant::now();
    let mut results = Vec::new();
    let mut skipped = Vec::new();
    for nb in notebooks {
        if start.elapsed() >= opts.budget {
            skipped.push(Skipped::new(nb, SkipReason::Timeout, ""));
            continue;
        }
        let db = match open_read_only(nb, opts.busy_timeout_ms) {
            Ok(db) => db,
            Err(s) => {
                skipped.push(s);
                continue;
            }
        };
        match search_db(&db, nb, false, query, opts) {
            Ok(r) if r.pages.is_empty() && r.blocks.is_empty() => {}
            Ok(r) => results.push(r),
            Err(e) => skipped.push(Skipped::new(nb, classify(&e), e.to_string())),
        }
    }
    CrossSearch { query: query.to_string(), results, skipped, elapsed_ms: start.elapsed().as_millis() as u64 }
}

/// Search every notebook except the one at `current_db`.
pub fn search_other_notebooks(current_db: Option<&Path>, query: &str, opts: &SearchOptions) -> CrossSearch {
    search_notebooks(&other_notebooks(current_db), query, opts)
}

/// Pages of another notebook whose title contains `query` (link autocomplete).
pub fn notebook_pages(nb: &Notebook, query: &str, limit: i64) -> std::result::Result<Vec<PageHit>, Skipped> {
    let db = open_read_only(nb, BUSY_TIMEOUT_MS)?;
    db.search_page_titles(query, limit).map_err(|e| Skipped::new(nb, classify(&e), e.to_string()))
}

// ── Links ──

/// A `[[Notebook::Page]]` occurrence to resolve.
#[derive(Debug, Clone, Deserialize)]
pub struct LinkRef {
    /// The block it is written in (its stored target ids are used when known).
    #[serde(default)]
    pub block_id: Option<String>,
    pub notebook: String,
    pub page: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkStatus {
    /// Resolved: `notebook_key` + `page_id` (the page's CURRENT title in `page_title`).
    Ok,
    /// No notebook by that name, but this notebook has a page titled
    /// `Notebook::Page` (an old title containing `::`): a local link.
    Local,
    /// The notebook exists; the page doesn't (or is in its trash/archive).
    PageMissing,
    /// No notebook by that name.
    NotebookMissing,
    /// The notebook exists but can't be read now (missing folder, locked, busy).
    Unavailable,
}

#[derive(Debug, Clone, Serialize)]
pub struct LinkTarget {
    pub status: LinkStatus,
    pub notebook_key: Option<String>,
    pub notebook_name: Option<String>,
    pub page_id: Option<String>,
    pub page_title: Option<String>,
    /// The target is the notebook that is open.
    pub current: bool,
    /// Why it is unavailable ("not available", "locked", …).
    pub detail: Option<String>,
}

impl LinkTarget {
    fn missing(status: LinkStatus, nb: Option<&Notebook>, current: bool, detail: Option<String>) -> LinkTarget {
        LinkTarget {
            status,
            notebook_key: nb.map(|n| n.key.clone()),
            notebook_name: nb.map(|n| n.name.clone()),
            page_id: None,
            page_title: None,
            current,
            detail,
        }
    }
}

/// A `notebook_links` row.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StoredNotebookLink {
    pub from_block: String,
    /// As written in the block.
    pub notebook_name: String,
    pub page_title: String,
    /// Resolved target (kept across renames), when it resolved.
    pub notebook_key: Option<String>,
    pub page_id: Option<String>,
}

fn is_hidden(db: &Database, page_id: &Uuid) -> bool {
    db.conn
        .query_row(
            &format!(
                "{} SELECT EXISTS(SELECT 1 FROM hidden_pages WHERE id = ?1)",
                crate::repo::trash::hidden_pages_cte()
            ),
            rusqlite::params![page_id.to_string()],
            |r| r.get::<_, bool>(0),
        )
        .unwrap_or(false)
}

/// The page a link points at in `db`: the stored id first (survives renames),
/// else the title (case-insensitive, aliases too). Hidden pages don't count.
fn find_target_page(db: &Database, stored_page_id: Option<&str>, title: &str) -> Option<Page> {
    if let Some(id) = stored_page_id.and_then(|s| Uuid::parse_str(s).ok()) {
        if let Ok(Some(p)) = db.get_page(&id) {
            if !is_hidden(db, &p.id) {
                return Some(p);
            }
        }
    }
    match db.find_page_for_link(title) {
        Ok(Some(p)) if !is_hidden(db, &p.id) => Some(p),
        _ => None,
    }
}

impl Database {
    pub(crate) fn migrate_notebook_links(&self) -> Result<()> {
        // Idempotent; no user_version bump (older apps simply ignore the table).
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS notebook_links (
                 id            TEXT PRIMARY KEY,
                 from_block    TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
                 notebook_name TEXT NOT NULL,
                 page_title    TEXT NOT NULL,
                 notebook_key  TEXT,
                 page_id       TEXT,
                 created_at    TEXT NOT NULL,
                 resolved_at   TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_notebook_links_block ON notebook_links(from_block);",
        )?;
        Ok(())
    }

    /// The `[[Notebook::Page]]` links recorded for a block.
    pub fn notebook_links_of(&self, block_id: &Uuid) -> Result<Vec<StoredNotebookLink>> {
        let mut stmt = self.conn.prepare(
            "SELECT from_block, notebook_name, page_title, notebook_key, page_id
             FROM notebook_links WHERE from_block = ?1 ORDER BY rowid",
        )?;
        let rows = stmt.query_map(rusqlite::params![block_id.to_string()], |r| {
            Ok(StoredNotebookLink {
                from_block: r.get(0)?,
                notebook_name: r.get(1)?,
                page_title: r.get(2)?,
                notebook_key: r.get(3)?,
                page_id: r.get(4)?,
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(Error::Database)
    }

    fn stored_notebook_link(&self, block_id: &str, nb: &str, page: &str) -> Option<(Option<String>, Option<String>)> {
        self.conn
            .query_row(
                "SELECT notebook_key, page_id FROM notebook_links
                 WHERE from_block = ?1 AND notebook_name = ?2 COLLATE NOCASE AND page_title = ?3 COLLATE NOCASE
                 ORDER BY rowid LIMIT 1",
                rusqlite::params![block_id, nb.trim(), page.trim()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok()
    }

    /// Remember what a link resolved to (only if it changed: a no-op writes nothing).
    pub fn pin_notebook_link(&self, block_id: &str, nb: &str, page: &str, key: &str, page_id: &str) -> Result<usize> {
        Ok(self.conn.execute(
            "UPDATE notebook_links SET notebook_key = ?4, page_id = ?5, resolved_at = ?6
             WHERE from_block = ?1 AND notebook_name = ?2 COLLATE NOCASE AND page_title = ?3 COLLATE NOCASE
               AND (notebook_key IS NOT ?4 OR page_id IS NOT ?5)",
            rusqlite::params![block_id, nb.trim(), page.trim(), key, page_id, chrono::Utc::now().to_rfc3339()],
        )?)
    }

    /// Link sync for a block's `[[Notebook::Page]]` links (inside the caller's
    /// transaction). Rows whose text is unchanged keep their resolved ids, so a
    /// renamed target stays linked; new ones are resolved now if possible. A
    /// `[[A::B]]` with no notebook named A that matches a local page titled
    /// `A::B` is an ordinary local link instead.
    pub(crate) fn sync_notebook_links(&self, block_id: &Uuid, found: &[(String, String)], actor: &str) -> Result<()> {
        let bid = block_id.to_string();
        let mut kept: HashMap<(String, String), (Option<String>, Option<String>)> = HashMap::new();
        for s in self.notebook_links_of(block_id)? {
            kept.entry((s.notebook_name.to_lowercase(), s.page_title.to_lowercase()))
                .or_insert((s.notebook_key, s.page_id));
        }
        self.conn.execute("DELETE FROM notebook_links WHERE from_block = ?1", rusqlite::params![bid])?;
        if found.is_empty() {
            return Ok(());
        }
        let all = notebook::list();
        let mut seen = std::collections::HashSet::new();
        for (nb, page) in found {
            let k = (nb.to_lowercase(), page.to_lowercase());
            if !seen.insert(k.clone()) {
                continue;
            }
            let (key, page_id) = match kept.get(&k) {
                Some(ids @ (Some(_), _)) => ids.clone(),
                _ => match pick_by_name(&all, nb) {
                    Some(info) => {
                        let pid = notebook::resolve(&info.key)
                            .ok()
                            .and_then(|n| open_read_only(&n, 100).ok())
                            .and_then(|db| find_target_page(&db, None, page))
                            .map(|p| p.id.to_string());
                        (Some(info.key.clone()), pid)
                    }
                    None => {
                        if let Some(p) = self.find_page_for_link(&format!("{nb}{}{page}", crate::links::NOTEBOOK_SEP))? {
                            self.create_link(block_id, Some(&p.id), None, "reference", actor)?;
                            continue;
                        }
                        (None, None)
                    }
                },
            };
            let resolved_at = page_id.as_ref().map(|_| chrono::Utc::now().to_rfc3339());
            self.conn.execute(
                "INSERT INTO notebook_links (id, from_block, notebook_name, page_title, notebook_key, page_id, created_at, resolved_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    Uuid::now_v7().to_string(),
                    bid,
                    nb,
                    page,
                    key,
                    page_id,
                    chrono::Utc::now().to_rfc3339(),
                    resolved_at
                ],
            )?;
        }
        Ok(())
    }
}

/// Resolve `[[Notebook::Page]]` links for display and navigation.
///
/// `current` is the open notebook's database (its stored link ids are used, and
/// a link into the open notebook is looked up there); `current_db` its file.
/// With `pin`, newly resolved targets are recorded in `notebook_links` (pass
/// false for a read-only session). Each other notebook is opened at most once.
pub fn resolve_links(current: &Database, current_db: Option<&Path>, items: &[LinkRef], pin: bool) -> Vec<LinkTarget> {
    let all = notebook::list();
    let mut opened: HashMap<String, std::result::Result<Database, Skipped>> = HashMap::new();
    let mut out = Vec::with_capacity(items.len());
    for it in items {
        let (nb_name, page) = (it.notebook.trim(), it.page.trim());
        let stored = it.block_id.as_deref().and_then(|b| current.stored_notebook_link(b, nb_name, page));
        let (stored_key, stored_page) = stored.clone().unwrap_or((None, None));

        // The notebook: by the stored key (survives a notebook rename), else by name.
        let info = stored_key
            .as_deref()
            .and_then(|k| all.iter().find(|i| i.key == k))
            .or_else(|| pick_by_name(&all, nb_name));
        let Some(info) = info else {
            let local = current
                .find_page_for_link(&format!("{nb_name}{}{page}", crate::links::NOTEBOOK_SEP))
                .ok()
                .flatten();
            out.push(match local {
                Some(p) => LinkTarget {
                    status: LinkStatus::Local,
                    notebook_key: None,
                    notebook_name: None,
                    page_id: Some(p.id.to_string()),
                    page_title: Some(p.title),
                    current: true,
                    detail: None,
                },
                None => LinkTarget::missing(LinkStatus::NotebookMissing, None, false, None),
            });
            continue;
        };
        let Ok(nb) = notebook::resolve(&info.key) else {
            out.push(LinkTarget::missing(LinkStatus::NotebookMissing, None, false, None));
            continue;
        };
        let is_current = current_db.is_some_and(|c| same_file(&nb.db_path(), c));
        // Stored page ids only count for the notebook they were resolved in.
        let stored_page = if stored_key.as_deref() == Some(nb.key.as_str()) { stored_page } else { None };

        let page_hit = if is_current {
            Ok(find_target_page(current, stored_page.as_deref(), page))
        } else {
            let db = opened
                .entry(nb.key.clone())
                .or_insert_with(|| open_read_only(&nb, BUSY_TIMEOUT_MS));
            match db {
                Ok(db) => Ok(find_target_page(db, stored_page.as_deref(), page)),
                Err(s) => Err(s.label.clone()),
            }
        };
        let target = match page_hit {
            Err(why) => LinkTarget::missing(LinkStatus::Unavailable, Some(&nb), is_current, Some(why)),
            Ok(None) => LinkTarget::missing(LinkStatus::PageMissing, Some(&nb), is_current, None),
            Ok(Some(p)) => {
                if pin {
                    if let Some(b) = it.block_id.as_deref() {
                        let _ = current.pin_notebook_link(b, nb_name, page, &nb.key, &p.id.to_string());
                    }
                }
                LinkTarget {
                    status: LinkStatus::Ok,
                    notebook_key: Some(nb.key.clone()),
                    notebook_name: Some(nb.name.clone()),
                    page_id: Some(p.id.to_string()),
                    page_title: Some(p.title),
                    current: is_current,
                    detail: None,
                }
            }
        };
        out.push(target);
    }
    out
}

/// Where a notebook's database is, for callers that only have a key.
pub fn db_path_of(key: &str) -> Option<PathBuf> {
    notebook::resolve(key).ok().map(|n| n.db_path())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notebook::tests::FakeHome;
    use sha2::{Digest, Sha256};

    fn hash(p: &Path) -> String {
        format!("{:x}", Sha256::digest(std::fs::read(p).unwrap()))
    }

    fn mtime(p: &Path) -> std::time::SystemTime {
        std::fs::metadata(p).unwrap().modified().unwrap()
    }

    /// Two folder notebooks, Home (the "open" one) and Work, with some content.
    fn setup(home: &FakeHome) -> (Notebook, Notebook) {
        let h = notebook::create_in_folder(&home.path().join("MiNotes/Home"), "Home").unwrap();
        let w = notebook::create_in_folder(&home.path().join("MiNotes/Work"), "Work").unwrap();
        {
            let db = w.open_db().unwrap();
            let p = db.create_page("Q3 Plan", None, false, None, "user").unwrap();
            db.create_block(&p.id, "budget zebrafish review", None, None, "user").unwrap();
            let gone = db.create_page("Old zebrafish notes", None, false, None, "user").unwrap();
            db.create_block(&gone.id, "zebrafish in the trash", None, None, "user").unwrap();
            db.trash_page(&gone.id).unwrap();
        }
        {
            let db = h.open_db().unwrap();
            let p = db.create_page("Groceries", None, false, None, "user").unwrap();
            db.create_block(&p.id, "zebrafish food", None, None, "user").unwrap();
        }
        (h, w)
    }

    #[test]
    fn read_only_open_never_writes_or_migrates() {
        let home = FakeHome::new();
        let (h, w) = setup(&home);
        let file = w.db_path();
        // An "old" notebook: pretend it predates the latest migration.
        {
            let c = rusqlite::Connection::open(&file).unwrap();
            c.execute_batch("PRAGMA user_version = 3; DROP TABLE notebook_links;").unwrap();
        }
        std::thread::sleep(Duration::from_millis(30));
        let (h0, m0) = (hash(&file), mtime(&file));
        let lock = w.lock_path();
        assert!(!lock.exists());

        let r = search_other_notebooks(Some(&h.db_path()), "zebrafish", &SearchOptions::default());
        assert_eq!(r.results.len(), 1, "{r:?}");
        let db = open_read_only(&w, BUSY_TIMEOUT_MS).unwrap();
        assert!(db.is_read_only());
        assert!(db.conn.execute("DELETE FROM pages", []).is_err(), "writes must fail");
        drop(db);

        assert_eq!(hash(&file), h0, "database bytes unchanged");
        assert_eq!(mtime(&file), m0, "database mtime unchanged");
        let c = rusqlite::Connection::open_with_flags(&file, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 3, "not migrated");
        let has: i64 = c
            .query_row("SELECT count(*) FROM sqlite_master WHERE name='notebook_links'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(has, 0, "no schema created");
        assert!(!lock.exists(), "the notebook lock is never taken");
    }

    #[test]
    fn search_results_are_labelled_and_skips_reported() {
        let home = FakeHome::new();
        let (h, w) = setup(&home);
        // A third notebook whose folder is gone, one that is encrypted, one broken.
        let gone = notebook::create_in_folder(&home.path().join("MiNotes/Gone"), "Gone").unwrap();
        std::fs::remove_dir_all(gone.root().unwrap()).unwrap();
        let enc = notebook::create_in_folder(&home.path().join("MiNotes/Secret"), "Secret").unwrap();
        let meta = enc.root().unwrap().join(notebook::META_FILE);
        let mut v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&meta).unwrap()).unwrap();
        v["encryption"] = serde_json::json!({"kdf": "argon2id"});
        std::fs::write(&meta, v.to_string()).unwrap();
        let bad = notebook::create_in_folder(&home.path().join("MiNotes/Broken"), "Broken").unwrap();
        std::fs::write(bad.db_path(), b"this is not a database at all, not even close........").unwrap();

        let r = search_other_notebooks(Some(&h.db_path()), "zebrafish", &SearchOptions::default());
        assert_eq!(r.results.len(), 1);
        let work = &r.results[0];
        assert_eq!((work.notebook_name.as_str(), work.notebook_key.as_str(), work.current), ("Work", w.key.as_str(), false));
        assert_eq!(work.blocks.len(), 1, "trashed page's block is not found");
        assert_eq!(work.blocks[0].page_title, "Q3 Plan");
        assert!(work.pages.is_empty());
        let reasons: Vec<(String, SkipReason)> =
            r.skipped.iter().map(|s| (s.notebook_name.clone(), s.reason)).collect();
        assert!(reasons.contains(&("Gone".into(), SkipReason::Unavailable)), "{reasons:?}");
        assert!(reasons.contains(&("Secret".into(), SkipReason::Locked)), "{reasons:?}");
        assert!(reasons.contains(&("Broken".into(), SkipReason::Error)), "{reasons:?}");
        assert!(!r.results.iter().any(|x| x.notebook_name == "Home"), "the open notebook is not searched again");

        // Title matches, per-notebook cap, and the time budget.
        let r = search_other_notebooks(Some(&h.db_path()), "q3", &SearchOptions::default());
        assert_eq!(r.results[0].pages.iter().map(|p| p.title.as_str()).collect::<Vec<_>>(), vec!["Q3 Plan"]);
        {
            let db = w.open_db().unwrap();
            let p = db.find_page_for_link("Q3 Plan").unwrap().unwrap();
            for i in 0..30 {
                db.create_block(&p.id, &format!("capybara {i}"), None, None, "user").unwrap();
            }
        }
        let opts = SearchOptions { per_notebook: 5, ..Default::default() };
        let r = search_other_notebooks(Some(&h.db_path()), "capybara", &opts);
        assert_eq!(r.results[0].blocks.len(), 5);
        let opts = SearchOptions { budget: Duration::ZERO, ..Default::default() };
        let r = search_other_notebooks(Some(&h.db_path()), "capybara", &opts);
        assert!(r.results.is_empty());
        assert!(r.skipped.iter().any(|s| s.notebook_name == "Work" && s.reason == SkipReason::Timeout));
    }

    #[test]
    fn exclusively_locked_notebook_is_skipped_as_busy() {
        let home = FakeHome::new();
        let (h, w) = setup(&home);
        let holder = rusqlite::Connection::open(w.db_path()).unwrap();
        holder.execute_batch("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; UPDATE pages SET position = position;").unwrap();
        let t = Instant::now();
        let r = search_other_notebooks(Some(&h.db_path()), "zebrafish", &SearchOptions::default());
        assert!(t.elapsed() < Duration::from_secs(3), "busy notebooks are not waited for");
        assert!(r.results.is_empty(), "{r:?}");
        assert_eq!(r.skipped.len(), 1);
        assert_eq!(r.skipped[0].reason, SkipReason::Busy, "{:?}", r.skipped);
        holder.execute_batch("ROLLBACK").unwrap();
    }

    #[test]
    fn links_resolve_by_id_after_renames_and_create_nothing_local() {
        let home = FakeHome::new();
        let (h, w) = setup(&home);
        let db = h.open_db().unwrap();
        let src = db.create_page("Src", None, false, None, "user").unwrap();
        let b = db
            .create_block(&src.id, "see [[work::Q3 Plan]] and [[Work::Nope]] and [[Nobook::X]]", None, None, "user")
            .unwrap();
        let pages_before = db.list_pages(Some(1000)).unwrap().len();

        // Recorded with the target ids; nothing in `links`, no local page.
        let rows = db.notebook_links_of(&b.id).unwrap();
        assert_eq!(rows.len(), 3);
        let wdb = w.open_db().unwrap();
        let q3 = wdb.find_page_for_link("Q3 Plan").unwrap().unwrap();
        assert_eq!(rows[0].notebook_key.as_deref(), Some(w.key.as_str()));
        assert_eq!(rows[0].page_id.as_deref(), Some(q3.id.to_string().as_str()));
        assert_eq!((rows[1].notebook_key.as_deref(), rows[1].page_id.as_deref()), (Some(w.key.as_str()), None));
        assert_eq!((rows[2].notebook_key.as_deref(), rows[2].page_id.as_deref()), (None, None));
        let n_links: i64 = db.conn.query_row("SELECT count(*) FROM links", [], |r| r.get(0)).unwrap();
        assert_eq!(n_links, 0, "no local link rows");
        assert_eq!(db.list_pages(Some(1000)).unwrap().len(), pages_before, "no local page created");
        assert!(db.find_page_for_link("work::Q3 Plan").unwrap().is_none());
        assert!(wdb.find_page_for_link("Nope").unwrap().is_none(), "no page created in the other notebook");
        let gd = db.get_graph_data().unwrap();
        assert!(gd.edges.is_empty(), "nothing in the local graph");

        // Rename the target page and the notebook: still resolves (by id/key).
        wdb.rename_page(&q3.id, "Q3 Plan (final)", "user").unwrap();
        drop(wdb);
        notebook::rename(&w.key, "Office").unwrap();
        let refs = |nb: &str, page: &str| LinkRef { block_id: Some(b.id.to_string()), notebook: nb.into(), page: page.into() };
        let t = resolve_links(&db, Some(&h.db_path()), &[refs("work", "Q3 Plan"), refs("Work", "Nope"), refs("Nobook", "X")], true);
        assert_eq!(t[0].status, LinkStatus::Ok, "{t:?}");
        assert_eq!(t[0].page_title.as_deref(), Some("Q3 Plan (final)"));
        assert_eq!(t[0].notebook_name.as_deref(), Some("Office"));
        assert_eq!(t[0].page_id.as_deref(), Some(q3.id.to_string().as_str()));
        assert_eq!(t[1].status, LinkStatus::PageMissing);
        assert_eq!(t[2].status, LinkStatus::NotebookMissing);

        // Editing other text in the block keeps the pinned ids.
        db.update_block(&b.id, Some("now: see [[work::Q3 Plan]] and [[Work::Nope]] and [[Nobook::X]]"), "user").unwrap();
        let rows = db.notebook_links_of(&b.id).unwrap();
        assert_eq!(rows[0].page_id.as_deref(), Some(q3.id.to_string().as_str()));
        let t = resolve_links(&db, Some(&h.db_path()), &[refs("work", "Q3 Plan")], false);
        assert_eq!(t[0].page_title.as_deref(), Some("Q3 Plan (final)"));

        // Without a block (no stored ids) the new notebook name resolves by name.
        let t = resolve_links(&db, Some(&h.db_path()), &[LinkRef { block_id: None, notebook: "OFFICE".into(), page: "q3 plan (final)".into() }], false);
        assert_eq!(t[0].status, LinkStatus::Ok);

        // A link into the open notebook resolves there; an old local title with
        // `::` and no such notebook stays a local link.
        let t = resolve_links(&db, Some(&h.db_path()), &[LinkRef { block_id: None, notebook: "Home".into(), page: "Groceries".into() }], false);
        assert_eq!((t[0].status, t[0].current), (LinkStatus::Ok, true));
        let odd = db.create_page("C++::Notes", None, false, None, "user").unwrap();
        let b2 = db.create_block(&src.id, "[[C++::Notes]]", None, None, "user").unwrap();
        assert_eq!(db.get_backlinks(&odd.id).unwrap().len(), 1);
        assert!(db.notebook_links_of(&b2.id).unwrap().is_empty());
        let t = resolve_links(&db, Some(&h.db_path()), &[LinkRef { block_id: None, notebook: "C++".into(), page: "Notes".into() }], false);
        assert_eq!(t[0].status, LinkStatus::Local);

        // Pinning a link created before its target existed.
        let b3 = db.create_block(&src.id, "[[Office::Later]]", None, None, "user").unwrap();
        assert_eq!(db.notebook_links_of(&b3.id).unwrap()[0].page_id, None);
        let later = w.open_db().unwrap().create_page("Later", None, false, None, "user").unwrap();
        let r3 = LinkRef { block_id: Some(b3.id.to_string()), notebook: "Office".into(), page: "Later".into() };
        assert_eq!(resolve_links(&db, Some(&h.db_path()), &[r3.clone()], true)[0].status, LinkStatus::Ok);
        assert_eq!(db.notebook_links_of(&b3.id).unwrap()[0].page_id.as_deref(), Some(later.id.to_string().as_str()));

        // Deleting the block removes its rows; the migration is idempotent.
        db.delete_block(&b.id, "user").unwrap();
        let n: i64 = db.conn.query_row("SELECT count(*) FROM notebook_links WHERE from_block = ?1", [b.id.to_string()], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        db.migrate_notebook_links().unwrap();
        drop(db);
        h.open_db().unwrap();
    }

    #[test]
    fn markdown_mirror_and_sync_round_trip_the_syntax() {
        let home = FakeHome::new();
        let (h, w) = setup(&home);
        let db = h.open_db().unwrap();
        let p = db.create_page("Linker", None, false, None, "user").unwrap();
        db.create_block(&p.id, "plan: [[Work::Q3 Plan]] and [[Work::Q3 Plan|alias]]", None, None, "user").unwrap();
        let dir = home.path().join("export");
        db.export_markdown_synced(&dir).unwrap();
        let md = std::fs::read_to_string(dir.join("Linker.md")).unwrap();
        assert!(md.contains("plan: [[Work::Q3 Plan]] and [[Work::Q3 Plan|alias]]"), "{md}");

        let db2 = Database::open_in_memory().unwrap();
        db2.sync_dir(&dir, "u", false, false).unwrap();
        let lp = db2.find_page_for_link("Linker").unwrap().unwrap();
        let blocks = db2.get_page_blocks(&lp.id).unwrap();
        assert_eq!(blocks[0].content, "plan: [[Work::Q3 Plan]] and [[Work::Q3 Plan|alias]]");
        assert!(db2.find_page_for_link("Work::Q3 Plan").unwrap().is_none(), "no local page from the import");
        let rows = db2.notebook_links_of(&blocks[0].id).unwrap();
        assert_eq!(rows.len(), 1, "one row per distinct target");
        assert_eq!(rows[0].notebook_key.as_deref(), Some(w.key.as_str()));
    }

    #[test]
    fn notebook_pages_lists_titles_read_only() {
        let home = FakeHome::new();
        let (_h, w) = setup(&home);
        let hits = notebook_pages(&w, "q3", 10).unwrap();
        assert_eq!(hits.iter().map(|p| p.title.as_str()).collect::<Vec<_>>(), vec!["Q3 Plan"]);
        assert_eq!(notebook_pages(&w, "", 10).unwrap().len(), 1, "trashed pages are not offered");
        assert_eq!(find_notebook_by_name("wORK").map(|n| n.key), Some(w.key.clone()));
    }
}
