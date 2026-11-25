//! Sync setup, conflict compare and held-deletion commands (UX review Wave 4).
//! See `minotes_core::sync_remote` (addresses, Test connection, join) and
//! `minotes_core::repo::conflicts` (compare / resolve a conflict copy).
//!
//! No credentials pass through here: git signs in with the user's SSH agent or
//! credential helper, and an address with a password in it is refused.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

use minotes_core::models::RestoreBlock;
use minotes_core::notebook::{self, NotebookInfo};
use minotes_core::repo::conflicts::{ConflictChoice, ConflictCompare, ConflictResolution};
use minotes_core::sync_manager::{self, GitSyncStatus};
use minotes_core::sync_remote::{self, LocalRoots, RemoteCheck};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use crate::notebooks::{home_roots, MirrorMsg, MirrorWorker};
use crate::{current_notebook_key, lock_db_for_notebook, refuse_read_only, security, AppState};

/// Folders the user chose in the native picker for a sync remote: such a
/// folder may be outside the home folder (only a picked one, never a typed one).
static PICKED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

fn roots() -> LocalRoots {
    LocalRoots { homes: home_roots(), picked: PICKED.lock().map(|p| p.clone()).unwrap_or_default() }
}

fn msg(e: minotes_core::error::Error) -> String {
    sync_remote::user_message(&e)
}

fn uuid(s: &str) -> Result<Uuid, String> {
    Uuid::parse_str(s).map_err(|e| e.to_string())
}

/// "Choose folder…" for a sync remote (a bare repository on a drive or a share).
/// Android has no folder choosing (the dialog plugin can't pick folders there;
/// the UI gates it on `useCapabilities()`), so the command refuses.
#[cfg(target_os = "android")]
#[tauri::command(async)]
pub fn pick_sync_remote_folder(app: AppHandle) -> Result<Option<String>, String> {
    let _ = (app, &PICKED);
    Err("Choosing a folder is not available on this device".into())
}

/// "Choose folder…" for a sync remote (a bare repository on a drive or a share).
#[cfg(not(target_os = "android"))]
#[tauri::command(async)]
pub fn pick_sync_remote_folder(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let mut dialog = app.dialog().file().set_title("Choose the git repository folder");
    dialog = dialog.set_directory(notebook::home_dir());
    let Some(chosen) = dialog.blocking_pick_folder() else { return Ok(None) };
    let path = chosen.into_path().map_err(|e| e.to_string())?;
    let canon = std::fs::canonicalize(&path).unwrap_or(path);
    if let Ok(mut p) = PICKED.lock() {
        if !p.contains(&canon) {
            p.push(canon.clone());
        }
    }
    Ok(Some(canon.to_string_lossy().to_string()))
}

/// "Test connection": reachable / empty / not found / sign-in refused / not a
/// git repository / offline / timeout (never an error).
#[tauri::command(async)]
pub fn git_sync_test_remote(url: String) -> RemoteCheck {
    sync_remote::check_remote(&url, &roots(), sync_remote::REMOTE_TEST_TIMEOUT)
}

/// "Set up sync": the remote (tested first) + init + first push, for the open notebook.
#[tauri::command(async)]
pub fn git_sync_setup(state: State<'_, AppState>, url: String) -> Result<GitSyncStatus, String> {
    refuse_read_only(&state)?;
    let key = current_notebook_key(&state)?;
    sync_manager::setup_sync_with(&key, &url, &roots(), || lock_db_for_notebook(&state, &key)).map_err(msg)
}

/// Change the open notebook's sync remote (tested first).
#[tauri::command(async)]
pub fn git_sync_set_remote(state: State<'_, AppState>, url: String) -> Result<GitSyncStatus, String> {
    refuse_read_only(&state)?;
    let key = current_notebook_key(&state)?;
    sync_manager::change_remote(&key, &url, &roots()).map_err(msg)
}

/// Remove the open notebook's sync remote (sync stays on, local only).
#[tauri::command(async)]
pub fn git_sync_remove_remote(state: State<'_, AppState>) -> Result<GitSyncStatus, String> {
    refuse_read_only(&state)?;
    let key = current_notebook_key(&state)?;
    sync_manager::remove_sync_remote(&key).map_err(msg)
}

/// "Join an existing notebook…": a new folder notebook (default
/// `~/MiNotes/<name>`) from a sync remote. Plain remote: fetched as is; an
/// encrypted one needs `passphrase` (or the recovery key) — without it the
/// error starts with `ENCRYPTED_REMOTE:`. Does not switch; the app switches
/// and turns sync on, which imports everything.
#[tauri::command(async)]
pub fn join_notebook(remote: String, name: String, location: Option<String>, passphrase: Option<String>) -> Result<NotebookInfo, String> {
    let name = name.trim().to_string();
    notebook::validate_name(&name).map_err(|e| e.to_string())?;
    let v = sync_remote::validate_remote(&remote, &roots()).map_err(msg)?;
    let loc = match location.filter(|l| !l.trim().is_empty() && !notebook::is_app_storage()) {
        Some(l) => l,
        None => notebook::default_location(&name).display().to_string(),
    };
    let dir = security::validate_notebook_dir(&loc, &home_roots())?;
    let nb = match passphrase.filter(|p| !p.is_empty()) {
        Some(secret) => minotes_core::sync_encrypted::join_from_remote(&v.url, &dir, &name, &secret).map_err(|e| match e {
            minotes_core::error::Error::WrongPassphrase => "Wrong passphrase or recovery key".to_string(),
            other => msg(other),
        })?,
        None => sync_remote::join_plain(&v.url, &roots(), &dir, &name).map_err(msg)?,
    };
    Ok(notebook::info(&nb))
}

/// The blocks of a conflict copy that differ from its page.
#[tauri::command]
pub fn conflict_compare(state: State<'_, AppState>, copy_id: String) -> Result<ConflictCompare, String> {
    let db = state.db_guard()?;
    db.conflict_compare(&uuid(&copy_id)?).map_err(msg)
}

/// Apply per-block choices and move the copy to the Trash (one transaction).
#[tauri::command]
pub fn resolve_conflict(app: AppHandle, state: State<'_, AppState>, copy_id: String, choices: Vec<ConflictChoice>) -> Result<ConflictResolution, String> {
    refuse_read_only(&state)?;
    let r = {
        let db = state.db_guard()?;
        db.resolve_conflict(&uuid(&copy_id)?, &choices).map_err(msg)?
    };
    if let Some(w) = app.try_state::<MirrorWorker>() {
        w.send(MirrorMsg::Changed);
    }
    Ok(r)
}

/// Undo (`before`, copy back) / redo (`after`, copy trashed) of a resolution.
#[tauri::command]
pub fn set_conflict_resolution(
    app: AppHandle,
    state: State<'_, AppState>,
    page_id: String,
    copy_id: String,
    blocks: Vec<RestoreBlock>,
    copy_in_trash: bool,
) -> Result<(), String> {
    refuse_read_only(&state)?;
    {
        let db = state.db_guard()?;
        db.set_conflict_resolution(&uuid(&page_id)?, &uuid(&copy_id)?, &blocks, copy_in_trash).map_err(msg)?;
    }
    if let Some(w) = app.try_state::<MirrorWorker>() {
        w.send(MirrorMsg::Changed);
    }
    Ok(())
}

/// Parse the review list's "keep" ids.
pub(crate) fn keep_set(keep: Option<Vec<String>>) -> Result<HashSet<Uuid>, String> {
    keep.unwrap_or_default().iter().map(|s| uuid(s)).collect()
}
