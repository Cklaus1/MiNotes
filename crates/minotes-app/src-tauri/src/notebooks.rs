//! Notebooks in the desktop app: the open notebook's session (lock, read-only
//! mode, notices), the commands behind the sidebar switcher and "Manage
//! notebooks…", the database file watcher, the markdown-mirror worker, and the
//! mirror-folder watcher that imports edits made outside MiNotes (Phase 4).
//!
//! Lock order everywhere: `mirror::FS_LOCK` → `AppState.db` → `current_notebook`
//! → `session` → `virtual_journals`.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use minotes_core::db::Database;
use minotes_core::encryption;
use minotes_core::mirror::{self, MirrorTarget, FS_LOCK};
use minotes_core::notebook::{self, LockInfo, LockStatus, Notebook, NotebookInfo};
use minotes_core::outside::{self, OutsideReport, Scope};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{security, AppState};

/// Quiet period after the last database write before the mirror is written.
const MIRROR_DEBOUNCE: Duration = Duration::from_millis(2000);
/// …but while writes keep coming (typing), never hold changes longer than this.
const MIRROR_MAX_WAIT: Duration = Duration::from_millis(4000);
/// Retry a failed mirror pass after this long.
const MIRROR_RETRY: Duration = Duration::from_secs(30);
/// Checkpoint the WAL once writes have been quiet this long.
const IDLE_CHECKPOINT: Duration = Duration::from_secs(20);

/// The open notebook.
pub struct Session {
    pub notebook: Notebook,
    /// Another MiNotes instance holds the notebook: opened read-only.
    pub held_by: Option<LockInfo>,
    /// Shown once as a banner (e.g. "the last notebook's folder is missing").
    pub notice: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionInfo {
    pub key: String,
    pub name: String,
    pub kind: String,
    pub path: String,
    pub db_path: String,
    pub mirror_dir: String,
    pub read_only: bool,
    /// "host (pid N)" of the instance that has it open, when read-only.
    pub held_by: Option<String>,
    pub notice: Option<String>,
    /// File-sync service the folder lives in (Dropbox, iCloud Drive, …).
    pub cloud: Option<String>,
    /// `notebook (conflicted copy).minotes` and friends next to the database.
    pub conflicted_copies: Vec<String>,
    /// Encrypted with a passphrase (PRD-encryption).
    pub encrypted: bool,
    /// Encrypted and not unlocked: only the unlock screen can be shown.
    pub locked: bool,
    /// Its key is kept in this device's keychain ("Keep unlocked on this device").
    pub remembered: bool,
    /// This device has a keychain MiNotes can use.
    pub keychain_available: bool,
}

pub(crate) fn session_info(s: &Session) -> SessionInfo {
    let nb = &s.notebook;
    let info = notebook::info(nb);
    let remembered = info.encrypted && minotes_core::keychain::is_remembered(&nb.key);
    SessionInfo {
        key: nb.key.clone(),
        name: nb.name.clone(),
        kind: info.kind,
        path: info.path,
        db_path: info.db_path,
        mirror_dir: info.mirror_dir,
        read_only: s.held_by.is_some(),
        held_by: s.held_by.as_ref().map(|l| format!("{} (pid {})", l.host, l.pid)),
        notice: s.notice.clone(),
        cloud: info.cloud,
        conflicted_copies: nb.root().map(notebook::conflicted_copies).unwrap_or_default(),
        encrypted: info.encrypted,
        locked: info.locked,
        remembered,
        keychain_available: info.encrypted && minotes_core::keychain::available(),
    }
}

/// Open a notebook's database for this instance: take its lock, or open it
/// read-only if another live instance holds it. A folder notebook that is
/// missing is an error — never an empty new notebook.
///
/// An encrypted notebook opens only when its key is known — unlocked in this
/// process, or remembered in this device's keychain; otherwise the database is
/// `None` (locked) and the window shows the unlock screen. A conversion a crash
/// interrupted is finished (or rolled back) first.
pub fn open_for_session(nb: &Notebook, force: bool) -> Result<(Option<Database>, Option<LockInfo>), String> {
    if nb.is_folder() && !nb.available() {
        return Err(format!(
            "Notebook \u{201c}{}\u{201d} is unavailable: {} was not found",
            nb.name,
            nb.root().map(|r| r.display().to_string()).unwrap_or_default()
        ));
    }
    let held = match notebook::acquire_lock(&nb.lock_path(), force) {
        Ok(LockStatus::HeldByOther(info)) => Some(info),
        // Acquired — or the lock could not be written (read-only medium):
        // SQLite's own locking stays the real guard.
        _ => None,
    };
    if held.is_none() {
        if let Err(e) = encryption::resume_conversion(nb) {
            eprintln!("[minotes] could not finish an interrupted conversion: {e}");
        }
    }
    if nb.is_encrypted() && encryption::unlocked_key(&nb.key).is_none() {
        match minotes_core::keychain::recall(&nb.key) {
            Some(k) => {
                if encryption::unlock_with_key(nb, k).is_err() {
                    // The remembered key no longer opens it (rotated): forget it.
                    minotes_core::keychain::forget(&nb.key);
                    return Ok((None, held));
                }
            }
            None => return Ok((None, held)),
        }
    }
    let db = open_unlocked(nb, held.is_some())?;
    Ok((Some(db), held))
}

/// Open `nb` (its key, if encrypted, is in the unlocked-key cache).
pub(crate) fn open_unlocked(nb: &Notebook, read_only: bool) -> Result<Database, String> {
    if read_only {
        return nb.open_read_only(5000).map_err(|e| e.to_string());
    }
    let db = nb.open_db().map_err(|e| e.to_string())?;
    // Startup / notebook switch: drop change-feed events past the horizon
    // (cheap when there are none; also done after empty-trash).
    db.compact_events_quietly();
    Ok(db)
}

pub(crate) fn home_roots() -> Vec<PathBuf> {
    let mut roots = vec![notebook::home_dir()];
    if let Some(w) = crate::wsl_windows_profile() {
        roots.push(w);
    }
    roots
}

fn session_notebook(state: &AppState) -> Result<Notebook, String> {
    Ok(state.session.lock().map_err(|e| e.to_string())?.notebook.clone())
}

// ── Mirror worker ──

pub enum MirrorMsg {
    /// The database changed (debounced).
    Changed,
    /// Full pass now (startup, notebook switch, "Rebuild markdown copy").
    Full,
    /// Files in the mirror changed (paths relative to it): import outside edits.
    Outside(Vec<PathBuf>),
}

pub struct MirrorWorker {
    tx: Mutex<Sender<MirrorMsg>>,
    /// A change is waiting for its debounce / a retry is scheduled.
    pub pending: Mutex<bool>,
}

impl MirrorWorker {
    pub fn send(&self, msg: MirrorMsg) {
        if let Ok(tx) = self.tx.lock() {
            let _ = tx.send(msg);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct MirrorStatusOut {
    #[serde(flatten)]
    pub status: mirror::MirrorStatus,
    /// Waiting to write (debounce) — not an error.
    pub pending: bool,
    /// The copy is behind because the last pass failed.
    pub behind: bool,
    pub read_only: bool,
}

fn mirror_status_of(app: &AppHandle) -> Option<MirrorStatusOut> {
    let state = app.try_state::<AppState>()?;
    let (nb, ro) = {
        let s = state.session.lock().ok()?;
        (s.notebook.clone(), s.held_by.is_some())
    };
    let target = MirrorTarget::for_notebook(&nb);
    let status = mirror::status(&target, nb.mirror_enabled());
    let pending = app.try_state::<MirrorWorker>().map(|w| w.pending.lock().map(|p| *p).unwrap_or(false)).unwrap_or(false);
    let behind = status.error.is_some();
    Some(MirrorStatusOut { status, pending, behind, read_only: ro })
}

fn emit_mirror_status(app: &AppHandle) {
    if let Some(s) = mirror_status_of(app) {
        let _ = app.emit("mirror-status", s);
    }
}

/// Tell the window what was imported from outside edits (toasts, banner, undo,
/// refresh of the open page).
fn emit_outside(app: &AppHandle, report: &OutsideReport) {
    if !report.is_empty() {
        let _ = app.emit("outside-edits", report);
    }
}

fn outside_or_error(r: minotes_core::error::Result<OutsideReport>) -> OutsideReport {
    r.unwrap_or_else(|e| OutsideReport { errors: vec![e.to_string()], ..Default::default() })
}

/// Import outside edits of the files at `paths` (relative to the mirror).
/// Never in a read-only session: the instance that owns the notebook imports.
fn outside_pass(app: &AppHandle, paths: Vec<PathBuf>) {
    let state = app.state::<AppState>();
    let _fs = FS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let report = {
        let Ok(db) = state.db_guard() else { return };
        let Ok(s) = state.session.lock() else { return };
        if s.held_by.is_some() || !s.notebook.mirror_enabled() || notebook::is_app_storage() {
            return;
        }
        let target = MirrorTarget::for_notebook(&s.notebook);
        drop(s);
        outside_or_error(outside::import_outside_edits(&db, &target, &Scope::Paths(paths)))
    };
    drop(_fs);
    if !report.touched_pages().is_empty() {
        if let Some(w) = app.try_state::<MirrorWorker>() {
            w.send(MirrorMsg::Changed);
        }
    }
    emit_outside(app, &report);
}

/// One mirror pass for the open notebook. The DB lock is held only while the
/// pass reads the database (and, on full passes, imports outside edits first);
/// files are written after it is released.
fn mirror_pass(app: &AppHandle, full: bool) -> Result<Option<mirror::MirrorReport>, String> {
    let r = mirror_pass_inner(app, full);
    if let Ok(Some(rep)) = &r {
        emit_outside(app, &rep.outside);
        // Files the guard refused to overwrite: someone edited them — import now.
        if !rep.guarded.is_empty() {
            if let Some(w) = app.try_state::<MirrorWorker>() {
                w.send(MirrorMsg::Outside(rep.guarded.iter().map(PathBuf::from).collect()));
            }
        }
    }
    follow_session_with_watch(app);
    r
}

fn mirror_pass_inner(app: &AppHandle, full: bool) -> Result<Option<mirror::MirrorReport>, String> {
    let state = app.state::<AppState>();
    let _fs = FS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    // The instance that has the notebook open owns its mirror (and an encrypted
    // notebook has none — checked before asking for its database, which a
    // locked one doesn't have).
    let (nb, ro) = {
        let s = state.session.lock().map_err(|e| e.to_string())?;
        (s.notebook.clone(), s.held_by.is_some())
    };
    if ro || !nb.mirror_enabled() {
        return Ok(None);
    }
    let (target, prepared, outside_report) = {
        let db = state.db_guard()?;
        let (nb, ro) = {
            let s = state.session.lock().map_err(|e| e.to_string())?;
            (s.notebook.clone(), s.held_by.is_some())
        };
        if ro || !nb.mirror_enabled() {
            return Ok(None);
        }
        let target = MirrorTarget::for_notebook(&nb);
        // Startup / switch / rebuild: catch edits made while the app was closed.
        let outside_report = if full {
            outside_or_error(outside::import_outside_edits(&db, &target, &Scope::All))
        } else {
            OutsideReport::default()
        };
        match mirror::prepare(&db, &target, full) {
            Ok(p) => (target, p, outside_report),
            Err(e) => {
                mirror::record_error(&target, &e.to_string());
                return Err(e.to_string());
            }
        }
    };
    let mut rep = mirror::apply(&target, prepared).map_err(|e| e.to_string())?;
    rep.outside = outside_report;
    Ok(Some(rep))
}

fn checkpoint_if_needed(app: &AppHandle) {
    let state = app.state::<AppState>();
    let Ok(db) = state.db_guard() else { return };
    let Ok(s) = state.session.lock() else { return };
    if s.held_by.is_some() {
        return;
    }
    let wal = PathBuf::from(format!("{}-wal", s.notebook.db_path().display()));
    let has_wal = std::fs::metadata(&wal).map(|m| m.len() > 0).unwrap_or(false);
    drop(s);
    if has_wal {
        let _ = notebook::checkpoint(&db);
    }
}

pub fn start_mirror_worker(app: &AppHandle) -> MirrorWorker {
    let (tx, rx) = mpsc::channel::<MirrorMsg>();
    app.manage(start_mirror_watch(app));
    let handle = app.clone();
    std::thread::spawn(move || {
        let mut due: Option<Instant> = None; // incremental pass due at
        let mut first_pending: Option<Instant> = None;
        let mut full = false;
        let mut checkpoint_at: Option<Instant> = None;
        loop {
            let next = [due, checkpoint_at].into_iter().flatten().min();
            let msg = match next {
                Some(t) => {
                    let wait = t.saturating_duration_since(Instant::now());
                    match rx.recv_timeout(wait) {
                        Ok(m) => Some(m),
                        Err(RecvTimeoutError::Timeout) => None,
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                }
                None => match rx.recv() {
                    Ok(m) => Some(m),
                    Err(_) => break,
                },
            };
            match msg {
                Some(MirrorMsg::Changed) => {
                    let now = Instant::now();
                    let first = *first_pending.get_or_insert(now);
                    due = Some((now + MIRROR_DEBOUNCE).min(first + MIRROR_MAX_WAIT));
                    checkpoint_at = None;
                    set_pending(&handle, true);
                    continue;
                }
                Some(MirrorMsg::Full) => {
                    full = true;
                    due = Some(Instant::now());
                    continue;
                }
                Some(MirrorMsg::Outside(paths)) => {
                    outside_pass(&handle, paths);
                    continue;
                }
                None => {}
            }
            let now = Instant::now();
            if due.map(|t| t <= now).unwrap_or(false) {
                due = None;
                first_pending = None;
                let res = mirror_pass(&handle, std::mem::take(&mut full));
                match res {
                    Ok(_) => {
                        set_pending(&handle, false);
                        checkpoint_at = Some(Instant::now() + IDLE_CHECKPOINT);
                    }
                    Err(e) => {
                        eprintln!("[minotes-mirror] pass failed: {e}");
                        due = Some(Instant::now() + MIRROR_RETRY);
                        set_pending(&handle, false);
                    }
                }
                emit_mirror_status(&handle);
            } else if checkpoint_at.map(|t| t <= now).unwrap_or(false) {
                checkpoint_at = None;
                checkpoint_if_needed(&handle);
            }
        }
    });
    MirrorWorker { tx: Mutex::new(tx), pending: Mutex::new(false) }
}

fn set_pending(app: &AppHandle, v: bool) {
    if let Some(w) = app.try_state::<MirrorWorker>() {
        if let Ok(mut p) = w.pending.lock() {
            *p = v;
        }
    }
}

// ── Database file watcher (external writes, e.g. the CLI; and the mirror trigger) ──

pub struct DbWatch {
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    dir: Mutex<Option<PathBuf>>,
}

impl DbWatch {
    /// Watch the folder holding `db_path` (non-recursive).
    pub fn watch(&self, db_path: &Path) {
        use notify::{RecursiveMode, Watcher};
        let Some(dir) = db_path.parent().map(Path::to_path_buf) else { return };
        let (Ok(mut w), Ok(mut cur)) = (self.watcher.lock(), self.dir.lock()) else { return };
        let Some(w) = w.as_mut() else { return };
        if cur.as_ref() == Some(&dir) {
            return;
        }
        if let Some(old) = cur.take() {
            let _ = w.unwatch(&old);
        }
        if w.watch(&dir, RecursiveMode::NonRecursive).is_ok() {
            *cur = Some(dir);
        }
    }
}

/// Watch the open notebook's database file. Every write (the app's, the CLI's, a
/// sync import) touches `<db>` / `<db>-wal`: the UI is told to refresh
/// (`db-changed`, debounced) and the mirror worker gets a change.
pub fn start_db_watch(app: &AppHandle) -> DbWatch {
    use notify::{Config, Watcher};
    let (tx, rx) = mpsc::channel();
    let watcher = notify::RecommendedWatcher::new(tx, Config::default()).ok();
    let app_handle = app.clone();
    std::thread::spawn(move || {
        // Debounce: a sync or import touches the WAL many times in quick
        // succession, and emitting per touch produced a storm of full UI
        // refreshes. Coalesce on the trailing edge (flush once writes go quiet
        // for DEBOUNCE), but never hold a burst longer than MAX_WAIT so
        // continuous activity still refreshes the UI at least ~1/s.
        const DEBOUNCE: Duration = Duration::from_millis(250);
        const MAX_WAIT: Duration = Duration::from_millis(1000);
        let mut pending_since: Option<Instant> = None;
        let flush = |h: &AppHandle| {
            let _ = h.emit("db-changed", ());
        };
        loop {
            let res = match pending_since {
                Some(since) => {
                    let elapsed = since.elapsed();
                    if elapsed >= MAX_WAIT {
                        pending_since = None;
                        flush(&app_handle);
                        continue;
                    }
                    match rx.recv_timeout(DEBOUNCE.min(MAX_WAIT - elapsed)) {
                        Ok(res) => Some(res),
                        Err(RecvTimeoutError::Timeout) => {
                            pending_since = None;
                            flush(&app_handle);
                            continue;
                        }
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                }
                None => match rx.recv() {
                    Ok(res) => Some(res),
                    Err(_) => break,
                },
            };
            let Some(Ok(event)) = res else { continue };
            let event: notify::Event = event;
            let Some(state) = app_handle.try_state::<AppState>() else { continue };
            let db_path = match state.session.lock() {
                Ok(s) => s.notebook.db_path(),
                Err(_) => continue,
            };
            let name = db_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let wal = format!("{name}-wal");
            let touched = event.paths.iter().any(|p| {
                p.file_name().and_then(|n| n.to_str()).map(|n| n == name || n == wal).unwrap_or(false)
                    && p.parent() == db_path.parent()
            });
            if touched {
                if pending_since.is_none() {
                    pending_since = Some(Instant::now());
                }
                if let Some(w) = app_handle.try_state::<MirrorWorker>() {
                    w.send(MirrorMsg::Changed);
                }
            }
        }
    });
    DbWatch { watcher: Mutex::new(watcher), dir: Mutex::new(None) }
}

// ── Mirror folder watcher (edits made outside MiNotes, Phase 4) ──

/// Quiet period after the last change in the mirror folder before importing.
const OUTSIDE_DEBOUNCE: Duration = Duration::from_millis(700);
/// …but never wait longer than this while changes keep coming.
const OUTSIDE_MAX_WAIT: Duration = Duration::from_millis(3000);

/// Watches the open notebook's markdown mirror (recursively). Changed paths go
/// to the mirror worker, which tells the mirror's own writes apart by hash
/// (`outside::import_outside_edits`) — timestamps are never trusted. Dot paths
/// (`.git`, `.minotes-*`, temp files), `_attachments/` and non-markdown files
/// are dropped here already. Nothing is watched in a read-only session.
pub struct MirrorWatch {
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    dir: Arc<Mutex<Option<PathBuf>>>,
}

impl MirrorWatch {
    fn set(&self, want: Option<PathBuf>) {
        use notify::{RecursiveMode, Watcher};
        let (Ok(mut w), Ok(mut cur)) = (self.watcher.lock(), self.dir.lock()) else { return };
        let Some(w) = w.as_mut() else { return };
        if *cur == want {
            return;
        }
        if let Some(old) = cur.take() {
            let _ = w.unwatch(&old);
        }
        if let Some(dir) = want {
            match w.watch(&dir, RecursiveMode::Recursive) {
                Ok(()) => *cur = Some(dir),
                Err(e) => eprintln!("[minotes-outside] cannot watch {}: {e}", dir.display()),
            }
        }
    }
}

/// Point the watcher at the open notebook's mirror (or at nothing when the
/// session is read-only / the mirror is off / not written yet).
fn follow_session_with_watch(app: &AppHandle) {
    let Some(w) = app.try_state::<MirrorWatch>() else { return };
    let Some(state) = app.try_state::<AppState>() else { return };
    let want = match state.session.lock() {
        Ok(s) if s.held_by.is_none() && s.notebook.mirror_enabled() && !notebook::is_app_storage() => Some(s.notebook.mirror_dir()),
        Ok(_) => None,
        Err(_) => return,
    };
    w.set(want.filter(|d| d.is_dir()));
}

fn start_mirror_watch(app: &AppHandle) -> MirrorWatch {
    use notify::{Config, Watcher};
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let watcher = notify::RecommendedWatcher::new(tx, Config::default()).ok();
    let dir: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(None));
    let cur = dir.clone();
    let handle = app.clone();
    std::thread::spawn(move || {
        let mut pending: BTreeSet<PathBuf> = BTreeSet::new();
        let mut first: Option<Instant> = None;
        let mut last = Instant::now();
        loop {
            let res = match first {
                Some(f) => {
                    let until = (last + OUTSIDE_DEBOUNCE).min(f + OUTSIDE_MAX_WAIT);
                    match rx.recv_timeout(until.saturating_duration_since(Instant::now())) {
                        Ok(r) => Some(r),
                        Err(RecvTimeoutError::Timeout) => None,
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                }
                None => match rx.recv() {
                    Ok(r) => Some(r),
                    Err(_) => break,
                },
            };
            match res {
                Some(Ok(event)) => {
                    if matches!(event.kind, notify::EventKind::Access(_)) {
                        continue;
                    }
                    let Some(root) = cur.lock().ok().and_then(|d| d.clone()) else { continue };
                    for p in &event.paths {
                        let Ok(rel) = p.strip_prefix(&root) else { continue };
                        if rel.as_os_str().is_empty() || outside::is_ignored(rel) {
                            continue;
                        }
                        pending.insert(rel.to_path_buf());
                        last = Instant::now();
                        first.get_or_insert(last);
                    }
                }
                Some(Err(_)) => {}
                None => {
                    first = None;
                    let paths: Vec<PathBuf> = std::mem::take(&mut pending).into_iter().collect();
                    if !paths.is_empty() {
                        if let Some(w) = handle.try_state::<MirrorWorker>() {
                            w.send(MirrorMsg::Outside(paths));
                        }
                    }
                }
            }
        }
    });
    MirrorWatch { watcher: Mutex::new(watcher), dir }
}

/// Undo / redo of one outside-edit import: make the page's blocks exactly
/// `blocks` (see `outside::set_page_blocks`). `park_title`: blocks not in the
/// snapshot go to a Trash page named after it (redo) instead of being deleted
/// (undo, where they are the import's own new blocks). `cleanup_page_id`: the
/// "removed outside" Trash page, deleted once empty. Returns a new such page.
#[tauri::command]
pub fn outside_edit_set_blocks(
    state: State<'_, AppState>,
    page_id: String,
    blocks: Vec<minotes_core::models::RestoreBlock>,
    park_title: Option<String>,
    cleanup_page_id: Option<String>,
) -> Result<Option<String>, String> {
    let pid = uuid::Uuid::parse_str(&page_id).map_err(|e| e.to_string())?;
    let cleanup = match cleanup_page_id {
        Some(c) => Some(uuid::Uuid::parse_str(&c).map_err(|e| e.to_string())?),
        None => None,
    };
    let db = state.db_guard()?;
    outside::set_page_blocks(&db, &pid, &blocks, park_title.as_deref(), cleanup.as_ref())
        .map(|p| p.map(|u| u.to_string()))
        .map_err(|e| e.to_string())
}

// ── Switching ──

/// Make `nb` the open notebook: open it (lock or read-only), swap the
/// connection, release the old lock, persist the choice, re-point the watcher
/// and give the new notebook a full mirror pass.
pub fn switch_to(app: &AppHandle, state: &AppState, nb: Notebook, force: bool) -> Result<SessionInfo, String> {
    let (new_db, held_by) = open_for_session(&nb, force)?;
    let info = {
        let mut db = state.db.lock().map_err(|e| e.to_string())?;
        let old = session_notebook(state)?;
        let old_ro = state.session.lock().map_err(|e| e.to_string())?.held_by.is_some();
        // Flush what the old notebook's mirror hasn't written yet — unless a
        // sync is busy in that folder (its next open does a full pass anyway).
        if !old_ro && old.key != nb.key {
            if let (Ok(_fs), Some(open)) = (FS_LOCK.try_lock(), db.as_ref()) {
                let _ = mirror::run(open, &MirrorTarget::for_notebook(&old), false);
            }
        }
        *db = new_db;
        if old.key != nb.key && !old_ro {
            notebook::release_lock(&old.lock_path());
        }
        // Only the open notebook stays unlocked (PRD-encryption §4.4).
        if old.key != nb.key {
            crate::encryption_commands::forget_session_secrets(&old);
        }
        *state.current_notebook.lock().map_err(|e| e.to_string())? = nb.key.clone();
        let mut s = state.session.lock().map_err(|e| e.to_string())?;
        *s = Session { notebook: nb.clone(), held_by, notice: None };
        state.virtual_journals.lock().map_err(|e| e.to_string())?.clear();
        session_info(&s)
    };
    crate::set_active_notebook_key(&nb.key);
    notebook::touch_last_opened(&nb);
    if let Some(w) = app.try_state::<DbWatch>() {
        w.watch(&nb.db_path());
    }
    if let Some(w) = app.try_state::<MirrorWorker>() {
        w.send(MirrorMsg::Full);
    }
    Ok(info)
}

/// On quit: write what the mirror hasn't yet, checkpoint (so a cloud-synced
/// folder holds one consistent file), release the lock.
pub fn shutdown(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return };
    crate::encryption_commands::remove_open_copies();
    let _fs = FS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let Ok(db) = state.db_guard() else {
        // Locked: nothing to write; still release the lock.
        if let Ok(s) = state.session.lock() {
            if s.held_by.is_none() {
                notebook::release_lock(&s.notebook.lock_path());
            }
        }
        return;
    };
    let Ok(s) = state.session.lock() else { return };
    if s.held_by.is_some() {
        return;
    }
    if s.notebook.mirror_enabled() {
        let _ = mirror::run(&db, &MirrorTarget::for_notebook(&s.notebook), false);
    }
    let _ = notebook::checkpoint(&db);
    notebook::release_lock(&s.notebook.lock_path());
}

// ── Commands ──

#[tauri::command]
pub fn list_notebooks() -> Vec<NotebookInfo> {
    notebook::list()
}

#[tauri::command]
pub fn get_notebook_session(state: State<'_, AppState>) -> Result<SessionInfo, String> {
    let s = state.session.lock().map_err(|e| e.to_string())?;
    Ok(session_info(&s))
}

/// The startup notice is shown once.
#[tauri::command]
pub fn dismiss_notebook_notice(state: State<'_, AppState>) -> Result<(), String> {
    state.session.lock().map_err(|e| e.to_string())?.notice = None;
    Ok(())
}

#[tauri::command]
pub fn default_notebook_location(name: String) -> String {
    notebook::default_location(name.trim()).display().to_string()
}

/// Create a notebook in a folder (default `~/MiNotes/<name>`). Does not switch.
#[tauri::command]
pub fn create_notebook(name: String, location: Option<String>) -> Result<NotebookInfo, String> {
    let name = name.trim().to_string();
    notebook::validate_name(&name).map_err(|e| e.to_string())?;
    let loc = match location.filter(|l| !l.trim().is_empty() && !notebook::is_app_storage()) {
        Some(l) => l,
        None => notebook::default_location(&name).display().to_string(),
    };
    let dir = security::validate_notebook_dir(&loc, &home_roots())?;
    let nb = notebook::create_in_folder(&dir, &name).map_err(|e| e.to_string())?;
    Ok(notebook::info(&nb))
}

/// Register an existing notebook folder ("Open notebook…"). Does not switch.
#[tauri::command]
pub fn open_notebook_folder(path: String) -> Result<NotebookInfo, String> {
    crate::platform::require_folders("Opening a notebook folder")?;
    let dir = security::validate_notebook_dir(&path, &home_roots())?;
    let nb = notebook::open_folder(&dir).map_err(|e| e.to_string())?;
    Ok(notebook::info(&nb))
}

/// "Locate…" for a notebook whose folder went missing.
#[tauri::command]
pub fn locate_notebook(key: String, path: String) -> Result<NotebookInfo, String> {
    crate::platform::require_folders("Locating a notebook folder")?;
    let dir = security::validate_notebook_dir(&path, &home_roots())?;
    let nb = notebook::locate(&key, &dir).map_err(|e| e.to_string())?;
    Ok(notebook::info(&nb))
}

#[tauri::command]
pub fn rename_notebook(state: State<'_, AppState>, key: String, name: String) -> Result<NotebookInfo, String> {
    let nb = notebook::rename(&key, name.trim()).map_err(|e| e.to_string())?;
    let mut s = state.session.lock().map_err(|e| e.to_string())?;
    if s.notebook.key == nb.key {
        s.notebook.name = nb.name.clone();
    }
    Ok(notebook::info(&nb))
}

/// Delete a notebook (refused for the open one). The markdown copy is kept.
#[tauri::command]
pub fn delete_notebook(state: State<'_, AppState>, key: String) -> Result<(), String> {
    let current = state.current_notebook.lock().map_err(|e| e.to_string())?.clone();
    notebook::delete(&key, &current).map_err(|e| e.to_string())
}

/// Remove an (unavailable) folder notebook from the list without touching files.
#[tauri::command]
pub fn forget_notebook(state: State<'_, AppState>, key: String) -> Result<(), String> {
    let current = state.current_notebook.lock().map_err(|e| e.to_string())?.clone();
    if current == key {
        return Err("Cannot remove the open notebook from the list".into());
    }
    notebook::forget(&key).map_err(|e| e.to_string())
}

/// Read-only because another instance has it open: take it over anyway (the
/// other instance may have crashed on another machine).
#[tauri::command]
pub fn take_over_notebook(app: AppHandle, state: State<'_, AppState>) -> Result<SessionInfo, String> {
    let nb = session_notebook(&state)?;
    switch_to(&app, &state, nb, true)
}

/// "Move notebook to a folder…": convert the open legacy notebook to the folder
/// layout (copy + verify + move mirror with .git + register), switch to it, and
/// only then remove the old files.
#[tauri::command(async)]
pub fn move_notebook_to_folder(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<SessionInfo, String> {
    crate::platform::require_folders("Moving a notebook to a folder")?;
    let dest = security::validate_notebook_dir(&path, &home_roots())?;
    let _fs = FS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let new_nb = {
        let mut slot = state.db.lock().map_err(|e| e.to_string())?;
        let db = slot.as_ref().ok_or("This notebook is locked")?;
        let (src, ro) = {
            let s = state.session.lock().map_err(|e| e.to_string())?;
            (s.notebook.clone(), s.held_by.is_some())
        };
        if ro {
            return Err("This notebook is open read-only".into());
        }
        // Bring the mirror up to date first, so what moves is current.
        let _ = mirror::run(db, &MirrorTarget::for_notebook(&src), false);
        let prepared = notebook::prepare_move_to_folder(db, &src, &dest, None).map_err(|e| e.to_string())?;
        let new_nb = prepared.notebook.clone();
        let new_db = match open_for_session(&new_nb, false) {
            Ok((Some(d), _)) => d,
            Ok((None, _)) => {
                prepared.rollback();
                return Err("The moved notebook could not be opened".into());
            }
            Err(e) => {
                prepared.rollback();
                return Err(e);
            }
        };
        *slot = Some(new_db); // closes the old database before its files go
        notebook::release_lock(&src.lock_path());
        *state.current_notebook.lock().map_err(|e| e.to_string())? = new_nb.key.clone();
        *state.session.lock().map_err(|e| e.to_string())? =
            Session { notebook: new_nb.clone(), held_by: None, notice: None };
        state.virtual_journals.lock().map_err(|e| e.to_string())?.clear();
        crate::set_active_notebook_key(&new_nb.key);
        if let Err(e) = prepared.finish() {
            eprintln!("[minotes] moved, but could not remove all old files: {e}");
        }
        new_nb
    };
    drop(_fs);
    if let Some(w) = app.try_state::<DbWatch>() {
        w.watch(&new_nb.db_path());
    }
    if let Some(w) = app.try_state::<MirrorWorker>() {
        w.send(MirrorMsg::Full);
    }
    let s = state.session.lock().map_err(|e| e.to_string())?;
    Ok(session_info(&s))
}

#[tauri::command]
pub fn mirror_status(app: AppHandle) -> Result<MirrorStatusOut, String> {
    mirror_status_of(&app).ok_or_else(|| "not ready".to_string())
}

/// "Rebuild markdown copy": a full pass now (also the "retry" when behind).
#[tauri::command(async)]
pub fn mirror_rebuild(app: AppHandle) -> Result<MirrorStatusOut, String> {
    let r = mirror_pass(&app, true);
    emit_mirror_status(&app);
    r?;
    mirror_status_of(&app).ok_or_else(|| "not ready".to_string())
}

#[tauri::command]
pub fn mirror_open_folder(state: State<'_, AppState>) -> Result<(), String> {
    crate::platform::require_folders("Opening the folder")?;
    let nb = session_notebook(&state)?;
    let dir = nb.mirror_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    tauri_plugin_opener::open_path(&dir, None::<&str>).map_err(|e| e.to_string())
}

/// The user's answer to deletions held by the mass-delete guard:
/// "trash" applies them, "keep" keeps the pages (their files are written again).
#[tauri::command(async)]
pub fn git_sync_resolve_deletions(app: AppHandle, state: State<'_, AppState>, action: String) -> Result<usize, String> {
    let move_to_trash = match action.as_str() {
        "trash" => true,
        "keep" => false,
        _ => return Err(format!("Unknown action '{action}'")),
    };
    let graph = state.current_notebook.lock().map_err(|e| e.to_string())?.clone();
    let n = {
        let _fs = FS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let db = state.db_guard()?;
        minotes_core::sync_manager::resolve_held_deletions(&db, &graph, move_to_trash).map_err(|e| e.to_string())?
    };
    if let Some(w) = app.try_state::<MirrorWorker>() {
        w.send(MirrorMsg::Changed);
    }
    Ok(n)
}
