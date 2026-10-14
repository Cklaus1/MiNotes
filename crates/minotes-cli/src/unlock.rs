//! Opening a notebook's database from the CLI, including encrypted notebooks
//! (PRD-encryption §4.4). The key comes from, in order: the OS keychain (when
//! "Keep unlocked on this device" remembered it), `MINOTES_PASSPHRASE`, or a
//! no-echo prompt on the terminal. The passphrase is never a command-line argument.

use std::io::IsTerminal;
use std::path::{Path, PathBuf};

use minotes_core::crypto::{self, Secret};
use minotes_core::db::Database;
use minotes_core::error::Error;
use minotes_core::notebook::{self, Location, Notebook};
use minotes_core::{encryption, keychain};
use zeroize::Zeroizing;

pub const PASSPHRASE_ENV: &str = "MINOTES_PASSPHRASE";

/// The folder notebook at `root` (registered or not), from its notebook.json.
pub fn folder_notebook(root: &Path) -> Option<Notebook> {
    if !root.join(notebook::META_FILE).is_file() {
        return None;
    }
    let meta = notebook::read_meta(root).ok()?;
    // A registered notebook keeps its registry name.
    let reg = notebook::Registry::load();
    let name = reg.find(&meta.id).map(|e| e.name.clone()).unwrap_or(meta.name);
    Some(Notebook { key: meta.id, name, location: Location::Folder { root: root.to_path_buf() } })
}

/// The folder notebook whose database is `db_path`, if it is one.
fn notebook_of_db(db_path: &Path) -> Option<Notebook> {
    if db_path.file_name().and_then(|n| n.to_str()) != Some(notebook::DB_FILE) {
        return None;
    }
    let root = db_path.parent().filter(|p| !p.as_os_str().is_empty()).map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
    folder_notebook(&root)
}

/// Human-readable message for a core error while unlocking.
fn unlock_error(e: Error) -> String {
    match e {
        Error::WrongPassphrase => "Wrong passphrase".into(),
        e => e.to_string(),
    }
}

/// A passphrase from `MINOTES_PASSPHRASE`, else a no-echo terminal prompt
/// (asked twice when `confirm`, for a new passphrase). No terminal and no
/// variable: `no_source` is the error.
pub fn passphrase(prompt: &str, confirm: bool, no_source: &str) -> Result<Zeroizing<String>, String> {
    if let Some(p) = std::env::var_os(PASSPHRASE_ENV).filter(|v| !v.is_empty()) {
        return p
            .into_string()
            .map(Zeroizing::new)
            .map_err(|_| format!("{PASSPHRASE_ENV} is not valid UTF-8"));
    }
    if !std::io::stdin().is_terminal() {
        return Err(no_source.to_string());
    }
    let read = |p: &str| {
        rpassword::prompt_password(p).map(Zeroizing::new).map_err(|e| format!("Could not read the passphrase: {e}"))
    };
    let first = read(prompt)?;
    if confirm {
        crypto::check_passphrase(&first).map_err(|e| e.to_string())?;
        let again = read("Repeat the passphrase: ")?;
        if *again != *first {
            return Err("The passphrases do not match".into());
        }
    }
    Ok(first)
}

/// Unlock `nb` (encrypted) in this process: keychain, then env, then prompt.
pub fn unlock(nb: &Notebook) -> Result<(), String> {
    if encryption::unlocked_key(&nb.key).is_some() {
        return Ok(());
    }
    // A stale remembered key (e.g. after a key rotation elsewhere) falls through.
    if let Some(key) = keychain::recall(&nb.key) {
        if encryption::unlock_with_key(nb, key).is_ok() {
            return Ok(());
        }
    }
    let pass = passphrase(
        &format!("Passphrase for {}: ", nb.name),
        false,
        &format!("Notebook '{}' is encrypted: set {PASSPHRASE_ENV} or run in a terminal", nb.name),
    )?;
    encryption::unlock(nb, Secret::Passphrase(&pass)).map(drop).map_err(unlock_error)
}

/// Open the database at `db_path` (as resolved by `--notebook`). A folder
/// notebook first finishes any interrupted encrypt/decrypt; an encrypted one is
/// unlocked. Anything else opens exactly as a plain database file.
pub fn open_db(db_path: &Path) -> Result<Database, String> {
    if let Some(nb) = notebook_of_db(db_path) {
        encryption::resume_conversion(&nb)
            .map_err(|e| format!("Could not finish an interrupted encryption change: {e}"))?;
        if nb.is_encrypted() {
            unlock(&nb)?;
            return nb.open_db().map_err(unlock_error);
        }
    }
    Database::open(db_path).map_err(|e| format!("Failed to open database: {e}"))
}
