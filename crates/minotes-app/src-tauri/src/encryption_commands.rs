//! Encrypted notebooks in the desktop app (PRD-encryption §5, §6.3): create,
//! unlock, lock, passphrase and recovery key, "keep unlocked on this device",
//! encrypt / decrypt / rotate the open notebook.
//!
//! The open notebook's database is `None` while it is locked (`AppState.db`);
//! every other command then fails with `NOTEBOOK_LOCKED: …` and the window shows
//! the unlock screen. Errors the UI must tell apart start with a code:
//! `NOTEBOOK_LOCKED`, `WRONG_PASSPHRASE`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use minotes_core::crypto::{RecoveryKey, Secret};
use minotes_core::encryption;
use minotes_core::error::Error;
use minotes_core::keychain;
use minotes_core::mirror::FS_LOCK;
use minotes_core::notebook::{self, Notebook, NotebookInfo};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::notebooks::{self, SessionInfo};
use crate::{security, AppState};

/// Map core errors to what the UI matches on.
fn err(e: Error) -> String {
    match e {
        Error::WrongPassphrase => "WRONG_PASSPHRASE: Wrong passphrase".into(),
        Error::Locked(name) => format!("{}: Notebook \u{201c}{name}\u{201d} is locked", crate::LOCKED_ERROR),
        other => other.to_string(),
    }
}

fn current(state: &AppState) -> Result<(Notebook, bool), String> {
    let s = state.session.lock().map_err(|e| e.to_string())?;
    Ok((s.notebook.clone(), s.held_by.is_some()))
}

fn session(state: &AppState) -> Result<SessionInfo, String> {
    let s = state.session.lock().map_err(|e| e.to_string())?;
    Ok(notebooks::session_info(&s))
}

fn require_encrypted(nb: &Notebook) -> Result<(), String> {
    if nb.is_encrypted() {
        Ok(())
    } else {
        Err(format!("Notebook \u{201c}{}\u{201d} is not encrypted", nb.name))
    }
}

// ── Session teardown ──

/// Temporary plaintext copies made to open an attachment in another app.
fn open_copies_dir() -> PathBuf {
    std::env::temp_dir().join(format!("minotes-open-{}", std::process::id()))
}

/// Delete the temporary copies (on lock, switch and quit).
pub(crate) fn remove_open_copies() {
    let _ = std::fs::remove_dir_all(open_copies_dir());
}

/// Forget everything secret about `nb` this process holds: its unlocked key,
/// running AI requests and conversations, temporary attachment copies.
pub(crate) fn forget_session_secrets(nb: &Notebook) {
    if nb.is_encrypted() {
        encryption::lock(nb);
        crate::ai_commands::forget_runtime();
        remove_open_copies();
    }
}

/// Write a temporary copy of an encrypted notebook's attachment to open it in
/// the OS default app (documented: deleted on lock, switch and quit).
pub(crate) fn temp_copy(hash: &str, ext: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let dir = open_copies_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    let p = dir.join(format!("{hash}.{ext}"));
    std::fs::write(&p, bytes).map_err(|e| e.to_string())?;
    Ok(p)
}

// ── Failed attempts (courtesy delay; the KDF is the real defence) ──

fn failures() -> &'static Mutex<HashMap<String, u32>> {
    static F: std::sync::OnceLock<Mutex<HashMap<String, u32>>> = std::sync::OnceLock::new();
    F.get_or_init(Default::default)
}

/// Delay before attempt `n+1` after `n` failures: none for the first 5, then
/// 1 s, 2 s, 4 s … up to 30 s.
fn attempt_delay(failed: u32) -> Duration {
    if failed < 5 {
        return Duration::ZERO;
    }
    Duration::from_secs((1u64 << (failed - 5).min(5)).min(30))
}

// ── Commands ──

#[derive(Serialize)]
pub struct CreatedEncrypted {
    pub notebook: NotebookInfo,
    /// Shown once; never stored.
    pub recovery_key: String,
}

/// "New notebook…" with "Encrypt this notebook". Does not switch (the key stays
/// unlocked in this process, so switching to it needs no passphrase).
#[tauri::command(async)]
pub fn create_encrypted_notebook(name: String, location: Option<String>, passphrase: String) -> Result<CreatedEncrypted, String> {
    let name = name.trim().to_string();
    notebook::validate_name(&name).map_err(|e| e.to_string())?;
    let loc = match location.filter(|l| !l.trim().is_empty() && !notebook::is_app_storage()) {
        Some(l) => l,
        None => notebook::default_location(&name).display().to_string(),
    };
    let dir = security::validate_notebook_dir(&loc, &notebooks::home_roots())?;
    let (nb, rk) = encryption::create_in_folder(&dir, &name, &passphrase).map_err(err)?;
    Ok(CreatedEncrypted { notebook: notebook::info(&nb), recovery_key: rk.display().to_string() })
}

/// "Join an encrypted notebook…": a new encrypted notebook (default
/// `~/MiNotes/<name>`) from a git sync remote another device pushed, unlocked
/// with that notebook's passphrase or recovery key. Does not switch; the caller
/// then switches and turns sync on (which imports everything). A wrong secret
/// creates nothing and nothing is written to the remote.
#[tauri::command(async)]
pub fn join_encrypted_notebook(remote: String, name: String, location: Option<String>, passphrase: String) -> Result<NotebookInfo, String> {
    let name = name.trim().to_string();
    notebook::validate_name(&name).map_err(|e| e.to_string())?;
    let remote = remote.trim().to_string();
    if remote.is_empty() || remote.starts_with('-') || remote.contains('\0') {
        return Err("Enter the sync remote's address".into());
    }
    let loc = match location.filter(|l| !l.trim().is_empty() && !notebook::is_app_storage()) {
        Some(l) => l,
        None => notebook::default_location(&name).display().to_string(),
    };
    let dir = security::validate_notebook_dir(&loc, &notebooks::home_roots())?;
    let nb = minotes_core::sync_encrypted::join_from_remote(&remote, &dir, &name, &passphrase).map_err(err)?;
    Ok(notebook::info(&nb))
}

/// Open the locked notebook with its passphrase (or, with `recovery`, its
/// recovery key). `remember`: keep the key in this device's keychain.
#[tauri::command(async)]
pub fn unlock_notebook(
    app: AppHandle,
    state: State<'_, AppState>,
    secret: String,
    recovery: Option<bool>,
    remember: Option<bool>,
) -> Result<SessionInfo, String> {
    let (nb, read_only) = current(&state)?;
    require_encrypted(&nb)?;
    let failed = failures().lock().map(|f| *f.get(&nb.key).unwrap_or(&0)).unwrap_or(0);
    std::thread::sleep(attempt_delay(failed));
    let unlocked = if recovery.unwrap_or(false) {
        let rk = RecoveryKey::parse(&secret).map_err(err)?;
        encryption::unlock(&nb, Secret::Recovery(&rk))
    } else {
        encryption::unlock(&nb, Secret::Passphrase(&secret))
    };
    let key = match unlocked {
        Ok(k) => k,
        Err(e) => {
            if matches!(e, Error::WrongPassphrase) {
                if let Ok(mut f) = failures().lock() {
                    *f.entry(nb.key.clone()).or_default() += 1;
                }
            }
            return Err(err(e));
        }
    };
    if let Ok(mut f) = failures().lock() {
        f.remove(&nb.key);
    }
    if remember.unwrap_or(false) {
        keychain::remember(&nb.key, &key).map_err(|e| e.to_string())?;
    }
    let db = notebooks::open_unlocked(&nb, read_only)?;
    {
        let mut slot = state.db.lock().map_err(|e| e.to_string())?;
        *slot = Some(db);
        state.virtual_journals.lock().map_err(|e| e.to_string())?.clear();
    }
    if let Some(w) = app.try_state::<notebooks::DbWatch>() {
        w.watch(&nb.db_path());
    }
    session(&state)
}

/// "Lock now" / auto-lock: close the database and forget the key.
#[tauri::command]
pub fn lock_notebook(state: State<'_, AppState>) -> Result<SessionInfo, String> {
    let (nb, _) = current(&state)?;
    require_encrypted(&nb)?;
    {
        let mut slot = state.db.lock().map_err(|e| e.to_string())?;
        if let Some(db) = slot.as_ref() {
            let _ = notebook::checkpoint(db);
        }
        *slot = None;
        state.virtual_journals.lock().map_err(|e| e.to_string())?.clear();
    }
    forget_session_secrets(&nb);
    session(&state)
}

/// Change the passphrase (the database is not rewritten).
#[tauri::command(async)]
pub fn change_passphrase(state: State<'_, AppState>, current_passphrase: String, new_passphrase: String) -> Result<(), String> {
    let (nb, _) = current(&state)?;
    require_encrypted(&nb)?;
    encryption::change_passphrase(&nb, Secret::Passphrase(&current_passphrase), &new_passphrase).map_err(err)
}

/// Forgotten passphrase: the recovery key sets a new passphrase and a new
/// recovery key is issued (returned, shown once). Unlocks the notebook.
#[tauri::command(async)]
pub fn recover_with_key(
    app: AppHandle,
    state: State<'_, AppState>,
    recovery_key: String,
    new_passphrase: String,
) -> Result<String, String> {
    let (nb, read_only) = current(&state)?;
    require_encrypted(&nb)?;
    let rk = RecoveryKey::parse(&recovery_key).map_err(err)?;
    let new_rk = encryption::recover(&nb, &rk, &new_passphrase).map_err(err)?;
    let db = notebooks::open_unlocked(&nb, read_only)?;
    *state.db.lock().map_err(|e| e.to_string())? = Some(db);
    if let Some(w) = app.try_state::<notebooks::DbWatch>() {
        w.watch(&nb.db_path());
    }
    Ok(new_rk.display().to_string())
}

/// A new recovery key (the old one stops working). Needs the passphrase.
#[tauri::command(async)]
pub fn regenerate_recovery_key(state: State<'_, AppState>, passphrase: String) -> Result<String, String> {
    let (nb, _) = current(&state)?;
    require_encrypted(&nb)?;
    encryption::regenerate_recovery_key(&nb, &passphrase).map(|rk| rk.display().to_string()).map_err(err)
}

/// "Keep unlocked on this device" on/off for the open (unlocked) notebook.
#[tauri::command]
pub fn set_remember_device(state: State<'_, AppState>, remember: bool) -> Result<SessionInfo, String> {
    let (nb, _) = current(&state)?;
    require_encrypted(&nb)?;
    if remember {
        let key = encryption::unlocked_key(&nb.key).ok_or_else(|| err(Error::Locked(nb.name.clone())))?;
        if !keychain::available() {
            return Err("This device has no keychain MiNotes can use".into());
        }
        keychain::remember(&nb.key, &key).map_err(|e| e.to_string())?;
    } else {
        keychain::forget(&nb.key);
    }
    session(&state)
}

#[derive(Serialize)]
pub struct EncryptionPlan {
    /// Paths deleted once the encrypted copy is verified.
    pub deletes: Vec<String>,
    /// A legacy-location notebook: move it to a folder first.
    pub needs_folder: bool,
    /// The markdown copy is a git repository (its remote keeps old plaintext commits).
    pub has_git: bool,
}

/// What "Encrypt this notebook" will do to the open notebook (shown first).
#[tauri::command]
pub fn encryption_plan(state: State<'_, AppState>) -> Result<EncryptionPlan, String> {
    let (nb, _) = current(&state)?;
    Ok(EncryptionPlan {
        deletes: encryption::encrypt_deletes(&nb).into_iter().map(|p| p.display().to_string()).collect(),
        needs_folder: !nb.is_folder(),
        has_git: nb.mirror_dir().join(".git").exists(),
    })
}

/// Run a conversion of the open notebook with its database closed, then reopen.
fn convert_open(
    app: &AppHandle,
    state: &AppState,
    run: impl FnOnce(&Notebook) -> Result<Option<String>, Error>,
) -> Result<Option<String>, String> {
    let (nb, read_only) = current(state)?;
    if read_only {
        return Err("This notebook is open read-only in this window".into());
    }
    let _fs = FS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut slot = state.db.lock().map_err(|e| e.to_string())?;
    if let Some(db) = slot.as_ref() {
        notebook::checkpoint(db).map_err(|e| e.to_string())?;
    }
    *slot = None; // closes the connection: the file is about to be replaced
    let result = run(&nb);
    // Reopen whatever is there now (the new notebook, or the old one on error).
    let _ = encryption::resume_conversion(&nb);
    *slot = match notebooks::open_unlocked(&nb, false) {
        Ok(db) => Some(db),
        Err(_) => None,
    };
    state.virtual_journals.lock().map_err(|e| e.to_string())?.clear();
    drop(slot);
    drop(_fs);
    if let Some(w) = app.try_state::<notebooks::DbWatch>() {
        w.watch(&nb.db_path());
    }
    if let Some(w) = app.try_state::<notebooks::MirrorWorker>() {
        w.send(notebooks::MirrorMsg::Full);
    }
    result.map_err(err)
}

/// Encrypt the open notebook. Returns the recovery key (shown once).
#[tauri::command(async)]
pub fn encrypt_notebook(app: AppHandle, state: State<'_, AppState>, passphrase: String) -> Result<String, String> {
    convert_open(&app, &state, |nb| encryption::encrypt_notebook(nb, &passphrase).map(|rk| Some(rk.display().to_string())))
        .map(Option::unwrap_or_default)
}

/// Remove encryption from the open notebook (behind its passphrase).
#[tauri::command(async)]
pub fn decrypt_notebook(app: AppHandle, state: State<'_, AppState>, passphrase: String) -> Result<(), String> {
    let (nb, _) = current(&state)?;
    require_encrypted(&nb)?;
    convert_open(&app, &state, |nb| encryption::decrypt_notebook(nb, &passphrase).map(|_| None)).map(drop)
}

/// Rotate the data key ("Advanced"): a new recovery key is returned, remembered
/// devices are forgotten.
#[tauri::command(async)]
pub fn rotate_notebook_key(app: AppHandle, state: State<'_, AppState>, passphrase: String) -> Result<String, String> {
    let (nb, _) = current(&state)?;
    require_encrypted(&nb)?;
    convert_open(&app, &state, |nb| encryption::rotate_key(nb, &passphrase).map(|rk| Some(rk.display().to_string())))
        .map(Option::unwrap_or_default)
}

#[cfg(test)]
mod tests {
    use super::attempt_delay;
    use std::time::Duration;

    #[test]
    fn delay_starts_after_five_failures_and_is_capped() {
        assert_eq!(attempt_delay(0), Duration::ZERO);
        assert_eq!(attempt_delay(4), Duration::ZERO);
        assert_eq!(attempt_delay(5), Duration::from_secs(1));
        assert_eq!(attempt_delay(6), Duration::from_secs(2));
        assert_eq!(attempt_delay(9), Duration::from_secs(16));
        assert_eq!(attempt_delay(10), Duration::from_secs(30));
        assert_eq!(attempt_delay(100), Duration::from_secs(30));
    }
}
