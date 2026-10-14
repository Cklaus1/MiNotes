//! Attachments and Import in the desktop app (PRD-import §3, §5).
//!
//! - `attachment://<hash>` streams a stored file to the webview. The path is
//!   derived from the hash alone (64 lowercase hex), so no request can reach
//!   anything outside the open notebook's attachment store.
//! - Paste stores bytes (`store_attachment`, raw IPC body); a file dropped on the
//!   window is stored only if the OS really dropped it (`store_dropped_files`).
//! - `open_attachment` hands a stored file to the OS (opener plugin), by hash.
//! - Import: scan (progress events), preview, import with progress + cancel
//!   (rolls back), undo, run list. A new notebook is the default destination.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use minotes_core::db::Database;
use minotes_core::import::{self, Destination, ImportOptions, Limits, Model, Preview, SourceKind, SourceSpec};
use minotes_core::notebook::{self, Notebook};
use minotes_core::repo::attachments::{self, Attachment};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{notebooks, security, AppState};

// ── Attachment protocol ──

fn store_dir(app: &AppHandle) -> Option<PathBuf> {
    let state = app.try_state::<AppState>()?;
    let nb = state.session.lock().ok()?.notebook.clone();
    Some(attachments::attachments_dir_for_db(&nb.db_path()))
}

fn respond(status: u16, mime: &str, body: Vec<u8>) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("X-Content-Type-Options", "nosniff")
        // An SVG opened directly must not run script.
        .header("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox")
        .header("Accept-Ranges", "bytes")
        .header("Cache-Control", "private, max-age=31536000, immutable")
        .body(body)
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

/// Serve `attachment://localhost/<hash>` (Windows: `http://attachment.localhost/<hash>`).
pub fn serve(app: &AppHandle, req: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let path = req.uri().path().trim_start_matches('/');
    let hash = path.split('/').next().unwrap_or("");
    // An encrypted notebook keeps attachments inside its database.
    if let Some(state) = app.try_state::<AppState>() {
        let encrypted = state.session.lock().map(|s| s.notebook.is_encrypted()).unwrap_or(false);
        if encrypted {
            let Ok(db) = state.db_guard() else { return respond(423, "text/plain", b"locked".to_vec()) };
            let mime = db.get_attachment(hash).ok().flatten().map(|a| attachments::mime_for_ext(&a.ext).to_string());
            return match (db.attachment_bytes(hash), mime) {
                (Ok(Some(bytes)), Some(mime)) => respond(200, &mime, bytes),
                _ => respond(404, "text/plain", b"not found".to_vec()),
            };
        }
    }
    let Some(dir) = store_dir(app) else { return respond(503, "text/plain", b"not ready".to_vec()) };
    let Some(file) = attachments::find_file(&dir, hash) else {
        return respond(404, "text/plain", b"not found".to_vec());
    };
    let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("bin").to_string();
    let mime = attachments::mime_for_ext(&ext);
    let Ok(mut f) = std::fs::File::open(&file) else { return respond(404, "text/plain", b"not found".to_vec()) };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    // Byte ranges (audio/video seeking).
    if let Some(range) = req.headers().get("range").and_then(|v| v.to_str().ok()).and_then(|r| r.strip_prefix("bytes=")) {
        let (a, b) = range.split_once('-').unwrap_or((range, ""));
        let start: u64 = a.trim().parse().unwrap_or(0);
        let end: u64 = b.trim().parse().unwrap_or(len.saturating_sub(1)).min(len.saturating_sub(1));
        if start <= end && start < len {
            let n = (end - start + 1).min(8 * 1024 * 1024);
            let mut buf = vec![0u8; n as usize];
            if f.seek(SeekFrom::Start(start)).is_ok() && f.read_exact(&mut buf).is_ok() {
                let mut r = respond(206, mime, buf);
                if let Ok(v) = format!("bytes {start}-{}/{len}", start + n - 1).parse() {
                    r.headers_mut().insert("Content-Range", v);
                }
                return r;
            }
        }
        return respond(416, "text/plain", Vec::new());
    }
    let mut buf = Vec::with_capacity(len as usize);
    if f.read_to_end(&mut buf).is_err() {
        return respond(500, "text/plain", Vec::new());
    }
    respond(200, mime, buf)
}

fn refuse_read_only(state: &AppState) -> Result<(), String> {
    if state.session.lock().map_err(|e| e.to_string())?.held_by.is_some() {
        return Err("This notebook is open read-only in this window".into());
    }
    Ok(())
}

fn decode_header(req: &tauri::ipc::Request<'_>, key: &str) -> Option<String> {
    let v = req.headers().get(key)?.to_str().ok()?;
    Some(attachments::decode_name(v))
}

/// Store pasted bytes (raw IPC body; headers `x-name`, `x-mime`, percent-encoded).
#[tauri::command]
pub fn store_attachment(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> Result<Attachment, String> {
    refuse_read_only(&state)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected the file's bytes".into());
    };
    let name = decode_header(&request, "x-name").filter(|n| !n.trim().is_empty()).unwrap_or_else(|| "pasted".into());
    let mime = decode_header(&request, "x-mime");
    let db = state.db_guard()?;
    db.store_attachment_bytes(&name, mime.as_deref(), bytes).map(|s| s.attachment).map_err(|e| e.to_string())
}

/// Files the OS dropped on the window, remembered briefly so a drop on a block
/// can store them — and only them (the webview can't name arbitrary paths).
#[derive(Default)]
pub struct DroppedFiles(pub Mutex<Option<(Instant, Vec<PathBuf>)>>);

pub fn remember_drop(app: &AppHandle, paths: Vec<PathBuf>) {
    if let Some(d) = app.try_state::<DroppedFiles>() {
        if let Ok(mut g) = d.0.lock() {
            *g = Some((Instant::now(), paths));
        }
    }
}

#[tauri::command]
pub fn store_dropped_files(state: State<'_, AppState>, dropped: State<'_, DroppedFiles>) -> Result<Vec<Attachment>, String> {
    refuse_read_only(&state)?;
    let paths = match dropped.0.lock().map_err(|e| e.to_string())?.take() {
        Some((t, p)) if t.elapsed() < Duration::from_secs(60) => p,
        _ => return Ok(vec![]),
    };
    let db = state.db_guard()?;
    let mut out = Vec::new();
    for p in paths.into_iter().filter(|p| p.is_file()).take(20) {
        out.push(db.store_attachment_file(&p, None, None).map_err(|e| e.to_string())?.attachment);
    }
    Ok(out)
}

/// Types safe to hand to the OS default app: documents and media that are
/// viewed, not run. Attachments arrive from imports and sync, so one click must
/// never launch a program; anything not listed here (including no extension,
/// HTML/SVG that open in a browser, and macro-enabled Office files) is shown in
/// its folder instead. An allowlist, because a denylist of executable types is
/// never complete (`.chm .pif .iso .xll .docm .jnlp .terminal …`).
const OPENABLE_EXTS: &[&str] = &[
    // images
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "avif", "ico",
    // documents
    "pdf",
    // audio
    "mp3", "wav", "ogg", "oga", "flac", "m4a", "aac", "opus",
    // video
    "mp4", "m4v", "mov", "webm", "mkv", "avi",
    // plain text
    "txt", "md", "markdown", "csv", "tsv", "json", "log",
    // macro-free office / OpenDocument
    "docx", "xlsx", "pptx", "odt", "ods", "odp", "rtf",
];

fn is_safe_to_open(file: &Path) -> bool {
    file.extension()
        .and_then(|e| e.to_str())
        .map(|e| OPENABLE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Open a stored attachment with the OS default app when its type is on the
/// viewing allowlist; reveal it in its folder otherwise.
#[tauri::command]
pub fn open_attachment(app: AppHandle, hash: String) -> Result<(), String> {
    // Encrypted notebook: a temporary copy (deleted on lock, switch and quit).
    if let Some(state) = app.try_state::<AppState>() {
        if state.session.lock().map(|s| s.notebook.is_encrypted()).unwrap_or(false) {
            let (bytes, ext) = {
                let db = state.db_guard()?;
                let a = db.get_attachment(&hash).map_err(|e| e.to_string())?.ok_or("Attachment not found")?;
                (db.attachment_bytes(&hash).map_err(|e| e.to_string())?.ok_or("Attachment not found")?, a.ext)
            };
            let file = crate::encryption_commands::temp_copy(&hash, &ext, &bytes)?;
            if !is_safe_to_open(&file) {
                return tauri_plugin_opener::reveal_item_in_dir(&file).map_err(|e| e.to_string());
            }
            return tauri_plugin_opener::open_path(&file, None::<&str>).map_err(|e| e.to_string());
        }
    }
    let dir = store_dir(&app).ok_or("not ready")?;
    let file = attachments::find_file(&dir, &hash).ok_or("Attachment not found")?;
    if !is_safe_to_open(&file) {
        return tauri_plugin_opener::reveal_item_in_dir(&file).map_err(|e| e.to_string());
    }
    tauri_plugin_opener::open_path(&file, None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::is_safe_to_open;
    use std::path::Path;

    #[test]
    fn only_viewable_types_are_opened() {
        for f in [
            "a.exe", "a.BAT", "a.desktop", "a.sh", "a.lnk", "a.AppImage", "noext", "a.chm", "a.pif", "a.iso",
            "a.img", "a.vhd", "a.xll", "a.docm", "a.xlsm", "a.pptm", "a.jnlp", "a.appref-ms", "a.library-ms",
            "a.terminal", "a.fileloc", "a.html", "a.svg", "a.js", "a.py", "a.pdf.exe", ".pdf",
        ] {
            assert!(!is_safe_to_open(Path::new(f)), "{f}");
        }
        for f in ["a.pdf", "a.PNG", "a.jpeg", "a.docx", "a.xlsx", "a.pptx", "a.odt", "a.rtf", "a.mp4", "a.mp3", "a.txt", "a.md", "a.csv", "a.json", "a.exe.pdf"] {
            assert!(is_safe_to_open(Path::new(f)), "{f}");
        }
    }
}

#[tauri::command]
pub fn get_attachment(state: State<'_, AppState>, hash: String) -> Result<Option<Attachment>, String> {
    let db = state.db_guard()?;
    db.get_attachment(&hash).map_err(|e| e.to_string())
}

// ── Import ──

#[derive(Default)]
pub struct ImportState {
    model: Mutex<Option<Arc<Model>>>,
    cancel: Arc<AtomicBool>,
    busy: AtomicBool,
}

fn home_roots() -> Vec<PathBuf> {
    let mut roots = vec![notebook::home_dir()];
    if let Some(w) = crate::wsl_windows_profile() {
        roots.push(w);
    }
    roots
}

/// Source paths come from the folder / file pickers; they must be ordinary
/// user folders (never `~/.ssh`, `~/.minotes`, …).
fn validate_source(kind: SourceKind, paths: &[String]) -> Result<Vec<PathBuf>, String> {
    if paths.is_empty() {
        return Err("Choose what to import".into());
    }
    let mut out = Vec::new();
    for p in paths {
        let canon = PathBuf::from(p).canonicalize().map_err(|_| format!("{p} was not found"))?;
        let dir = if kind == SourceKind::Evernote {
            if !canon.is_file() || !canon.extension().map(|e| e.eq_ignore_ascii_case("enex")).unwrap_or(false) {
                return Err(format!("{} is not an .enex file", canon.display()));
            }
            canon.parent().map(Path::to_path_buf).unwrap_or_default()
        } else {
            if !canon.is_dir() {
                return Err(format!("{} is not a folder", canon.display()));
            }
            canon.clone()
        };
        security::validate_notebook_dir(&dir.display().to_string(), &home_roots())?;
        out.push(canon);
    }
    Ok(out)
}

#[derive(Serialize)]
pub struct Detected {
    pub kind: SourceKind,
    pub name: String,
}

#[tauri::command]
pub fn import_detect(path: String) -> Result<Detected, String> {
    let p = PathBuf::from(&path);
    let kind = import::detect(&p);
    let name = p.file_stem().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    Ok(Detected { kind, name })
}

/// DbAccess over the app's connection: the mutex is taken per batch, and the
/// import stops if the user switched notebooks meanwhile.
struct AppDb<'a> {
    state: &'a AppState,
    key: String,
}

impl import::DbAccess for AppDb<'_> {
    fn with<R>(&self, f: &mut dyn FnMut(&Database) -> minotes_core::error::Result<R>) -> minotes_core::error::Result<R> {
        let db = self.state.db_guard().map_err(minotes_core::error::Error::InvalidInput)?;
        let cur = self.state.current_notebook.lock().map(|g| g.clone()).unwrap_or_default();
        if cur != self.key {
            return Err(minotes_core::error::Error::InvalidInput("The notebook was switched during the import".into()));
        }
        f(&db)
    }
}

fn emit_progress(app: &AppHandle, p: &import::Progress) {
    let _ = app.emit("import-progress", p);
}

/// Scan a source (read-only) and return the preview. Long-running: runs off the
/// main thread, emits `import-progress`, cancellable with `import_cancel`.
#[tauri::command(async)]
pub fn import_scan(app: AppHandle, imp: State<'_, ImportState>, kind: SourceKind, paths: Vec<String>, options: Option<ImportOptions>) -> Result<Preview, String> {
    let opts = options.unwrap_or_default();
    let paths = validate_source(kind, &paths)?;
    imp.cancel.store(false, Ordering::Relaxed);
    let cancel = imp.cancel.clone();
    let app2 = app.clone();
    let last = Mutex::new(Instant::now() - Duration::from_secs(1));
    let progress = move |p: import::Progress| {
        if let Ok(mut l) = last.lock() {
            if l.elapsed() >= Duration::from_millis(100) || p.done >= p.total {
                *l = Instant::now();
                emit_progress(&app2, &p);
            }
        }
    };
    let model = import::scan(&SourceSpec { kind, paths }, &opts, &Limits::default(), &cancel, &progress).map_err(|e| e.to_string())?;
    let preview = import::preview(&model, &opts, &|_| false, &Default::default());
    *imp.model.lock().map_err(|e| e.to_string())? = Some(Arc::new(model));
    Ok(preview)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ImportDestination {
    /// A new notebook (default), named after the source.
    NewNotebook { name: Option<String>, location: Option<String> },
    /// A new Project in the open notebook.
    Current { project: Option<String> },
}

/// Preview again with other options or against the open notebook (titles in use).
#[tauri::command(async)]
pub fn import_preview(state: State<'_, AppState>, imp: State<'_, ImportState>, options: Option<ImportOptions>, destination: Option<ImportDestination>) -> Result<Preview, String> {
    let opts = options.unwrap_or_default();
    let model = imp.model.lock().map_err(|e| e.to_string())?.clone().ok_or("Scan a source first")?;
    match destination {
        Some(ImportDestination::Current { .. }) => {
            let key = state.current_notebook.lock().map_err(|e| e.to_string())?.clone();
            import::preview_for(&AppDb { state: &state, key }, &model, &opts).map_err(|e| e.to_string())
        }
        _ => Ok(import::preview(&model, &opts, &|_| false, &Default::default())),
    }
}

#[derive(Serialize)]
pub struct ImportResult {
    #[serde(flatten)]
    pub report: import::ImportReport,
    /// Set when a new notebook was created: its key (switch to it) and name.
    pub notebook_key: Option<String>,
    pub notebook_name: Option<String>,
}

fn new_notebook(name: Option<String>, location: Option<String>, source_name: &str) -> Result<Notebook, String> {
    let base: String = name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| source_name.chars().map(|c| if matches!(c, '/' | '\\' | '.' | '\0') || c.is_control() { ' ' } else { c }).collect())
        .trim()
        .to_string();
    let base = if base.is_empty() { "Imported".to_string() } else { base };
    let names: Vec<String> = notebook::list().into_iter().map(|n| n.name).collect();
    let mut nb_name = base.clone();
    let mut n = 2;
    while names.contains(&nb_name) {
        nb_name = format!("{base} {n}");
        n += 1;
    }
    notebook::validate_name(&nb_name).map_err(|e| e.to_string())?;
    let loc = match location.filter(|l| !l.trim().is_empty()) {
        Some(l) => security::validate_notebook_dir(&l, &home_roots())?,
        None => {
            let mut l = notebook::default_location(&nb_name);
            let mut k = 2;
            while l.exists() {
                l = notebook::default_location(&format!("{nb_name} {k}"));
                k += 1;
            }
            security::validate_notebook_dir(&l.display().to_string(), &home_roots())?
        }
    };
    notebook::create_in_folder(&loc, &nb_name).map_err(|e| e.to_string())
}

/// Import the scanned source. Emits `import-progress`; `import_cancel` rolls
/// the whole import back (a new notebook created for it is removed too).
#[tauri::command(async)]
pub fn import_run(app: AppHandle, state: State<'_, AppState>, imp: State<'_, ImportState>, destination: ImportDestination, options: Option<ImportOptions>) -> Result<ImportResult, String> {
    let opts = options.unwrap_or_default();
    let model = imp.model.lock().map_err(|e| e.to_string())?.clone().ok_or("Scan a source first")?;
    if imp.busy.swap(true, Ordering::SeqCst) {
        return Err("An import is already running".into());
    }
    imp.cancel.store(false, Ordering::Relaxed);
    let cancel = imp.cancel.clone();
    let app2 = app.clone();
    let progress = move |p: import::Progress| emit_progress(&app2, &p);
    let result = (|| match destination {
        ImportDestination::NewNotebook { name, location } => {
            let nb = new_notebook(name, location, &model.name)?;
            let db = nb.open_db().map_err(|e| e.to_string())?;
            let r = import::import(&db, &model, &opts, &Destination::Root, &cancel, &progress);
            let _ = notebook::checkpoint(&db);
            drop(db);
            match r {
                Ok(report) => Ok(ImportResult { report, notebook_key: Some(nb.key.clone()), notebook_name: Some(nb.name.clone()) }),
                Err(e) => {
                    // Nothing of a failed / cancelled import into a new notebook stays.
                    let _ = notebook::forget(&nb.key);
                    if let Some(root) = nb.root() {
                        let _ = std::fs::remove_dir_all(root);
                    }
                    Err(e.to_string())
                }
            }
        }
        ImportDestination::Current { project } => {
            refuse_read_only(&state)?;
            let key = state.current_notebook.lock().map_err(|e| e.to_string())?.clone();
            let report = import::import(&AppDb { state: &state, key }, &model, &opts, &Destination::NewProject { name: project }, &cancel, &progress)
                .map_err(|e| e.to_string())?;
            if let Some(w) = app.try_state::<notebooks::MirrorWorker>() {
                w.send(notebooks::MirrorMsg::Changed);
            }
            Ok(ImportResult { report, notebook_key: None, notebook_name: None })
        }
    })();
    imp.busy.store(false, Ordering::SeqCst);
    if result.is_ok() {
        *imp.model.lock().map_err(|e| e.to_string())? = None; // drops the spool
    }
    result
}

#[tauri::command]
pub fn import_cancel(imp: State<'_, ImportState>) {
    imp.cancel.store(true, Ordering::Relaxed);
}

/// Forget the scanned source (dialog closed).
#[tauri::command]
pub fn import_discard(imp: State<'_, ImportState>) -> Result<(), String> {
    if !imp.busy.load(Ordering::SeqCst) {
        *imp.model.lock().map_err(|e| e.to_string())? = None;
    }
    Ok(())
}

#[tauri::command]
pub fn import_undo(app: AppHandle, state: State<'_, AppState>, run_id: String, keep_edited: Option<bool>) -> Result<import::UndoReport, String> {
    refuse_read_only(&state)?;
    let r = {
        let db = state.db_guard()?;
        import::undo(&db, &run_id, keep_edited.unwrap_or(false)).map_err(|e| e.to_string())?
    };
    if let Some(w) = app.try_state::<notebooks::MirrorWorker>() {
        w.send(notebooks::MirrorMsg::Changed);
    }
    Ok(r)
}

#[tauri::command]
pub fn import_runs(state: State<'_, AppState>) -> Result<Vec<import::RunInfo>, String> {
    let db = state.db_guard()?;
    import::list_runs(&db).map_err(|e| e.to_string())
}
