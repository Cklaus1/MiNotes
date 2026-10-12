//! A whole notebook as one `.zip`: "Export notebook…" / "Import notebook…".
//!
//! This is how a notebook leaves or enters app-private storage on Android (the
//! system picker hands over a copy; SQLite never runs on a picker URI), and a
//! one-file backup on desktop. The archive is a notebook folder:
//!
//! ```text
//! <Name>/
//! ├── notebook.minotes   # consistent snapshot (VACUUM INTO, integrity-checked)
//! ├── notebook.json      # name, id, format version
//! ├── notes/             # the markdown copy, freshly rendered (without _attachments/)
//! └── attachments/       # the attachment store (<2 hex>/<sha256>.<ext>)
//! ```
//!
//! `notes/` is there for people reading the zip with other tools; it is derived
//! from the database, so import ignores it (the mirror rebuilds it). Its image
//! links point into `_attachments/`, which is left out to keep the archive from
//! carrying every attachment twice — the originals are in `attachments/`.
//!
//! Import never trusts the archive: names are checked for traversal (`..`,
//! absolute paths, drive letters, backslashes, NUL), symlinks and encrypted
//! entries are refused, sizes are capped while extracting (declared sizes can
//! lie), attachments must hash to their names, the database must pass
//! `PRAGMA integrity_check` and look like a MiNotes database. The result always
//! becomes a **new** notebook in a new folder: an id or name that is already
//! taken is replaced, and an existing folder is never written into.

use std::collections::HashSet;
use std::fs;
use std::io::{Read, Seek, Write};
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};
use uuid::Uuid;
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::notebook::{
    self, read_meta, Notebook, NotebookMeta, DB_FILE, FORMAT_VERSION, META_FILE, NOTES_DIR,
};

const ATTACHMENTS_DIR: &str = "attachments";
const MIRROR_ATTACHMENTS: &str = "_attachments";

fn zip_err(e: zip::result::ZipError) -> Error {
    Error::InvalidInput(format!("Not a readable zip archive: {e}"))
}

fn io_err(what: &str, path: &Path, e: std::io::Error) -> Error {
    Error::InvalidInput(format!("{what} {}: {e}", path.display()))
}

// ── Export ──

/// What an export wrote.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ExportSummary {
    pub name: String,
    pub pages: usize,
    pub attachments: usize,
    /// Size of the archive in bytes.
    pub bytes: u64,
}

/// Step 1 (hold the database while this runs): a consistent copy of the
/// database at `staging/notebook.minotes`, checked against the live row counts.
/// Works on a read-only connection too.
pub fn snapshot(conn: &rusqlite::Connection, staging: &Path) -> Result<PathBuf> {
    fs::create_dir_all(staging).map_err(|e| io_err("Cannot create", staging, e))?;
    let target = staging.join(DB_FILE);
    let _ = fs::remove_file(&target);
    let counts = notebook::table_row_counts(conn)?;
    // A read-only session's connection has query_only on; VACUUM INTO writes
    // only the new file, so lift it for this statement.
    let query_only: i64 = conn.query_row("PRAGMA query_only", [], |r| r.get(0)).unwrap_or(0);
    if query_only != 0 {
        conn.execute_batch("PRAGMA query_only=OFF")?;
    }
    let r = conn.execute("VACUUM INTO ?1", [target.to_string_lossy().to_string()]);
    if query_only != 0 {
        let _ = conn.execute_batch("PRAGMA query_only=ON");
    }
    r?;
    notebook::verify_copy(&target, &counts)?;
    Ok(target)
}

/// The `notebook.json` an export carries for `nb` (legacy notebooks get one).
pub fn export_meta(nb: &Notebook) -> NotebookMeta {
    if let Some(root) = nb.root() {
        if let Ok(m) = read_meta(root) {
            return m;
        }
    }
    NotebookMeta {
        name: nb.name.clone(),
        id: Uuid::now_v7().to_string(),
        format_version: FORMAT_VERSION,
        mirror: Default::default(),
        created_at: Some(chrono::Utc::now().to_rfc3339()),
    }
}

/// A file name for the archive: `<Name>.minotes.zip`.
pub fn suggested_file_name(name: &str) -> String {
    format!("{}.minotes.zip", crate::repo::export::sanitize_component(name))
}

/// Step 2 (no database lock): write the archive to `out` from the snapshot made
/// by [`snapshot`]. `attachments` is the live notebook's attachment store
/// (content-addressed and append-only, so reading it unlocked is safe).
/// `staging` holds the rendered markdown and is left for the caller to remove.
pub fn write_zip<W: Write + Seek>(
    snapshot_db: &Path,
    meta: &NotebookMeta,
    attachments: Option<&Path>,
    staging: &Path,
    out: W,
) -> Result<ExportSummary> {
    let top = crate::repo::export::sanitize_component(&meta.name);
    let mut zw = zip::ZipWriter::new(out);
    let deflate = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let big = |len: u64| len >= u32::MAX as u64 / 2;

    // notebook.json
    let json = serde_json::to_string_pretty(meta)? + "\n";
    zw.start_file(format!("{top}/{META_FILE}"), deflate).map_err(zip_err)?;
    zw.write_all(json.as_bytes()).map_err(|e| io_err("Cannot write", Path::new(META_FILE), e))?;

    // The database snapshot.
    let len = fs::metadata(snapshot_db).map_err(|e| io_err("Cannot read", snapshot_db, e))?.len();
    zw.start_file(format!("{top}/{DB_FILE}"), deflate.large_file(big(len))).map_err(zip_err)?;
    let mut f = fs::File::open(snapshot_db).map_err(|e| io_err("Cannot read", snapshot_db, e))?;
    std::io::copy(&mut f, &mut zw).map_err(|e| io_err("Cannot write", snapshot_db, e))?;
    drop(f);

    // notes/: rendered from the snapshot (current even when the mirror is off).
    // Links into _attachments/ are rewritten, but no files are copied there.
    let notes = staging.join(NOTES_DIR);
    let pages = {
        let db = Database::open_read_only(snapshot_db)?;
        db.set_attachments_dir(staging.join(".no-attachments"));
        crate::mirror::run(&db, &crate::mirror::MirrorTarget::new(&notes, None), true)?;
        db.list_pages(None)?.len()
    };
    let mut files = Vec::new();
    walk_files(&notes, &notes, &mut files);
    files.sort();
    for rel in files {
        if rel.starts_with(MIRROR_ATTACHMENTS) {
            continue;
        }
        let name = format!("{top}/{NOTES_DIR}/{}", rel_slash(&rel));
        zw.start_file(name, deflate).map_err(zip_err)?;
        let mut f = fs::File::open(notes.join(&rel)).map_err(|e| io_err("Cannot read", &rel, e))?;
        std::io::copy(&mut f, &mut zw).map_err(|e| io_err("Cannot write", &rel, e))?;
    }

    // attachments/
    let mut n_att = 0;
    if let Some(dir) = attachments.filter(|d| d.is_dir()) {
        let mut files = Vec::new();
        walk_files(dir, dir, &mut files);
        files.sort();
        for rel in files {
            // Only stored files (<2 hex>/<sha256>.<ext>), not temp files.
            if attachment_hash_of(&rel).is_none() {
                continue;
            }
            let src = dir.join(&rel);
            let len = fs::metadata(&src).map(|m| m.len()).unwrap_or(0);
            zw.start_file(format!("{top}/{ATTACHMENTS_DIR}/{}", rel_slash(&rel)), stored.large_file(big(len)))
                .map_err(zip_err)?;
            let mut f = fs::File::open(&src).map_err(|e| io_err("Cannot read", &src, e))?;
            std::io::copy(&mut f, &mut zw).map_err(|e| io_err("Cannot write", &src, e))?;
            n_att += 1;
        }
    }

    let mut out = zw.finish().map_err(zip_err)?;
    let bytes = out.stream_position().unwrap_or(0);
    out.flush().map_err(|e| io_err("Cannot write", Path::new("zip"), e))?;
    Ok(ExportSummary { name: meta.name.clone(), pages, attachments: n_att, bytes })
}

/// Export the notebook whose database is `conn` to the file `dest` (written
/// next to it under a temporary name, then renamed into place).
pub fn export_to_file(conn: &rusqlite::Connection, nb: &Notebook, dest: &Path) -> Result<ExportSummary> {
    let staging = staging_dir(dest.parent().unwrap_or(Path::new(".")))?;
    let res = (|| {
        let snap = snapshot(conn, &staging)?;
        write_snapshot_to_file(&snap, &export_meta(nb), attachments_of(conn).as_deref(), &staging, dest)
    })();
    let _ = fs::remove_dir_all(&staging);
    res
}

/// [`write_zip`] into `dest` atomically (temp file + rename).
pub fn write_snapshot_to_file(
    snapshot_db: &Path,
    meta: &NotebookMeta,
    attachments: Option<&Path>,
    staging: &Path,
    dest: &Path,
) -> Result<ExportSummary> {
    let parent = dest.parent().unwrap_or(Path::new("."));
    let tmp = parent.join(format!(".minotes-export-{}.minotes-tmp", Uuid::now_v7().simple()));
    let res = (|| {
        let f = fs::File::create(&tmp).map_err(|e| io_err("Cannot write", &tmp, e))?;
        let s = write_zip(snapshot_db, meta, attachments, staging, std::io::BufWriter::new(f))?;
        fs::rename(&tmp, dest).map_err(|e| io_err("Cannot write", dest, e))?;
        Ok(s)
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    res
}

/// The attachment store of an open database connection.
pub fn attachments_of(conn: &rusqlite::Connection) -> Option<PathBuf> {
    let p = conn.path().filter(|p| !p.is_empty())?;
    Some(crate::repo::attachments::attachments_dir_for_db(Path::new(p)))
}

/// A fresh scratch directory inside `parent`.
pub fn staging_dir(parent: &Path) -> Result<PathBuf> {
    let d = parent.join(format!(".minotes-staging-{}", Uuid::now_v7().simple()));
    fs::create_dir_all(&d).map_err(|e| io_err("Cannot create", &d, e))?;
    Ok(d)
}

fn walk_files(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        let p = e.path();
        if ft.is_dir() {
            walk_files(root, &p, out);
        } else if ft.is_file() {
            if let Ok(rel) = p.strip_prefix(root) {
                out.push(rel.to_path_buf());
            }
        }
    }
}

fn rel_slash(rel: &Path) -> String {
    rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/")
}

/// `ab/<sha256>.<ext>` → the hash, when the path is a stored attachment.
fn attachment_hash_of(rel: &Path) -> Option<String> {
    let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect();
    let [shard, file] = parts.as_slice() else { return None };
    let (hash, ext) = file.split_once('.')?;
    let ok = crate::repo::attachments::is_valid_hash(hash)
        && shard.as_str() == &hash[..2]
        && !ext.is_empty()
        && ext.len() <= 10
        && ext.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    ok.then(|| hash.to_string())
}

// ── Import ──

/// Caps an import enforces (actual bytes are counted while extracting).
#[derive(Debug, Clone)]
pub struct ImportLimits {
    pub max_entries: usize,
    /// Everything extracted, together.
    pub max_total_bytes: u64,
    pub max_db_bytes: u64,
}

impl Default for ImportLimits {
    fn default() -> Self {
        ImportLimits { max_entries: 200_000, max_total_bytes: 8 << 30, max_db_bytes: 4 << 30 }
    }
}

/// What an import made.
#[derive(Debug, Clone)]
pub struct ImportOutcome {
    pub notebook: Notebook,
    pub pages: usize,
    pub attachments: usize,
    /// Attachments left out (content did not match the name).
    pub skipped: Vec<String>,
    /// The archive's id or name was taken, so the new notebook got another.
    pub renamed_from: Option<String>,
    pub new_id: bool,
}

/// Is `name` a safe relative path inside the archive? (`enclosed_name` already
/// refuses escapes; this is stricter: no `..` at all, no `.`/empty segments
/// beyond a trailing `/`, no backslashes, drive letters or control characters.)
fn safe_entry_name(name: &str) -> bool {
    if name.is_empty() || name.starts_with('/') || name.contains('\\') || name.contains('\0') {
        return false;
    }
    if name.chars().any(|c| c.is_control()) {
        return false;
    }
    let trimmed = name.strip_suffix('/').unwrap_or(name);
    trimmed.split('/').all(|seg| !seg.is_empty() && seg != "." && seg != ".." && !seg.contains(':'))
        && Path::new(trimmed).components().all(|c| matches!(c, Component::Normal(_)))
}

struct Entry {
    index: usize,
    /// Path below the notebook root inside the archive.
    rel: String,
    size: u64,
}

/// Import a notebook archive as a new notebook (see the module docs). The new
/// folder goes into [`notebook::notebooks_dir`] (`~/MiNotes` / app storage).
pub fn import_zip(zip_path: &Path, limits: &ImportLimits) -> Result<ImportOutcome> {
    import_zip_into(zip_path, &notebook::notebooks_dir(), limits)
}

/// [`import_zip`] into the folder `parent`.
pub fn import_zip_into(zip_path: &Path, parent: &Path, limits: &ImportLimits) -> Result<ImportOutcome> {
    let file = fs::File::open(zip_path).map_err(|e| io_err("Cannot read", zip_path, e))?;
    let mut ar = zip::ZipArchive::new(std::io::BufReader::new(file)).map_err(zip_err)?;
    if ar.len() > limits.max_entries {
        return Err(Error::InvalidInput(format!(
            "The archive has too many files ({}; at most {})",
            ar.len(),
            limits.max_entries
        )));
    }

    // ── Check every entry before writing anything ──
    let mut names: Vec<(usize, String, u64, bool)> = Vec::with_capacity(ar.len());
    let mut seen = HashSet::new();
    for i in 0..ar.len() {
        let f = ar.by_index_raw(i).map_err(zip_err)?;
        let name = f.name().map_err(zip_err)?.to_string();
        if !safe_entry_name(&name) || f.enclosed_name().is_none() {
            return Err(Error::InvalidInput(format!("Refusing an unsafe path in the archive: {name:?}")));
        }
        if f.is_symlink() || f.unix_mode().map(|m| m & 0o170000 == 0o120000).unwrap_or(false) {
            return Err(Error::InvalidInput(format!("Refusing a symbolic link in the archive: {name}")));
        }
        if f.encrypted() {
            return Err(Error::InvalidInput(format!("Encrypted archives are not supported ({name})")));
        }
        let key = name.trim_end_matches('/').to_lowercase();
        if !f.is_dir() && !seen.insert(key) {
            return Err(Error::InvalidInput(format!("The archive lists {name} twice")));
        }
        names.push((i, name, f.size(), f.is_dir()));
    }

    // ── Where the notebook is inside: `notebook.minotes` or `<dir>/notebook.minotes` ──
    let dbs: Vec<&String> = names
        .iter()
        .filter(|(_, n, _, d)| !d && (n == DB_FILE || n.split('/').count() == 2 && n.ends_with(&format!("/{DB_FILE}"))))
        .map(|(_, n, _, _)| n)
        .collect();
    let prefix = match dbs.as_slice() {
        [one] => one.strip_suffix(DB_FILE).unwrap_or("").to_string(),
        [] => {
            return Err(Error::InvalidInput(
                "This zip is not a MiNotes notebook (no notebook.minotes inside)".into(),
            ))
        }
        _ => return Err(Error::InvalidInput("This zip holds more than one notebook".into())),
    };
    let top_name = prefix.trim_end_matches('/').to_string();

    let mut entries = Vec::new();
    let mut declared: u64 = 0;
    for (index, name, size, is_dir) in &names {
        if *is_dir {
            continue;
        }
        let Some(rel) = name.strip_prefix(&prefix) else { continue };
        let wanted = rel == DB_FILE
            || rel == META_FILE
            || rel.strip_prefix(&format!("{ATTACHMENTS_DIR}/")).map(|r| attachment_hash_of(Path::new(r)).is_some()).unwrap_or(false);
        if !wanted {
            continue; // notes/ (derived), .minotes/ (device-private), anything else
        }
        declared = declared.saturating_add(*size);
        entries.push(Entry { index: *index, rel: rel.to_string(), size: *size });
    }
    if declared > limits.max_total_bytes {
        return Err(Error::InvalidInput(format!(
            "The archive is too large to import ({} MB; at most {} MB)",
            declared >> 20,
            limits.max_total_bytes >> 20
        )));
    }

    // ── Extract into a staging folder next to the destination ──
    fs::create_dir_all(parent).map_err(|e| io_err("Cannot create", parent, e))?;
    let staging = parent.join(format!(".minotes-import-{}", Uuid::now_v7().simple()));
    fs::create_dir_all(&staging).map_err(|e| io_err("Cannot create", &staging, e))?;
    let res = extract_and_adopt(&mut ar, &entries, &staging, parent, &top_name, zip_path, limits);
    if res.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    res
}

#[allow(clippy::too_many_arguments)]
fn extract_and_adopt<R: Read + Seek>(
    ar: &mut zip::ZipArchive<R>,
    entries: &[Entry],
    staging: &Path,
    parent: &Path,
    top_name: &str,
    zip_path: &Path,
    limits: &ImportLimits,
) -> Result<ImportOutcome> {
    let mut total: u64 = 0;
    let mut skipped = Vec::new();
    let mut n_att = 0;
    for e in entries {
        let cap = if e.rel == DB_FILE { limits.max_db_bytes } else { limits.max_total_bytes };
        if e.size > cap {
            return Err(Error::InvalidInput(format!("{} is too large to import", e.rel)));
        }
        let dest = staging.join(&e.rel);
        if let Some(p) = dest.parent() {
            fs::create_dir_all(p).map_err(|er| io_err("Cannot create", p, er))?;
        }
        let mut f = ar.by_index(e.index).map_err(zip_err)?;
        let mut out = fs::File::create(&dest).map_err(|er| io_err("Cannot write", &dest, er))?;
        // Never trust the declared size: stop one byte past what is allowed.
        let budget = cap.min(limits.max_total_bytes.saturating_sub(total));
        let mut hasher = Sha256::new();
        let mut limited = (&mut f).take(budget.saturating_add(1));
        let mut buf = vec![0u8; 64 * 1024];
        let mut written: u64 = 0;
        loop {
            let n = limited.read(&mut buf).map_err(|er| Error::InvalidInput(format!("Damaged archive ({}): {er}", e.rel)))?;
            if n == 0 {
                break;
            }
            written += n as u64;
            if written > budget {
                return Err(Error::InvalidInput(format!(
                    "The archive expands beyond the import limit ({} MB) at {}",
                    limits.max_total_bytes >> 20,
                    e.rel
                )));
            }
            hasher.update(&buf[..n]);
            out.write_all(&buf[..n]).map_err(|er| io_err("Cannot write", &dest, er))?;
        }
        total += written;
        drop(out);
        if let Some(r) = e.rel.strip_prefix(&format!("{ATTACHMENTS_DIR}/")) {
            let want = attachment_hash_of(Path::new(r)).unwrap_or_default();
            let got = format!("{:x}", hasher.finalize());
            if got != want {
                let _ = fs::remove_file(&dest);
                skipped.push(r.to_string());
            } else {
                n_att += 1;
            }
        }
    }

    // ── The database: intact, and a MiNotes database ──
    let db_path = staging.join(DB_FILE);
    check_database(&db_path)?;
    // Bring it to this version's schema (and prove it opens), then close.
    let pages = {
        let db = Database::open(&db_path)?;
        let n = db.list_pages(None)?.len();
        let _ = notebook::checkpoint(&db);
        n
    };
    for f in ["notebook.minotes-wal", "notebook.minotes-shm"] {
        let _ = fs::remove_file(staging.join(f));
    }

    // ── Identity: never collide with a notebook we already know ──
    let fallback_name = if !top_name.is_empty() {
        top_name.to_string()
    } else {
        zip_path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.trim_end_matches(".zip").trim_end_matches(".minotes").to_string())
            .unwrap_or_else(|| "Imported notebook".into())
    };
    let mut meta = if staging.join(META_FILE).is_file() {
        read_meta(staging)?
    } else {
        NotebookMeta {
            name: fallback_name.clone(),
            id: Uuid::now_v7().to_string(),
            format_version: FORMAT_VERSION,
            mirror: Default::default(),
            created_at: Some(chrono::Utc::now().to_rfc3339()),
        }
    };
    if notebook::validate_name(&meta.name).is_err() {
        let cleaned: String = meta.name.chars().map(|c| if matches!(c, '/' | '\\' | '.') || c.is_control() { '_' } else { c }).collect();
        let cleaned: String = cleaned.trim().chars().take(100).collect();
        meta.name = if notebook::validate_name(&cleaned).is_ok() { cleaned } else { "Imported notebook".into() };
    }
    let known = notebook::list();
    let mut new_id = false;
    if Uuid::parse_str(&meta.id).is_err() || known.iter().any(|n| n.key == meta.id) || notebook::Registry::load().find(&meta.id).is_some() {
        meta.id = Uuid::now_v7().to_string();
        new_id = true;
    }
    let mut renamed_from = None;
    if known.iter().any(|n| n.name == meta.name) {
        renamed_from = Some(meta.name.clone());
        meta.name = notebook::unique_name(&meta.name);
    }

    // ── A folder of its own (never an existing one) ──
    let mut dest = parent.join(crate::repo::export::sanitize_component(&meta.name));
    let mut n = 2;
    while dest.exists() {
        dest = parent.join(format!("{} {n}", crate::repo::export::sanitize_component(&meta.name)));
        n += 1;
    }
    fs::create_dir_all(staging.join(NOTES_DIR)).map_err(|e| io_err("Cannot create", staging, e))?;
    fs::create_dir_all(staging.join(notebook::PRIVATE_DIR)).map_err(|e| io_err("Cannot create", staging, e))?;
    notebook::write_meta(staging, &meta)?;
    fs::rename(staging, &dest).map_err(|e| io_err("Cannot create", &dest, e))?;
    let nb = match notebook::register(&dest, &meta) {
        Ok(nb) => nb,
        Err(e) => {
            let _ = fs::remove_dir_all(&dest);
            return Err(e);
        }
    };
    Ok(ImportOutcome { notebook: nb, pages, attachments: n_att, skipped, renamed_from, new_id })
}

/// `PRAGMA integrity_check` + the tables a MiNotes database has.
pub fn check_database(path: &Path) -> Result<()> {
    let bad = |why: String| Error::InvalidInput(format!("The notebook database in the archive is damaged: {why}"));
    let conn = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| bad(e.to_string()))?;
    let check: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).map_err(|e| bad(e.to_string()))?;
    if check != "ok" {
        return Err(bad(check));
    }
    for t in ["pages", "blocks"] {
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1", [t], |r| r.get(0))
            .map_err(|e| bad(e.to_string()))?;
        if n == 0 {
            return Err(Error::InvalidInput(format!("This is not a MiNotes notebook database (no {t} table)")));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notebook::tests::FakeHome;

    fn make_notebook(home: &FakeHome, name: &str) -> (Notebook, Database) {
        let root = home.path().join("MiNotes").join(name);
        let nb = notebook::create_in_folder(&root, name).unwrap();
        let db = nb.open_db().unwrap();
        let p = db.create_page("Alpha", None, false, None, "test").unwrap();
        db.create_block(&p.id, "hello from alpha", None, None, "test").unwrap();
        let st = db.store_attachment_bytes("pic.png", Some("image/png"), b"\x89PNG fake image bytes").unwrap();
        db.create_block(&p.id, &crate::repo::attachments::reference(&st.attachment.hash, "pic.png", true), None, None, "test").unwrap();
        (nb, db)
    }

    fn export(home: &FakeHome, nb: &Notebook, db: &Database) -> PathBuf {
        let dest = home.path().join(format!("{}.zip", nb.name));
        export_to_file(&db.conn, nb, &dest).unwrap();
        dest
    }

    /// Build a zip from (name, bytes) pairs; `symlink` entries get a link mode.
    fn raw_zip(path: &Path, files: &[(&str, &[u8])]) {
        let mut zw = zip::ZipWriter::new(fs::File::create(path).unwrap());
        for (n, b) in files {
            zw.start_file(*n, SimpleFileOptions::default()).unwrap();
            zw.write_all(b).unwrap();
        }
        zw.finish().unwrap();
    }

    fn valid_db_bytes(home: &FakeHome) -> Vec<u8> {
        let p = home.path().join("plain.minotes");
        drop(Database::open(&p).unwrap());
        fs::read(&p).unwrap()
    }

    #[test]
    fn round_trip_keeps_pages_and_attachments_and_gets_new_identity() {
        let home = FakeHome::new();
        let (nb, db) = make_notebook(&home, "Trip");
        let zip = export(&home, &nb, &db);

        // The archive: a notebook folder with notes/ but no _attachments or private state.
        let mut ar = zip::ZipArchive::new(fs::File::open(&zip).unwrap()).unwrap();
        let names: Vec<String> = (0..ar.len()).map(|i| ar.by_index(i).unwrap().name().unwrap().to_string()).collect();
        assert!(names.contains(&"Trip/notebook.minotes".to_string()), "{names:?}");
        assert!(names.contains(&"Trip/notebook.json".to_string()));
        assert!(names.iter().any(|n| n == "Trip/notes/Alpha.md"), "{names:?}");
        assert!(names.iter().any(|n| n.starts_with("Trip/attachments/")));
        assert!(!names.iter().any(|n| n.contains("_attachments") || n.contains(".minotes/")));

        // Importing next to the original: new id, new name, new folder.
        let out = import_zip(&zip, &ImportLimits::default()).unwrap();
        assert!(out.new_id);
        assert_eq!(out.renamed_from.as_deref(), Some("Trip"));
        assert_eq!(out.notebook.name, "Trip 2");
        assert_ne!(out.notebook.key, nb.key);
        let root = out.notebook.root().unwrap().to_path_buf();
        assert_eq!(root, home.path().join("MiNotes").join("Trip 2"));
        assert_eq!(out.attachments, 1);
        assert!(root.join(notebook::NOTES_DIR).is_dir() && root.join(notebook::PRIVATE_DIR).is_dir());
        // Original untouched.
        assert_eq!(read_meta(nb.root().unwrap()).unwrap().name, "Trip");

        let db2 = out.notebook.open_db().unwrap();
        let tree = db2.get_page_by_title("Alpha").unwrap().unwrap();
        let blocks = db2.get_page_blocks(&tree.id).unwrap();
        assert!(blocks.iter().any(|b| b.content == "hello from alpha"));
        let hash = crate::repo::attachments::attachment_hashes(&blocks.iter().map(|b| b.content.clone()).collect::<Vec<_>>().join("\n"))
            .into_iter()
            .next()
            .unwrap();
        let f = db2.attachment_file(&hash).expect("attachment restored");
        assert_eq!(fs::read(f).unwrap(), b"\x89PNG fake image bytes");
        assert!(notebook::list().iter().any(|n| n.key == out.notebook.key && n.available));
    }

    #[test]
    fn import_on_another_device_keeps_id_and_name() {
        let home = FakeHome::new();
        let (nb, db) = make_notebook(&home, "Shared");
        let zip = home.path().join("x.zip");
        export_to_file(&db.conn, &nb, &zip).unwrap();
        drop(db);
        // "Another device": the notebook is not known here.
        notebook::forget(&nb.key).unwrap();
        fs::rename(nb.root().unwrap(), home.path().join("elsewhere")).unwrap();
        let out = import_zip(&zip, &ImportLimits::default()).unwrap();
        assert!(!out.new_id);
        assert_eq!(out.notebook.key, nb.key);
        assert_eq!(out.notebook.name, "Shared");
        assert!(out.renamed_from.is_none());
    }

    #[test]
    fn legacy_notebook_exports_with_a_description() {
        let home = FakeHome::new();
        let nb = Notebook::legacy("default");
        let db = nb.open_db().unwrap();
        let p = db.create_page("Legacy", None, false, None, "test").unwrap();
        db.create_block(&p.id, "old data", None, None, "t").unwrap();
        let zip = home.path().join("legacy.zip");
        let s = export_to_file(&db.conn, &nb, &zip).unwrap();
        assert!(s.pages >= 1 && s.bytes > 0);
        let out = import_zip(&zip, &ImportLimits::default()).unwrap();
        assert!(out.notebook.is_folder());
        assert_eq!(out.notebook.name, "default 2"); // "default" is taken by the legacy one
        let db2 = out.notebook.open_db().unwrap();
        assert!(db2.get_page_by_title("Legacy").unwrap().is_some());
    }

    #[test]
    fn read_only_connection_can_be_exported() {
        let home = FakeHome::new();
        let (nb, db) = make_notebook(&home, "Ro");
        drop(db);
        let ro = Database::open_read_only(&nb.db_path()).unwrap();
        let zip = home.path().join("ro.zip");
        export_to_file(&ro.conn, &nb, &zip).unwrap();
        assert!(ro.is_read_only(), "query_only restored");
    }

    #[test]
    fn rejects_path_traversal_and_writes_nothing() {
        let home = FakeHome::new();
        let db = valid_db_bytes(&home);
        for evil in ["../evil.txt", "N/../../evil.txt", "/abs/evil.txt", "N\\..\\evil.txt", "C:/evil.txt", "N/./x"] {
            let z = home.path().join("evil.zip");
            raw_zip(&z, &[("N/notebook.minotes", &db), (evil, b"pwned")]);
            let err = import_zip(&z, &ImportLimits::default()).unwrap_err().to_string();
            assert!(err.contains("unsafe path"), "{evil}: {err}");
        }
        assert!(!home.path().join("evil.txt").exists());
        assert!(!home.path().join("MiNotes").exists() || fs::read_dir(home.path().join("MiNotes")).unwrap().next().is_none());
    }

    #[test]
    fn rejects_symlinks() {
        let home = FakeHome::new();
        let db = valid_db_bytes(&home);
        let z = home.path().join("link.zip");
        let mut zw = zip::ZipWriter::new(fs::File::create(&z).unwrap());
        zw.start_file("N/notebook.minotes", SimpleFileOptions::default()).unwrap();
        zw.write_all(&db).unwrap();
        zw.add_symlink("N/attachments", "/etc", SimpleFileOptions::default()).unwrap();
        zw.finish().unwrap();
        let err = import_zip(&z, &ImportLimits::default()).unwrap_err().to_string();
        assert!(err.contains("symbolic link"), "{err}");
    }

    #[test]
    fn rejects_oversize_and_zip_bombs() {
        let home = FakeHome::new();
        let db = valid_db_bytes(&home);
        let z = home.path().join("big.zip");
        let zeros = vec![0u8; 3 << 20]; // compresses to almost nothing
        let mut zw = zip::ZipWriter::new(fs::File::create(&z).unwrap());
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        zw.start_file("N/notebook.minotes", opts).unwrap();
        zw.write_all(&db).unwrap();
        let h = format!("{:x}", Sha256::digest(&zeros));
        zw.start_file(format!("N/attachments/{}/{h}.bin", &h[..2]), opts).unwrap();
        zw.write_all(&zeros).unwrap();
        zw.finish().unwrap();
        let small = ImportLimits { max_total_bytes: 1 << 20, ..Default::default() };
        let err = import_zip(&z, &small).unwrap_err().to_string();
        assert!(err.contains("too large") || err.contains("beyond"), "{err}");
        let few = ImportLimits { max_entries: 1, ..Default::default() };
        assert!(import_zip(&z, &few).unwrap_err().to_string().contains("too many files"));
        // Within the limits it imports, and the attachment checks out.
        let out = import_zip(&z, &ImportLimits::default()).unwrap();
        assert_eq!(out.attachments, 1);
        // Staging folders are cleaned up after the failures.
        let left: Vec<_> = fs::read_dir(home.path().join("MiNotes")).unwrap().flatten()
            .map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n.starts_with('.')).collect();
        assert!(left.is_empty(), "{left:?}");
    }

    #[test]
    fn a_lying_declared_size_is_caught_while_extracting() {
        let home = FakeHome::new();
        let db = valid_db_bytes(&home);
        let zeros = vec![0u8; 3 << 20];
        let h = format!("{:x}", Sha256::digest(&zeros));
        let z = home.path().join("liar.zip");
        let mut zw = zip::ZipWriter::new(fs::File::create(&z).unwrap());
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        zw.start_file("N/notebook.minotes", opts).unwrap();
        zw.write_all(&db).unwrap();
        zw.start_file(format!("N/attachments/{}/{h}.bin", &h[..2]), opts).unwrap();
        zw.write_all(&zeros).unwrap();
        zw.finish().unwrap();
        // Claim the 3 MB entry is 10 bytes, in both the local and central headers.
        let mut bytes = fs::read(&z).unwrap();
        let want = (3u32 << 20).to_le_bytes();
        let mut patched = 0;
        for i in 0..bytes.len().saturating_sub(4) {
            if bytes[i..i + 4] == want {
                bytes[i..i + 4].copy_from_slice(&10u32.to_le_bytes());
                patched += 1;
            }
        }
        assert!(patched >= 2, "patched {patched}");
        fs::write(&z, &bytes).unwrap();
        let limits = ImportLimits { max_total_bytes: 1 << 20, ..Default::default() };
        let err = import_zip(&z, &limits).unwrap_err().to_string();
        assert!(err.contains("beyond the import limit") || err.contains("Damaged"), "{err}");
        assert!(notebook::list().is_empty());
    }

    #[test]
    fn rejects_corrupt_or_foreign_databases() {
        let home = FakeHome::new();
        let z = home.path().join("bad.zip");
        raw_zip(&z, &[("N/notebook.minotes", b"this is not sqlite at all, just text")]);
        assert!(import_zip(&z, &ImportLimits::default()).unwrap_err().to_string().contains("damaged"));

        // A valid SQLite file that is not a MiNotes database.
        let other = home.path().join("other.sqlite");
        rusqlite::Connection::open(&other).unwrap().execute_batch("CREATE TABLE t(x); INSERT INTO t VALUES (1);").unwrap();
        raw_zip(&z, &[("N/notebook.minotes", &fs::read(&other).unwrap())]);
        assert!(import_zip(&z, &ImportLimits::default()).unwrap_err().to_string().contains("not a MiNotes"));

        // A damaged MiNotes database (page bytes overwritten).
        let mut db = valid_db_bytes(&home);
        let len = db.len();
        for b in &mut db[len / 2..len / 2 + 2048.min(len / 2)] {
            *b = 0xAB;
        }
        raw_zip(&z, &[("N/notebook.minotes", &db)]);
        assert!(import_zip(&z, &ImportLimits::default()).is_err());

        // Not a notebook at all / not a zip.
        raw_zip(&z, &[("readme.txt", b"hi")]);
        assert!(import_zip(&z, &ImportLimits::default()).unwrap_err().to_string().contains("not a MiNotes notebook"));
        fs::write(&z, b"PK garbage").unwrap();
        assert!(import_zip(&z, &ImportLimits::default()).is_err());
        assert!(notebook::list().iter().all(|n| n.kind == "legacy"));
    }

    #[test]
    fn mismatched_attachment_is_skipped_and_private_files_ignored() {
        let home = FakeHome::new();
        let db = valid_db_bytes(&home);
        let h = "a".repeat(64);
        let z = home.path().join("mix.zip");
        raw_zip(&z, &[
            ("notebook.minotes", &db),
            (&format!("attachments/aa/{h}.png"), b"not matching the hash"),
            (".minotes/lock.json", b"{\"pid\":1}"),
            ("notes/Page.md", b"# hi"),
        ]);
        let out = import_zip(&z, &ImportLimits::default()).unwrap();
        assert_eq!(out.skipped, vec![format!("aa/{h}.png")]);
        let root = out.notebook.root().unwrap();
        assert!(!root.join(".minotes/lock.json").exists());
        assert!(!root.join("notes/Page.md").exists());
        assert_eq!(out.notebook.name, "mix"); // no notebook.json: named after the file
    }

    #[test]
    fn never_overwrites_an_existing_folder() {
        let home = FakeHome::new();
        let (nb, db) = make_notebook(&home, "Keep");
        let zip = export(&home, &nb, &db);
        // Occupy the folder the copy would get.
        fs::create_dir_all(home.path().join("MiNotes").join("Keep 2")).unwrap();
        fs::write(home.path().join("MiNotes").join("Keep 2").join("mine.txt"), "x").unwrap();
        let out = import_zip(&zip, &ImportLimits::default()).unwrap();
        assert_eq!(out.notebook.root().unwrap(), home.path().join("MiNotes").join("Keep 2 2"));
        assert_eq!(fs::read_to_string(home.path().join("MiNotes/Keep 2/mine.txt")).unwrap(), "x");
    }

    #[test]
    fn app_storage_paths_and_import() {
        let home = FakeHome::new();
        let app = home.path().join("data/user/0/com.minotes.app");
        let _g = crate::notebook::tests::AppStorage::set(&app);
        assert_eq!(notebook::base_dir(), app);
        assert_eq!(notebook::home_dir(), app);
        assert_eq!(notebook::default_location("Work"), app.join("notebooks/Work"));
        assert_eq!(notebook::legacy_mirror_dir("default"), app.join("MiNotes_Sync"));
        assert_eq!(Notebook::legacy("default").db_path(), app.join("default.db"));
        assert_eq!(crate::sync_manager::sync_dir_for_notebook("default"), app.join("MiNotes_Sync"));
        assert_eq!(notebook::Registry::path(), app.join(notebook::REGISTRY_FILE));
        assert_eq!(crate::repo::attachments::attachments_dir_for_db(&Notebook::legacy("default").db_path()), app.join("default.attachments"));

        let nb = notebook::create_in_folder(&notebook::default_location("Work"), "Work").unwrap();
        assert!(nb.db_path().starts_with(&app));
        // The mirror is off in app storage unless git sync is on.
        assert!(!nb.mirror_enabled());
        assert!(!Notebook::legacy("default").mirror_enabled());
        fs::write(nb.sync_config_path(), r#"{"enabled":true}"#).unwrap();
        assert!(nb.mirror_enabled());

        let db = nb.open_db().unwrap();
        let p = db.create_page("Phone page", None, false, None, "test").unwrap();
        db.create_block(&p.id, "written on the phone", None, None, "t").unwrap();
        let zip = home.path().join("phone.zip");
        export_to_file(&db.conn, &nb, &zip).unwrap();
        let out = import_zip(&zip, &ImportLimits::default()).unwrap();
        assert_eq!(out.notebook.root().unwrap(), app.join("notebooks/Work 2"));
        // Nothing was written outside app storage (except the zip we asked for).
        let outside: Vec<_> = fs::read_dir(home.path()).unwrap().flatten()
            .map(|e| e.file_name().to_string_lossy().to_string()).collect();
        let mut outside = outside;
        outside.sort();
        assert_eq!(outside, vec!["data".to_string(), "phone.zip".to_string()]);
    }
}
