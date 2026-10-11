//! Attachment store (PRD-import §5).
//!
//! Files are content-addressed: `<store>/<sha256[0..2]>/<sha256>.<ext>`, so an
//! identical file is stored once, and a file's location is derived from its hash
//! alone (nothing a block contains can steer a read outside the store). The
//! store lives next to the database:
//!
//! - folder notebooks: `<notebook>/attachments/`
//! - legacy notebooks: `~/.minotes/<name>.attachments/`
//!
//! The `attachments` table records `hash, name, mime, ext, size, created_at`;
//! `block_attachments` joins blocks to the hashes their content references.
//!
//! Block content references an attachment as `![alt](attachment:<hash>/<name>)`
//! (images) or `[name](attachment:<hash>/<name>)` (other files). `<name>` is the
//! percent-encoded file name (see [`encode_name`]); only the hash identifies
//! the file, so a reference stays valid whatever the page is renamed to.
//!
//! Garbage collection ([`Database::gc_attachments`]) follows the whiteboard
//! rule: an attachment is kept while any block (live, trashed or archived), a
//! template, or an undo-able event references it.

use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use chrono::Utc;
use rusqlite::OptionalExtension;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::db::Database;
use crate::error::{Error, Result};

/// Per-file cap (PRD §5 "Limits").
pub const MAX_ATTACHMENT_BYTES: u64 = 200 * 1024 * 1024;
/// Files above this are left out of git sync (with a warning).
pub const GIT_SYNC_MAX_BYTES: u64 = 50 * 1024 * 1024;
/// Directory inside the markdown mirror that carries the attachments.
pub const MIRROR_DIR: &str = "_attachments";
/// Attachments younger than this are never collected (a pasted image is stored
/// a moment before the block that references it is saved).
const GC_GRACE_SECS: i64 = 600;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS attachments (
    hash        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    mime        TEXT NOT NULL,
    ext         TEXT NOT NULL,
    size        INTEGER NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS block_attachments (
    block_id    TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    hash        TEXT NOT NULL,
    PRIMARY KEY (block_id, hash)
);
CREATE INDEX IF NOT EXISTS idx_block_attachments_hash ON block_attachments(hash);
";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Attachment {
    pub hash: String,
    pub name: String,
    pub mime: String,
    pub ext: String,
    pub size: u64,
    pub created_at: String,
}

impl Attachment {
    pub fn is_image(&self) -> bool {
        is_image_mime(&self.mime)
    }
    /// The markdown that references this attachment in a block.
    pub fn markdown(&self) -> String {
        reference(&self.hash, &self.name, self.is_image())
    }
}

/// Result of storing a file.
#[derive(Debug, Clone, Serialize)]
pub struct Stored {
    pub attachment: Attachment,
    /// False when the same content was already in the store (deduplicated).
    pub created: bool,
}

/// A sha256 in lowercase hex — the only thing that may name a stored file.
pub fn is_valid_hash(h: &str) -> bool {
    h.len() == 64 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The attachment store of the database at `db_path`.
pub fn attachments_dir_for_db(db_path: &Path) -> PathBuf {
    let parent = db_path.parent().unwrap_or(Path::new("."));
    let file = db_path.file_name().and_then(|n| n.to_str()).unwrap_or("graph");
    if file == crate::notebook::DB_FILE {
        return parent.join("attachments");
    }
    let stem = file.strip_suffix(".db").unwrap_or(file);
    parent.join(format!("{stem}.attachments"))
}

fn valid_ext(e: &str) -> bool {
    !e.is_empty() && e.len() <= 10 && e.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// Where a stored file lives.
pub fn file_path(dir: &Path, hash: &str, ext: &str) -> PathBuf {
    dir.join(&hash[..2]).join(format!("{hash}.{ext}"))
}

/// Find the stored file for `hash` (any extension) without a database.
/// `None` for an invalid hash, a missing file, or anything that isn't a plain
/// file (symlinks are refused).
pub fn find_file(dir: &Path, hash: &str) -> Option<PathBuf> {
    if !is_valid_hash(hash) {
        return None;
    }
    let sub = dir.join(&hash[..2]);
    let prefix = format!("{hash}.");
    for e in fs::read_dir(&sub).ok()?.flatten() {
        let name = e.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(ext) = name.strip_prefix(&prefix) else { continue };
        if !valid_ext(ext) {
            continue;
        }
        let path = e.path();
        if fs::symlink_metadata(&path).map(|m| m.file_type().is_file()).unwrap_or(false) {
            return Some(path);
        }
    }
    None
}

/// File extension for a stored file: the name's own extension when it is a
/// plain short one, else one derived from the mime type, else `bin`.
pub fn sanitize_ext(name: &str, mime: Option<&str>) -> String {
    if let Some((_, e)) = name.rsplit_once('.') {
        let e = e.to_ascii_lowercase();
        if valid_ext(&e) {
            return e;
        }
    }
    let from_mime = match mime.unwrap_or("") {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "image/bmp" => "bmp",
        "image/heic" => "heic",
        "image/tiff" => "tiff",
        "application/pdf" => "pdf",
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/ogg" => "ogg",
        "audio/mp4" | "audio/m4a" | "audio/x-m4a" => "m4a",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        "text/plain" => "txt",
        "text/html" => "html",
        "application/json" => "json",
        "application/zip" => "zip",
        _ => "bin",
    };
    from_mime.to_string()
}

/// Mime type for an extension (what the protocol serves and the table records
/// when the source gave none).
pub fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "heic" => "image/heic",
        "tif" | "tiff" => "image/tiff",
        "pdf" => "application/pdf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "txt" | "md" | "log" => "text/plain",
        "csv" => "text/csv",
        "json" | "canvas" => "application/json",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

pub fn is_image_mime(mime: &str) -> bool {
    mime.starts_with("image/")
}

/// Percent-encode a file name for a reference: the name is first made a safe
/// path component, then every byte outside `A-Z a-z 0-9 - . _ ~` is encoded,
/// so it can't end the markdown link and decodes to the mirror's file name.
pub fn encode_name(name: &str) -> String {
    let safe = crate::repo::export::sanitize_component(name.trim());
    let mut out = String::with_capacity(safe.len());
    for b in safe.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Inverse of [`encode_name`] (lossy on invalid UTF-8).
pub fn decode_name(enc: &str) -> String {
    let b = enc.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&enc[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn link_text(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '[' | ']' => '_',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect::<String>()
        .trim()
        .to_string()
}

/// `![name](attachment:<hash>/<enc>)` for images, `[name](attachment:<hash>/<enc>)`
/// for other files.
pub fn reference(hash: &str, name: &str, image: bool) -> String {
    let text = link_text(name);
    let url = format!("attachment:{hash}/{}", encode_name(name));
    if image {
        format!("![{text}]({url})")
    } else {
        format!("[{text}]({url})")
    }
}

/// Every attachment reference in `text`: (hash, encoded name if present).
pub fn attachment_refs(text: &str) -> Vec<(String, Option<String>)> {
    const OPEN: &str = "attachment:";
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find(OPEN) {
        rest = &rest[i + OPEN.len()..];
        if rest.len() < 64 || !is_valid_hash(&rest[..64]) {
            continue;
        }
        let hash = rest[..64].to_string();
        rest = &rest[64..];
        let name = rest.strip_prefix('/').map(|after| {
            let end = after
                .find(|c: char| c == ')' || c == '"' || c == '\'' || c == '>' || c == ']' || c.is_whitespace())
                .unwrap_or(after.len());
            after[..end].to_string()
        });
        out.push((hash, name.filter(|n| !n.is_empty())));
    }
    out
}

/// Just the hashes referenced in `text`.
pub fn attachment_hashes(text: &str) -> HashSet<String> {
    attachment_refs(text).into_iter().map(|(h, _)| h).collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn io_err(what: &str, p: &Path, e: std::io::Error) -> Error {
    Error::InvalidInput(format!("{what} {}: {e}", p.display()))
}

fn too_large(name: &str, size: u64) -> Error {
    Error::InvalidInput(format!(
        "'{name}' is {} MB — attachments are limited to {} MB",
        size / (1024 * 1024),
        MAX_ATTACHMENT_BYTES / (1024 * 1024)
    ))
}

/// Move a finished temp file to its content-addressed place (or drop it if the
/// content is already stored with the right size).
fn place(dir: &Path, tmp: &Path, hash: &str, ext: &str, size: u64) -> Result<()> {
    let dest = file_path(dir, hash, ext);
    let existing = find_file(dir, hash);
    if existing.filter(|p| fs::metadata(p).map(|m| m.len() == size).unwrap_or(false)).is_some() {
        let _ = fs::remove_file(tmp);
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| io_err("Cannot create", parent, e))?;
    }
    fs::rename(tmp, &dest).map_err(|e| {
        let _ = fs::remove_file(tmp);
        io_err("Cannot store attachment", &dest, e)
    })
}

fn temp_path(dir: &Path) -> PathBuf {
    dir.join(format!(".incoming-{}.minotes-tmp", uuid::Uuid::now_v7().simple()))
}

impl Database {
    /// Idempotent migration: the attachment tables.
    pub fn migrate_attachments(&self) -> Result<()> {
        self.conn.execute_batch(SCHEMA)?;
        Ok(())
    }

    /// Use `dir` as this database's attachment store (in-memory databases and
    /// tests; on-disk databases derive it from their path).
    pub fn set_attachments_dir(&self, dir: impl Into<PathBuf>) {
        *self.attachments_override.borrow_mut() = Some(dir.into());
    }

    /// The attachment store directory, if this database has one.
    pub fn attachments_dir(&self) -> Option<PathBuf> {
        if let Some(d) = self.attachments_override.borrow().clone() {
            return Some(d);
        }
        let p = self.conn.path().filter(|p| !p.is_empty())?;
        Some(attachments_dir_for_db(Path::new(p)))
    }

    fn require_store(&self) -> Result<PathBuf> {
        let dir = self
            .attachments_dir()
            .ok_or_else(|| Error::InvalidInput("This notebook has no attachment store".into()))?;
        fs::create_dir_all(&dir).map_err(|e| io_err("Cannot create", &dir, e))?;
        Ok(dir)
    }

    /// Store `bytes` as an attachment named `name`.
    pub fn store_attachment_bytes(&self, name: &str, mime: Option<&str>, bytes: &[u8]) -> Result<Stored> {
        if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
            return Err(too_large(name, bytes.len() as u64));
        }
        let dir = self.require_store()?;
        let hash = hex(&Sha256::digest(bytes));
        let ext = sanitize_ext(name, mime);
        if find_file(&dir, &hash).filter(|p| fs::metadata(p).map(|m| m.len() == bytes.len() as u64).unwrap_or(false)).is_none() {
            let tmp = temp_path(&dir);
            let mut f = fs::File::create(&tmp).map_err(|e| io_err("Cannot write", &tmp, e))?;
            f.write_all(bytes).and_then(|_| f.flush()).map_err(|e| {
                let _ = fs::remove_file(&tmp);
                io_err("Cannot write", &tmp, e)
            })?;
            drop(f);
            place(&dir, &tmp, &hash, &ext, bytes.len() as u64)?;
        }
        self.register_attachment(&hash, name, mime, &ext, bytes.len() as u64)
    }

    /// Store the file at `path` (streamed: hashed while it is copied, never
    /// held in memory). `name` defaults to the file's own name.
    pub fn store_attachment_file(&self, path: &Path, name: Option<&str>, mime: Option<&str>) -> Result<Stored> {
        let meta = fs::metadata(path).map_err(|e| io_err("Cannot read", path, e))?;
        if !meta.is_file() {
            return Err(Error::InvalidInput(format!("{} is not a file", path.display())));
        }
        let own = path.file_name().and_then(|n| n.to_str()).unwrap_or("file").to_string();
        let name = name.unwrap_or(&own).to_string();
        if meta.len() > MAX_ATTACHMENT_BYTES {
            return Err(too_large(&name, meta.len()));
        }
        let dir = self.require_store()?;
        let tmp = temp_path(&dir);
        let res = (|| -> Result<(String, u64)> {
            let mut src = fs::File::open(path).map_err(|e| io_err("Cannot read", path, e))?;
            let mut out = fs::File::create(&tmp).map_err(|e| io_err("Cannot write", &tmp, e))?;
            let mut hasher = Sha256::new();
            let mut buf = vec![0u8; 256 * 1024];
            let mut size = 0u64;
            loop {
                let n = src.read(&mut buf).map_err(|e| io_err("Cannot read", path, e))?;
                if n == 0 {
                    break;
                }
                size += n as u64;
                if size > MAX_ATTACHMENT_BYTES {
                    return Err(too_large(&name, size));
                }
                hasher.update(&buf[..n]);
                out.write_all(&buf[..n]).map_err(|e| io_err("Cannot write", &tmp, e))?;
            }
            out.flush().map_err(|e| io_err("Cannot write", &tmp, e))?;
            Ok((hex(&hasher.finalize()), size))
        })();
        let (hash, size) = match res {
            Ok(v) => v,
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                return Err(e);
            }
        };
        let ext = sanitize_ext(&name, mime);
        place(&dir, &tmp, &hash, &ext, size)?;
        self.register_attachment(&hash, &name, mime, &ext, size)
    }

    /// Adopt a file that is already at its content-addressed place in the store
    /// (written by a streaming reader). Verifies the hash.
    pub(crate) fn register_attachment(
        &self,
        hash: &str,
        name: &str,
        mime: Option<&str>,
        ext: &str,
        size: u64,
    ) -> Result<Stored> {
        if let Some(a) = self.get_attachment(hash)? {
            return Ok(Stored { attachment: a, created: false });
        }
        let name = crate::repo::pages::normalize_name(name).unwrap_or_else(|| format!("file.{ext}"));
        let mime = mime
            .filter(|m| !m.is_empty() && m.len() < 128 && !m.contains(['\n', '\r']))
            .map(str::to_string)
            .unwrap_or_else(|| mime_for_ext(ext).to_string());
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "INSERT INTO attachments (hash, name, mime, ext, size, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![hash, name, mime, ext, size as i64, now],
        )?;
        Ok(Stored {
            attachment: Attachment { hash: hash.to_string(), name, mime, ext: ext.to_string(), size, created_at: now },
            created: true,
        })
    }

    pub fn get_attachment(&self, hash: &str) -> Result<Option<Attachment>> {
        if !is_valid_hash(hash) {
            return Ok(None);
        }
        Ok(self
            .conn
            .query_row(
                "SELECT hash, name, mime, ext, size, created_at FROM attachments WHERE hash = ?1",
                [hash],
                row_to_attachment,
            )
            .optional()?)
    }

    pub fn list_attachments(&self) -> Result<Vec<Attachment>> {
        let mut stmt = self
            .conn
            .prepare("SELECT hash, name, mime, ext, size, created_at FROM attachments ORDER BY created_at, hash")?;
        let rows = stmt.query_map([], row_to_attachment)?.collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// The stored file of an attachment (derived from its hash only).
    pub fn attachment_file(&self, hash: &str) -> Option<PathBuf> {
        find_file(&self.attachments_dir()?, hash)
    }

    /// Keep `block_attachments` in step with a block's content. Called with the
    /// link sync, inside the same transaction as the content write.
    pub(crate) fn sync_block_attachments(&self, block_id: &uuid::Uuid, content: &str) -> Result<()> {
        let id = block_id.to_string();
        self.conn.execute("DELETE FROM block_attachments WHERE block_id = ?1", [&id])?;
        if content.contains("attachment:") {
            for h in attachment_hashes(content) {
                self.conn.execute(
                    "INSERT OR IGNORE INTO block_attachments (block_id, hash) VALUES (?1, ?2)",
                    rusqlite::params![id, h],
                )?;
            }
        }
        Ok(())
    }

    /// Hashes something can still bring back: block content (live, trashed,
    /// archived pages alike), templates, and not-yet-undone events whose undo
    /// restores content (the whiteboard rule, see `gc_whiteboards`).
    pub(crate) fn referenced_attachment_hashes(&self) -> Result<HashSet<String>> {
        let mut referenced = HashSet::new();
        for sql in [
            "SELECT content FROM blocks WHERE content LIKE '%attachment:%'",
            "SELECT content FROM templates WHERE content LIKE '%attachment:%'",
            "SELECT payload FROM events
              WHERE undone = 0 AND event_type = 'block.deleted' AND payload LIKE '%attachment:%'",
            "SELECT json_extract(payload, '$.previous_content') FROM events
              WHERE undone = 0 AND event_type = 'block.updated' AND json_valid(payload)
                AND json_extract(payload, '$.previous_content') LIKE '%attachment:%'",
        ] {
            let mut stmt = self.conn.prepare(sql)?;
            for text in stmt.query_map([], |r| r.get::<_, String>(0))? {
                referenced.extend(attachment_hashes(&text?));
            }
        }
        Ok(referenced)
    }

    /// Delete attachments nothing can reach any more (rows and files).
    /// Attachments stored in the last few minutes are kept (their block may not
    /// be saved yet). Returns the deleted hashes.
    pub fn gc_attachments(&self) -> Result<Vec<String>> {
        let referenced = self.referenced_attachment_hashes()?;
        let cutoff = (Utc::now() - chrono::Duration::seconds(GC_GRACE_SECS)).to_rfc3339();
        let candidates: Vec<String> = {
            let mut stmt = self.conn.prepare("SELECT hash FROM attachments WHERE created_at < ?1")?;
            let rows = stmt.query_map([&cutoff], |r| r.get::<_, String>(0))?.collect::<std::result::Result<Vec<_>, _>>()?;
            rows
        };
        let mut deleted = Vec::new();
        for h in candidates {
            if referenced.contains(&h) {
                continue;
            }
            self.delete_attachment_raw(&h)?;
            deleted.push(h);
        }
        Ok(deleted)
    }

    /// Remove an attachment's row and file (no reference check).
    pub(crate) fn delete_attachment_raw(&self, hash: &str) -> Result<()> {
        if !is_valid_hash(hash) {
            return Ok(());
        }
        self.conn.execute("DELETE FROM attachments WHERE hash = ?1", [hash])?;
        self.conn.execute("DELETE FROM block_attachments WHERE hash = ?1", [hash])?;
        if let Some(dir) = self.attachments_dir() {
            if let Some(p) = find_file(&dir, hash) {
                let _ = fs::remove_file(&p);
                if let Some(parent) = p.parent() {
                    let _ = fs::remove_dir(parent); // only when empty
                }
            }
        }
        Ok(())
    }

    pub(crate) fn gc_attachments_quietly(&self) {
        if let Err(e) = self.gc_attachments() {
            eprintln!("[minotes] attachment GC failed: {e}");
        }
    }
}

fn row_to_attachment(r: &rusqlite::Row<'_>) -> rusqlite::Result<Attachment> {
    Ok(Attachment {
        hash: r.get(0)?,
        name: r.get(1)?,
        mime: r.get(2)?,
        ext: r.get(3)?,
        size: r.get::<_, i64>(4)? as u64,
        created_at: r.get(5)?,
    })
}

// ── Mirror / sync support ──

/// Relative path (from a page file `depth` directories below the mirror root)
/// to a mirrored attachment: `../../_attachments/<hash>/<enc name>`.
pub fn mirror_link(depth: usize, hash: &str, enc_name: &str) -> String {
    format!("{}{MIRROR_DIR}/{hash}/{enc_name}", "../".repeat(depth))
}

/// Rewrite `attachment:<hash>/<enc>` references in a page's markdown to
/// relative mirror paths. Returns the rewritten text and the (hash, enc name)
/// pairs it points at. Exact inverse: [`unrewrite_mirror_links`].
pub fn rewrite_for_mirror(md: &str, depth: usize) -> (String, Vec<(String, String)>) {
    if !md.contains("attachment:") {
        return (md.to_string(), Vec::new());
    }
    let mut out = String::with_capacity(md.len());
    let mut used = Vec::new();
    let mut rest = md;
    const OPEN: &str = "](attachment:";
    while let Some(i) = rest.find(OPEN) {
        out.push_str(&rest[..i + 2]);
        let after = &rest[i + OPEN.len()..];
        let ok = after.len() > 65 && is_valid_hash(&after[..64]) && after.as_bytes()[64] == b'/';
        if ok {
            let tail = &after[65..];
            let end = tail.find(|c: char| c == ')' || c.is_whitespace()).unwrap_or(tail.len());
            let enc = &tail[..end];
            if !enc.is_empty() && !enc.contains('/') {
                let hash = &after[..64];
                out.push_str(&mirror_link(depth, hash, enc));
                used.push((hash.to_string(), enc.to_string()));
                rest = &tail[end..];
                continue;
            }
        }
        out.push_str("attachment:");
        rest = after;
    }
    out.push_str(rest);
    (out, used)
}

/// Turn mirror links (`(../_attachments/<hash>/<enc>`) back into
/// `(attachment:<hash>/<enc>` — applied to a page file before sync imports it.
pub fn unrewrite_mirror_links(md: &str) -> String {
    let needle = format!("{MIRROR_DIR}/");
    if !md.contains(&needle) {
        return md.to_string();
    }
    let mut out = String::with_capacity(md.len());
    let mut rest = md;
    while let Some(i) = rest.find("](") {
        out.push_str(&rest[..i + 2]);
        let mut after = &rest[i + 2..];
        let start = after;
        while let Some(r) = after.strip_prefix("../") {
            after = r;
        }
        if let Some(a) = after.strip_prefix(&needle) {
            if a.len() > 65 && is_valid_hash(&a[..64]) && a.as_bytes()[64] == b'/' {
                let tail = &a[65..];
                let end = tail.find(|c: char| c == ')' || c.is_whitespace()).unwrap_or(tail.len());
                if end > 0 && !tail[..end].contains('/') {
                    out.push_str("attachment:");
                    out.push_str(&a[..65]);
                    out.push_str(&tail[..end]);
                    rest = &tail[end..];
                    continue;
                }
            }
        }
        rest = start;
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db_with_store() -> (tempfile::TempDir, Database) {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::open_in_memory().unwrap();
        db.set_attachments_dir(tmp.path().join("att"));
        (tmp, db)
    }

    #[test]
    fn store_dedupes_and_lays_out_by_hash() {
        let (_t, db) = db_with_store();
        let a = db.store_attachment_bytes("Photo One.PNG", Some("image/png"), b"pngbytes").unwrap();
        assert!(a.created);
        assert_eq!(a.attachment.ext, "png");
        let b = db.store_attachment_bytes("other.png", None, b"pngbytes").unwrap();
        assert!(!b.created, "same content is stored once");
        assert_eq!(a.attachment.hash, b.attachment.hash);
        let dir = db.attachments_dir().unwrap();
        let h = &a.attachment.hash;
        assert_eq!(db.attachment_file(h).unwrap(), dir.join(&h[..2]).join(format!("{h}.png")));
        assert_eq!(db.list_attachments().unwrap().len(), 1);
        // File path from a file on disk, streamed.
        let src = dir.parent().unwrap().join("doc.pdf");
        fs::write(&src, b"%PDF-1.4 fake").unwrap();
        let c = db.store_attachment_file(&src, None, None).unwrap();
        assert_eq!(c.attachment.mime, "application/pdf");
        assert_eq!(c.attachment.markdown(), format!("[doc.pdf](attachment:{}/doc.pdf)", c.attachment.hash));
    }

    #[test]
    fn size_cap_is_enforced() {
        let (_t, db) = db_with_store();
        let big = vec![0u8; (MAX_ATTACHMENT_BYTES + 1) as usize];
        assert!(db.store_attachment_bytes("big.bin", None, &big).is_err());
        assert!(db.list_attachments().unwrap().is_empty());
    }

    #[test]
    fn protocol_lookup_is_hash_only() {
        let (_t, db) = db_with_store();
        let a = db.store_attachment_bytes("x.png", None, b"abc").unwrap().attachment;
        let dir = db.attachments_dir().unwrap();
        assert!(find_file(&dir, &a.hash).is_some());
        for bad in ["../etc/passwd", "..", "", "ABC", &a.hash.to_uppercase(), &format!("{}/../x", a.hash), &a.hash[..63]] {
            assert!(find_file(&dir, bad).is_none(), "{bad:?} must not resolve");
        }
        // A symlink planted in the store is never served.
        #[cfg(unix)]
        {
            let fake = "f".repeat(64);
            fs::create_dir_all(dir.join("ff")).unwrap();
            std::os::unix::fs::symlink("/etc/passwd", dir.join("ff").join(format!("{fake}.txt"))).unwrap();
            assert!(find_file(&dir, &fake).is_none());
        }
    }

    #[test]
    fn names_encode_and_refs_parse() {
        assert_eq!(encode_name("My File (1).pdf"), "My%20File%20%281%29.pdf");
        assert_eq!(decode_name("My%20File%20%281%29.pdf"), "My File (1).pdf");
        assert_eq!(encode_name("../../etc/passwd"), "_.._.._etc_passwd");
        let h = "a".repeat(64);
        let md = format!("see ![x](attachment:{h}/a%20b.png) and [f](attachment:{h}) attachment:zz");
        let refs = attachment_refs(&md);
        assert_eq!(refs, vec![(h.clone(), Some("a%20b.png".into())), (h.clone(), None)]);
    }

    #[test]
    fn mirror_rewrite_round_trips() {
        let h = "0123456789abcdef".repeat(4);
        let md = format!("- ![pic](attachment:{h}/a%20b.png) <!-- id:x -->\n- [doc](attachment:{h}/d.pdf)\n- `attachment:` plain\n");
        let (out, used) = rewrite_for_mirror(&md, 2);
        assert!(out.contains(&format!("(../../_attachments/{h}/a%20b.png)")), "{out}");
        assert_eq!(used.len(), 2);
        assert_eq!(unrewrite_mirror_links(&out), md);
        let (root, _) = rewrite_for_mirror(&md, 0);
        assert!(root.contains(&format!("(_attachments/{h}/d.pdf)")));
        assert_eq!(unrewrite_mirror_links(&root), md);
    }

    // GC keeps attachments referenced by live/trashed pages and undo-able events,
    // removes the rest (rows and files) — but never one stored moments ago.
    #[test]
    fn gc_follows_the_whiteboard_rule() {
        let (_t, db) = db_with_store();
        let mk = |n: &str| db.store_attachment_bytes(n, None, n.as_bytes()).unwrap().attachment;
        let live = mk("live.png");
        let trashed = mk("trashed.png");
        let undo = mk("undo.png");
        let orphan = mk("orphan.png");
        let fresh = mk("fresh.png");
        // Age every row but `fresh` past the grace period.
        db.conn
            .execute("UPDATE attachments SET created_at = '2000-01-01T00:00:00+00:00' WHERE hash != ?1", [&fresh.hash])
            .unwrap();
        let p = db.create_page("P", None, false, None, "user").unwrap();
        let t = db.create_page("T", None, false, None, "user").unwrap();
        db.create_block(&p.id, &live.markdown(), None, None, "user").unwrap();
        db.create_block(&t.id, &trashed.markdown(), None, None, "user").unwrap();
        let d = db.create_block(&p.id, &undo.markdown(), None, None, "user").unwrap();
        db.delete_block(&d.id, "user").unwrap();
        db.trash_page(&t.id).unwrap();
        let joined: i64 = db.conn.query_row("SELECT COUNT(*) FROM block_attachments", [], |r| r.get(0)).unwrap();
        assert_eq!(joined, 2, "join rows for the two blocks that still exist");

        let gone = db.gc_attachments().unwrap();
        assert_eq!(gone, vec![orphan.hash.clone()]);
        assert!(db.attachment_file(&orphan.hash).is_none());
        assert!(db.attachment_file(&fresh.hash).is_some());
        assert!(db.attachment_file(&undo.hash).is_some());
        // Emptying the trash collects the trashed page's attachment.
        db.empty_trash("user").unwrap();
        assert!(db.get_attachment(&trashed.hash).unwrap().is_none());
        assert!(db.attachment_file(&trashed.hash).is_none());
        assert!(db.get_attachment(&live.hash).unwrap().is_some());
    }

    #[test]
    fn store_dir_derives_from_db_path() {
        assert_eq!(
            attachments_dir_for_db(Path::new("/n/My Notebook/notebook.minotes")),
            PathBuf::from("/n/My Notebook/attachments")
        );
        assert_eq!(attachments_dir_for_db(Path::new("/h/.minotes/work.db")), PathBuf::from("/h/.minotes/work.attachments"));
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::open(&tmp.path().join("g.db")).unwrap();
        assert_eq!(db.attachments_dir().unwrap(), tmp.path().join("g.attachments"));
    }
}
