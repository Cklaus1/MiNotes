//! Git sync for encrypted notebooks (PRD-encryption §4.5, step 5).
//!
//! An encrypted notebook has no plaintext markdown copy, so git moves an
//! **encrypted mirror** instead. Its sync folder holds only:
//!
//! ```text
//! .minotes-encryption.json   key slots (as in notebook.json) + a key check
//! p/<name>.mne               one file per page       (name = keyed hash of the id)
//! f/<name>.mne               one file per folder
//! w/<name>.mne               one file per whiteboard
//! a/<name>.mne               one file per attachment (content-addressed)
//! ```
//!
//! Every `.mne` file is `MNE1:` + base64(nonce ‖ AES-256-GCM ciphertext), keyed
//! by HKDF(data key, "minotes sync file v1"), with the file's path as associated
//! data (a file can't be moved to another name and still open). Names are
//! HKDF(data key, "minotes sync names v1")-keyed hashes of the id, so the remote
//! learns file count, sizes and timing — nothing else. A page file decrypts to
//! the same markdown the plain mirror writes (frontmatter, block markers, block
//! properties as `key:: value` lines), so the import, the F-2 three-way merge and
//! the F-7 property sync are the plain sync's own code, run on decrypted text.
//!
//! Merging: git can't merge ciphertext, so a page edited on both sides is a git
//! conflict on its file. The conflict keeps the local file and records the
//! other side's blob ids; once the database is open the other version is merged
//! **per block** against the common ancestor (`merge_into_protected_page`) —
//! changes to different blocks both survive, and only a block changed on both
//! sides keeps the other version as a separate "(conflict from …)" page, the
//! plain sync's keep-both rule.
//!
//! Fail closed: before anything is pulled or pushed, the remote's key check must
//! match this notebook's key. A remote holding a different notebook (or a plain
//! one) is refused — nothing is rebased, imported or pushed.

use std::collections::{HashMap, HashSet};
use std::ops::Deref;
use std::path::{Path, PathBuf};

use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, KeyInit, OsRng, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::crypto::{DataKey, EncryptionInfo, RecoveryKey, Secret};
use crate::db::Database;
use crate::error::{Error, Result};
use crate::git_cmd;
use crate::repo::sync::{ImportFile, SyncResult};
use crate::sync_manager::{self, ExportPhase, GitPhase, IMPORT_ACTOR};

/// Key slots + key check, committed so another device can join with the passphrase.
pub const KEY_FILE: &str = ".minotes-encryption.json";
const MAGIC: &str = "MNE1:";
const EXT: &str = "mne";
const PAGES: &str = "p";
const FOLDERS: &str = "f";
const WHITEBOARDS: &str = "w";
const ATTACHMENTS: &str = "a";
const NONCE_LEN: usize = 12;

// ── Keys ──

/// Keys derived from the notebook's data key for the sync format.
pub(crate) struct SyncKeys {
    file: Zeroizing<[u8; 32]>,
    name: Zeroizing<[u8; 32]>,
}

impl SyncKeys {
    pub(crate) fn new(dek: &DataKey) -> SyncKeys {
        let hk = hkdf::Hkdf::<Sha256>::new(None, dek.bytes());
        let mut file = Zeroizing::new([0u8; 32]);
        let mut name = Zeroizing::new([0u8; 32]);
        hk.expand(b"minotes sync file v1", &mut file[..]).expect("valid HKDF length");
        hk.expand(b"minotes sync names v1", &mut name[..]).expect("valid HKDF length");
        SyncKeys { file, name }
    }

    fn prf(&self, info: &[u8], len: usize) -> Vec<u8> {
        let hk = hkdf::Hkdf::<Sha256>::from_prk(&self.name[..]).expect("32-byte PRK");
        let mut out = vec![0u8; len];
        hk.expand(info, &mut out).expect("valid HKDF length");
        out
    }

    /// The opaque file name of entity `id` of `kind`.
    fn name(&self, kind: &str, id: &str) -> String {
        hex(&self.prf(format!("{kind}:{id}").as_bytes(), 16))
    }

    /// Identifies the data key without revealing it (same key ⇔ same check).
    pub(crate) fn key_check(&self) -> String {
        hex(&self.prf(b"minotes key check v1", 16))
    }

    fn aad(rel: &str) -> Vec<u8> {
        format!("minotes-sync-v1:{rel}").into_bytes()
    }

    fn seal(&self, rel: &str, plain: &[u8]) -> String {
        let cipher = Aes256Gcm::new_from_slice(&self.file[..]).expect("32-byte key");
        let mut nonce = [0u8; NONCE_LEN];
        OsRng.fill_bytes(&mut nonce);
        let ct = cipher
            .encrypt(Nonce::from_slice(&nonce), Payload { msg: plain, aad: &Self::aad(rel) })
            .expect("AES-GCM encryption cannot fail");
        let mut raw = nonce.to_vec();
        raw.extend_from_slice(&ct);
        format!("{MAGIC}{}\n", B64.encode(raw))
    }

    fn open(&self, rel: &str, text: &str) -> Result<Zeroizing<Vec<u8>>> {
        let bad = || Error::InvalidInput(format!("{rel}: not a file this notebook can decrypt"));
        let body = text.trim().strip_prefix(MAGIC).ok_or_else(bad)?;
        let raw = B64.decode(body).map_err(|_| bad())?;
        if raw.len() < NONCE_LEN + 16 {
            return Err(bad());
        }
        let (nonce, ct) = raw.split_at(NONCE_LEN);
        let cipher = Aes256Gcm::new_from_slice(&self.file[..]).expect("32-byte key");
        cipher
            .decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad: &Self::aad(rel) })
            .map(Zeroizing::new)
            .map_err(|_| bad())
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The committed key file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct KeyFile {
    pub(crate) version: u32,
    pub(crate) key_check: String,
    /// Bumped by every key rotation (1 = the notebook's first data key).
    #[serde(default = "first_generation")]
    pub(crate) generation: u32,
    /// Key checks of the data keys this notebook had before (rotations), so a
    /// device still on an old key is told the key changed — not "another notebook".
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) previous_key_checks: Vec<String>,
    pub(crate) encryption: EncryptionInfo,
}

fn first_generation() -> u32 {
    1
}

/// A key rotation this device made that the sync repo doesn't have yet: the
/// files are still encrypted with the old data key, which is kept here (sealed
/// with the new key, inside `.git`, never committed) until everything is
/// re-encrypted and pushed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PendingRekey {
    /// Key check of the old data key (the repo's) and of the new one (this notebook's).
    pub from: String,
    pub to: String,
    pub old_key: String,
}

const REKEY_AAD: &str = ".git/minotes-rekey";

// ── Entries ──

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Entry {
    Page {
        id: Uuid,
        folder_id: Option<Uuid>,
        markdown: String,
    },
    Folder {
        id: Uuid,
        name: String,
        parent_id: Option<Uuid>,
        icon: Option<String>,
        color: Option<String>,
    },
    Whiteboard {
        id: String,
        updated_at: String,
        data: String,
    },
    Attachment {
        hash: String,
        name: String,
        mime: String,
        data: String,
    },
}

fn rel_of(kind: &str, name: &str) -> String {
    format!("{kind}/{name}.{EXT}")
}

fn read_entry(dir: &Path, keys: &SyncKeys, rel: &str) -> Result<Option<Entry>> {
    let text = match crate::repo::export::read_text_below(dir, Path::new(rel)) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(Error::InvalidInput(format!("{rel}: {e}"))),
    };
    decode_entry(keys, rel, &text).map(Some)
}

fn decode_entry(keys: &SyncKeys, rel: &str, text: &str) -> Result<Entry> {
    let plain = keys.open(rel, text)?;
    serde_json::from_slice(&plain).map_err(|e| Error::InvalidInput(format!("{rel}: {e}")))
}

/// Write `entry` at `rel` unless the file already holds exactly it (no
/// re-encryption churn: every write gets a fresh nonce).
fn write_entry(dir: &Path, keys: &SyncKeys, rel: &str, entry: &Entry) -> Result<bool> {
    if let Ok(Some(existing)) = read_entry(dir, keys, rel) {
        if existing == *entry {
            return Ok(false);
        }
    }
    let path = crate::repo::export::safe_join(dir, Path::new(rel))?;
    if let Some(link) = crate::repo::export::symlink_below(dir, Path::new(rel)) {
        return Err(Error::InvalidInput(format!("Not writing {rel}: symbolic link at {}", link.display())));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| Error::InvalidInput(format!("Cannot create {}: {e}", parent.display())))?;
    }
    let plain = Zeroizing::new(serde_json::to_vec(entry)?);
    crate::repo::export::atomic_write(&path, keys.seal(rel, &plain).as_bytes())
        .map_err(|e| Error::InvalidInput(format!("Cannot write {rel}: {e}")))?;
    Ok(true)
}

/// `.mne` files of one kind directory (never through a symbolic link).
fn list_kind(dir: &Path, kind: &str) -> Vec<(String, String)> {
    let base = dir.join(kind);
    if crate::repo::export::is_symlink(&base) {
        return Vec::new();
    }
    let mut out = Vec::new();
    for e in std::fs::read_dir(&base).into_iter().flatten().flatten() {
        let Ok(ft) = e.file_type() else { continue };
        if !ft.is_file() {
            continue;
        }
        let file = e.file_name().to_string_lossy().to_string();
        if let Some(name) = file.strip_suffix(&format!(".{EXT}")) {
            out.push((name.to_string(), rel_of(kind, name)));
        }
    }
    out.sort();
    out
}

// ── Key file / remote check ──

fn read_key_file_text(text: &str) -> Result<KeyFile> {
    serde_json::from_str(text).map_err(|e| Error::InvalidInput(format!("{KEY_FILE} is malformed: {e}")))
}

fn write_key_file(dir: &Path, kf: &KeyFile) -> Result<()> {
    if let Some(link) = crate::repo::export::symlink_below(dir, Path::new(KEY_FILE)) {
        return Err(Error::InvalidInput(format!("Not writing {KEY_FILE}: symbolic link at {}", link.display())));
    }
    let json = serde_json::to_string_pretty(kf)? + "\n";
    crate::repo::export::atomic_write(&dir.join(KEY_FILE), json.as_bytes())
        .map_err(|e| Error::InvalidInput(format!("Cannot write {KEY_FILE}: {e}")))
}

/// Did the repo ever hold these key slots? Every slot carries a fresh random
/// nonce (and the passphrase slot a fresh salt), so slots made by a passphrase
/// change here never equal an earlier version of the key file.
fn slots_in_history(dir: &Path, info: &EncryptionInfo) -> Result<bool> {
    let (out, _, ok) = git_cmd::run_git(dir, &["log", "--format=%H", "--", KEY_FILE])?;
    if !ok {
        return Ok(false);
    }
    for rev in out.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if let Some(text) = git_cmd::show_file_at(dir, rev, KEY_FILE)? {
            if read_key_file_text(&text).map(|kf| kf.encryption == *info).unwrap_or(false) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Write the key file when the repo has none; refuse a repo made with another
/// key; publish this notebook's key slots when they changed **here** (a new
/// passphrase or recovery key — the data key, and so the key check, is the
/// same), so a device joining later uses the current passphrase.
///
/// Which side is newer: slots this device has that the repo never held were
/// made here and are published; slots the repo held before are an older version
/// (another device changed the passphrase since) and never overwrite the repo's.
/// Other devices keep their own local slots (a remote can't hand a device key
/// slots it can't check), and keep syncing: the data key didn't change.
/// `info: None` (re-encrypting after a rotation) leaves the slots alone.
fn ensure_key_file(dir: &Path, keys: &SyncKeys, info: Option<&EncryptionInfo>) -> Result<()> {
    match crate::repo::export::read_text_below(dir, Path::new(KEY_FILE)) {
        Ok(text) => {
            let mut kf = read_key_file_text(&text)?;
            if kf.key_check != keys.key_check() {
                return Err(mismatch(&kf, keys));
            }
            if let Some(info) = info {
                if kf.encryption != *info && !slots_in_history(dir, info)? {
                    kf.encryption = info.clone();
                    write_key_file(dir, &kf)?;
                }
            }
            Ok(())
        }
        Err(_) => {
            let Some(info) = info else {
                return Err(Error::InvalidInput("The notebook's key slots are not available".into()));
            };
            let kf = KeyFile {
                version: 1,
                key_check: keys.key_check(),
                generation: first_generation(),
                previous_key_checks: Vec::new(),
                encryption: info.clone(),
            };
            write_key_file(dir, &kf)
        }
    }
}

/// The remote (or the repo) holds a key file whose key isn't this notebook's.
fn mismatch(kf: &KeyFile, keys: &SyncKeys) -> Error {
    if kf.previous_key_checks.contains(&keys.key_check()) {
        return Error::Git(format!(
            "{KEY_CHANGED}: this notebook\u{2019}s key was changed (rotated) on another device, so this device can no longer \
             read or write its sync files. Nothing was pulled or pushed, and your notes here are unchanged. To keep syncing, \
             open the notebook on this device again with \u{201c}Join an encrypted notebook\u{201d} and the passphrase."
        ));
    }
    Error::Git(
        "This sync remote belongs to a different encrypted notebook (another key): nothing was pulled or pushed. \
         Use \u{201c}Join an encrypted notebook\u{201d} to open it, or sync this notebook to an empty remote."
            .into(),
    )
}

/// Prefix of the error a device on a rotated-away key gets (fail closed).
pub const KEY_CHANGED: &str = "KEY_CHANGED";

/// What the remote branch holds, fetched.
enum Remote {
    /// No remote configured, or an empty one (our first push creates it).
    Empty,
    Keyed(KeyFile),
    /// Commits, but no key file: plain notes, or something else.
    Unkeyed,
}

fn fetch_remote(dir: &Path) -> Result<Remote> {
    if !git_cmd::has_remote(dir) {
        return Ok(Remote::Empty);
    }
    let branch = git_cmd::require_branch(dir)?;
    let (_, stderr, ok) = git_cmd::run_git(dir, &["fetch", "--no-tags", "origin", &branch])?;
    if !ok {
        if stderr.contains("couldn't find remote ref") {
            return Ok(Remote::Empty);
        }
        return Err(Error::Git(git_cmd::classify_git_error(&stderr)));
    }
    match git_cmd::show_file_at(dir, "FETCH_HEAD", KEY_FILE)? {
        Some(text) => Ok(Remote::Keyed(read_key_file_text(&text)?)),
        None => Ok(Remote::Unkeyed),
    }
}

fn unkeyed() -> Error {
    Error::Git(
        "This sync remote holds notes that are not this encrypted notebook's (no key file): nothing was pulled or pushed. \
         Sync an encrypted notebook to an empty remote of its own."
            .into(),
    )
}

/// Fetch the remote branch and check its key file before anything else touches
/// the repo. Ok(()) also for an empty remote (nothing to check yet).
pub(crate) fn check_remote(dir: &Path, keys: &SyncKeys) -> Result<()> {
    match fetch_remote(dir)? {
        Remote::Empty => Ok(()),
        Remote::Keyed(kf) if kf.key_check == keys.key_check() => Ok(()),
        Remote::Keyed(kf) => Err(mismatch(&kf, keys)),
        Remote::Unkeyed => Err(unkeyed()),
    }
}

// ── Export ──

/// Write the database out as encrypted files (only what changed) and remove the
/// files of pages/folders that went to the Trash here. Returns (files written,
/// large attachments left out).
fn export(db: &Database, dir: &Path, keys: &SyncKeys) -> Result<(u32, Vec<String>)> {
    let skip = sync_manager::held_export_options(dir);
    let plan = db.plan_export_paths()?;
    let mut written = 0u32;
    let mut keep: HashMap<&'static str, HashSet<String>> = HashMap::new();

    for (folder, _) in &plan.folders {
        if skip.skip_folders.contains(&folder.id) {
            continue;
        }
        let name = keys.name(FOLDERS, &folder.id.to_string());
        let entry = Entry::Folder {
            id: folder.id,
            name: folder.name.clone(),
            parent_id: folder.parent_id,
            icon: folder.icon.clone(),
            color: folder.color.clone(),
        };
        written += write_entry(dir, keys, &rel_of(FOLDERS, &name), &entry)? as u32;
        keep.entry(FOLDERS).or_default().insert(name);
    }
    let mut page_ids: Vec<Uuid> = Vec::new();
    for (page, _) in &plan.pages {
        page_ids.push(page.id);
        if skip.skip_pages.contains(&page.id) {
            continue;
        }
        let name = keys.name(PAGES, &page.id.to_string());
        let entry = Entry::Page { id: page.id, folder_id: page.folder_id, markdown: db.render_page_markdown(page)? };
        written += write_entry(dir, keys, &rel_of(PAGES, &name), &entry)? as u32;
        keep.entry(PAGES).or_default().insert(name);
    }
    page_ids.extend(plan.archived_ids.iter().copied());

    // Whiteboards on live and archived pages; a newer version on disk (pulled,
    // not imported yet) is never overwritten by an older one.
    let mut boards: Vec<String> = db.whiteboards_on_pages(&page_ids)?.into_iter().collect();
    boards.sort();
    for id in boards {
        let Some(wb) = db.get_whiteboard(&id)? else { continue };
        let rel = rel_of(WHITEBOARDS, &keys.name(WHITEBOARDS, &id));
        if let Ok(Some(Entry::Whiteboard { updated_at, .. })) = read_entry(dir, keys, &rel) {
            if crate::repo::export::ts_newer(&updated_at, &wb.updated_at) {
                continue;
            }
        }
        let entry = Entry::Whiteboard { id: wb.id, updated_at: wb.updated_at, data: wb.data };
        written += write_entry(dir, keys, &rel, &entry)? as u32;
    }

    // Attachments referenced by blocks (content-addressed: written once).
    let mut large = Vec::new();
    let mut hashes: HashSet<String> = HashSet::new();
    {
        let mut stmt = db.conn.prepare("SELECT content FROM blocks WHERE content LIKE '%attachment:%'")?;
        for text in stmt.query_map([], |r| r.get::<_, String>(0))? {
            hashes.extend(crate::repo::attachments::attachment_hashes(&text?));
        }
    }
    let mut hashes: Vec<String> = hashes.into_iter().collect();
    hashes.sort();
    for hash in hashes {
        let rel = rel_of(ATTACHMENTS, &keys.name(ATTACHMENTS, &hash));
        if dir.join(&rel).is_file() {
            continue;
        }
        let (Some(a), Some(bytes)) = (db.get_attachment(&hash)?, db.attachment_bytes(&hash)?) else { continue };
        if bytes.len() as u64 > crate::repo::attachments::GIT_SYNC_MAX_BYTES {
            large.push(a.name.clone());
            continue;
        }
        let entry = Entry::Attachment { hash: a.hash, name: a.name, mime: a.mime, data: B64.encode(&bytes) };
        written += write_entry(dir, keys, &rel, &entry)? as u32;
    }

    // Prune: files of pages / folders that are in the Trash here (their removal is
    // how the deletion reaches the other devices). Unknown files are kept.
    let inputs = db.prune_inputs(&plan)?;
    let trashed_pages: HashMap<String, Uuid> =
        inputs.trashed.iter().map(|id| (keys.name(PAGES, &id.to_string()), *id)).collect();
    let trashed_folders: HashMap<String, Uuid> =
        inputs.trashed_folders.iter().map(|id| (keys.name(FOLDERS, &id.to_string()), *id)).collect();
    for (kind, trashed) in [(PAGES, &trashed_pages), (FOLDERS, &trashed_folders)] {
        let kept = keep.get(kind);
        for (name, rel) in list_kind(dir, kind) {
            if kept.map(|k| k.contains(&name)).unwrap_or(false) {
                continue;
            }
            if trashed.contains_key(&name) {
                let path = crate::repo::export::safe_join(dir, Path::new(&rel))?;
                std::fs::remove_file(&path).map_err(|e| Error::InvalidInput(format!("Cannot remove {rel}: {e}")))?;
                written += 1;
            }
        }
    }
    Ok((written, large))
}

/// Phase 1 for an encrypted notebook: key file, encrypted files, commit.
fn export_and_commit(db: &Database, dir: &Path, keys: &SyncKeys, info: Option<&EncryptionInfo>) -> Result<ExportPhase> {
    git_cmd::abort_stale_rebase(dir)?;
    sync_manager::ensure_gitignore(dir);
    ensure_key_file(dir, keys, info)?;
    let export_time = Utc::now();
    let (written, large) = export(db, dir, keys)?;
    let before = git_cmd::rev_parse_head(dir)?;
    let committed = git_cmd::commit_all(dir, &sync_manager::commit_message())?;
    if committed {
        let mut st = sync_manager::read_state(dir);
        if st.imported_head.is_some() && st.imported_head == before {
            st.imported_head = git_cmd::rev_parse_head(dir)?;
            sync_manager::write_state(dir, &st)?;
        }
    }
    Ok(ExportPhase { pages_exported: written, export_time, large_attachments: large })
}

// ── Phase 2: pull (conflicts recorded for a per-block merge) and push ──

/// The other device's version of a file a git conflict kept local.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PendingMerge {
    pub path: String,
    /// Blob ids: the common ancestor (none if both sides added the file) and the other side.
    pub base: Option<String>,
    pub theirs: String,
    /// This device deleted the file (the other side changed it).
    pub local_deleted: bool,
}

fn pull_with_resolve(dir: &Path) -> Result<u32> {
    match git_cmd::pull_rebase(dir) {
        Ok(_) => Ok(0),
        Err(e) if e.to_string().contains("merge_conflict") => {
            let mut merges: Vec<PendingMerge> = Vec::new();
            let resolved = git_cmd::resolve_rebase_conflicts(dir, &mut |file| {
                let mergeable = file.starts_with(&format!("{PAGES}/")) || file.starts_with(&format!("{WHITEBOARDS}/"));
                if mergeable {
                    let [base, theirs, local] = git_cmd::conflict_stages(dir, file)?;
                    if let Some(theirs) = theirs {
                        merges.push(PendingMerge { path: file.to_string(), base, theirs, local_deleted: local.is_none() });
                    }
                }
                // The local file stays (the key file, folders and attachments too:
                // folders are last-writer-local, attachments are content-addressed).
                git_cmd::keep_local_side(dir, file)
            });
            // Remember the other versions even if the rebase failed part-way.
            if !merges.is_empty() {
                let mut st = sync_manager::read_state(dir);
                st.merges.extend(merges);
                sync_manager::write_state(dir, &st)?;
            }
            Ok(resolved?.len() as u32)
        }
        Err(e) => Err(e),
    }
}

/// Phase 2 for an encrypted notebook: refuse a foreign remote, pull --rebase
/// (conflicts keep the local file, the other version is merged in phase 3) and push.
fn pull_push(dir: &Path, keys: &SyncKeys) -> Result<GitPhase> {
    let mut out = GitPhase::default();
    if !git_cmd::has_remote(dir) {
        return Ok(out);
    }
    git_cmd::abort_stale_rebase(dir)?;
    if let Err(e) = check_remote(dir, keys) {
        out.error = Some(e.to_string());
        return Ok(out);
    }
    match pull_with_resolve(dir) {
        Ok(n) => out.conflicts_resolved += n,
        Err(e) => {
            out.error = Some(e.to_string());
            return Ok(out);
        }
    }
    match git_cmd::push(dir) {
        Ok(_) => {}
        Err(e) if e.to_string().contains("push_rejected") => {
            if let Err(e2) = check_remote(dir, keys).and_then(|_| pull_with_resolve(dir)) {
                out.error = Some(e2.to_string());
                return Ok(out);
            }
            if let Err(e2) = git_cmd::push(dir) {
                out.error = Some(format!("Push failed after retry: {e2}"));
            }
        }
        Err(e) => out.error = Some(e.to_string()),
    }
    Ok(out)
}

// ── Phase 3: import ──

/// What a pull changed: files to import, files removed, and the commit to merge against.
struct Pending {
    head: String,
    base: Option<String>,
    /// None: no earlier import to compare with — import every file.
    changed: Option<Vec<String>>,
    deleted: Vec<String>,
}

fn pending_since(dir: &Path, old: Option<&str>) -> Result<Option<Pending>> {
    let Some(head) = git_cmd::rev_parse_head(dir)? else { return Ok(None) };
    if old == Some(head.as_str()) {
        return Ok(None);
    }
    match old.filter(|o| git_cmd::commit_exists(dir, o)) {
        Some(old) => Ok(Some(Pending {
            changed: Some(git_cmd::changed_files_between(dir, old, &head)?),
            deleted: git_cmd::deleted_files_between(dir, old, &head)?,
            base: Some(old.to_string()),
            head,
        })),
        None => Ok(Some(Pending { head, base: None, changed: None, deleted: Vec::new() })),
    }
}

fn is_entry_path(p: &str) -> bool {
    p.ends_with(&format!(".{EXT}")) && [PAGES, FOLDERS, WHITEBOARDS, ATTACHMENTS].iter().any(|k| p.starts_with(&format!("{k}/")))
}

/// Import what the pull brought (decrypted in memory), then merge the versions
/// recorded at git conflicts. Pages edited here after `protect_after` (or in
/// `protect`) are merged per block instead of overwritten.
fn import(
    db: &Database,
    dir: &Path,
    keys: &SyncKeys,
    pending: Option<&Pending>,
    protect_after: Option<DateTime<Utc>>,
) -> Result<SyncResult> {
    let mut r = SyncResult::default();
    let host = git_cmd::get_hostname();
    let mut entries: Vec<(String, Entry)> = Vec::new();
    if let Some(p) = pending {
        let paths: Vec<String> = match &p.changed {
            Some(c) => c.iter().filter(|x| is_entry_path(x)).cloned().collect(),
            None => [FOLDERS, PAGES, WHITEBOARDS, ATTACHMENTS].iter().flat_map(|k| list_kind(dir, k)).map(|(_, rel)| rel).collect(),
        };
        for rel in paths {
            match read_entry(dir, keys, &rel) {
                Ok(Some(e)) => entries.push((rel, e)),
                Ok(None) => {} // deleted: handled below
                Err(e) => r.errors.push(e.to_string()),
            }
        }
    }
    let protected: HashSet<Uuid> = match protect_after {
        Some(t) => db.pages_modified_since(t, IMPORT_ACTOR)?,
        None => HashSet::new(),
    };
    let protected_folders: HashSet<Uuid> = match protect_after {
        Some(t) => db.folders_modified_since(t, IMPORT_ACTOR)?,
        None => HashSet::new(),
    };

    // Folders first, parents before children.
    let mut folders: Vec<&Entry> = entries.iter().map(|(_, e)| e).filter(|e| matches!(e, Entry::Folder { .. })).collect();
    let mut seen_folders: HashSet<Uuid> = HashSet::new();
    let incoming: HashSet<Uuid> =
        folders.iter().filter_map(|e| if let Entry::Folder { id, .. } = e { Some(*id) } else { None }).collect();
    for round in 0..64 {
        if folders.is_empty() {
            break;
        }
        let mut rest = Vec::new();
        for e in folders {
            let Entry::Folder { id, name, parent_id, icon, color } = e else { continue };
            // A parent that arrives in this import goes first (the last round
            // takes whatever is left, e.g. a parent cycle, at the top level).
            let waits = parent_id.map(|p| incoming.contains(&p) && !seen_folders.contains(&p)).unwrap_or(false);
            if waits && round < 63 {
                rest.push(e);
                continue;
            }
            let parent = parent_id.filter(|p| db.get_folder(p).ok().flatten().is_some());
            let res = db.tx(|| {
                match db.get_folder(id)? {
                    Some(f) => {
                        if !protected_folders.contains(id) && !db.is_folder_trashed(id)? {
                            if f.name != *name {
                                db.rename_folder(id, name, IMPORT_ACTOR)?;
                                r.folders_renamed.push(format!("{} -> {name}", f.name));
                            }
                            if f.parent_id != parent {
                                db.move_folder(id, parent.as_ref(), IMPORT_ACTOR)?;
                            }
                            if f.icon != *icon || f.color != *color {
                                db.update_folder_appearance(id, icon.as_deref(), color.as_deref(), IMPORT_ACTOR)?;
                            }
                        }
                    }
                    None => {
                        db.create_folder_with_id(*id, name, parent.as_ref(), icon.as_deref(), color.as_deref(), IMPORT_ACTOR)?;
                        r.folders_created.push(name.clone());
                    }
                }
                Ok(())
            });
            match res {
                Ok(()) => {
                    seen_folders.insert(*id);
                }
                Err(e) => r.errors.push(format!("folder {name}: {e}")),
            }
        }
        if rest.is_empty() {
            break;
        }
        folders = rest;
    }

    // Pages — those this device knows first, so a rename frees its title before
    // a new page claims it (the plain import's order).
    let mut seen: HashSet<Uuid> = HashSet::new();
    let mut pages: Vec<(bool, &String, &Entry)> = Vec::new();
    for (rel, e) in &entries {
        if let Entry::Page { id, .. } = e {
            pages.push((db.get_page(id)?.is_none(), rel, e));
        }
    }
    pages.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(b.1)));
    for (_, rel, e) in pages {
        let Entry::Page { id, folder_id, markdown } = e else { continue };
        let file = ImportFile::from_text(&page_rel(rel), markdown);
        if file.fm.id != Some(*id) {
            r.errors.push(format!("{rel}: page file does not match its id"));
            continue;
        }
        let folder = folder_id.filter(|f| db.get_folder(f).ok().flatten().is_some());
        let snapshot = r.clone();
        let res = db.tx(|| db.sync_page(&file, folder, IMPORT_ACTOR, &mut r, &mut seen, &protected, None));
        if let Err(err) = res {
            r = snapshot;
            r.errors.push(format!("{rel}: {err}"));
        }
    }
    // Pages skipped because they were edited here meanwhile: merge per block.
    let skipped = std::mem::take(&mut r.skipped_pages);
    for (id, prel) in skipped {
        let rel = prel.to_string_lossy().trim_end_matches(".md").to_string() + "." + EXT;
        let theirs = entries.iter().find_map(|(x, e)| match e {
            Entry::Page { markdown, .. } if *x == rel => Some(markdown.clone()),
            _ => None,
        });
        let Some(theirs) = theirs else { continue };
        let base = match pending.and_then(|p| p.base.as_deref()) {
            Some(b) => match git_cmd::show_file_at(dir, b, &rel)? {
                Some(t) => match decode_entry(keys, &rel, &t) {
                    Ok(Entry::Page { markdown, .. }) => Some(markdown),
                    _ => None,
                },
                None => None,
            },
            None => None,
        };
        merge_page(db, &id, &rel, &theirs, base.as_deref(), &host, &mut r);
    }

    // Whiteboards: the newer version wins.
    for (_, e) in &entries {
        if let Entry::Whiteboard { id, updated_at, data } = e {
            import_whiteboard(db, id, updated_at, data, &mut r);
        }
    }
    // Attachments: content-addressed, checked against their hash.
    for (rel, e) in &entries {
        let Entry::Attachment { hash, name, mime, data } = e else { continue };
        if db.attachment_bytes(hash)?.is_some() {
            continue;
        }
        let bytes = match B64.decode(data) {
            Ok(b) => b,
            Err(_) => {
                r.errors.push(format!("{rel}: attachment data is malformed"));
                continue;
            }
        };
        if hex(&Sha256::digest(&bytes)) != *hash {
            r.errors.push(format!("{rel}: attachment does not match its hash"));
            continue;
        }
        if let Err(err) = db.store_attachment_bytes(name, Some(mime), &bytes) {
            r.errors.push(format!("{rel}: {err}"));
        }
    }

    // Removed upstream → Trash (guarded like the plain sync).
    if let Some(p) = pending {
        let mut page_ids = Vec::new();
        let mut folder_ids = Vec::new();
        if let Some(base) = &p.base {
            for rel in p.deleted.iter().filter(|x| is_entry_path(x)) {
                let Some(text) = git_cmd::show_file_at(dir, base, rel)? else { continue };
                match decode_entry(keys, rel, &text) {
                    Ok(Entry::Page { id, .. }) => page_ids.push(id),
                    Ok(Entry::Folder { id, .. }) => folder_ids.push(id),
                    Ok(_) => {}
                    Err(e) => r.errors.push(e.to_string()),
                }
            }
        }
        db.trash_removed_pages(&page_ids, &seen, &protected, false, &mut r)?;
        db.trash_removed_folders(&folder_ids, &seen_folders, &protected_folders, &protected, false, &mut r)?;
    }

    // Versions a git conflict kept aside: merge them now.
    let mut st = sync_manager::read_state(dir);
    let merges = std::mem::take(&mut st.merges);
    let mut left = Vec::new();
    for m in merges {
        if let Err(e) = apply_pending_merge(db, dir, keys, &m, &host, &mut r) {
            r.errors.push(format!("{}: could not merge the other device's changes: {e}", m.path));
            left.push(m);
        }
    }
    st.merges = left;
    sync_manager::write_state(dir, &st)?;
    Ok(r)
}

/// The rel path page imports report (and conflict copies are named from).
fn page_rel(rel: &str) -> PathBuf {
    PathBuf::from(rel.trim_end_matches(&format!(".{EXT}")).to_string() + ".md")
}

fn merge_page(db: &Database, id: &Uuid, rel: &str, theirs: &str, base: Option<&str>, host: &str, r: &mut SyncResult) {
    let mut sr = SyncResult::default();
    let res = db.tx(|| db.merge_into_protected_page(id, &page_rel(rel), theirs, base, IMPORT_ACTOR, host, &mut sr));
    match res {
        Ok(()) => {
            r.errors.extend(sr.errors);
            r.pages_merged.extend(sr.pages_merged);
            r.conflict_copies.extend(sr.conflict_copies);
            r.pages_created.extend(sr.pages_created);
        }
        Err(e) => r.errors.push(format!("{rel}: could not merge the other device's changes: {e}")),
    }
}

fn import_whiteboard(db: &Database, id: &str, updated_at: &str, data: &str, r: &mut SyncResult) {
    match db.get_whiteboard(id) {
        Ok(Some(w)) if !crate::repo::export::ts_newer(updated_at, &w.updated_at) => return,
        Ok(_) => {}
        Err(e) => {
            r.errors.push(format!("whiteboard {id}: {e}"));
            return;
        }
    }
    match db.put_whiteboard_raw(id, data, updated_at) {
        Ok(()) => r.whiteboards_imported.push(id.to_string()),
        Err(e) => r.errors.push(format!("whiteboard {id}: {e}")),
    }
}

fn apply_pending_merge(db: &Database, dir: &Path, keys: &SyncKeys, m: &PendingMerge, host: &str, r: &mut SyncResult) -> Result<()> {
    let blob = |sha: &str| -> Result<Entry> {
        let text = git_cmd::blob_text(dir, sha)?.ok_or_else(|| Error::Git(format!("missing blob {sha}")))?;
        decode_entry(keys, &m.path, &text)
    };
    let theirs = blob(&m.theirs)?;
    let base = match &m.base {
        Some(b) => Some(blob(b)?),
        None => None,
    };
    match theirs {
        Entry::Page { folder_id, markdown, .. } => {
            let base_md = match base {
                Some(Entry::Page { markdown, .. }) => Some(markdown),
                _ => None,
            };
            let folder = folder_id.filter(|f| db.get_folder(f).ok().flatten().is_some());
            let mut sr = SyncResult::default();
            db.merge_remote_version(&page_rel(&m.path), &markdown, base_md.as_deref(), folder, IMPORT_ACTOR, host, &mut sr)?;
            r.errors.extend(sr.errors);
            r.pages_merged.extend(sr.pages_merged);
            r.conflict_copies.extend(sr.conflict_copies);
            r.pages_created.extend(sr.pages_created);
            r.pages_updated.extend(sr.pages_updated);
        }
        Entry::Whiteboard { id, updated_at, data } => import_whiteboard(db, &id, &updated_at, &data, r),
        _ => {}
    }
    Ok(())
}

// ── Cycles ──

/// The encryption slots to publish in a new sync repo (this notebook's own:
/// the sync folder is `<notebook>/notes`).
fn info_for(dir: &Path) -> Option<EncryptionInfo> {
    dir.parent().and_then(|root| crate::notebook::read_meta(root).ok()).and_then(|m| m.encryption)
}

fn keys_of(db: &Database) -> Result<SyncKeys> {
    db.data_key()
        .map(SyncKeys::new)
        .ok_or_else(|| Error::InvalidInput("Not an encrypted notebook".into()))
}

/// One sync cycle of an encrypted notebook (see the module docs). `enabling`:
/// the first cycle after turning sync on — the import takes only what the pull
/// changed relative to the commit this device just made.
pub(crate) fn cycle<G, F>(dir: &Path, lock_db: &F, enabling: bool) -> Result<sync_manager::GitSyncResult>
where
    G: Deref<Target = Database>,
    F: Fn() -> Result<G>,
{
    if !git_cmd::is_git_repo(dir) {
        git_cmd::init_repo(dir)?;
    }
    git_cmd::harden_repo(dir)?;
    // Fail closed before this device writes or commits anything.
    let keys = {
        let db = lock_db()?;
        keys_of(&db)?
    };
    if let Some(old) = pending_rekey(dir, &keys)? {
        return rekey_cycle(dir, lock_db, enabling, &keys, &old);
    }
    if let Err(e) = check_remote(dir, &keys) {
        return refuse(e, enabling);
    }
    cycle_with(dir, lock_db, enabling, &keys, info_for(dir).as_ref())
}

fn refuse(e: Error, enabling: bool) -> Result<sync_manager::GitSyncResult> {
    if enabling {
        return Err(e);
    }
    let msg = e.to_string();
    Ok(sync_manager::GitSyncResult { offline: sync_manager::is_offline_error(&msg), ..sync_manager::GitSyncResult::refused(&msg) })
}

/// Export, pull/push and import with `keys` (the remote was checked).
/// `info`: the slots to publish (None: leave the key file's slots alone).
fn cycle_with<G, F>(
    dir: &Path,
    lock_db: &F,
    enabling: bool,
    keys: &SyncKeys,
    info: Option<&EncryptionInfo>,
) -> Result<sync_manager::GitSyncResult>
where
    G: Deref<Target = Database>,
    F: Fn() -> Result<G>,
{
    let (export, flushed_head) = {
        let db = lock_db()?;
        let exp = export_and_commit(&db, dir, keys, info)?;
        (exp, git_cmd::rev_parse_head(dir)?)
    };
    let git = pull_push(dir, keys)?;

    let base = if enabling { flushed_head.clone() } else { sync_manager::read_state(dir).imported_head };
    let pending = pending_since(dir, base.as_deref())?;
    let has_merges = !sync_manager::read_state(dir).merges.is_empty();
    let mut pages_imported = 0u32;
    let mut import_errors = Vec::new();
    let mut conflict_pages = Vec::new();
    if git.error.is_none() && (pending.is_some() || has_merges) {
        let db = lock_db()?;
        let r = import(&db, dir, keys, pending.as_ref(), Some(export.export_time))?;
        let mut st = sync_manager::read_state(dir);
        if !r.held_page_ids.is_empty() || !r.held_folder_ids.is_empty() {
            let mut h = st.held.take().unwrap_or_default();
            for id in &r.held_page_ids {
                if !h.page_ids.contains(id) {
                    h.page_ids.push(*id);
                }
            }
            for id in &r.held_folder_ids {
                if !h.folder_ids.contains(id) {
                    h.folder_ids.push(*id);
                }
            }
            h.held_at = Utc::now().to_rfc3339();
            st.held = Some(h);
        }
        if r.errors.is_empty() {
            if let Some(p) = &pending {
                st.imported_head = Some(p.head.clone());
            }
        }
        sync_manager::write_state(dir, &st)?;
        pages_imported = (r.pages_created.len() + r.pages_updated.len() + r.pages_deleted.len() + r.pages_merged.len()) as u32;
        import_errors = r.errors.clone();
        conflict_pages = r.conflict_copies.clone();
    } else if git.error.is_none() && pending.is_none() && enabling {
        sync_manager::write_state(dir, &{
            let mut st = sync_manager::read_state(dir);
            st.imported_head = git_cmd::rev_parse_head(dir)?;
            st
        })?;
    }
    let error = match (&git.error, import_errors.first()) {
        (Some(e), _) => Some(e.clone()),
        (None, Some(first)) => Some(format!("Could not import {} file(s) from the other device: {first}", import_errors.len())),
        (None, None) => None,
    };
    Ok(sync_manager::GitSyncResult {
        success: error.is_none(),
        pages_exported: export.pages_exported,
        pages_imported,
        conflicts_resolved: git.conflicts_resolved,
        conflict_pages,
        offline: git.error.as_deref().map(sync_manager::is_offline_error).unwrap_or(false),
        error,
        import_errors,
        held_deletions: None,
        warnings: export.large_attachments.iter().map(|a| format!("{a} is over 50 MB and was not synced")).collect(),
        needs_confirmation: false,
    })
}

// ── Key rotation ──
//
// Rotating the data key (PRD-encryption §4.2) changes every sync key: file
// names, file encryption and the key check. The device that rotated keeps the
// old key sealed in its `.git` (see `PendingRekey`) and, at its next sync:
//   1. syncs once more with the OLD key — so edits other devices pushed before
//      the rotation are pulled and merged, not lost;
//   2. re-encrypts the whole repo with the new key: every `.mne` file is
//      rewritten under its new name, and the key file gets the new key check,
//      the new slots, `generation + 1` and the old key check in
//      `previous_key_checks`; one commit, pushed.
// If the push is refused (another device pushed meanwhile) the re-encrypting
// commit is dropped and the whole step runs again next time. Other devices,
// still on the old key, then fail closed (`KEY_CHANGED`): nothing is pulled or
// pushed until the notebook is joined again with the passphrase.

/// Record a rotation of `nb`'s data key from `old` to `new` for its sync repo
/// (before the database is swapped: a crash after the swap still finds it; a
/// rotation that rolls back leaves a record whose `to` matches no key, ignored).
/// No-op when the notebook has no encrypted sync repo.
pub fn prepare_rekey(nb: &crate::notebook::Notebook, old: &DataKey, new: &DataKey) -> Result<()> {
    let dir = nb.mirror_dir();
    if !git_cmd::is_git_repo(&dir) {
        return Ok(());
    }
    let (old_keys, new_keys) = (SyncKeys::new(old), SyncKeys::new(new));
    let mut st = sync_manager::read_state(&dir);
    // A rotation that never reached the repo: the repo still holds the older key.
    let from = match &st.rekey {
        Some(r) if r.to == old_keys.key_check() => r.from.clone(),
        _ => old_keys.key_check(),
    };
    let repo_key = match &st.rekey {
        Some(r) if r.to == old_keys.key_check() => {
            let k = open_old_key(&old_keys, r)?;
            Zeroizing::new(*k.bytes())
        }
        _ => Zeroizing::new(*old.bytes()),
    };
    st.rekey = Some(PendingRekey { from, to: new_keys.key_check(), old_key: new_keys.seal(REKEY_AAD, &repo_key[..]) });
    sync_manager::write_state(&dir, &st)
}

fn open_old_key(keys: &SyncKeys, r: &PendingRekey) -> Result<DataKey> {
    let raw = keys.open(REKEY_AAD, &r.old_key)?;
    let bytes: [u8; 32] = raw[..].try_into().map_err(|_| Error::InvalidInput("Malformed key rotation record".into()))?;
    Ok(DataKey::from_bytes(bytes))
}

/// The old sync keys when this device rotated the key and the repo isn't
/// re-encrypted yet. A record for another key (a rotation that rolled back) is dropped.
fn pending_rekey(dir: &Path, keys: &SyncKeys) -> Result<Option<SyncKeys>> {
    let mut st = sync_manager::read_state(dir);
    let Some(r) = st.rekey.clone() else { return Ok(None) };
    if r.to != keys.key_check() {
        st.rekey = None;
        sync_manager::write_state(dir, &st)?;
        return Ok(None);
    }
    let old = SyncKeys::new(&open_old_key(keys, &r)?);
    if old.key_check() != r.from {
        return Err(Error::InvalidInput("The key rotation record does not match the old key".into()));
    }
    Ok(Some(old))
}

fn finish_rekey(dir: &Path) -> Result<()> {
    let mut st = sync_manager::read_state(dir);
    st.rekey = None;
    sync_manager::write_state(dir, &st)
}

/// A cycle while this device's key rotation is not in the repo yet (see above).
fn rekey_cycle<G, F>(dir: &Path, lock_db: &F, enabling: bool, new: &SyncKeys, old: &SyncKeys) -> Result<sync_manager::GitSyncResult>
where
    G: Deref<Target = Database>,
    F: Fn() -> Result<G>,
{
    let remote = match fetch_remote(dir) {
        Ok(r) => r,
        Err(e) => return refuse(e, enabling),
    };
    let info = info_for(dir);
    match &remote {
        // Already re-encrypted (a push whose bookkeeping didn't finish).
        Remote::Keyed(kf) if kf.key_check == new.key_check() => {
            finish_rekey(dir)?;
            return cycle_with(dir, lock_db, enabling, new, info.as_ref());
        }
        Remote::Keyed(kf) if kf.key_check != old.key_check() => return refuse(mismatch(kf, old), enabling),
        Remote::Unkeyed => return refuse(unkeyed(), enabling),
        _ => {}
    }
    // The repo (local, and the remote if any) is on the old key: one more cycle
    // with it, so nothing pushed before the rotation is lost.
    let local_old = match crate::repo::export::read_text_below(dir, Path::new(KEY_FILE)) {
        Ok(text) => read_key_file_text(&text)?.key_check == old.key_check(),
        Err(_) => false,
    };
    let mut result = if local_old || matches!(remote, Remote::Keyed(_)) {
        let r = cycle_with(dir, lock_db, enabling, old, None)?;
        if !r.success {
            return Ok(r);
        }
        r
    } else {
        sync_manager::GitSyncResult { success: true, error: None, ..sync_manager::GitSyncResult::refused("") }
    };
    if !sync_manager::read_state(dir).merges.is_empty() {
        result.success = false;
        result.error = Some("The key rotation is synced once the other device's changes are merged".into());
        return Ok(result);
    }
    let Some(info) = info else {
        return Err(Error::InvalidInput("The notebook's key slots are not available".into()));
    };
    let pre = git_cmd::rev_parse_head(dir)?;
    {
        let db = lock_db()?;
        reencrypt(&db, dir, old, new, &info)?;
    }
    if git_cmd::has_remote(dir) {
        if let Err(e) = git_cmd::push(dir) {
            // Drop the re-encrypting commit; the next cycle pulls with the old key first.
            if let Some(pre) = &pre {
                let _ = git_cmd::run_git(dir, &["reset", "--hard", "-q", pre]);
            }
            let msg = format!("The new key is published at the next sync ({e})");
            return Ok(sync_manager::GitSyncResult {
                success: false,
                offline: sync_manager::is_offline_error(&e.to_string()),
                error: Some(msg),
                ..result
            });
        }
    }
    let mut st = sync_manager::read_state(dir);
    st.rekey = None;
    st.imported_head = git_cmd::rev_parse_head(dir)?;
    sync_manager::write_state(dir, &st)?;
    result.error = None;
    result.success = true;
    Ok(result)
}

/// Rewrite every file of the repo with the new key and commit (no push).
fn reencrypt(db: &Database, dir: &Path, old: &SyncKeys, new: &SyncKeys, info: &EncryptionInfo) -> Result<()> {
    let prev = match crate::repo::export::read_text_below(dir, Path::new(KEY_FILE)) {
        Ok(text) => Some(read_key_file_text(&text)?),
        Err(_) => None,
    };
    let mut previous_key_checks = prev.as_ref().map(|k| k.previous_key_checks.clone()).unwrap_or_default();
    if prev.is_some() && !previous_key_checks.contains(&old.key_check()) {
        previous_key_checks.push(old.key_check());
    }
    for kind in [PAGES, FOLDERS, WHITEBOARDS, ATTACHMENTS] {
        for (_, rel) in list_kind(dir, kind) {
            let path = crate::repo::export::safe_join(dir, Path::new(&rel))?;
            std::fs::remove_file(&path).map_err(|e| Error::InvalidInput(format!("Cannot remove {rel}: {e}")))?;
        }
    }
    write_key_file(
        dir,
        &KeyFile {
            version: 1,
            key_check: new.key_check(),
            generation: prev.as_ref().map(|k| k.generation + 1).unwrap_or(first_generation()),
            previous_key_checks,
            encryption: info.clone(),
        },
    )?;
    export(db, dir, new)?;
    git_cmd::commit_all(dir, &sync_manager::commit_message())?;
    Ok(())
}

// ── Joining ──

/// "Join an encrypted notebook": fetch a sync remote, unlock its key slots with
/// the passphrase (or recovery key), and create a new encrypted notebook in
/// `root` with that key and those slots; its sync folder is the fetched repo.
/// Nothing is written to the remote. A wrong secret creates nothing.
pub fn join_from_remote(remote: &str, root: &Path, name: &str, secret: &str) -> Result<crate::notebook::Notebook> {
    crate::notebook::validate_name(name)?;
    if root.exists() && std::fs::read_dir(root).map(|mut d| d.next().is_some()).unwrap_or(true) {
        return Err(Error::AlreadyExists(format!("{} already exists and is not empty — choose a new folder", root.display())));
    }
    let parent = root.parent().ok_or_else(|| Error::InvalidInput("Choose a folder for the notebook".into()))?;
    std::fs::create_dir_all(parent).map_err(|e| Error::InvalidInput(format!("Cannot create {}: {e}", parent.display())))?;
    let staging = parent.join(format!(".minotes-join-{}", Uuid::now_v7().simple()));
    let result = (|| {
        git_cmd::init_repo(&staging)?;
        git_cmd::harden_repo(&staging)?;
        let (_, e, ok) = git_cmd::run_git(&staging, &["remote", "add", "origin", remote])?;
        if !ok {
            return Err(Error::Git(format!("Cannot use that remote: {e}")));
        }
        let branch = git_cmd::require_branch(&staging)?;
        let (_, stderr, ok) = git_cmd::run_git(&staging, &["fetch", "--no-tags", "origin", &branch])?;
        if !ok {
            return Err(Error::Git(git_cmd::classify_git_error(&stderr)));
        }
        let text = git_cmd::show_file_at(&staging, "FETCH_HEAD", KEY_FILE)?
            .ok_or_else(|| Error::InvalidInput("That remote holds no encrypted MiNotes notebook".into()))?;
        let kf = read_key_file_text(&text)?;
        let dek = match kf.encryption.unlock(Secret::Passphrase(secret)) {
            Err(Error::WrongPassphrase) => match RecoveryKey::parse(secret) {
                Ok(rk) => kf.encryption.unlock(Secret::Recovery(&rk))?,
                Err(_) => return Err(Error::WrongPassphrase),
            },
            other => other?,
        };
        if SyncKeys::new(&dek).key_check() != kf.key_check {
            return Err(Error::InvalidInput("The remote's key file is inconsistent".into()));
        }
        let nb = crate::notebook::create_in_folder_with(root, name, Some((&dek, kf.encryption.clone())))?;
        let notes = nb.mirror_dir();
        let _ = std::fs::remove_dir_all(&notes);
        std::fs::rename(&staging, &notes).map_err(|e| Error::InvalidInput(format!("Cannot move the sync folder: {e}")))?;
        crate::encryption::remember_unlocked(&nb.key, dek);
        Ok(nb)
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result
}

#[cfg(test)]
mod tests;
