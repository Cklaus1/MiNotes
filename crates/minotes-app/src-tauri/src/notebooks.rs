//! Notebooks in the desktop app: the open notebook's session (lock, read-only
//! mode, notices), the commands behind the sidebar switcher and "Manage
//! notebooks…", the database file watcher, and the markdown-mirror worker.
//!
//! Lock order everywhere: `mirror::FS_LOCK` → `AppState.db` → `current_graph`
//! → `session` → `virtual_journals`.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use minotes_core::db::Database;
use minotes_core::mirror::{self, MirrorTarget, FS_LOCK};
use minotes_core::notebook::{self, LockInfo, LockStatus, Notebook, NotebookInfo};
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
}

fn session_info(s: &Session) -> SessionInfo {
    let nb = &s.notebook;
    let info = notebook::info(nb);
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
    }
}

/// Open a notebook's database for this instance: take its lock, or open it
/// read-only if another live instance holds it. A folder notebook that is
/// missing is an error — never an empty new notebook.
pub fn open_for_session(nb: &Notebook, force: bool) -> Result<(Database, Option<LockInfo>), String> {
    if nb.is_folder() && !nb.available() {
        return Err(format!(
            "Notebook \u{201c}{}\u{201d} is unavailable: {} was not found",
            nb.name,
            nb.root().map(|r| r.display().to_string()).unwrap_or_default()
        ));
    }
    match notebook::acquire_lock(&nb.lock_path(), force) {
        Ok(LockStatus::HeldByOther(info)) => {
            let db = Database::open_read_only(&nb.db_path()).map_err(|e| e.to_string())?;
            Ok((db, Some(info)))
        }
        // Acquired — or the lock could not be written (read-only medium):
        // SQLite's own locking stays the real guard.
        _ => {
            let db = nb.open_db().map_err(|e| e.to_string())?;
            Ok((db, None))
        }
    }
}

fn home_roots() -> Vec<PathBuf> {
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

/// One mirror pass for the open notebook. The DB lock is held only while the
/// pass reads the database; files are written after it is released.
fn mirror_pass(app: &AppHandle, full: bool) -> Result<Option<mirror::MirrorReport>, String> {
    let state = app.state::<AppState>();
    let _fs = FS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let (target, prepared) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let (nb, ro) = {
            let s = state.session.lock().map_err(|e| e.to_string())?;
            (s.notebook.clone(), s.held_by.is_some())
        };
        // The instance that has the notebook open owns its mirror.
        if ro || !nb.mirror_enabled() {
            return Ok(None);
        }
        let target = MirrorTarget::for_notebook(&nb);
        match mirror::prepare(&db, &target, full) {
            Ok(p) => (target, p),
            Err(e) => {
                mirror::record_error(&target, &e.to_string());
                return Err(e.to_string());
            }
        }
    };
    mirror::apply(&target, prepared).map(Some).map_err(|e| e.to_string())
}

fn checkpoint_if_needed(app: &AppHandle) {
    let state = app.state::<AppState>();
    let Ok(db) = state.db.lock() else { return };
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
            if let Ok(_fs) = FS_LOCK.try_lock() {
                let _ = mirror::run(&db, &MirrorTarget::for_notebook(&old), false);
            }
        }
        *db = new_db;
        if old.key != nb.key && !old_ro {
            notebook::release_lock(&old.lock_path());
        }
        *state.current_graph.lock().map_err(|e| e.to_string())? = nb.key.clone();
        let mut s = state.session.lock().map_err(|e| e.to_string())?;
        *s = Session { notebook: nb.clone(), held_by, notice: None };
        state.virtual_journals.lock().map_err(|e| e.to_string())?.clear();
        session_info(&s)
    };
    crate::set_active_graph_name(&nb.key);
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
    let _fs = FS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let Ok(db) = state.db.lock() else { return };
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
    let loc = match location.filter(|l| !l.trim().is_empty()) {
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
    let dir = security::validate_notebook_dir(&path, &home_roots())?;
    let nb = notebook::open_folder(&dir).map_err(|e| e.to_string())?;
    Ok(notebook::info(&nb))
}

/// "Locate…" for a notebook whose folder went missing.
#[tauri::command]
pub fn locate_notebook(key: String, path: String) -> Result<NotebookInfo, String> {
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
    let current = state.current_graph.lock().map_err(|e| e.to_string())?.clone();
    notebook::delete(&key, &current).map_err(|e| e.to_string())
}

/// Remove an (unavailable) folder notebook from the list without touching files.
#[tauri::command]
pub fn forget_notebook(state: State<'_, AppState>, key: String) -> Result<(), String> {
    let current = state.current_graph.lock().map_err(|e| e.to_string())?.clone();
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
    let dest = security::validate_notebook_dir(&path, &home_roots())?;
    let _fs = FS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let new_nb = {
        let mut db = state.db.lock().map_err(|e| e.to_string())?;
        let (src, ro) = {
            let s = state.session.lock().map_err(|e| e.to_string())?;
            (s.notebook.clone(), s.held_by.is_some())
        };
        if ro {
            return Err("This notebook is open read-only".into());
        }
        // Bring the mirror up to date first, so what moves is current.
        let _ = mirror::run(&db, &MirrorTarget::for_notebook(&src), false);
        let prepared = notebook::prepare_move_to_folder(&db, &src, &dest, None).map_err(|e| e.to_string())?;
        let new_nb = prepared.notebook.clone();
        let (new_db, _) = match open_for_session(&new_nb, false) {
            Ok(x) => x,
            Err(e) => {
                prepared.rollback();
                return Err(e);
            }
        };
        *db = new_db; // closes the old database before its files go
        notebook::release_lock(&src.lock_path());
        *state.current_graph.lock().map_err(|e| e.to_string())? = new_nb.key.clone();
        *state.session.lock().map_err(|e| e.to_string())? =
            Session { notebook: new_nb.clone(), held_by: None, notice: None };
        state.virtual_journals.lock().map_err(|e| e.to_string())?.clear();
        crate::set_active_graph_name(&new_nb.key);
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
    let graph = state.current_graph.lock().map_err(|e| e.to_string())?.clone();
    let n = {
        let _fs = FS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let db = state.db.lock().map_err(|e| e.to_string())?;
        minotes_core::sync_manager::resolve_held_deletions(&db, &graph, move_to_trash).map_err(|e| e.to_string())?
    };
    if let Some(w) = app.try_state::<MirrorWorker>() {
        w.send(MirrorMsg::Changed);
    }
    Ok(n)
}
