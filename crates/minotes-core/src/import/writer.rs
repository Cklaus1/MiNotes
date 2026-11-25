//! The writer (PRD-import §4.1, §4.6): creates Projects, pages, blocks,
//! properties and attachments through the core API in batched transactions,
//! records everything in `import_runs` / `import_run_items` so the run can be
//! undone exactly, and handles re-import (unchanged → skipped; changed at the
//! source and untouched here → updated; changed in both → "(reimported)" copy).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::model::*;
use super::resolve::{ResolveCtx, Resolved, ResolvedNote};
use super::split::{split, OutBlock};
use super::{Cancelled, DbAccess, Destination, ImportOptions, Progress};
use crate::db::Database;
use crate::error::{Error, Result};
use crate::repo::attachments::{self, Attachment};

pub(crate) const RUNS_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS import_runs (
    id            TEXT PRIMARY KEY,
    source        TEXT NOT NULL,
    origin        TEXT NOT NULL,
    source_path   TEXT NOT NULL,
    started_at    TEXT NOT NULL,
    finished_at   TEXT,
    status        TEXT NOT NULL,
    report        TEXT,
    report_page   TEXT
);
CREATE TABLE IF NOT EXISTS import_run_items (
    run_id      TEXT NOT NULL,
    kind        TEXT NOT NULL,
    id          TEXT NOT NULL,
    source_ref  TEXT,
    PRIMARY KEY (run_id, kind, id)
);
CREATE INDEX IF NOT EXISTS idx_import_items_id ON import_run_items(id);
";

const ACTOR: &str = "import";

/// What an import created and everything it couldn't convert cleanly.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ImportReport {
    pub run_id: String,
    pub source: String,
    pub source_name: String,
    pub status: String,
    pub pages_created: usize,
    pub journals_created: usize,
    pub folders_created: usize,
    pub blocks_created: usize,
    pub attachments_created: usize,
    pub attachments_reused: usize,
    pub attachment_bytes: u64,
    pub pages_updated: usize,
    pub pages_unchanged: usize,
    pub reimported_copies: usize,
    pub skipped: usize,
    pub warnings: Vec<ReportWarning>,
    pub report_page_id: Option<String>,
    pub report_page_title: Option<String>,
    pub project_id: Option<String>,
    pub duration_ms: u128,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReportWarning {
    pub category: String,
    pub label: String,
    pub count: usize,
    /// Affected pages (title, page id when it was created).
    pub pages: Vec<(String, Option<String>)>,
    pub examples: Vec<String>,
}

/// A page from an earlier run of the same source (re-import).
#[derive(Debug, Clone)]
pub(crate) struct Existing {
    pub page_id: Uuid,
    pub title: String,
    pub src_hash: String,
    pub import_hash: String,
}

/// Pages earlier imports from `origin` created (by `import_ref`).
pub(crate) fn existing_imports(db: &Database, kind: SourceKind, origin: &str) -> Result<HashMap<String, Existing>> {
    let mut stmt = db.conn.prepare(
        "SELECT p.id, p.title, r.value,
                (SELECT value FROM properties WHERE entity_id = p.id AND key = 'import_src_hash'),
                (SELECT value FROM properties WHERE entity_id = p.id AND key = 'import_hash')
           FROM properties r
           JOIN pages p ON p.id = r.entity_id
          WHERE r.key = 'import_ref'
            AND EXISTS (SELECT 1 FROM properties s WHERE s.entity_id = p.id AND s.key = 'import_source' AND s.value = ?1)
            AND EXISTS (SELECT 1 FROM properties o WHERE o.entity_id = p.id AND o.key = 'import_origin' AND o.value = ?2)
            AND p.id NOT IN (SELECT page_id FROM trash)",
    )?;
    let rows = stmt.query_map(rusqlite::params![kind.as_str(), origin], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<String>>(3)?, r.get::<_, Option<String>>(4)?))
    })?;
    let mut out = HashMap::new();
    for row in rows {
        let (id, title, rf, sh, ih) = row?;
        let (Ok(id), Some(rf)) = (Uuid::parse_str(&id), rf) else { continue };
        out.entry(rf).or_insert(Existing { page_id: id, title, src_hash: sh.unwrap_or_default(), import_hash: ih.unwrap_or_default() });
    }
    Ok(out)
}

/// Is `title` used by a live page or alias (case-insensitive)?
pub(crate) fn title_taken(db: &Database, title: &str) -> bool {
    db.conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pages WHERE title = ?1 COLLATE NOCASE AND id NOT IN (SELECT page_id FROM trash))
                 OR EXISTS(SELECT 1 FROM page_aliases WHERE alias = ?1 COLLATE NOCASE)",
            [title],
            |r| r.get::<_, bool>(0),
        )
        .unwrap_or(false)
}

/// Fingerprint of what a user sees of a page: its title and blocks in outline
/// order (depth + content). "Edited since the import" = this changed.
pub fn page_hash(db: &Database, page_id: &Uuid) -> Result<String> {
    let Some(page) = db.get_page(page_id)? else { return Ok(String::new()) };
    let blocks = db.get_page_blocks(page_id)?;
    let mut depth: HashMap<Uuid, usize> = HashMap::new();
    let mut h = Sha256::new();
    h.update(page.title.as_bytes());
    h.update([0u8]);
    for b in &blocks {
        let d = b.parent_id.and_then(|p| depth.get(&p).map(|x| x + 1)).unwrap_or(0);
        depth.insert(b.id, d);
        h.update(format!("{d}\t{}\n", b.content).as_bytes());
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn record(db: &Database, run: &str, kind: &str, id: &str, source_ref: Option<&str>) -> Result<()> {
    db.conn.execute(
        "INSERT OR IGNORE INTO import_run_items (run_id, kind, id, source_ref) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![run, kind, id, source_ref],
    )?;
    Ok(())
}

/// A page's blocks, split and given their ids up front (block references
/// between notes need the target's id before it is written).
struct Planned {
    note: usize,
    blocks: Vec<(OutBlock, Uuid)>,
}

/// Obsidian `^blockid` anchors: strip them, remember which block carries each.
fn plan_blocks(notes: &[ResolvedNote], mode: super::split::SplitMode) -> (Vec<Planned>, HashMap<(usize, String), Uuid>) {
    let mut anchors = HashMap::new();
    let mut plans = Vec::with_capacity(notes.len());
    for (ni, n) in notes.iter().enumerate() {
        if n.skipped {
            plans.push(Planned { note: ni, blocks: vec![] });
            continue;
        }
        let mut out: Vec<(OutBlock, Uuid)> = Vec::new();
        for mut b in split(&n.body, mode) {
            // A lone `^id` line anchors the previous block.
            let t = b.content.trim();
            if t.starts_with('^') && t.len() > 1 && t[1..].chars().all(|c| c.is_ascii_alphanumeric() || c == '-') && !t.contains(' ') {
                if let (Some(prev), Some(src)) = (out.last(), n.src) {
                    anchors.insert((src, t[1..].to_string()), prev.1);
                }
                continue;
            }
            let id = Uuid::now_v7();
            if let Some(src) = n.src {
                let last_line = b.content.rsplit('\n').next().unwrap_or("").trim_end().to_string();
                if let Some(pos) = last_line.rfind(" ^") {
                    let aid = &last_line[pos + 2..];
                    if !aid.is_empty() && aid.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                        anchors.insert((src, aid.to_string()), id);
                        let cut = b.content.len() - (last_line.len() - pos);
                        b.content.truncate(cut);
                        b.content = b.content.trim_end().to_string();
                    }
                }
            }
            out.push((b, id));
        }
        plans.push(Planned { note: ni, blocks: out });
    }
    (plans, anchors)
}

/// Replace `((minotes-blockref:<note>:<id>))` placeholders.
fn subst_blockrefs(content: &str, anchors: &HashMap<(usize, String), Uuid>, title_of: &dyn Fn(usize) -> String) -> String {
    const P: &str = "((minotes-blockref:";
    if !content.contains(P) {
        return content.to_string();
    }
    let mut out = String::new();
    let mut rest = content;
    while let Some(i) = rest.find(P) {
        out.push_str(&rest[..i]);
        let after = &rest[i + P.len()..];
        let Some(end) = after.find("))") else {
            out.push_str(&rest[i..]);
            return out;
        };
        let inner = &after[..end];
        let mut parts = inner.splitn(2, ':');
        let note: usize = parts.next().and_then(|x| x.parse().ok()).unwrap_or(usize::MAX);
        let id = parts.next().unwrap_or("").to_string();
        match anchors.get(&(note, id.clone())) {
            Some(u) => out.push_str(&format!("(({u}))")),
            None => out.push_str(&format!("[[{}]]", title_of(note))),
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out
}

struct AttCache {
    stored: HashMap<usize, Option<Attachment>>,
    /// Hashes stored during the current batch (cleaned up if it rolls back).
    batch_new: Vec<String>,
}

fn subst_attachments(
    db: &Database,
    content: &str,
    model: &Model,
    cache: &mut AttCache,
    run: &str,
    rep: &mut ImportReport,
    w: &mut Warnings,
    note_key: &str,
) -> Result<String> {
    const P: &str = "](minotes-att:";
    if !content.contains(P) {
        return Ok(content.to_string());
    }
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(i) = rest.find(P) {
        let after = &rest[i + P.len()..];
        let digits = after.chars().take_while(|c| c.is_ascii_digit()).count();
        if digits == 0 || !after[digits..].starts_with(')') {
            out.push_str(&rest[..i + P.len()]);
            rest = after;
            continue;
        }
        let idx: usize = after[..digits].parse().unwrap_or(usize::MAX);
        if !cache.stored.contains_key(&idx) {
            let stored = match model.attachments.get(idx) {
                Some(a) if !a.skipped => {
                    let path = match &a.data {
                        Some(AttachmentData::File(p)) | Some(AttachmentData::Spooled(p)) => Some(p.clone()),
                        None => None,
                    };
                    match path.map(|p| db.store_attachment_file(&p, Some(&a.name), a.mime.as_deref())) {
                        Some(Ok(s)) => {
                            if s.created {
                                rep.attachments_created += 1;
                                rep.attachment_bytes += s.attachment.size;
                                record(db, run, "attachment", &s.attachment.hash, Some(&a.key))?;
                                cache.batch_new.push(s.attachment.hash.clone());
                            } else {
                                rep.attachments_reused += 1;
                            }
                            Some(s.attachment)
                        }
                        Some(Err(e)) => {
                            w.add("unreadable", Some(note_key), Some(&format!("{}: {e}", a.key)));
                            None
                        }
                        None => None,
                    }
                }
                _ => None,
            };
            cache.stored.insert(idx, stored);
        }
        // `[text](minotes-att:N)` → `[text](attachment:<hash>/<name>)`.
        match cache.stored.get(&idx).and_then(|a| a.as_ref()) {
            Some(a) => {
                out.push_str(&rest[..i]);
                out.push_str(&format!("](attachment:{}/{})", a.hash, attachments::encode_name(&a.name)));
            }
            None => {
                // Not stored: drop the link syntax, keep the text.
                let head = &rest[..i];
                let open = head.rfind('[').unwrap_or(head.len());
                let bang = open > 0 && head.as_bytes()[open - 1] == b'!';
                let text_start = open.min(head.len());
                out.push_str(&head[..if bang { open - 1 } else { text_start }]);
                let label = head.get(open + 1..).unwrap_or("");
                let name = model.attachments.get(idx).map(|a| a.name.as_str()).unwrap_or("file");
                out.push_str(&format!("{} (not imported)", if label.is_empty() { name } else { label }));
            }
        }
        rest = &after[digits + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

fn set_prop(db: &Database, page: &Uuid, k: &str, v: &str, w: &mut Warnings, key: &str) {
    if let Err(e) = db.set_property(page, "page", k, v, "text", ACTOR) {
        w.add("property_rejected", Some(key), Some(&format!("{k}: {e}")));
    }
}

/// Create a page with `title`, falling back to a numbered title if something
/// else took it meanwhile.
fn create_page_titled(db: &Database, title: &str) -> Result<crate::models::Page> {
    match db.create_page(title, None, false, None, ACTOR) {
        Ok(p) => Ok(p),
        Err(Error::AlreadyExists(_)) => {
            for n in 2..10_000 {
                let t = format!("{title} ({n})");
                if !title_taken(db, &t) {
                    return db.create_page(&t, None, false, None, ACTOR);
                }
            }
            Err(Error::AlreadyExists(title.to_string()))
        }
        Err(e) => Err(e),
    }
}

fn unique_title(db: &Database, base: &str) -> String {
    if !title_taken(db, base) {
        return base.to_string();
    }
    (2..100_000).map(|n| format!("{base} ({n})")).find(|t| !title_taken(db, t)).unwrap_or_else(|| format!("{base} {}", Uuid::now_v7()))
}

/// Write blocks under `page` in outline order with per-parent positions.
fn write_blocks(db: &Database, page: &Uuid, blocks: &[(OutBlock, Uuid)], contents: &[String]) -> Result<usize> {
    let mut stack: Vec<(usize, Uuid)> = Vec::new();
    let mut next_pos: HashMap<Option<Uuid>, f64> = HashMap::new();
    let mut n = 0;
    for ((b, id), content) in blocks.iter().zip(contents) {
        while let Some(&(d, _)) = stack.last() {
            if d >= b.depth {
                stack.pop();
            } else {
                break;
            }
        }
        let parent = stack.last().map(|(_, id)| *id);
        let pos = next_pos.entry(parent).or_insert(0.0);
        *pos += 1.0;
        db.create_block_with_id(*id, page, content, parent.as_ref(), Some(*pos), ACTOR)?;
        stack.push((b.depth, *id));
        n += 1;
    }
    Ok(n)
}

pub(crate) struct Prepared<'m> {
    pub model: &'m Model,
    pub resolved: Resolved,
    pub existing: HashMap<String, Existing>,
    pub origin: String,
}

/// Resolve against the destination database (titles in use, earlier imports).
pub(crate) fn prepare<'m, A: DbAccess>(acc: &A, model: &'m Model, opts: &ImportOptions) -> Result<Prepared<'m>> {
    let origin = model.origin();
    acc.with(&mut |db: &Database| {
        let existing = existing_imports(db, model.kind, &origin)?;
        let reimport: HashMap<String, String> = existing.iter().map(|(k, e)| (k.clone(), e.title.clone())).collect();
        let taken = |t: &str| title_taken(db, t);
        let resolved = super::resolve::resolve(
            model,
            &ResolveCtx { title_taken: &taken, reimport: &reimport, collisions: opts.collisions, unlinked_files: opts.unlinked_files },
        );
        Ok(Prepared { model, resolved, existing: existing.clone(), origin: origin.clone() })
    })
}

pub(crate) fn write<A: DbAccess>(
    acc: &A,
    prep: Prepared,
    opts: &ImportOptions,
    dest: &Destination,
    cancel: &AtomicBool,
    progress: &dyn Fn(Progress),
) -> Result<ImportReport> {
    let t0 = Instant::now();
    let model = prep.model;
    let mut res = prep.resolved;
    let run = Uuid::now_v7().to_string();
    let mut rep = ImportReport {
        run_id: run.clone(),
        source: model.kind.as_str().into(),
        source_name: model.name.clone(),
        status: "running".into(),
        ..Default::default()
    };
    let (plans, anchors) = plan_blocks(&res.notes, opts.split);
    let titles: Vec<String> = res.notes.iter().map(|n| n.title.clone()).collect();
    let src_to_resolved: HashMap<usize, usize> = res.notes.iter().enumerate().filter_map(|(i, n)| n.src.map(|s| (s, i))).collect();
    let title_of = |src: usize| src_to_resolved.get(&src).map(|&i| titles[i].clone()).unwrap_or_default();

    // ── Run row, Projects ──
    let source_path = model.root.as_ref().map(|r| r.display().to_string()).unwrap_or_else(|| model.name.clone());
    let folder_ids: HashMap<String, Uuid> = acc.with(&mut |db: &Database| {
        db.tx(|| {
            db.conn.execute(
                "INSERT INTO import_runs (id, source, origin, source_path, started_at, status) VALUES (?1, ?2, ?3, ?4, ?5, 'running')",
                rusqlite::params![run, model.kind.as_str(), prep.origin, source_path, chrono::Utc::now().to_rfc3339()],
            )?;
            // Folders an earlier run of this source created and that still exist.
            let mut reuse: HashMap<String, Uuid> = HashMap::new();
            {
                let mut stmt = db.conn.prepare(
                    "SELECT i.kind, i.id, i.source_ref FROM import_run_items i
                       JOIN import_runs r ON r.id = i.run_id
                      WHERE r.source = ?1 AND r.origin = ?2 AND r.status = 'done' AND i.kind IN ('folder', 'project')
                        AND i.id IN (SELECT id FROM folders) AND i.id NOT IN (SELECT folder_id FROM folder_trash)
                      ORDER BY r.started_at",
                )?;
                let rows = stmt.query_map(rusqlite::params![model.kind.as_str(), prep.origin], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?))
                })?;
                for row in rows {
                    let (kind, id, sr) = row?;
                    if let Ok(u) = Uuid::parse_str(&id) {
                        let key = if kind == "project" { "\u{0}project".to_string() } else { sr.unwrap_or_default() };
                        reuse.insert(key, u);
                    }
                }
            }
            let mut ids: HashMap<String, Uuid> = HashMap::new();
            let top: Option<Uuid> = match dest {
                Destination::Root => None,
                Destination::NewProject { name } => match reuse.get("\u{0}project") {
                    Some(u) => Some(*u),
                    None => {
                        let base = name.clone().unwrap_or_else(|| {
                            format!("Imported from {} ({})", model.name, chrono::Local::now().format("%Y-%m-%d"))
                        });
                        let f = create_folder_unique(db, &base, None)?;
                        record(db, &run, "project", &f.to_string(), None)?;
                        rep.folders_created += 1;
                        Some(f)
                    }
                },
            };
            if let Some(t) = top {
                ids.insert("\u{0}project".into(), t);
            }
            for f in &model.folders {
                if let Some(u) = reuse.get(&f.path) {
                    ids.insert(f.path.clone(), *u);
                    continue;
                }
                let parent = match &f.parent {
                    Some(p) => ids.get(p).copied(),
                    None => top,
                };
                let id = create_folder_unique(db, &f.name, parent.as_ref())?;
                record(db, &run, "folder", &id.to_string(), Some(&f.path))?;
                rep.folders_created += 1;
                ids.insert(f.path.clone(), id);
            }
            Ok(ids)
        })
    })?;
    rep.project_id = folder_ids.get("\u{0}project").map(|u| u.to_string());
    let top = folder_ids.get("\u{0}project").copied();

    // ── Pages, in batches ──
    let mut cache = AttCache { stored: HashMap::new(), batch_new: Vec::new() };
    let mut key_to_page: HashMap<String, (String, Option<String>)> = HashMap::new();
    let mut ref_blocks: Vec<(Uuid, String)> = Vec::new();
    let total = plans.len();
    let batch = opts.batch_size.max(1);
    let mut done = 0usize;
    let mut warnings = std::mem::take(&mut res.warnings);
    let outcome: Result<()> = (|| {
        for chunk in plans.chunks(batch) {
            let r = acc.with(&mut |db: &Database| {
                cache.batch_new.clear();
                let r = db.tx(|| {
                    for plan in chunk {
                        if cancel.load(Ordering::Relaxed) {
                            return Err(Cancelled.into());
                        }
                        let n = &res.notes[plan.note];
                        write_note(db, n, plan, model, &folder_ids, top, &prep.existing, &anchors, &title_of, &run, &prep.origin, &mut cache, &mut rep, &mut warnings, &mut key_to_page, &mut ref_blocks)?;
                    }
                    Ok(())
                });
                if r.is_err() {
                    // The batch rolled back: files it put in the store that no
                    // row refers to now are removed (the whole run is undone next).
                    for h in std::mem::take(&mut cache.batch_new) {
                        if db.get_attachment(&h).ok().flatten().is_none() {
                            if let Some(p) = db.attachment_file(&h) {
                                let _ = std::fs::remove_file(p);
                            }
                        }
                    }
                }
                r
            });
            r?;
            done += chunk.len();
            progress(Progress { phase: "import".into(), done, total, current: chunk.last().map(|p| res.notes[p.note].title.clone()).unwrap_or_default() });
        }
        Ok(())
    })();
    if let Err(e) = outcome {
        // Cancelled (or failed): remove everything earlier batches committed.
        let _ = acc.with(&mut |db: &Database| {
            let _ = super::undo::undo_run(db, &run, true, true);
            db.conn.execute(
                "UPDATE import_runs SET status = ?2, finished_at = ?3 WHERE id = ?1",
                rusqlite::params![run, if super::is_cancelled(&e) { "cancelled" } else { "failed" }, chrono::Utc::now().to_rfc3339()],
            )?;
            Ok(())
        });
        return Err(e);
    }

    // ── Block references across notes, report page, finish ──
    rep.status = "done".into();
    let warn_list = warnings.list();
    rep.warnings = warn_list
        .iter()
        .map(|e| ReportWarning {
            category: e.category.clone(),
            label: e.label.clone(),
            count: e.count,
            pages: e
                .notes
                .iter()
                .map(|k| match key_to_page.get(k) {
                    Some((t, id)) => (t.clone(), id.clone()),
                    None => (k.clone(), None),
                })
                .collect(),
            examples: e.examples.clone(),
        })
        .collect();
    rep.duration_ms = t0.elapsed().as_millis();
    acc.with(&mut |db: &Database| {
        db.tx(|| {
            for (id, content) in &ref_blocks {
                db.sync_block_links(id, content, ACTOR)?;
            }
            let (pid, title) = write_report_page(db, &rep, model, &run)?;
            rep.report_page_id = Some(pid.to_string());
            rep.report_page_title = Some(title);
            if let Some(t) = top {
                let _ = db.move_page_to_folder(&pid, Some(&t), ACTOR);
            }
            let json = serde_json::to_string(&rep)?;
            db.conn.execute(
                "UPDATE import_runs SET status = 'done', finished_at = ?2, report = ?3, report_page = ?4 WHERE id = ?1",
                rusqlite::params![run, chrono::Utc::now().to_rfc3339(), json, pid.to_string()],
            )?;
            Ok(())
        })
    })?;
    Ok(rep)
}

fn create_folder_unique(db: &Database, name: &str, parent: Option<&Uuid>) -> Result<Uuid> {
    let base = crate::repo::pages::normalize_name(name).unwrap_or_else(|| "Untitled".into());
    let mut cand = base.clone();
    let mut n = 2;
    loop {
        match db.create_folder(&cand, parent, None, None, ACTOR) {
            Ok(f) => return Ok(f.id),
            Err(Error::Database(rusqlite::Error::SqliteFailure(e, _))) if e.code == rusqlite::ErrorCode::ConstraintViolation && n < 1000 => {
                cand = format!("{base} ({n})");
                n += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn write_note(
    db: &Database,
    n: &ResolvedNote,
    plan: &Planned,
    model: &Model,
    folders: &HashMap<String, Uuid>,
    top: Option<Uuid>,
    existing: &HashMap<String, Existing>,
    anchors: &HashMap<(usize, String), Uuid>,
    title_of: &dyn Fn(usize) -> String,
    run: &str,
    origin: &str,
    cache: &mut AttCache,
    rep: &mut ImportReport,
    w: &mut Warnings,
    key_to_page: &mut HashMap<String, (String, Option<String>)>,
    ref_blocks: &mut Vec<(Uuid, String)>,
) -> Result<()> {
    if n.skipped {
        rep.skipped += 1;
        return Ok(());
    }
    // Final block contents: block refs and attachments substituted.
    let mut contents = Vec::with_capacity(plan.blocks.len());
    for (b, _) in &plan.blocks {
        let c = subst_blockrefs(&b.content, anchors, title_of);
        let c = subst_attachments(db, &c, model, cache, run, rep, w, &n.key)?;
        contents.push(c);
    }
    let folder = n.folder.as_ref().and_then(|f| folders.get(f)).copied().or(top);

    // Re-import of a page an earlier run created.
    if let Some(ex) = existing.get(&n.source_ref).filter(|_| n.reimport) {
        if db.get_page(&ex.page_id)?.is_some() {
            if ex.src_hash == n.source_hash {
                rep.pages_unchanged += 1;
                key_to_page.insert(n.key.clone(), (ex.title.clone(), Some(ex.page_id.to_string())));
                return Ok(());
            }
            if page_hash(db, &ex.page_id)? == ex.import_hash {
                // Changed at the source, untouched here: update in place.
                db.conn.execute(
                    "DELETE FROM properties WHERE entity_id IN (SELECT id FROM blocks WHERE page_id = ?1)",
                    [ex.page_id.to_string()],
                )?;
                db.conn.execute("DELETE FROM blocks WHERE page_id = ?1", [ex.page_id.to_string()])?;
                let fresh: Vec<(OutBlock, Uuid)> = plan.blocks.iter().map(|(b, _)| (b.clone(), Uuid::now_v7())).collect();
                rep.blocks_created += write_blocks(db, &ex.page_id, &fresh, &contents)?;
                for ((_, id), c) in fresh.iter().zip(&contents) {
                    if c.contains("((") {
                        ref_blocks.push((*id, c.clone()));
                    }
                }
                set_prop(db, &ex.page_id, "import_src_hash", &n.source_hash, w, &n.key);
                let h = page_hash(db, &ex.page_id)?;
                set_prop(db, &ex.page_id, "import_hash", &h, w, &n.key);
                record(db, run, "updated", &ex.page_id.to_string(), Some(&n.source_ref))?;
                rep.pages_updated += 1;
                key_to_page.insert(n.key.clone(), (ex.title.clone(), Some(ex.page_id.to_string())));
                return Ok(());
            }
            // Changed in both: keep the user's page, import a copy.
            w.add("reimport_conflict", Some(&n.key), Some(&ex.title));
            let title = unique_title(db, &format!("{} (reimported)", ex.title));
            let page = create_page_titled(db, &title)?;
            rep.reimported_copies += 1;
            return finish_page(db, n, plan, &contents, page.id, &page.title, folder, run, origin, rep, w, key_to_page, ref_blocks, false);
        }
    }

    let page = match n.journal {
        Some(d) => {
            let p = db.get_or_create_journal(d, None, ACTOR)?;
            rep.journals_created += 1;
            p
        }
        None => create_page_titled(db, &n.title)?,
    };
    let is_journal = n.journal.is_some();
    finish_page(db, n, plan, &contents, page.id, &page.title, if is_journal { None } else { folder }, run, origin, rep, w, key_to_page, ref_blocks, true)
}

#[allow(clippy::too_many_arguments)]
fn finish_page(
    db: &Database,
    n: &ResolvedNote,
    plan: &Planned,
    contents: &[String],
    page: Uuid,
    title: &str,
    folder: Option<Uuid>,
    run: &str,
    origin: &str,
    rep: &mut ImportReport,
    w: &mut Warnings,
    key_to_page: &mut HashMap<String, (String, Option<String>)>,
    ref_blocks: &mut Vec<(Uuid, String)>,
    count_created: bool,
) -> Result<()> {
    if let Some(f) = folder {
        db.move_page_to_folder(&page, Some(&f), ACTOR)?;
    }
    let ids: Vec<(OutBlock, Uuid)> = if count_created {
        plan.blocks.clone()
    } else {
        plan.blocks.iter().map(|(b, _)| (b.clone(), Uuid::now_v7())).collect()
    };
    rep.blocks_created += write_blocks(db, &page, &ids, contents)?;
    for ((_, id), c) in ids.iter().zip(contents) {
        if c.contains("((") {
            ref_blocks.push((*id, c.clone()));
        }
    }
    set_prop(db, &page, "import_source", &rep.source.clone(), w, &n.key);
    set_prop(db, &page, "import_origin", origin, w, &n.key);
    set_prop(db, &page, "import_ref", &n.source_ref, w, &n.key);
    set_prop(db, &page, "import_run", run, w, &n.key);
    set_prop(db, &page, "import_src_hash", &n.source_hash, w, &n.key);
    let mut seen: HashSet<String> = ["import_source", "import_origin", "import_ref", "import_run", "import_src_hash", "import_hash"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    for (k, v) in &n.properties {
        if crate::repo::properties::validate_property_key(k).is_err() {
            w.add("property_rejected", Some(&n.key), Some(k));
            continue;
        }
        if seen.insert(k.to_lowercase()) {
            set_prop(db, &page, k, v, w, &n.key);
        }
    }
    if !n.tags.is_empty() {
        let v = n.tags.iter().map(|t| format!("#{t}")).collect::<Vec<_>>().join(" ");
        set_prop(db, &page, "tags", &v, w, &n.key);
    }
    for a in &n.aliases {
        let a = a.trim();
        if a.is_empty() || a.eq_ignore_ascii_case(title) {
            continue;
        }
        if title_taken(db, a) {
            w.add("alias_conflict", Some(&n.key), Some(a));
            continue;
        }
        if db.add_alias(&page, a, ACTOR).is_err() {
            w.add("alias_conflict", Some(&n.key), Some(a));
        }
    }
    let h = page_hash(db, &page)?;
    set_prop(db, &page, "import_hash", &h, w, &n.key);
    record(db, run, "page", &page.to_string(), Some(&n.source_ref))?;
    if count_created {
        rep.pages_created += 1;
    }
    key_to_page.insert(n.key.clone(), (title.to_string(), Some(page.to_string())));
    Ok(())
}

fn human_size(b: u64) -> String {
    if b < 1024 * 1024 {
        format!("{:.1} KB", b as f64 / 1024.0)
    } else {
        format!("{:.1} MB", b as f64 / (1024.0 * 1024.0))
    }
}

fn write_report_page(db: &Database, rep: &ImportReport, model: &Model, run: &str) -> Result<(Uuid, String)> {
    let date = chrono::Local::now();
    let title = unique_title(db, &format!("Import report — {}", date.format("%Y-%m-%d")));
    let page = db.create_page(&title, None, false, None, ACTOR)?;
    let mut lines: Vec<(usize, String)> = vec![
        (0, format!("Imported **{}** ({}) on {}", model.name, model.kind.label(), date.format("%Y-%m-%d %H:%M"))),
        (
            0,
            format!(
                "Created {} pages ({} journal pages), {} Projects, {} attachments ({}); {} attachments were already stored",
                rep.pages_created,
                rep.journals_created,
                rep.folders_created,
                rep.attachments_created,
                human_size(rep.attachment_bytes),
                rep.attachments_reused
            ),
        ),
    ];
    if rep.pages_updated + rep.pages_unchanged + rep.reimported_copies > 0 {
        lines.push((
            0,
            format!(
                "Re-import: {} updated, {} unchanged, {} imported as \"(reimported)\" copies",
                rep.pages_updated, rep.pages_unchanged, rep.reimported_copies
            ),
        ));
    }
    if rep.skipped > 0 {
        lines.push((0, format!("{} notes skipped (title already in use)", rep.skipped)));
    }
    if rep.warnings.is_empty() {
        lines.push((0, "Everything converted cleanly.".into()));
    } else {
        lines.push((0, "## What didn't convert cleanly".into()));
        for wr in &rep.warnings {
            lines.push((1, format!("**{}** {}", wr.count, wr.label)));
            for (t, id) in wr.pages.iter().take(50) {
                if id.is_some() {
                    lines.push((2, format!("[[{t}]]")));
                } else {
                    lines.push((2, t.clone()));
                }
            }
            if wr.pages.is_empty() {
                for x in &wr.examples {
                    lines.push((2, format!("`{}`", x.replace('`', "'"))));
                }
            }
        }
    }
    lines.push((0, format!("Undo: Import → \"Undo import\" (run `{run}`)")));
    let blocks: Vec<(OutBlock, Uuid)> = lines.iter().map(|(d, c)| (OutBlock { depth: *d, content: c.clone() }, Uuid::now_v7())).collect();
    let contents: Vec<String> = lines.into_iter().map(|(_, c)| c).collect();
    write_blocks(db, &page.id, &blocks, &contents)?;
    db.set_property(&page.id, "page", "import_run", run, "text", ACTOR)?;
    db.set_property(&page.id, "page", "import_report", "true", "text", ACTOR)?;
    let h = page_hash(db, &page.id)?;
    db.set_property(&page.id, "page", "import_hash", &h, "text", ACTOR)?;
    record(db, run, "page", &page.id.to_string(), Some("report"))?;
    Ok((page.id, page.title))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn block_anchors_are_planned_and_substituted() {
        let n = ResolvedNote {
            src: Some(3),
            key: "k".into(),
            source_ref: "k".into(),
            kind: NoteKind::Note,
            folder: None,
            title: "T".into(),
            body: "para one ^p1\n\n- item ^i2\n\n| a |\n|---|\n\n^tbl".into(),
            journal: None,
            tags: vec![],
            aliases: vec![],
            properties: vec![],
            source_hash: String::new(),
            skipped: false,
            reimport: false,
        };
        let (plans, anchors) = plan_blocks(&[n], super::super::split::SplitMode::Outline);
        let blocks = &plans[0].blocks;
        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[0].0.content, "para one");
        assert_eq!(blocks[1].0.content, "item");
        assert_eq!(anchors[&(3, "p1".to_string())], blocks[0].1);
        assert_eq!(anchors[&(3, "tbl".to_string())], blocks[2].1);
        let s = subst_blockrefs("see ((minotes-blockref:3:i2)) and ((minotes-blockref:3:zz))", &anchors, &|_| "T".into());
        assert_eq!(s, format!("see (({})) and [[T]]", blocks[1].1));
    }
}
