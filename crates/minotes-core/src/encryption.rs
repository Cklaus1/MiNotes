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

// ── Converting (PRD-encryption §4.6) ──
//
// Encrypt an existing notebook, remove encryption, or rotate the data key. All
// three write a complete new database next to the old one with
// `sqlcipher_export`, verify it (integrity check + row counts per table), and
// only then swap it in. A marker in `.minotes/` records the step, so a crash
// leaves either the old or the new notebook intact, never neither:
//
//   export  → the new file may be partial: roll back (delete it)
//   swap    → the new file is verified: roll forward (notebook.json, rename)
//   cleanup → the swap is done: finish deleting the old plaintext copies
//
// The new key slots are written into the marker *before* the swap, so an
// encrypted database can never be left without its slots. The caller must have
// closed every connection to the notebook first.

const MARKER_FILE: &str = "convert.json";
const TMP_DB: &str = "notebook.minotes.converting";

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConvertOp {
    Encrypt,
    Decrypt,
    Rotate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConvertStep {
    Export,
    Swap,
    Cleanup,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct Marker {
    op: ConvertOp,
    step: ConvertStep,
    /// The slots notebook.json gets at the swap (`None` = unencrypted).
    info: Option<EncryptionInfo>,
}

fn folder_root(nb: &Notebook) -> Result<&Path> {
    nb.root().ok_or_else(|| {
        Error::InvalidInput(
            "Only notebooks in a folder can be encrypted — use “Move notebook to a folder…” first".into(),
        )
    })
}

fn marker_path(root: &Path) -> std::path::PathBuf {
    root.join(notebook::PRIVATE_DIR).join(MARKER_FILE)
}

fn write_marker(root: &Path, m: &Marker) -> Result<()> {
    let p = marker_path(root);
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| Error::InvalidInput(format!("Cannot create {}: {e}", d.display())))?;
    }
    let json = serde_json::to_string_pretty(m)?;
    crate::repo::export::atomic_write(&p, json.as_bytes())
        .map_err(|e| Error::InvalidInput(format!("Cannot write {}: {e}", p.display())))
}

fn read_marker(root: &Path) -> Option<Marker> {
    serde_json::from_str(&std::fs::read_to_string(marker_path(root)).ok()?).ok()
}

/// What encrypting `nb` deletes once the encrypted copy is verified: the
/// plaintext database and its WAL/SHM (replaced), the markdown mirror with its
/// git history and `.minotes-trash/`, mirror state, sync config, and the
/// attachment files (moved into the database). Only paths that exist.
pub fn encrypt_deletes(nb: &Notebook) -> Vec<std::path::PathBuf> {
    if !nb.is_folder() {
        return Vec::new();
    }
    let db = nb.db_path();
    let mut out = vec![db.clone()];
    for suffix in ["-wal", "-shm"] {
        out.push(std::path::PathBuf::from(format!("{}{suffix}", db.display())));
    }
    out.push(nb.mirror_dir());
    out.push(nb.mirror_state_path());
    out.push(nb.sync_config_path());
    out.push(crate::repo::attachments::attachments_dir_for_db(&db));
    out.into_iter().filter(|p| p.exists()).collect()
}

fn remove_path(p: &Path) -> Result<()> {
    let r = match std::fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() => std::fs::remove_dir_all(p),
        Ok(_) => std::fs::remove_file(p),
        Err(_) => return Ok(()),
    };
    r.map_err(|e| Error::InvalidInput(format!("Cannot delete {}: {e}", p.display())))
}

fn wal_files(db: &Path) -> [std::path::PathBuf; 2] {
    [
        std::path::PathBuf::from(format!("{}-wal", db.display())),
        std::path::PathBuf::from(format!("{}-shm", db.display())),
    ]
}

/// Open the current database for exporting, keyed if it is encrypted, with its
/// WAL folded in.
fn open_source(db_path: &Path, key: Option<&DataKey>) -> Result<rusqlite::Connection> {
    if !db_path.is_file() {
        return Err(Error::NotFound(format!("{} not found", db_path.display())));
    }
    // CREATE is for the ATTACHed new file (the main one exists).
    let conn = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
            | rusqlite::OpenFlags::SQLITE_OPEN_CREATE
            | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    if let Some(k) = key {
        crate::db::apply_key(&conn, k)?;
    }
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
    Ok(conn)
}

/// `sqlcipher_export` the open source into `tmp` (keyed with `to`, or plain),
/// carrying the schema version over (`sqlcipher_export` does not).
fn export_to(src: &rusqlite::Connection, tmp: &Path, to: Option<&DataKey>) -> Result<()> {
    let lit = to.map(|k| k.sqlcipher_literal());
    let key_param: &str = lit.as_ref().map(|s| s.as_str()).unwrap_or("");
    src.execute(
        "ATTACH DATABASE ?1 AS minotes_new KEY ?2",
        rusqlite::params![tmp.to_string_lossy(), key_param],
    )?;
    let res = (|| -> Result<()> {
        src.query_row("SELECT sqlcipher_export('minotes_new')", [], |_| Ok(()))?;
        let v: i64 = src.query_row("PRAGMA main.user_version", [], |r| r.get(0))?;
        src.execute_batch(&format!("PRAGMA minotes_new.user_version = {v};"))?;
        Ok(())
    })();
    src.execute_batch("DETACH DATABASE minotes_new;")?;
    res
}

/// Integrity check + per-table row counts of the converted copy.
fn verify_converted(tmp: &Path, key: Option<&DataKey>, expected: &std::collections::BTreeMap<String, i64>) -> Result<()> {
    let conn = rusqlite::Connection::open_with_flags(tmp, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    if let Some(k) = key {
        crate::db::apply_key(&conn, k)?;
    }
    let check: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if check != "ok" {
        return Err(Error::InvalidInput(format!("The converted copy failed its integrity check: {check}")));
    }
    let mut got = notebook::table_row_counts(&conn)?;
    let mut want = expected.clone();
    // Attachment bytes legitimately move in or out of the database.
    got.remove("attachment_blobs");
    want.remove("attachment_blobs");
    if got != want {
        let diff: Vec<String> = want
            .iter()
            .filter(|(k, v)| got.get(*k) != Some(*v))
            .map(|(k, v)| format!("{k}: {v} → {}", got.get(k).map(|g| g.to_string()).unwrap_or("missing".into())))
            .collect();
        return Err(Error::InvalidInput(format!("The converted copy differs: {}", diff.join(", "))));
    }
    Ok(())
}

/// Test hook: return an error right after `step` was reached (a simulated crash —
/// nothing is cleaned up, as if the process died there).
type Inject<'a> = &'a mut dyn FnMut(ConvertStep) -> Result<()>;

fn convert(nb: &Notebook, op: ConvertOp, from: Option<&DataKey>, to: Option<&DataKey>, info: Option<EncryptionInfo>, inject: Inject<'_>) -> Result<()> {
    let root = folder_root(nb)?.to_path_buf();
    if let Some(m) = read_marker(&root) {
        return Err(Error::InvalidInput(format!(
            "An interrupted {:?} of this notebook must finish first (reopen it)",
            m.op
        )));
    }
    let db_path = nb.db_path();
    let tmp = root.join(TMP_DB);
    let mut marker = Marker { op, step: ConvertStep::Export, info };
    write_marker(&root, &marker)?;
    inject(ConvertStep::Export)?;
    let _ = std::fs::remove_file(&tmp);
    let exported = (|| -> Result<()> {
        let src = open_source(&db_path, from)?;
        let expected = notebook::table_row_counts(&src)?;
        export_to(&src, &tmp, to)?;
        drop(src);
        // Attachment bytes follow the encryption state.
        {
            let store = crate::repo::attachments::attachments_dir_for_db(&db_path);
            let conv = match to {
                Some(k) => Database::open_encrypted(&tmp, k)?,
                None => Database::open(&tmp)?,
            };
            match op {
                ConvertOp::Encrypt => {
                    conv.import_attachment_files_into_db(&store)?;
                    // PRD-plugin-architecture §6.2: plugins (and CSS snippets) are
                    // off in an encrypted notebook until re-enabled knowingly.
                    conv.conn.execute_batch("UPDATE plugins SET enabled = 0; UPDATE css_snippets SET enabled = 0;")?;
                }
                ConvertOp::Decrypt => {
                    conv.export_attachment_blobs(&store)?;
                }
                ConvertOp::Rotate => {}
            }
            notebook::checkpoint(&conv)?;
        }
        verify_converted(&tmp, to, &expected)
    })();
    if let Err(e) = exported {
        // Not a crash: roll back now (the old notebook was never touched).
        let _ = std::fs::remove_file(&tmp);
        for w in wal_files(&tmp) {
            let _ = std::fs::remove_file(w);
        }
        let _ = std::fs::remove_file(marker_path(&root));
        return Err(e);
    }
    marker.step = ConvertStep::Swap;
    write_marker(&root, &marker)?;
    inject(ConvertStep::Swap)?;
    finish(nb, &root, marker, inject)
}

/// Roll forward from `Swap`/`Cleanup` (also used when resuming).
fn finish(nb: &Notebook, root: &Path, mut marker: Marker, inject: Inject<'_>) -> Result<()> {
    let db_path = nb.db_path();
    let tmp = root.join(TMP_DB);
    if marker.step == ConvertStep::Swap {
        let mut meta = notebook::read_meta(root)?;
        meta.encryption = marker.info.clone();
        if meta.encryption.is_none() {
            meta.format_version = notebook::FORMAT_VERSION;
        }
        notebook::write_meta(root, &meta)?;
        if tmp.exists() {
            // The old WAL/SHM belong to the old file (checkpointed and empty).
            for w in wal_files(&db_path) {
                let _ = std::fs::remove_file(w);
            }
            for w in wal_files(&tmp) {
                let _ = std::fs::remove_file(w);
            }
            std::fs::rename(&tmp, &db_path)
                .map_err(|e| Error::InvalidInput(format!("Cannot replace {}: {e}", db_path.display())))?;
        }
        marker.step = ConvertStep::Cleanup;
        write_marker(root, &marker)?;
        inject(ConvertStep::Cleanup)?;
    }
    match marker.op {
        ConvertOp::Encrypt => {
            for p in [
                nb.mirror_dir(),
                nb.mirror_state_path(),
                nb.sync_config_path(),
                crate::repo::attachments::attachments_dir_for_db(&db_path),
            ] {
                remove_path(&p)?;
            }
        }
        ConvertOp::Decrypt => {
            crate::keychain::forget(&nb.key);
            forget_unlocked(&nb.key);
            let _ = std::fs::create_dir_all(nb.mirror_dir());
        }
        ConvertOp::Rotate => {
            // Remembered devices hold the old key (PRD §4.3).
            crate::keychain::forget(&nb.key);
        }
    }
    let _ = std::fs::remove_file(marker_path(root));
    Ok(())
}

/// Finish or roll back a conversion a crash interrupted. Call before opening a
/// folder notebook. Returns the operation that was resumed, if any.
pub fn resume_conversion(nb: &Notebook) -> Result<Option<ConvertOp>> {
    let Some(root) = nb.root() else { return Ok(None) };
    let Some(marker) = read_marker(root) else { return Ok(None) };
    let op = marker.op;
    match marker.step {
        ConvertStep::Export => {
            let tmp = root.join(TMP_DB);
            let _ = std::fs::remove_file(&tmp);
            for w in wal_files(&tmp) {
                let _ = std::fs::remove_file(w);
            }
            let _ = std::fs::remove_file(marker_path(root));
        }
        _ => finish(nb, root, marker, &mut |_| Ok(()))?,
    }
    Ok(Some(op))
}

/// Encrypt an existing (folder) notebook. Returns the recovery key to show once.
/// The notebook ends up unlocked in this process.
pub fn encrypt_notebook(nb: &Notebook, passphrase: &str) -> Result<RecoveryKey> {
    encrypt_notebook_with(nb, passphrase, KdfParams::default(), &mut |_| Ok(()))
}

pub fn encrypt_notebook_with(nb: &Notebook, passphrase: &str, params: KdfParams, inject: Inject<'_>) -> Result<RecoveryKey> {
    folder_root(nb)?;
    if nb.is_encrypted() {
        return Err(Error::InvalidInput("This notebook is already encrypted".into()));
    }
    crypto::check_passphrase(passphrase)?;
    let dek = DataKey::generate();
    let (info, rk) = EncryptionInfo::new(&dek, passphrase, params)?;
    convert(nb, ConvertOp::Encrypt, None, Some(&dek), Some(info), inject)?;
    remember_unlocked(&nb.key, dek);
    Ok(rk)
}

/// Remove encryption (behind the passphrase).
pub fn decrypt_notebook(nb: &Notebook, passphrase: &str) -> Result<()> {
    decrypt_notebook_with(nb, passphrase, &mut |_| Ok(()))
}

pub fn decrypt_notebook_with(nb: &Notebook, passphrase: &str, inject: Inject<'_>) -> Result<()> {
    let dek = info_of(nb)?.unlock(Secret::Passphrase(passphrase))?;
    convert(nb, ConvertOp::Decrypt, Some(&dek), None, None, inject)
}

/// Rotate the data key (suspected compromise): re-encrypt the whole database
/// with a new key, new slots for the same passphrase and a new recovery key
/// (returned; the old one stops working), and forget remembered devices.
pub fn rotate_key(nb: &Notebook, passphrase: &str) -> Result<RecoveryKey> {
    rotate_key_with(nb, passphrase, KdfParams::default(), &mut |_| Ok(()))
}

pub fn rotate_key_with(nb: &Notebook, passphrase: &str, params: KdfParams, inject: Inject<'_>) -> Result<RecoveryKey> {
    let old = info_of(nb)?.unlock(Secret::Passphrase(passphrase))?;
    let new = DataKey::generate();
    let (info, rk) = EncryptionInfo::new(&new, passphrase, params)?;
    convert(nb, ConvertOp::Rotate, Some(&old), Some(&new), Some(info), inject)?;
    remember_unlocked(&nb.key, new);
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
    fn the_mirror_refuses_an_encrypted_database_whoever_asks() {
        with_home(|home| {
            let (nb, _rk) = new_encrypted(home, "NoMirror");
            let db = nb.open_db().unwrap();
            let p = db.create_page("Mirrored?", None, false, None, "user").unwrap();
            let a = db.store_attachment_bytes("x.txt", None, b"attached").unwrap().attachment;
            db.create_block(&p.id, &a.markdown(), None, None, "user").unwrap();
            // Even with an explicit target (the app's switch flush once did this).
            let target = crate::mirror::MirrorTarget::for_notebook(&nb);
            assert!(crate::mirror::run(&db, &target, true).is_err());
            assert!(crate::mirror::prepare(&db, &target, true).is_err());
            assert!(!nb.mirror_dir().exists(), "no notes/ written");
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

    // ── Converting ──

    const MARKERS: [&str; 6] =
        ["TitleWombat", "BlockWombat", "FolderWombat", "PropWombat", "BoardWombat", "AttachWombat"];

    /// A plaintext folder notebook with every kind of content, a mirror with a
    /// git dir and a trash, and an attachment file.
    fn rich_plain(home: &Path) -> Notebook {
        let nb = notebook::create_in_folder(&home.join("MiNotes/Plain"), "Plain").unwrap();
        let db = nb.open_db().unwrap();
        let f = db.create_folder("FolderWombat", None, None, None, "user").unwrap();
        let p = db.create_page("TitleWombat", None, false, None, "user").unwrap();
        db.move_page_to_folder(&p.id, Some(&f.id), "user").unwrap();
        let b = db.create_block(&p.id, "BlockWombat body", None, None, "user").unwrap();
        db.set_property(&b.id, "block", "status", "PropWombat", "text", "user").unwrap();
        db.save_whiteboard("wb1", r#"{"elements":[{"text":"BoardWombat"}]}"#).unwrap();
        let a = db.store_attachment_bytes("x.txt", None, b"AttachWombat bytes").unwrap().attachment;
        db.create_block(&p.id, &a.markdown(), None, None, "user").unwrap();
        db.conn
            .execute("INSERT INTO css_snippets (id, name, css, enabled, created_at) VALUES ('s1', 'snip', 'body{}', 1, 't')", [])
            .unwrap();
        drop(db);
        let notes = nb.mirror_dir();
        std::fs::create_dir_all(notes.join(".git")).unwrap();
        std::fs::write(notes.join(".git/objects-TitleWombat"), "x").unwrap();
        std::fs::create_dir_all(notes.join(".minotes-trash")).unwrap();
        std::fs::write(notes.join("TitleWombat.md"), "- BlockWombat body").unwrap();
        std::fs::write(nb.mirror_state_path(), r#"{"pages":{"TitleWombat.md":"h"}}"#).unwrap();
        nb
    }

    fn counts(nb: &Notebook) -> std::collections::BTreeMap<String, i64> {
        let db = nb.open_db().unwrap();
        let mut c = notebook::table_row_counts(&db.conn).unwrap();
        c.remove("attachment_blobs");
        c
    }

    fn files_under(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                files_under(&p, out);
            } else {
                out.push(p);
            }
        }
    }

    /// No marker string in any file of the notebook folder (or the registry).
    fn assert_no_plaintext(home: &Path) {
        let mut files = Vec::new();
        files_under(home, &mut files);
        for f in files {
            let bytes = std::fs::read(&f).unwrap();
            for m in MARKERS {
                assert!(!bytes.windows(m.len()).any(|w| w == m.as_bytes()), "{} contains {m}", f.display());
            }
        }
    }

    fn assert_content(nb: &Notebook) {
        let db = nb.open_db().unwrap();
        let p = db.get_page_by_title("TitleWombat").unwrap().unwrap();
        let blocks = db.get_page_blocks(&p.id).unwrap();
        assert!(blocks.iter().any(|b| b.content.contains("BlockWombat")));
        let hash = db.list_attachments().unwrap()[0].hash.clone();
        assert_eq!(db.attachment_bytes(&hash).unwrap().unwrap(), b"AttachWombat bytes");
        assert!(db.get_whiteboard("wb1").unwrap().unwrap().data.contains("BoardWombat"));
    }

    #[test]
    fn encrypt_existing_notebook_preserves_everything_and_leaves_no_plaintext() {
        with_home(|home| {
            let nb = rich_plain(home);
            let before = counts(&nb);
            let deletes = encrypt_deletes(&nb);
            assert!(deletes.contains(&nb.db_path()));
            assert!(deletes.contains(&nb.mirror_dir()));
            assert!(deletes.iter().any(|p| p.ends_with("attachments")));
            let rk = encrypt_notebook_with(&nb, PASS, FAST, &mut |_| Ok(())).unwrap();
            assert!(nb.is_encrypted());
            assert_eq!(counts(&nb), before, "every table keeps its rows");
            assert_content(&nb);
            assert!(!nb.mirror_dir().exists() && !nb.mirror_state_path().exists());
            assert!(!nb.root().unwrap().join("attachments").exists());
            assert!(!marker_path(nb.root().unwrap()).exists());
            assert_no_plaintext(home);
            let enabled: i64 = nb.open_db().unwrap().conn.query_row("SELECT enabled FROM css_snippets", [], |r| r.get(0)).unwrap();
            assert_eq!(enabled, 0, "CSS snippets are turned off when a notebook is encrypted");
            // The recovery key and the passphrase both open it.
            lock(&nb);
            unlock(&nb, Secret::Recovery(&rk)).unwrap();
            lock(&nb);
            unlock(&nb, Secret::Passphrase(PASS)).unwrap();
            assert_content(&nb);
            // Encrypting twice is refused; legacy notebooks are refused.
            assert!(encrypt_notebook_with(&nb, PASS, FAST, &mut |_| Ok(())).is_err());
            let legacy = Notebook::legacy("default");
            drop(legacy.open_db().unwrap());
            let e = encrypt_notebook_with(&legacy, PASS, FAST, &mut |_| Ok(())).err().unwrap();
            assert!(e.to_string().contains("Move notebook to a folder"), "{e}");
        });
    }

    #[test]
    fn interrupted_encryption_leaves_old_or_new_intact_at_every_step() {
        for crash_at in [ConvertStep::Export, ConvertStep::Swap, ConvertStep::Cleanup] {
            with_home(|home| {
                let nb = rich_plain(home);
                let before = counts(&nb);
                let r = encrypt_notebook_with(&nb, PASS, FAST, &mut |s| {
                    if s == crash_at { Err(Error::InvalidInput("simulated crash".into())) } else { Ok(()) }
                });
                assert!(r.is_err());
                // Next open: resume.
                let resumed = resume_conversion(&nb).unwrap();
                assert_eq!(resumed, Some(ConvertOp::Encrypt), "{crash_at:?}");
                assert!(!marker_path(nb.root().unwrap()).exists());
                assert!(!nb.root().unwrap().join(TMP_DB).exists());
                match crash_at {
                    ConvertStep::Export => {
                        assert!(!nb.is_encrypted(), "rolled back");
                        assert!(crate::db::is_plaintext_sqlite(&nb.db_path()));
                        assert_eq!(counts(&nb), before);
                        assert_content(&nb);
                    }
                    _ => {
                        assert!(nb.is_encrypted(), "rolled forward at {crash_at:?}");
                        lock(&nb);
                        unlock(&nb, Secret::Passphrase(PASS)).unwrap();
                        assert_eq!(counts(&nb), before);
                        assert_content(&nb);
                        assert_no_plaintext(home);
                    }
                }
                lock(&nb);
            });
        }
    }

    #[test]
    fn decrypt_round_trip_and_interruptions() {
        for crash_at in [None, Some(ConvertStep::Export), Some(ConvertStep::Swap), Some(ConvertStep::Cleanup)] {
            with_home(|home| {
                let nb = rich_plain(home);
                let before = counts(&nb);
                encrypt_notebook_with(&nb, PASS, FAST, &mut |_| Ok(())).unwrap();
                assert!(matches!(decrypt_notebook_with(&nb, "wrong passphrase!!", &mut |_| Ok(())), Err(Error::WrongPassphrase)));
                let r = decrypt_notebook_with(&nb, PASS, &mut |s| {
                    if Some(s) == crash_at { Err(Error::InvalidInput("simulated crash".into())) } else { Ok(()) }
                });
                if crash_at.is_some() {
                    assert!(r.is_err());
                    resume_conversion(&nb).unwrap();
                } else {
                    r.unwrap();
                }
                let decrypted = crash_at != Some(ConvertStep::Export);
                assert_eq!(!nb.is_encrypted(), decrypted, "{crash_at:?}");
                if decrypted {
                    assert!(crate::db::is_plaintext_sqlite(&nb.db_path()));
                    let meta = notebook::read_meta(nb.root().unwrap()).unwrap();
                    assert_eq!(meta.format_version, notebook::FORMAT_VERSION);
                    let text = std::fs::read_to_string(nb.root().unwrap().join("notebook.json")).unwrap();
                    assert!(text.contains("\"name\": \"Plain\""), "the name is back: {text}");
                    // Attachments are files again.
                    let db = nb.open_db().unwrap();
                    let h = db.list_attachments().unwrap()[0].hash.clone();
                    assert!(db.attachment_file(&h).is_some());
                    let n: i64 = db.conn.query_row("SELECT count(*) FROM attachment_blobs", [], |r| r.get(0)).unwrap();
                    assert_eq!(n, 0);
                } else {
                    lock(&nb);
                    unlock(&nb, Secret::Passphrase(PASS)).unwrap();
                }
                assert_eq!(counts(&nb), before);
                assert_content(&nb);
            });
        }
    }

    #[test]
    fn rotate_key_reencrypts_and_retires_the_old_key_and_recovery_key() {
        with_home(|home| {
            let (nb, old_rk) = new_encrypted(home, "Rot");
            nb.open_db().unwrap().create_page("Rotated page", None, false, None, "user").unwrap();
            let old_key = unlocked_key(&nb.key).unwrap();
            let new_rk = rotate_key_with(&nb, PASS, FAST, &mut |_| Ok(())).unwrap();
            let new_key = unlocked_key(&nb.key).unwrap();
            assert_ne!(old_key.bytes(), new_key.bytes());
            assert!(matches!(Database::open_encrypted(&nb.db_path(), &old_key), Err(Error::KeyMismatch)));
            lock(&nb);
            assert!(matches!(unlock(&nb, Secret::Recovery(&old_rk)), Err(Error::WrongPassphrase)));
            unlock(&nb, Secret::Recovery(&new_rk)).unwrap();
            lock(&nb);
            unlock(&nb, Secret::Passphrase(PASS)).unwrap();
            assert_eq!(nb.open_db().unwrap().list_pages(Some(10)).unwrap()[0].title, "Rotated page");
        });
    }
}
