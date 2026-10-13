//! Encrypted notebooks (PRD-encryption): creating one, unlocking and locking it,
//! changing the passphrase, the recovery key — and the process-wide cache of
//! unlocked data keys that every way of opening a notebook consults
//! ([`Notebook::open_db`], [`Notebook::open_read_only`], cross-notebook reads).
//!
//! The key material itself is in [`crate::crypto`]; the slots live in the
//! notebook's `notebook.json` (`"encryption"`). Only folder notebooks can be
//! encrypted (a legacy `~/.minotes/<name>.db` is moved to a folder first).

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use crate::crypto::{self, DataKey, EncryptionInfo, KdfParams, RecoveryKey, Secret};
use crate::db::Database;
use crate::error::{Error, Result};
use crate::notebook::{self, Notebook, NotebookMeta};

// ── Unlocked-key cache ──

/// Data keys of the notebooks unlocked in this process, by notebook key. Entries
/// are zeroized when removed ([`DataKey`] zeroizes on drop).
static UNLOCKED: Mutex<Option<HashMap<String, DataKey>>> = Mutex::new(None);

/// The data key of an unlocked notebook.
pub fn unlocked_key(notebook_key: &str) -> Option<DataKey> {
    UNLOCKED.lock().ok()?.as_ref()?.get(notebook_key).cloned()
}

/// Remember `key` for `notebook_key` (after a verified unlock).
pub fn remember_unlocked(notebook_key: &str, key: DataKey) {
    if let Ok(mut g) = UNLOCKED.lock() {
        g.get_or_insert_with(HashMap::new).insert(notebook_key.to_string(), key);
    }
}

/// Forget (zeroize) the key of `notebook_key`: the notebook is locked again.
pub fn forget_unlocked(notebook_key: &str) {
    if let Ok(mut g) = UNLOCKED.lock() {
        if let Some(m) = g.as_mut() {
            m.remove(notebook_key);
        }
    }
}

/// Is `nb` encrypted and not unlocked in this process?
pub fn is_locked(nb: &Notebook) -> bool {
    nb.is_encrypted() && unlocked_key(&nb.key).is_none()
}

// ── Create ──

/// Create a new encrypted notebook in `root` (which must not exist yet, or be
/// empty). Returns the notebook — unlocked — and the recovery key to show once.
pub fn create_in_folder(root: &Path, name: &str, passphrase: &str) -> Result<(Notebook, RecoveryKey)> {
    create_in_folder_with(root, name, passphrase, KdfParams::default())
}

/// [`create_in_folder`] with chosen Argon2 parameters (tests use small ones).
pub fn create_in_folder_with(
    root: &Path,
    name: &str,
    passphrase: &str,
    params: KdfParams,
) -> Result<(Notebook, RecoveryKey)> {
    crypto::check_passphrase(passphrase)?;
    let dek = DataKey::generate();
    let (info, rk) = EncryptionInfo::new(&dek, passphrase, params)?;
    let nb = notebook::create_in_folder_with(root, name, Some((&dek, info)))?;
    remember_unlocked(&nb.key, dek);
    Ok((nb, rk))
}

// ── Unlock / lock ──

fn info_of(nb: &Notebook) -> Result<EncryptionInfo> {
    nb.encryption()
        .ok_or_else(|| Error::InvalidInput(format!("Notebook '{}' is not encrypted", nb.name)))
}

/// Check that `key` opens the notebook's database (read-only, nothing written).
fn verify_key(nb: &Notebook, key: &DataKey) -> Result<()> {
    Database::open_read_only_encrypted(&nb.db_path(), key, 2000).map(drop)
}

/// Unlock with the passphrase or the recovery key. A wrong one is
/// [`Error::WrongPassphrase`]; a right one that doesn't open the database is
/// [`Error::KeyMismatch`].
pub fn unlock(nb: &Notebook, secret: Secret<'_>) -> Result<DataKey> {
    let key = info_of(nb)?.unlock(secret)?;
    verify_key(nb, &key)?;
    remember_unlocked(&nb.key, key.clone());
    Ok(key)
}

/// Unlock with a data key remembered on this device (the OS keychain).
pub fn unlock_with_key(nb: &Notebook, key: DataKey) -> Result<()> {
    info_of(nb)?;
    verify_key(nb, &key)?;
    remember_unlocked(&nb.key, key);
    Ok(())
}

/// Lock: forget the data key. (The caller closes its connection.)
pub fn lock(nb: &Notebook) {
    forget_unlocked(&nb.key);
}

// ── Passphrase and recovery key ──

fn write_info(nb: &Notebook, info: EncryptionInfo) -> Result<()> {
    let root = nb.root().ok_or_else(|| Error::InvalidInput("Only folder notebooks can be encrypted".into()))?;
    let mut meta: NotebookMeta = notebook::read_meta(root)?;
    meta.encryption = Some(info);
    notebook::write_meta(root, &meta)
}

/// Change the passphrase: unwrap with `current` (passphrase or recovery key),
/// re-wrap with `new_passphrase`, rewrite the one slot atomically. The database
/// is not touched.
pub fn change_passphrase(nb: &Notebook, current: Secret<'_>, new_passphrase: &str) -> Result<()> {
    change_passphrase_with(nb, current, new_passphrase, KdfParams::default())
}

pub fn change_passphrase_with(nb: &Notebook, current: Secret<'_>, new_passphrase: &str, params: KdfParams) -> Result<()> {
    crypto::check_passphrase(new_passphrase)?;
    let mut info = info_of(nb)?;
    let dek = info.unlock(current)?;
    verify_key(nb, &dek)?;
    info.set_passphrase(&dek, new_passphrase, params)?;
    write_info(nb, info)?;
    remember_unlocked(&nb.key, dek);
    Ok(())
}

/// A new recovery key (the old one stops working). Requires the passphrase.
pub fn regenerate_recovery_key(nb: &Notebook, passphrase: &str) -> Result<RecoveryKey> {
    let mut info = info_of(nb)?;
    let dek = info.unlock(Secret::Passphrase(passphrase))?;
    verify_key(nb, &dek)?;
    let rk = info.regenerate_recovery(&dek);
    write_info(nb, info)?;
    Ok(rk)
}

/// Forgotten passphrase: unlock with the recovery key, set a new passphrase and
/// issue a new recovery key (PRD §5: using the recovery key forces both).
pub fn recover(nb: &Notebook, recovery: &RecoveryKey, new_passphrase: &str) -> Result<RecoveryKey> {
    recover_with(nb, recovery, new_passphrase, KdfParams::default())
}

pub fn recover_with(nb: &Notebook, recovery: &RecoveryKey, new_passphrase: &str, params: KdfParams) -> Result<RecoveryKey> {
    crypto::check_passphrase(new_passphrase)?;
    let mut info = info_of(nb)?;
    let dek = info.unlock(Secret::Recovery(recovery))?;
    verify_key(nb, &dek)?;
    info.set_passphrase(&dek, new_passphrase, params)?;
    let rk = info.regenerate_recovery(&dek);
    write_info(nb, info)?;
    remember_unlocked(&nb.key, dek);
    Ok(rk)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::notebook::tests::FakeHome;

    pub(crate) fn with_home(f: impl FnOnce(&Path)) {
        let h = FakeHome::new();
        f(h.path())
    }

    pub(crate) const FAST: KdfParams = KdfParams { m_kib: 1024, t: 1, p: 1 };
    pub(crate) const PASS: &str = "correct horse battery";

    pub(crate) fn new_encrypted(home: &Path, name: &str) -> (Notebook, RecoveryKey) {
        create_in_folder_with(&home.join("MiNotes").join(name), name, PASS, FAST).unwrap()
    }

    fn contains(path: &Path, needle: &[u8]) -> bool {
        std::fs::read(path).map(|b| b.windows(needle.len()).any(|w| w == needle)).unwrap_or(false)
    }

    #[test]
    fn create_write_lock_unlock_round_trip() {
        with_home(|home| {
            let (nb, _rk) = new_encrypted(home, "Secret");
            {
                let db = nb.open_db().unwrap();
                db.create_page("Marker Platypus", None, false, None, "user").unwrap();
            }
            let meta_text = std::fs::read_to_string(nb.root().unwrap().join("notebook.json")).unwrap();
            assert!(!meta_text.contains("Secret"), "notebook.json must not hold the name: {meta_text}");
            assert!(meta_text.contains("\"format_version\": 2"));
            assert!(meta_text.contains("argon2id"));
            // Still listed under its local name, encrypted and (now) unlocked.
            let info = notebook::list().into_iter().find(|n| n.key == nb.key).unwrap();
            assert_eq!(info.name, "Secret");
            assert!(info.encrypted && !info.locked);
            assert!(!nb.mirror_enabled(), "no plaintext mirror for an encrypted notebook");

            lock(&nb);
            assert!(is_locked(&nb));
            assert!(matches!(nb.open_db(), Err(Error::Locked(_))));
            assert!(matches!(nb.open_read_only(100), Err(Error::Locked(_))));
            assert!(notebook::list().into_iter().find(|n| n.key == nb.key).unwrap().locked);

            assert!(matches!(unlock(&nb, Secret::Passphrase("wrong passphrase!")), Err(Error::WrongPassphrase)));
            assert!(is_locked(&nb));
            unlock(&nb, Secret::Passphrase(PASS)).unwrap();
            let db = nb.open_db().unwrap();
            assert_eq!(db.list_pages(Some(10)).unwrap()[0].title, "Marker Platypus");
            drop(db);
            for f in ["notebook.minotes", "notebook.minotes-wal", "notebook.json"] {
                assert!(!contains(&nb.root().unwrap().join(f), b"Marker Platypus"), "{f}");
            }
        });
    }

    #[test]
    fn recovery_key_unlocks_and_recover_sets_new_passphrase_and_key() {
        with_home(|home| {
            let (nb, rk) = new_encrypted(home, "Rec");
            lock(&nb);
            let parsed = RecoveryKey::parse(&rk.display()).unwrap();
            unlock(&nb, Secret::Recovery(&parsed)).unwrap();
            lock(&nb);
            let new_rk = recover_with(&nb, &parsed, "a fresh new passphrase", FAST).unwrap();
            assert!(!is_locked(&nb));
            lock(&nb);
            assert!(matches!(unlock(&nb, Secret::Passphrase(PASS)), Err(Error::WrongPassphrase)));
            assert!(matches!(unlock(&nb, Secret::Recovery(&parsed)), Err(Error::WrongPassphrase)), "old recovery key retired");
            unlock(&nb, Secret::Recovery(&new_rk)).unwrap();
            lock(&nb);
            unlock(&nb, Secret::Passphrase("a fresh new passphrase")).unwrap();
        });
    }

    #[test]
    fn change_passphrase_leaves_database_bytes_unchanged() {
        with_home(|home| {
            let (nb, _rk) = new_encrypted(home, "Bytes");
            {
                let db = nb.open_db().unwrap();
                db.create_page("Some page", None, false, None, "user").unwrap();
                crate::notebook::checkpoint(&db).unwrap();
            }
            let before = std::fs::read(nb.db_path()).unwrap();
            lock(&nb);
            change_passphrase_with(&nb, Secret::Passphrase(PASS), "another good passphrase", FAST).unwrap();
            assert_eq!(std::fs::read(nb.db_path()).unwrap(), before, "the database is not rewritten");
            lock(&nb);
            assert!(matches!(unlock(&nb, Secret::Passphrase(PASS)), Err(Error::WrongPassphrase)));
            unlock(&nb, Secret::Passphrase("another good passphrase")).unwrap();
            // Weak new passphrases are refused.
            assert!(change_passphrase_with(&nb, Secret::Passphrase("another good passphrase"), "1234", FAST).is_err());
        });
    }

    #[test]
    fn regenerate_recovery_key_needs_the_passphrase() {
        with_home(|home| {
            let (nb, old) = new_encrypted(home, "Regen");
            assert!(matches!(regenerate_recovery_key(&nb, "not it at all"), Err(Error::WrongPassphrase)));
            let new = regenerate_recovery_key(&nb, PASS).unwrap();
            lock(&nb);
            assert!(unlock(&nb, Secret::Recovery(&old)).is_err());
            unlock(&nb, Secret::Recovery(&new)).unwrap();
        });
    }

    #[test]
    fn weak_passphrase_refused_at_creation() {
        with_home(|home| {
            let e = create_in_folder_with(&home.join("MiNotes/Weak"), "Weak", "password", FAST).err().unwrap();
            assert!(e.to_string().contains("too easy"), "{e}");
            assert!(!home.join("MiNotes/Weak").exists());
        });
    }

    #[test]
    fn copied_encrypted_folder_opens_with_the_same_passphrase() {
        with_home(|home| {
            let (nb, _rk) = new_encrypted(home, "Orig");
            nb.open_db().unwrap().create_page("Copied page", None, false, None, "user").unwrap();
            let src = nb.root().unwrap().to_path_buf();
            let copy = home.join("Elsewhere/Orig copy");
            std::fs::create_dir_all(&copy).unwrap();
            for f in ["notebook.minotes", "notebook.json"] {
                // checkpointed by the drop above (WAL mode truncates on close)
                std::fs::copy(src.join(f), copy.join(f)).unwrap();
            }
            let opened = notebook::open_folder(&copy).unwrap();
            assert_ne!(opened.key, nb.key, "a copy gets its own id");
            assert!(opened.is_encrypted());
            assert!(is_locked(&opened));
            unlock(&opened, Secret::Passphrase(PASS)).unwrap();
            assert_eq!(opened.open_db().unwrap().list_pages(Some(10)).unwrap()[0].title, "Copied page");
        });
    }

    #[test]
    fn database_without_its_notebook_json_is_not_a_new_notebook() {
        with_home(|home| {
            let (nb, _rk) = new_encrypted(home, "Lost");
            let root = nb.root().unwrap().to_path_buf();
            std::fs::remove_file(root.join("notebook.json")).unwrap();
            let e = notebook::open_folder(&root).err().unwrap();
            assert!(e.to_string().contains("encrypted"), "{e}");
            assert!(!root.join("notebook.json").exists());
        });
    }

    #[test]
    fn older_apps_see_a_newer_format() {
        with_home(|home| {
            let (nb, _rk) = new_encrypted(home, "Fmt");
            let v: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(nb.root().unwrap().join("notebook.json")).unwrap()).unwrap();
            assert!(v["format_version"].as_u64().unwrap() > notebook::FORMAT_VERSION as u64);
            assert!(v.get("name").is_none());
        });
    }

    #[test]
    fn cross_notebook_reads_follow_the_lock() {
        with_home(|home| {
            let (nb, _rk) = new_encrypted(home, "Cross");
            assert!(crate::cross_notebook::readable(&nb).is_ok(), "unlocked in this process");
            assert!(crate::cross_notebook::open_read_only(&nb, 500).is_ok());
            lock(&nb);
            assert_eq!(crate::cross_notebook::readable(&nb), Err(crate::cross_notebook::SkipReason::Locked));
        });
    }
}
