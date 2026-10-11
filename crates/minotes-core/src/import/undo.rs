//! "Undo import" (PRD-import §4.6): delete exactly the pages, Projects and
//! attachments one run created — refusing for pages edited since, which are
//! listed instead.

use std::collections::HashMap;

use serde::Serialize;
use uuid::Uuid;

use super::writer::page_hash;
use crate::db::Database;
use crate::error::{Error, Result};

#[derive(Debug, Clone, Serialize)]
pub struct EditedPage {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct UndoReport {
    pub run_id: String,
    /// False when it refused (edited pages and `keep_edited` not set).
    pub undone: bool,
    pub pages_deleted: usize,
    pub folders_deleted: usize,
    pub attachments_deleted: usize,
    /// Pages changed since the import: listed, never deleted.
    pub edited: Vec<EditedPage>,
    /// Pages a re-import updated in place (they existed before the run; kept).
    pub updated_kept: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunInfo {
    pub id: String,
    pub source: String,
    pub origin: String,
    pub source_path: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub status: String,
    pub report_page: Option<String>,
    pub pages: usize,
}

pub fn list_runs(db: &Database) -> Result<Vec<RunInfo>> {
    let mut stmt = db.conn.prepare(
        "SELECT r.id, r.source, r.origin, r.source_path, r.started_at, r.finished_at, r.status, r.report_page,
                (SELECT COUNT(*) FROM import_run_items i WHERE i.run_id = r.id AND i.kind = 'page'
                    AND i.id IN (SELECT id FROM pages))
           FROM import_runs r ORDER BY r.started_at DESC",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(RunInfo {
                id: r.get(0)?,
                source: r.get(1)?,
                origin: r.get(2)?,
                source_path: r.get(3)?,
                started_at: r.get(4)?,
                finished_at: r.get(5)?,
                status: r.get(6)?,
                report_page: r.get(7)?,
                pages: r.get::<_, i64>(8)? as usize,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn items(db: &Database, run: &str, kinds: &[&str]) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for k in kinds {
        let mut stmt = db.conn.prepare("SELECT id FROM import_run_items WHERE run_id = ?1 AND kind = ?2 ORDER BY rowid")?;
        out.extend(stmt.query_map(rusqlite::params![run, k], |r| r.get::<_, String>(0))?.collect::<std::result::Result<Vec<_>, _>>()?);
    }
    Ok(out)
}

/// Undo run `run`. Pages whose content changed since the import are never
/// deleted: without `keep_edited` nothing happens and they are listed; with it,
/// everything else is undone and they (and the Projects holding them) stay.
/// `force` skips the edit check (cleaning up a cancelled import).
pub fn undo_run(db: &Database, run: &str, keep_edited: bool, force: bool) -> Result<UndoReport> {
    let exists: bool = db.conn.query_row("SELECT EXISTS(SELECT 1 FROM import_runs WHERE id = ?1)", [run], |r| r.get(0))?;
    if !exists {
        return Err(Error::NotFound(format!("Import run {run}")));
    }
    let mut rep = UndoReport { run_id: run.to_string(), ..Default::default() };
    let pages = items(db, run, &["page"])?;
    let mut to_delete = Vec::new();
    for id in &pages {
        let Ok(u) = Uuid::parse_str(id) else { continue };
        let Some(p) = db.get_page(&u)? else { continue };
        if !force {
            let recorded: Option<String> = db
                .conn
                .query_row("SELECT value FROM properties WHERE entity_id = ?1 AND key = 'import_hash'", [id], |r| r.get(0))
                .ok()
                .flatten();
            let now = page_hash(db, &u)?;
            if recorded.as_deref() != Some(now.as_str()) {
                rep.edited.push(EditedPage { id: id.clone(), title: p.title.clone() });
                continue;
            }
        }
        to_delete.push(u);
    }
    rep.updated_kept = items(db, run, &["updated"])?.len();
    if !rep.edited.is_empty() && !keep_edited {
        return Ok(rep);
    }
    db.tx(|| {
        for u in &to_delete {
            if db.delete_page(u, "import")? {
                rep.pages_deleted += 1;
            }
        }
        // Projects: deepest first, only once nothing else lives in them.
        let folders = items(db, run, &["folder", "project"])?;
        let mut depth: HashMap<String, usize> = HashMap::new();
        for f in &folders {
            let d: i64 = db.conn.query_row(
                "WITH RECURSIVE up(id, d) AS (SELECT parent_id, 1 FROM folders WHERE id = ?1
                     UNION ALL SELECT f.parent_id, up.d + 1 FROM folders f JOIN up ON f.id = up.id WHERE up.d < 200)
                 SELECT COALESCE(MAX(d), 0) FROM up WHERE id IS NOT NULL",
                [f],
                |r| r.get(0),
            )?;
            depth.insert(f.clone(), d as usize);
        }
        let mut ordered = folders.clone();
        ordered.sort_by_key(|f| std::cmp::Reverse(depth.get(f).copied().unwrap_or(0)));
        for f in ordered {
            let busy: bool = db.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM pages WHERE folder_id = ?1) OR EXISTS(SELECT 1 FROM folders WHERE parent_id = ?1)",
                [&f],
                |r| r.get(0),
            )?;
            let present: bool = db.conn.query_row("SELECT EXISTS(SELECT 1 FROM folders WHERE id = ?1)", [&f], |r| r.get(0))?;
            if present && !busy {
                if let Ok(u) = Uuid::parse_str(&f) {
                    if db.delete_folder(&u, "import")? {
                        rep.folders_deleted += 1;
                    }
                }
            }
        }
        // Attachments this run added, unless something still references them.
        let referenced = db.referenced_attachment_hashes()?;
        for h in items(db, run, &["attachment"])? {
            if !referenced.contains(&h) && db.get_attachment(&h)?.is_some() {
                db.delete_attachment_raw(&h)?;
                rep.attachments_deleted += 1;
            }
        }
        let status = if rep.edited.is_empty() { "undone" } else { "partially_undone" };
        db.conn.execute("UPDATE import_runs SET status = ?2 WHERE id = ?1", rusqlite::params![run, status])?;
        Ok(())
    })?;
    rep.undone = true;
    Ok(rep)
}
