//! Notebooks: where a notebook's database, markdown mirror and app-private state live.
//!
//! Two kinds exist side by side (both are "notebooks" in the UI, the CLI and the
//! commands; they used to be called "graphs", which survives only in on-disk
//! names such as `~/.minotes/active_graph`):
//!
//! - **Legacy** — `~/.minotes/<name>.db`, keyed by `<name>`. Its markdown mirror is
//!   `~/MiNotes_Sync[-<name>]` (exactly where git sync has always put it), its sync
//!   config `~/.minotes/sync-config[-<name>].json`.
//! - **Folder** — a self-describing folder the user chose, keyed by the id in its
//!   `notebook.json`:
//!
//!   ```text
//!   My Notebook/
//!   ├── notebook.minotes   # the SQLite database (source of truth)
//!   ├── notebook.json      # name, id, format version, mirror settings
//!   ├── notes/             # the markdown mirror (and the git sync repo)
//!   └── .minotes/          # app-private: sync config, mirror state, lock
//!   ```
//!
//! `~/.minotes/notebooks.json` remembers known folder notebooks (path, name, last
//! opened). It is a convenience: the folder itself carries everything needed to
//! open it on another machine.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::db::Database;
use crate::error::{Error, Result};

pub const DB_FILE: &str = "notebook.minotes";
pub const META_FILE: &str = "notebook.json";
pub const NOTES_DIR: &str = "notes";
pub const PRIVATE_DIR: &str = ".minotes";
pub const LOCK_FILE: &str = "lock.json";
pub const REGISTRY_FILE: &str = "notebooks.json";
pub const FORMAT_VERSION: u32 = 1;
const MIRROR_STATE_FILE: &str = "mirror-state.json";
const SYNC_CONFIG_FILE: &str = "sync-config.json";

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// `~/.minotes` (created on demand): legacy databases, the registry, the active
/// notebook marker.
pub fn base_dir() -> PathBuf {
    let dir = home_dir().join(".minotes");
    let _ = fs::create_dir_all(&dir);
    dir
}

/// Where "New notebook…" proposes to put a notebook: `~/MiNotes/<name>`.
pub fn default_location(name: &str) -> PathBuf {
    home_dir().join("MiNotes").join(crate::repo::export::sanitize_component(name))
}

fn io_err(what: &str, path: &Path, e: std::io::Error) -> Error {
    Error::InvalidInput(format!("{what} {}: {e}", path.display()))
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| io_err("Cannot create", parent, e))?;
    }
    let json = serde_json::to_string_pretty(value)? + "\n";
    crate::repo::export::atomic_write(path, json.as_bytes()).map_err(|e| io_err("Cannot write", path, e))
}

/// The rules a notebook name must follow (same as legacy names have always had):
/// non-empty, no path separators, no dots, no NUL, at most 100 characters.
pub fn validate_name(name: &str) -> Result<()> {
    let ok = !name.trim().is_empty()
        && name.trim() == name
        && name.chars().count() <= 100
        && !name.contains(['/', '\\', '.', '\0'])
        && !name.chars().any(|c| c.is_control());
    if ok {
        Ok(())
    } else {
        Err(Error::InvalidInput(format!(
            "Invalid notebook name: '{name}'. Use letters, numbers, spaces, - or _ (no dots or slashes)."
        )))
    }
}

// ── notebook.json ──

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MirrorSettings {
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

impl Default for MirrorSettings {
    fn default() -> Self {
        Self { enabled: true }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NotebookMeta {
    pub name: String,
    pub id: String,
    pub format_version: u32,
    #[serde(default)]
    pub mirror: MirrorSettings,
    #[serde(default)]
    pub created_at: Option<String>,
}

pub fn read_meta(root: &Path) -> Result<NotebookMeta> {
    let path = root.join(META_FILE);
    let text = fs::read_to_string(&path).map_err(|e| io_err("Cannot read", &path, e))?;
    let meta: NotebookMeta = serde_json::from_str(&text)
        .map_err(|e| Error::InvalidInput(format!("{} is not a notebook description: {e}", path.display())))?;
    if meta.format_version > FORMAT_VERSION {
        return Err(Error::InvalidInput(format!(
            "This notebook was made by a newer MiNotes (format {}); please update the app",
            meta.format_version
        )));
    }
    Ok(meta)
}

fn write_meta(root: &Path, meta: &NotebookMeta) -> Result<()> {
    write_json_atomic(&root.join(META_FILE), meta)
}

// ── Registry (~/.minotes/notebooks.json) ──

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Registry {
    #[serde(default)]
    pub notebooks: Vec<RegistryEntry>,
    /// Display names given to legacy notebooks ("Manage notebooks… → Rename");
    /// their key stays the database file name.
    #[serde(default)]
    pub legacy_names: BTreeMap<String, String>,
    #[serde(default)]
    pub legacy_last_opened: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RegistryEntry {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub last_opened: Option<String>,
}

impl Registry {
    pub fn path() -> PathBuf {
        base_dir().join(REGISTRY_FILE)
    }

    pub fn load() -> Registry {
        fs::read_to_string(Self::path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> Result<()> {
        write_json_atomic(&Self::path(), self)
    }

    pub fn find(&self, id: &str) -> Option<&RegistryEntry> {
        self.notebooks.iter().find(|e| e.id == id)
    }

    fn upsert(&mut self, entry: RegistryEntry) {
        match self.notebooks.iter_mut().find(|e| e.id == entry.id) {
            Some(e) => *e = entry,
            None => self.notebooks.push(entry),
        }
    }
}

// ── Notebook ──

#[derive(Debug, Clone, PartialEq)]
pub enum Location {
    Legacy { name: String },
    Folder { root: PathBuf },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Notebook {
    /// What `switch_notebook` / `active_graph` / sync are keyed by: the legacy name,
    /// or the folder notebook's id.
    pub key: String,
    /// Display name.
    pub name: String,
    pub location: Location,
}

fn is_default(name: &str) -> bool {
    name.is_empty() || name == "default"
}

/// The markdown mirror (and git sync dir) of a legacy notebook.
pub fn legacy_mirror_dir(name: &str) -> PathBuf {
    if is_default(name) {
        home_dir().join("MiNotes_Sync")
    } else {
        home_dir().join(format!("MiNotes_Sync-{}", crate::repo::export::sanitize_component(name)))
    }
}

fn legacy_sync_config(name: &str) -> PathBuf {
    if is_default(name) {
        base_dir().join("sync-config.json")
    } else {
        base_dir().join(format!("sync-config-{}.json", crate::repo::export::sanitize_component(name)))
    }
}

impl Notebook {
    pub fn legacy(name: &str) -> Notebook {
        let name = if name.is_empty() { "default" } else { name };
        let display = Registry::load().legacy_names.get(name).cloned().unwrap_or_else(|| name.to_string());
        Notebook { key: name.to_string(), name: display, location: Location::Legacy { name: name.to_string() } }
    }

    pub fn is_folder(&self) -> bool {
        matches!(self.location, Location::Folder { .. })
    }

    pub fn root(&self) -> Option<&Path> {
        match &self.location {
            Location::Folder { root } => Some(root),
            Location::Legacy { .. } => None,
        }
    }

    pub fn db_path(&self) -> PathBuf {
        match &self.location {
            Location::Legacy { name } => base_dir().join(format!("{name}.db")),
            Location::Folder { root } => root.join(DB_FILE),
        }
    }

    pub fn mirror_dir(&self) -> PathBuf {
        match &self.location {
            Location::Legacy { name } => legacy_mirror_dir(name),
            Location::Folder { root } => root.join(NOTES_DIR),
        }
    }

    /// App-private state: sync config, mirror state, lock file.
    pub fn private_dir(&self) -> PathBuf {
        match &self.location {
            Location::Legacy { .. } => base_dir(),
            Location::Folder { root } => root.join(PRIVATE_DIR),
        }
    }

    pub fn lock_path(&self) -> PathBuf {
        match &self.location {
            Location::Legacy { name } => base_dir().join(format!("{}.lock.json", crate::repo::export::sanitize_component(name))),
            Location::Folder { root } => root.join(PRIVATE_DIR).join(LOCK_FILE),
        }
    }

    pub fn mirror_state_path(&self) -> PathBuf {
        match &self.location {
            Location::Legacy { name } => {
                base_dir().join(format!("mirror-state-{}.json", crate::repo::export::sanitize_component(name)))
            }
            Location::Folder { root } => root.join(PRIVATE_DIR).join(MIRROR_STATE_FILE),
        }
    }

    pub fn sync_config_path(&self) -> PathBuf {
        match &self.location {
            Location::Legacy { name } => legacy_sync_config(name),
            Location::Folder { root } => root.join(PRIVATE_DIR).join(SYNC_CONFIG_FILE),
        }
    }

    /// The database exists where it should (a folder on an unplugged drive does not).
    pub fn available(&self) -> bool {
        self.db_path().is_file()
    }

    pub fn mirror_enabled(&self) -> bool {
        match &self.location {
            Location::Legacy { .. } => true,
            Location::Folder { root } => read_meta(root).map(|m| m.mirror.enabled).unwrap_or(true),
        }
    }

    /// Open the database. A folder notebook's database must already exist — a
    /// missing folder is reported, never silently replaced by an empty notebook.
    pub fn open_db(&self) -> Result<Database> {
        if self.is_folder() && !self.available() {
            return Err(Error::NotFound(format!(
                "Notebook '{}' is unavailable: {} not found",
                self.name,
                self.db_path().display()
            )));
        }
        Database::open(&self.db_path())
    }
}

/// Resolve a key (`active_graph`, `switch_notebook`, the CLI default) to a notebook.
/// A registered folder notebook id wins; otherwise it is a legacy name.
pub fn resolve(key: &str) -> Result<Notebook> {
    let reg = Registry::load();
    if let Some(e) = reg.find(key) {
        return Ok(Notebook {
            key: e.id.clone(),
            name: e.name.clone(),
            location: Location::Folder { root: PathBuf::from(&e.path) },
        });
    }
    if !is_default(key) {
        validate_name(key)?;
    }
    Ok(Notebook::legacy(key))
}

/// Resolve a notebook by its display name (CLI `--notebook <name>`): registered
/// folder notebooks and legacy ones. Ambiguous names are an error.
pub fn find_by_name(name: &str) -> Result<Notebook> {
    let all = list();
    let hits: Vec<&NotebookInfo> = all.iter().filter(|n| n.name == name).collect();
    let hits = if hits.is_empty() {
        all.iter().filter(|n| n.name.eq_ignore_ascii_case(name) || n.key == name).collect()
    } else {
        hits
    };
    match hits.as_slice() {
        [one] => resolve(&one.key),
        [] => Err(Error::NotFound(format!("No notebook named '{name}'"))),
        _ => Err(Error::InvalidInput(format!(
            "Several notebooks are named '{name}'; pass --notebook <folder> instead"
        ))),
    }
}

// ── Listing ──

#[derive(Debug, Clone, Serialize)]
pub struct NotebookInfo {
    pub key: String,
    pub name: String,
    /// "legacy" (in ~/.minotes) or "folder".
    pub kind: String,
    /// The folder (folder notebooks) or the database file (legacy).
    pub path: String,
    pub db_path: String,
    pub mirror_dir: String,
    pub available: bool,
    pub last_opened: Option<String>,
    pub size_bytes: u64,
    pub modified_at: String,
    /// Name of the file-sync service the folder seems to live in (Dropbox, …).
    pub cloud: Option<String>,
}

fn file_times(path: &Path) -> (u64, String) {
    match fs::metadata(path) {
        Ok(m) => {
            let modified = m
                .modified()
                .ok()
                .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339())
                .unwrap_or_default();
            (m.len(), modified)
        }
        Err(_) => (0, String::new()),
    }
}

pub fn info(nb: &Notebook) -> NotebookInfo {
    let reg = Registry::load();
    let (size_bytes, modified_at) = file_times(&nb.db_path());
    let (kind, path, last_opened) = match &nb.location {
        Location::Legacy { name } => {
            ("legacy", nb.db_path(), reg.legacy_last_opened.get(name).cloned())
        }
        Location::Folder { root } => {
            ("folder", root.clone(), reg.find(&nb.key).and_then(|e| e.last_opened.clone()))
        }
    };
    NotebookInfo {
        key: nb.key.clone(),
        name: nb.name.clone(),
        kind: kind.to_string(),
        path: path.display().to_string(),
        db_path: nb.db_path().display().to_string(),
        mirror_dir: nb.mirror_dir().display().to_string(),
        available: nb.available(),
        last_opened,
        size_bytes,
        modified_at,
        cloud: nb.root().and_then(cloud_service).map(str::to_string),
    }
}

/// Every known notebook: legacy databases in `~/.minotes`, then registered folders
/// (including unavailable ones, so the UI can offer "Locate…").
pub fn list() -> Vec<NotebookInfo> {
    let mut out = Vec::new();
    if let Ok(legacy) = crate::repo::legacy_notebooks::list(&base_dir()) {
        for g in legacy {
            out.push(info(&Notebook::legacy(&g.name)));
        }
    }
    for e in Registry::load().notebooks {
        out.push(info(&Notebook {
            key: e.id.clone(),
            name: e.name.clone(),
            location: Location::Folder { root: PathBuf::from(&e.path) },
        }));
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.key.cmp(&b.key)));
    out
}

pub fn touch_last_opened(nb: &Notebook) {
    let mut reg = Registry::load();
    let now = chrono::Utc::now().to_rfc3339();
    match &nb.location {
        Location::Legacy { name } => {
            reg.legacy_last_opened.insert(name.clone(), now);
        }
        Location::Folder { .. } => {
            if let Some(e) = reg.notebooks.iter_mut().find(|e| e.id == nb.key) {
                e.last_opened = Some(now);
            }
        }
    }
    let _ = reg.save();
}

// ── Create / open / locate / rename / delete ──

fn dir_is_empty(p: &Path) -> bool {
    fs::read_dir(p).map(|mut rd| rd.next().is_none()).unwrap_or(false)
}

fn register(root: &Path, meta: &NotebookMeta) -> Result<Notebook> {
    let mut reg = Registry::load();
    reg.upsert(RegistryEntry {
        id: meta.id.clone(),
        name: meta.name.clone(),
        path: root.display().to_string(),
        last_opened: reg.find(&meta.id).and_then(|e| e.last_opened.clone()),
    });
    reg.save()?;
    Ok(Notebook { key: meta.id.clone(), name: meta.name.clone(), location: Location::Folder { root: root.to_path_buf() } })
}

fn absolute(p: &Path) -> PathBuf {
    let p = if let Ok(rest) = p.strip_prefix("~") { home_dir().join(rest) } else { p.to_path_buf() };
    if p.is_absolute() {
        p
    } else {
        std::env::current_dir().map(|d| d.join(&p)).unwrap_or(p)
    }
}

/// Create a new notebook in `root` (which must not exist yet, or be empty).
pub fn create_in_folder(root: &Path, name: &str) -> Result<Notebook> {
    validate_name(name)?;
    let root = absolute(root);
    if root.exists() && !(root.is_dir() && dir_is_empty(&root)) {
        return Err(Error::AlreadyExists(format!(
            "{} already exists and is not empty — choose a new folder",
            root.display()
        )));
    }
    if list().iter().any(|n| n.name == name) {
        return Err(Error::AlreadyExists(format!("A notebook named '{name}' already exists")));
    }
    let created_root = !root.exists();
    let result = (|| {
        fs::create_dir_all(root.join(PRIVATE_DIR)).map_err(|e| io_err("Cannot create", &root, e))?;
        fs::create_dir_all(root.join(NOTES_DIR)).map_err(|e| io_err("Cannot create", &root, e))?;
        drop(Database::open(&root.join(DB_FILE))?);
        let meta = NotebookMeta {
            name: name.to_string(),
            id: Uuid::now_v7().to_string(),
            format_version: FORMAT_VERSION,
            mirror: MirrorSettings::default(),
            created_at: Some(chrono::Utc::now().to_rfc3339()),
        };
        write_meta(&root, &meta)?;
        register(&root, &meta)
    })();
    if result.is_err() {
        if created_root {
            let _ = fs::remove_dir_all(&root);
        } else {
            for f in [DB_FILE, META_FILE, "notebook.minotes-wal", "notebook.minotes-shm"] {
                let _ = fs::remove_file(root.join(f));
            }
            let _ = fs::remove_dir_all(root.join(PRIVATE_DIR));
            let _ = fs::remove_dir(root.join(NOTES_DIR));
        }
    }
    result
}

/// Does `root` look like a notebook folder?
pub fn is_notebook_folder(root: &Path) -> bool {
    root.join(DB_FILE).is_file() && root.join(META_FILE).is_file()
}

/// Open (and register) an existing notebook folder. A copy of a folder that is
/// already registered elsewhere gets a fresh id, so both can be listed.
pub fn open_folder(root: &Path) -> Result<Notebook> {
    let root = absolute(root);
    let root = root.canonicalize().unwrap_or(root);
    if !root.join(DB_FILE).is_file() {
        return Err(Error::NotFound(format!(
            "{} is not a MiNotes notebook (no {DB_FILE} inside)",
            root.display()
        )));
    }
    let mut meta = match read_meta(&root) {
        Ok(m) => m,
        // A folder with a database but no description (e.g. copied by hand):
        // describe it now rather than refusing.
        Err(_) if !root.join(META_FILE).exists() => {
            let name = root.file_name().and_then(|n| n.to_str()).unwrap_or("Notebook").replace('.', "_");
            let m = NotebookMeta {
                name: if validate_name(&name).is_ok() { name } else { "Notebook".into() },
                id: Uuid::now_v7().to_string(),
                format_version: FORMAT_VERSION,
                mirror: MirrorSettings::default(),
                created_at: Some(chrono::Utc::now().to_rfc3339()),
            };
            write_meta(&root, &m)?;
            m
        }
        Err(e) => return Err(e),
    };
    let reg = Registry::load();
    if let Some(e) = reg.find(&meta.id) {
        let registered = PathBuf::from(&e.path);
        let same = registered.canonicalize().map(|p| p == root).unwrap_or(false);
        if !same {
            let other_is_live = read_meta(&registered).map(|m| m.id == meta.id).unwrap_or(false);
            if other_is_live {
                // A copy: give it its own identity (and a distinguishable name).
                meta.id = Uuid::now_v7().to_string();
                if list().iter().any(|n| n.name == meta.name) {
                    meta.name = unique_name(&meta.name);
                }
                write_meta(&root, &meta)?;
                // The copied lock belongs to the original.
                let _ = fs::remove_file(root.join(PRIVATE_DIR).join(LOCK_FILE));
            }
            // else: the folder moved — the registry follows it.
        }
    }
    let _ = fs::create_dir_all(root.join(PRIVATE_DIR));
    register(&root, &meta)
}

fn unique_name(base: &str) -> String {
    let names: Vec<String> = list().into_iter().map(|n| n.name).collect();
    for n in 2..1000 {
        let c = format!("{base} {n}");
        if !names.contains(&c) {
            return c;
        }
    }
    format!("{base} {}", &Uuid::now_v7().simple().to_string()[..8])
}

/// Point a registered (unavailable) notebook at its new folder.
pub fn locate(key: &str, root: &Path) -> Result<Notebook> {
    let root = absolute(root);
    let root = root.canonicalize().unwrap_or(root);
    let reg = Registry::load();
    let entry = reg.find(key).cloned().ok_or_else(|| Error::NotFound(format!("Unknown notebook {key}")))?;
    let meta = read_meta(&root)?;
    if !root.join(DB_FILE).is_file() {
        return Err(Error::NotFound(format!("{} has no {DB_FILE}", root.display())));
    }
    if meta.id != entry.id {
        return Err(Error::InvalidInput(format!(
            "{} holds a different notebook ('{}'); use Open notebook… for it",
            root.display(),
            meta.name
        )));
    }
    register(&root, &meta)
}

/// Rename a notebook's display name (the folder and files keep their names).
pub fn rename(key: &str, new_name: &str) -> Result<Notebook> {
    validate_name(new_name)?;
    let nb = resolve(key)?;
    if list().iter().any(|n| n.name == new_name && n.key != nb.key) {
        return Err(Error::AlreadyExists(format!("A notebook named '{new_name}' already exists")));
    }
    let mut reg = Registry::load();
    match &nb.location {
        Location::Legacy { name } => {
            if new_name == name {
                reg.legacy_names.remove(name);
            } else {
                reg.legacy_names.insert(name.clone(), new_name.to_string());
            }
        }
        Location::Folder { root } => {
            if let Ok(mut meta) = read_meta(root) {
                meta.name = new_name.to_string();
                write_meta(root, &meta)?;
            }
            if let Some(e) = reg.notebooks.iter_mut().find(|e| e.id == nb.key) {
                e.name = new_name.to_string();
            }
        }
    }
    reg.save()?;
    resolve(key)
}

/// Delete a notebook's database. The markdown mirror is the user's plain-text
/// copy and is kept. Folder notebooks lose `notebook.minotes`, `notebook.json`
/// and `.minotes/`; the registry entry goes too. Refused for `active_key`.
pub fn delete(key: &str, active_key: &str) -> Result<()> {
    if key == active_key {
        return Err(Error::InvalidInput(
            "Cannot delete the open notebook. Switch to another notebook first.".into(),
        ));
    }
    let nb = resolve(key)?;
    let mut reg = Registry::load();
    match &nb.location {
        Location::Legacy { name } => {
            crate::repo::legacy_notebooks::delete(&base_dir(), name)?;
            reg.legacy_names.remove(name);
            reg.legacy_last_opened.remove(name);
            let _ = fs::remove_file(nb.mirror_state_path());
        }
        Location::Folder { root } => {
            if root.exists() {
                if let LockStatus::HeldByOther(l) = check_lock(&nb.lock_path()) {
                    return Err(Error::InvalidInput(format!(
                        "Notebook is open in another MiNotes window ({}, pid {})",
                        l.host, l.pid
                    )));
                }
                for f in [DB_FILE, "notebook.minotes-wal", "notebook.minotes-shm", META_FILE] {
                    let p = root.join(f);
                    if p.exists() {
                        fs::remove_file(&p).map_err(|e| io_err("Cannot delete", &p, e))?;
                    }
                }
                let _ = fs::remove_dir_all(root.join(PRIVATE_DIR));
                let _ = fs::remove_dir(root.join(NOTES_DIR)); // only if empty
                let _ = fs::remove_dir(root); // only if empty
            }
            reg.notebooks.retain(|e| e.id != nb.key);
        }
    }
    reg.save()
}

/// Forget a registered folder notebook without touching its files.
pub fn forget(key: &str) -> Result<()> {
    let mut reg = Registry::load();
    reg.notebooks.retain(|e| e.id != key);
    reg.save()
}

// ── Lock file ──

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LockInfo {
    pub pid: u32,
    pub host: String,
    pub instance: String,
    pub opened_at: String,
    /// Where the lock was taken: a copy of the folder carries a lock that is
    /// not about the copy.
    #[serde(default)]
    pub root: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum LockStatus {
    Acquired,
    HeldByOther(LockInfo),
}

/// Identifies this app instance (process) in lock files.
pub fn instance_id() -> &'static str {
    static ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    ID.get_or_init(|| Uuid::now_v7().to_string())
}

fn hostname() -> String {
    hostname::get().map(|h| h.to_string_lossy().to_string()).unwrap_or_default()
}

fn pid_alive(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    {
        Path::new(&format!("/proc/{pid}")).exists()
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(true)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

fn lock_root(lock_path: &Path) -> Option<String> {
    // <root>/.minotes/lock.json → <root>
    let parent = lock_path.parent()?;
    if parent.file_name().and_then(|n| n.to_str()) == Some(PRIVATE_DIR) {
        parent.parent().map(|r| r.display().to_string())
    } else {
        None
    }
}

/// Who holds the lock (without taking it). Stale locks (dead process on this
/// host, or a lock copied along with the folder) count as free.
pub fn check_lock(lock_path: &Path) -> LockStatus {
    let Ok(text) = fs::read_to_string(lock_path) else { return LockStatus::Acquired };
    let Ok(info) = serde_json::from_str::<LockInfo>(&text) else { return LockStatus::Acquired };
    if info.instance == instance_id() {
        return LockStatus::Acquired;
    }
    if let (Some(r), Some(here)) = (&info.root, lock_root(lock_path)) {
        if *r != here {
            return LockStatus::Acquired; // copied with the folder
        }
    }
    if info.host == hostname() && !pid_alive(info.pid) {
        return LockStatus::Acquired; // crashed / killed
    }
    LockStatus::HeldByOther(info)
}

/// Take the notebook's lock unless another live instance holds it (then the
/// caller opens the notebook read-only). `force` takes it regardless.
pub fn acquire_lock(lock_path: &Path, force: bool) -> Result<LockStatus> {
    if !force {
        if let st @ LockStatus::HeldByOther(_) = check_lock(lock_path) {
            return Ok(st);
        }
    }
    let info = LockInfo {
        pid: std::process::id(),
        host: hostname(),
        instance: instance_id().to_string(),
        opened_at: chrono::Utc::now().to_rfc3339(),
        root: lock_root(lock_path),
    };
    write_json_atomic(lock_path, &info)?;
    Ok(LockStatus::Acquired)
}

/// Release the lock if it is ours.
pub fn release_lock(lock_path: &Path) {
    if let Ok(text) = fs::read_to_string(lock_path) {
        if let Ok(info) = serde_json::from_str::<LockInfo>(&text) {
            if info.instance == instance_id() {
                let _ = fs::remove_file(lock_path);
            }
        }
    }
}

// ── Cloud folders ──

/// The file-sync service a path seems to live in, judging by its components.
pub fn cloud_service(path: &Path) -> Option<&'static str> {
    for c in path.components() {
        let s = c.as_os_str().to_string_lossy().to_lowercase();
        let hit = if s == "dropbox" || s.starts_with("dropbox (") {
            Some("Dropbox")
        } else if s == "icloud drive" || s == "mobile documents" || s.contains("com~apple~clouddocs") || s == "iclouddrive" {
            Some("iCloud Drive")
        } else if s == "onedrive" || s.starts_with("onedrive - ") || s.starts_with("onedrive-") {
            Some("OneDrive")
        } else if s == "google drive" || s == "googledrive" || s == "my drive" || s.starts_with("googledrive-") {
            Some("Google Drive")
        } else if s == "pcloud drive" || s == "box" || s == "box sync" || s == "nextcloud" || s == "owncloud" {
            Some("a cloud-synced folder")
        } else {
            None
        };
        if hit.is_some() {
            return hit;
        }
    }
    None
}

/// Database copies a file-sync service made after a conflict, e.g.
/// `notebook (conflicted copy).minotes`, `notebook (Chris's conflicted copy
/// 2026-10-10).minotes`, `notebook 2.minotes`, `notebook-LAPTOP.minotes`.
pub fn conflicted_copies(root: &Path) -> Vec<String> {
    let Ok(rd) = fs::read_dir(root) else { return vec![] };
    let mut out: Vec<String> = rd
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| {
            n != DB_FILE
                && n.starts_with("notebook")
                && (n.ends_with(".minotes") || n.contains(".minotes-") && n.contains("conflict"))
        })
        .collect();
    out.sort();
    out
}

/// Fold the WAL back into the database file and truncate it, so a file-sync
/// service copying the folder sees one consistent file.
pub fn checkpoint(db: &Database) -> Result<()> {
    db.conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
    Ok(())
}

// ── Move a legacy notebook into a folder ──

/// Steps of [`prepare_move_to_folder`]; tests inject a failure after one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MoveStep {
    CopyDatabase,
    Verify,
    Describe,
    MoveMirror,
    Register,
}

/// A move that has been copied and verified but not finished: the old files are
/// still in place. `finish` removes them (after the caller switched to the new
/// database); `rollback` undoes everything.
#[derive(Debug)]
pub struct PreparedMove {
    pub notebook: Notebook,
    src: Notebook,
    created_root: bool,
    mirror: Option<MirrorMove>,
    registered: bool,
    pub row_counts: BTreeMap<String, i64>,
}

#[derive(Debug)]
struct MirrorMove {
    from: PathBuf,
    to: PathBuf,
    /// Renamed (same filesystem) rather than copied.
    renamed: bool,
}

/// Row count of every real table (FTS shadow tables included).
pub fn table_row_counts(conn: &rusqlite::Connection) -> Result<BTreeMap<String, i64>> {
    let mut names: Vec<String> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
               AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' ORDER BY name",
        )?;
        for r in stmt.query_map([], |r| r.get::<_, String>(0))? {
            names.push(r?);
        }
    }
    let mut out = BTreeMap::new();
    for n in names {
        let c: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM \"{}\"", n.replace('"', "\"\"")), [], |r| r.get(0))?;
        out.insert(n, c);
    }
    Ok(out)
}

/// `PRAGMA integrity_check` and per-table row counts of `copy` against `expected`.
pub fn verify_copy(copy: &Path, expected: &BTreeMap<String, i64>) -> Result<()> {
    let conn = rusqlite::Connection::open_with_flags(copy, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let check: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if check != "ok" {
        return Err(Error::InvalidInput(format!("Copied database failed its integrity check: {check}")));
    }
    let got = table_row_counts(&conn)?;
    if &got != expected {
        let diff: Vec<String> = expected
            .iter()
            .filter(|(k, v)| got.get(*k) != Some(*v))
            .map(|(k, v)| format!("{k}: {v} → {}", got.get(k).map(|g| g.to_string()).unwrap_or("missing".into())))
            .collect();
        return Err(Error::InvalidInput(format!("Copied database differs: {}", diff.join(", "))));
    }
    Ok(())
}

fn copy_dir_all(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for e in fs::read_dir(from)? {
        let e = e?;
        let ft = e.file_type()?;
        let dest = to.join(e.file_name());
        if ft.is_dir() {
            copy_dir_all(&e.path(), &dest)?;
        } else if ft.is_symlink() {
            #[cfg(unix)]
            std::os::unix::fs::symlink(fs::read_link(e.path())?, &dest)?;
        } else {
            fs::copy(e.path(), &dest)?;
        }
    }
    Ok(())
}

/// Convert a legacy notebook (`~/.minotes/<name>.db` + `~/MiNotes_Sync[-<name>]`)
/// to the folder layout at `dest`: checkpoint, copy the database
/// (`VACUUM INTO`, consistent even while open), verify it (`integrity_check` +
/// row counts), describe it, move the mirror (keeping `.git`), register it.
/// Nothing old is removed here — see [`PreparedMove::finish`]. On any failure
/// everything done so far is undone. `db` is the open source database; the
/// caller holds it for the duration, so no write can slip in between.
pub fn prepare_move_to_folder(
    db: &Database,
    src: &Notebook,
    dest: &Path,
    fail_after: Option<MoveStep>,
) -> Result<PreparedMove> {
    if src.is_folder() {
        return Err(Error::InvalidInput("This notebook is already in a folder of its own".into()));
    }
    let dest = absolute(dest);
    if dest.exists() && !(dest.is_dir() && dir_is_empty(&dest)) {
        return Err(Error::AlreadyExists(format!(
            "{} already exists and is not empty — choose a new folder",
            dest.display()
        )));
    }
    let mirror_from = src.mirror_dir();
    if dest.starts_with(&mirror_from) || dest.starts_with(base_dir()) {
        return Err(Error::InvalidInput("Choose a folder outside the notebook's current files".into()));
    }
    let mut mv = PreparedMove {
        notebook: Notebook { key: String::new(), name: src.name.clone(), location: Location::Folder { root: dest.clone() } },
        src: src.clone(),
        created_root: !dest.exists(),
        mirror: None,
        registered: false,
        row_counts: BTreeMap::new(),
    };
    let inject = |step: MoveStep| -> Result<()> {
        if fail_after == Some(step) {
            Err(Error::InvalidInput(format!("injected failure after {step:?}")))
        } else {
            Ok(())
        }
    };
    let res = (|| -> Result<()> {
        fs::create_dir_all(dest.join(PRIVATE_DIR)).map_err(|e| io_err("Cannot create", &dest, e))?;
        // 1. copy
        checkpoint(db)?;
        mv.row_counts = table_row_counts(&db.conn)?;
        let target = dest.join(DB_FILE);
        db.conn.execute("VACUUM INTO ?1", [target.to_string_lossy().to_string()])?;
        inject(MoveStep::CopyDatabase)?;
        // 2. verify
        verify_copy(&target, &mv.row_counts)?;
        inject(MoveStep::Verify)?;
        // 3. describe + carry the private state along
        let meta = NotebookMeta {
            name: src.name.clone(),
            id: Uuid::now_v7().to_string(),
            format_version: FORMAT_VERSION,
            mirror: MirrorSettings::default(),
            created_at: Some(chrono::Utc::now().to_rfc3339()),
        };
        write_meta(&dest, &meta)?;
        mv.notebook.key = meta.id.clone();
        if let Ok(cfg) = fs::read(src.sync_config_path()) {
            fs::write(dest.join(PRIVATE_DIR).join(SYNC_CONFIG_FILE), cfg).map_err(|e| io_err("Cannot write", &dest, e))?;
        }
        inject(MoveStep::Describe)?;
        // 4. mirror (with its .git)
        let to = dest.join(NOTES_DIR);
        if mirror_from.is_dir() {
            match fs::rename(&mirror_from, &to) {
                Ok(()) => mv.mirror = Some(MirrorMove { from: mirror_from.clone(), to: to.clone(), renamed: true }),
                Err(_) => {
                    // Different filesystem: copy now, delete the original in finish().
                    mv.mirror = Some(MirrorMove { from: mirror_from.clone(), to: to.clone(), renamed: false });
                    copy_dir_all(&mirror_from, &to).map_err(|e| io_err("Cannot copy", &mirror_from, e))?;
                }
            }
        } else {
            fs::create_dir_all(&to).map_err(|e| io_err("Cannot create", &to, e))?;
        }
        inject(MoveStep::MoveMirror)?;
        // 5. register
        register(&dest, &meta)?;
        mv.registered = true;
        inject(MoveStep::Register)?;
        Ok(())
    })();
    match res {
        Ok(()) => Ok(mv),
        Err(e) => {
            mv.rollback();
            Err(e)
        }
    }
}

impl PreparedMove {
    /// Undo a prepared move: the legacy notebook is exactly as before.
    pub fn rollback(mut self) {
        self.undo();
    }

    fn undo(&mut self) {
        if self.registered {
            let _ = forget(&self.notebook.key);
            self.registered = false;
        }
        if let Some(m) = self.mirror.take() {
            if m.renamed {
                let _ = fs::rename(&m.to, &m.from);
            } else {
                let _ = fs::remove_dir_all(&m.to);
            }
        }
        if let Some(root) = self.notebook.root().map(Path::to_path_buf) {
            if self.created_root {
                let _ = fs::remove_dir_all(&root);
            } else {
                for f in [DB_FILE, "notebook.minotes-wal", "notebook.minotes-shm", META_FILE] {
                    let _ = fs::remove_file(root.join(f));
                }
                let _ = fs::remove_dir_all(root.join(PRIVATE_DIR));
                let _ = fs::remove_dir_all(root.join(NOTES_DIR));
            }
        }
    }

    /// Remove the legacy files. Call only after nothing uses the old database
    /// any more (the app has switched its connection).
    pub fn finish(mut self) -> Result<Notebook> {
        let Location::Legacy { name } = &self.src.location else { unreachable!() };
        let base = base_dir();
        for f in [format!("{name}.db-wal"), format!("{name}.db-shm"), format!("{name}.db")] {
            let p = base.join(&f);
            if p.exists() {
                fs::remove_file(&p).map_err(|e| io_err("Cannot remove", &p, e))?;
            }
        }
        let _ = fs::remove_file(self.src.sync_config_path());
        let _ = fs::remove_file(self.src.mirror_state_path());
        let _ = fs::remove_file(self.src.lock_path());
        if let Some(m) = self.mirror.take() {
            if !m.renamed {
                let _ = fs::remove_dir_all(&m.from);
            }
        }
        let mut reg = Registry::load();
        reg.legacy_names.remove(name);
        reg.legacy_last_opened.remove(name);
        reg.save()?;
        Ok(self.notebook.clone())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Tests that touch `HOME` run one at a time, each with its own fake home.
    pub(crate) static HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    pub(crate) struct FakeHome {
        pub dir: tempfile::TempDir,
        old: Option<std::ffi::OsString>,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl FakeHome {
        pub(crate) fn new() -> FakeHome {
            let guard = HOME_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            let dir = tempfile::tempdir().unwrap();
            let old = std::env::var_os("HOME");
            std::env::set_var("HOME", dir.path());
            FakeHome { dir, old, _guard: guard }
        }
        pub(crate) fn path(&self) -> &Path {
            self.dir.path()
        }
    }

    impl Drop for FakeHome {
        fn drop(&mut self) {
            match &self.old {
                Some(h) => std::env::set_var("HOME", h),
                None => std::env::remove_var("HOME"),
            }
        }
    }

    #[test]
    fn test_create_open_and_registry() {
        let home = FakeHome::new();
        let root = home.path().join("MiNotes").join("Work");
        let nb = create_in_folder(&root, "Work").unwrap();
        assert!(root.join(DB_FILE).is_file());
        assert!(root.join(NOTES_DIR).is_dir());
        assert!(root.join(PRIVATE_DIR).is_dir());
        let meta = read_meta(&root).unwrap();
        assert_eq!(meta.name, "Work");
        assert_eq!(meta.id, nb.key);
        assert_eq!(meta.format_version, FORMAT_VERSION);
        assert!(meta.mirror.enabled);

        // Registry knows it; resolve by key and by name.
        let reg = Registry::load();
        assert_eq!(reg.notebooks.len(), 1);
        assert_eq!(reg.notebooks[0].path, root.display().to_string());
        assert_eq!(resolve(&nb.key).unwrap().db_path(), root.join(DB_FILE));
        assert_eq!(find_by_name("Work").unwrap().key, nb.key);
        assert_eq!(nb.mirror_dir(), root.join(NOTES_DIR));
        assert_eq!(nb.sync_config_path(), root.join(PRIVATE_DIR).join("sync-config.json"));

        // Listed with legacy notebooks.
        crate::repo::legacy_notebooks::create(&base_dir(), "default").unwrap();
        let all = list();
        assert_eq!(all.iter().map(|n| n.kind.as_str()).collect::<Vec<_>>().len(), 2);
        assert!(all.iter().any(|n| n.key == "default" && n.kind == "legacy"));

        // Non-empty folder, duplicate name and bad names are refused.
        assert!(create_in_folder(&root, "Other").is_err());
        assert!(create_in_folder(&home.path().join("x"), "Work").is_err());
        assert!(create_in_folder(&home.path().join("y"), "a/b").is_err());
        assert!(create_in_folder(&home.path().join("y"), "a.b").is_err());

        // The registry is a convenience: wipe it and the folder still opens.
        fs::remove_file(Registry::path()).unwrap();
        let reopened = open_folder(&root).unwrap();
        assert_eq!(reopened.key, nb.key);
        assert_eq!(reopened.name, "Work");
        let db = reopened.open_db().unwrap();
        assert!(db.list_pages(None).unwrap().is_empty());
    }

    #[test]
    fn test_copied_folder_gets_its_own_identity_and_moved_folder_follows() {
        let home = FakeHome::new();
        let root = home.path().join("nb");
        let nb = create_in_folder(&root, "Notes").unwrap();
        {
            let db = nb.open_db().unwrap();
            db.create_page("Hello", None, false, None, "user").unwrap();
        }
        acquire_lock(&nb.lock_path(), false).unwrap();
        let copy = home.path().join("nb copy");
        copy_dir_all(&root, &copy).unwrap();
        let c = open_folder(&copy).unwrap();
        assert_ne!(c.key, nb.key, "a copy is a separate notebook");
        assert_eq!(c.name, "Notes 2");
        assert_eq!(Registry::load().notebooks.len(), 2);
        assert!(!copy.join(PRIVATE_DIR).join(LOCK_FILE).exists(), "the original's lock stays behind");
        assert_eq!(c.open_db().unwrap().list_pages(None).unwrap().len(), 1);

        // Moving (not copying) the original: the registry follows.
        let moved = home.path().join("elsewhere");
        fs::rename(&root, &moved).unwrap();
        assert!(!resolve(&nb.key).unwrap().available(), "missing folder → unavailable");
        assert!(list().iter().any(|n| n.key == nb.key && !n.available));
        let again = open_folder(&moved).unwrap();
        assert_eq!(again.key, nb.key);
        assert!(again.available());
    }

    #[test]
    fn test_missing_folder_is_never_recreated_and_locate_fixes_it() {
        let home = FakeHome::new();
        let root = home.path().join("drive").join("Book");
        let nb = create_in_folder(&root, "Book").unwrap();
        let unplugged = home.path().join("drive-unplugged");
        fs::rename(home.path().join("drive"), &unplugged).unwrap();

        let r = resolve(&nb.key).unwrap();
        assert!(!r.available());
        assert!(r.open_db().is_err(), "opening a missing notebook must fail");
        assert!(!root.exists(), "and must not create an empty one");
        let info = list().into_iter().find(|n| n.key == nb.key).unwrap();
        assert!(!info.available);

        // Locate: a folder with a different notebook is refused; the right one works.
        let other = create_in_folder(&home.path().join("other"), "Other").unwrap();
        assert!(locate(&nb.key, other.root().unwrap()).is_err());
        let found = locate(&nb.key, &unplugged.join("Book")).unwrap();
        assert!(found.available());
        assert_eq!(found.key, nb.key);
        assert!(found.open_db().is_ok());
    }

    #[test]
    fn test_lock_file_second_opener_and_stale_locks() {
        let home = FakeHome::new();
        let nb = create_in_folder(&home.path().join("L"), "L").unwrap();
        let lock = nb.lock_path();
        assert_eq!(acquire_lock(&lock, false).unwrap(), LockStatus::Acquired);
        // Re-acquiring our own lock is fine.
        assert_eq!(acquire_lock(&lock, false).unwrap(), LockStatus::Acquired);

        // Another live instance on this host holds it → second opener is refused.
        let other = LockInfo {
            pid: std::process::id(), // alive
            host: hostname(),
            instance: "someone-else".into(),
            opened_at: chrono::Utc::now().to_rfc3339(),
            root: lock_root(&lock),
        };
        write_json_atomic(&lock, &other).unwrap();
        match acquire_lock(&lock, false).unwrap() {
            LockStatus::HeldByOther(i) => assert_eq!(i.instance, "someone-else"),
            s => panic!("expected held, got {s:?}"),
        }
        // Our release must not remove someone else's lock.
        release_lock(&lock);
        assert!(lock.exists());

        // A dead process's lock is stale.
        let dead = LockInfo { pid: 0x7fff_fff0, ..other.clone() };
        write_json_atomic(&lock, &dead).unwrap();
        assert_eq!(acquire_lock(&lock, false).unwrap(), LockStatus::Acquired);

        // Another host: held (can't tell if it's alive) unless forced.
        let remote = LockInfo { host: "far-away-host".into(), ..other };
        write_json_atomic(&lock, &remote).unwrap();
        assert!(matches!(acquire_lock(&lock, false).unwrap(), LockStatus::HeldByOther(_)));
        assert_eq!(acquire_lock(&lock, true).unwrap(), LockStatus::Acquired);
        release_lock(&lock);
        assert!(!lock.exists());
    }

    #[test]
    fn test_read_only_open_reads_but_never_writes() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join(DB_FILE);
        {
            let db = Database::open(&path).unwrap();
            db.create_page("Readable", None, false, None, "user").unwrap();
        }
        let ro = Database::open_read_only(&path).unwrap();
        assert!(ro.is_read_only());
        assert!(ro.get_page_by_title("Readable").unwrap().is_some());
        assert!(ro.create_page("Nope", None, false, None, "user").is_err());
        let rw = Database::open(&path).unwrap();
        assert!(!rw.is_read_only());
        assert!(rw.get_page_by_title("Nope").unwrap().is_none());
    }

    #[test]
    fn test_cloud_and_conflicted_copies() {
        assert_eq!(cloud_service(Path::new("/home/u/Dropbox/Notes")), Some("Dropbox"));
        assert_eq!(
            cloud_service(Path::new("/Users/u/Library/Mobile Documents/com~apple~CloudDocs/N")),
            Some("iCloud Drive")
        );
        assert_eq!(cloud_service(Path::new("/c/Users/u/OneDrive - Acme/N")), Some("OneDrive"));
        assert_eq!(cloud_service(Path::new("/home/u/MiNotes/Work")), None);
        let d = tempfile::tempdir().unwrap();
        for f in [DB_FILE, "notebook (conflicted copy).minotes", "notebook 2.minotes", "notebook.json", "other.minotes"] {
            fs::write(d.path().join(f), "x").unwrap();
        }
        assert_eq!(
            conflicted_copies(d.path()),
            vec!["notebook (conflicted copy).minotes".to_string(), "notebook 2.minotes".to_string()]
        );
    }

    #[test]
    fn test_rename_and_delete() {
        let home = FakeHome::new();
        crate::repo::legacy_notebooks::create(&base_dir(), "default").unwrap();
        crate::repo::legacy_notebooks::create(&base_dir(), "work").unwrap();
        let nb = create_in_folder(&home.path().join("F"), "Folder Book").unwrap();

        rename("work", "Work Stuff").unwrap();
        assert_eq!(resolve("work").unwrap().name, "Work Stuff");
        assert!(rename("work", "Folder Book").is_err(), "names stay unique");
        rename(&nb.key, "Renamed").unwrap();
        assert_eq!(read_meta(nb.root().unwrap()).unwrap().name, "Renamed");

        assert!(delete("default", "default").is_err(), "the open notebook can't be deleted");
        fs::create_dir_all(nb.mirror_dir()).unwrap();
        fs::write(nb.mirror_dir().join("Kept.md"), "- kept").unwrap();
        delete(&nb.key, "default").unwrap();
        assert!(!nb.db_path().exists());
        assert!(nb.mirror_dir().join("Kept.md").exists(), "the markdown copy is kept");
        assert!(Registry::load().find(&nb.key).is_none());
        delete("work", "default").unwrap();
        assert!(!base_dir().join("work.db").exists());
        assert_eq!(list().len(), 1);
    }

    fn legacy_with_content(name: &str) -> (Notebook, Database) {
        let nb = Notebook::legacy(name);
        let db = Database::open(&nb.db_path()).unwrap();
        let p = db.create_page("Kept Page", None, false, None, "user").unwrap();
        let b = db.create_block(&p.id, "with [[Other]] link", None, None, "user").unwrap();
        db.set_property(&b.id, "block", "k", "v", "text", "user").unwrap();
        db.save_whiteboard("wb-1", "{\"a\":1}").unwrap();
        // Mirror with a git dir inside.
        let m = nb.mirror_dir();
        fs::create_dir_all(m.join(".git")).unwrap();
        fs::write(m.join(".git").join("HEAD"), "ref: refs/heads/main\n").unwrap();
        fs::write(m.join("Kept Page.md"), "---\n---\n").unwrap();
        fs::write(nb.sync_config_path(), "{\"enabled\":true}").unwrap();
        (nb, db)
    }

    #[test]
    fn test_move_legacy_to_folder_verifies_and_finishes() {
        let home = FakeHome::new();
        let (src, db) = legacy_with_content("work");
        let dest = home.path().join("MiNotes").join("Work");
        let mv = prepare_move_to_folder(&db, &src, &dest, None).unwrap();
        assert!(mv.row_counts.get("pages").copied().unwrap_or(0) >= 1);
        // Copied and verified, old files still in place.
        assert!(src.db_path().exists());
        assert!(dest.join(DB_FILE).is_file());
        assert!(dest.join(NOTES_DIR).join(".git").join("HEAD").is_file(), ".git travels with the mirror");
        assert!(dest.join(PRIVATE_DIR).join("sync-config.json").is_file());
        drop(db); // the app switches its connection before finishing
        let nb = mv.finish().unwrap();
        assert!(!src.db_path().exists(), "old database removed only at the end");
        assert!(!src.mirror_dir().exists());
        assert!(!src.sync_config_path().exists());
        let db2 = nb.open_db().unwrap();
        let p = db2.get_page_by_title("Kept Page").unwrap().unwrap();
        assert_eq!(db2.get_page_blocks(&p.id).unwrap().len(), 1);
        assert!(db2.get_whiteboard("wb-1").unwrap().is_some());
        assert_eq!(resolve(&nb.key).unwrap().name, "work");
        assert!(list().iter().all(|n| n.kind == "folder"));
    }

    #[test]
    fn test_move_legacy_to_folder_rolls_back_on_failure() {
        for step in [MoveStep::CopyDatabase, MoveStep::Verify, MoveStep::Describe, MoveStep::MoveMirror, MoveStep::Register] {
            let home = FakeHome::new();
            let (src, db) = legacy_with_content("default");
            let before = table_row_counts(&db.conn).unwrap();
            let dest = home.path().join("Target");
            let err = prepare_move_to_folder(&db, &src, &dest, Some(step)).unwrap_err();
            assert!(err.to_string().contains("injected"), "{err}");
            assert!(!dest.exists(), "{step:?}: destination cleaned up");
            assert!(src.mirror_dir().join(".git").join("HEAD").is_file(), "{step:?}: mirror back in place");
            assert!(src.sync_config_path().is_file());
            assert!(Registry::load().notebooks.is_empty(), "{step:?}: not registered");
            assert_eq!(table_row_counts(&db.conn).unwrap(), before, "{step:?}: source untouched");
            assert_eq!(list().len(), 1);
        }
    }

    #[test]
    fn test_verify_detects_a_bad_copy() {
        let d = tempfile::tempdir().unwrap();
        let a = Database::open(&d.path().join("a.db")).unwrap();
        a.create_page("One", None, false, None, "user").unwrap();
        let counts = table_row_counts(&a.conn).unwrap();
        let b_path = d.path().join("b.db");
        a.conn.execute("VACUUM INTO ?1", [b_path.to_string_lossy().to_string()]).unwrap();
        verify_copy(&b_path, &counts).unwrap();
        let b = Database::open(&b_path).unwrap();
        b.create_page("Extra", None, false, None, "user").unwrap();
        drop(b);
        let err = verify_copy(&b_path, &counts).unwrap_err().to_string();
        assert!(err.contains("pages"), "{err}");
    }
}
