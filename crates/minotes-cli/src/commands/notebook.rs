//! Notebooks: which database a command opens (`--notebook <name|folder|path>`,
//! default = the desktop app's active notebook) and `minotes notebook …`.
//!
//! A notebook is either a folder (`<folder>/notebook.minotes`, registered in
//! `~/.minotes/notebooks.json`) or a legacy database `~/.minotes/<name>.db`.

use std::path::{Path, PathBuf};

use clap::Subcommand;
use minotes_core::error::Error;
use minotes_core::notebook::{self, NotebookInfo};

use crate::output::{print_error, print_json, Format};

#[derive(Subcommand)]
pub enum NotebookCmd {
    /// List known notebooks (name, kind, location, availability)
    List,
    /// Show the desktop app's open notebook (what commands use by default)
    Current,
    /// Create a notebook in a folder (default ~/MiNotes/<name>); does not switch the app
    Create {
        /// Notebook name (letters, numbers, spaces, - or _; no dots or slashes)
        name: String,
        /// Folder to create it in (must not exist yet, or be empty)
        #[arg(long)]
        location: Option<String>,
    },
    /// Register an existing notebook folder (like "Open notebook…" in the app)
    Open {
        /// The notebook folder (the one holding notebook.minotes)
        folder: String,
    },
    /// Rename a notebook (its folder and files keep their names)
    Rename {
        /// Notebook name or id
        notebook: String,
        /// New name
        new_name: String,
    },
    /// Delete a notebook's database (the markdown copy is kept). Refused for the
    /// app's open notebook.
    Delete {
        /// Notebook name or id
        notebook: String,
        /// Confirm the deletion
        #[arg(long)]
        yes: bool,
    },
}

/// Expand a leading `~` / `~/` to $HOME.
pub fn expand_tilde(p: &str) -> PathBuf {
    if p == "~" {
        return notebook::home_dir();
    }
    match p.strip_prefix("~/") {
        Some(rest) => notebook::home_dir().join(rest),
        None => PathBuf::from(p),
    }
}

fn home_set() -> bool {
    std::env::var_os("HOME").is_some_and(|h| !h.is_empty())
}

/// The app's open notebook key: `~/.minotes/active_graph` (the on-disk name is
/// kept for compatibility) holds a legacy name or a folder notebook's id.
pub fn active_key() -> String {
    std::fs::read_to_string(notebook::home_dir().join(".minotes").join("active_graph"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "default".to_string())
}

/// The desktop app's active notebook database. A legacy notebook may be created
/// on demand (like the app does); a folder notebook is never silently recreated.
fn default_db_path() -> Result<(PathBuf, bool), String> {
    if !home_set() {
        return Err("HOME is not set; pass --notebook <name|folder|path>".into());
    }
    let key = active_key();
    match notebook::resolve(&key) {
        Ok(nb) if nb.is_folder() => {
            if !nb.available() {
                return Err(format!(
                    "The app's notebook '{}' is unavailable ({} not found)",
                    nb.name,
                    nb.db_path().display()
                ));
            }
            Ok((nb.db_path(), false))
        }
        _ => Ok((notebook::base_dir().join(format!("{key}.db")), true)),
    }
}

/// A `--notebook` value that is clearly a filesystem path rather than a name.
fn looks_like_path(s: &str) -> bool {
    s.contains(['/', '\\'])
        || s.starts_with('~')
        || s.starts_with('.')
        || s.ends_with(".db")
        || s.ends_with(".minotes")
}

/// Open a path: a notebook folder means its notebook.minotes; a database file
/// must exist unless `create` is given.
pub fn resolve_path(p: &str, create: bool) -> Result<PathBuf, String> {
    let path = expand_tilde(p);
    if path.is_dir() {
        if !path.join(notebook::DB_FILE).is_file() {
            return Err(format!(
                "{} is a folder but not a MiNotes notebook (no {} inside)",
                path.display(),
                notebook::DB_FILE
            ));
        }
        return Ok(path.join(notebook::DB_FILE));
    }
    ensure_db(path, create)
}

fn ensure_db(path: PathBuf, may_create: bool) -> Result<PathBuf, String> {
    if !path.exists() {
        if !may_create {
            return Err(format!(
                "Notebook database not found: {} (pass --create to create a new notebook database there)",
                path.display()
            ));
        }
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create directory {}: {e}", parent.display()))?;
        }
    }
    Ok(path)
}

/// Resolve `--notebook <sel>`: a registered notebook name (or id), a notebook
/// folder, or a `.db` path. `None` = the app's active notebook.
pub fn resolve_selector(sel: Option<&str>, create: bool) -> Result<PathBuf, String> {
    let Some(sel) = sel else {
        let (path, may_create) = default_db_path()?;
        return ensure_db(path, may_create);
    };
    if !looks_like_path(sel) {
        match notebook::find_by_name(sel) {
            Ok(nb) => {
                if !nb.available() {
                    return Err(format!(
                        "Notebook '{}' is unavailable ({} not found)",
                        nb.name,
                        nb.db_path().display()
                    ));
                }
                return Ok(nb.db_path());
            }
            // Not a name: maybe a file or folder in the current directory.
            Err(Error::NotFound(_)) if Path::new(sel).exists() => {}
            Err(Error::NotFound(_)) => {
                return Err(format!(
                    "No notebook named '{sel}' (see `minotes notebook list`; create one with `minotes notebook create \"{sel}\"`)"
                ));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    resolve_path(sel, create)
}

/// A notebook named (or keyed) `sel`, for the management commands.
fn find(sel: &str) -> Result<notebook::Notebook, String> {
    notebook::find_by_name(sel).map_err(|e| e.to_string())
}

fn print_info(info: &NotebookInfo, fmt: &Format) {
    match fmt {
        Format::Text | Format::Md => println!(
            "{}\t{}\t{}{}",
            info.name,
            info.kind,
            info.path,
            if info.available { "" } else { "\t(unavailable)" }
        ),
        _ => print_json(info),
    }
}

/// `minotes notebook [cmd]` (no subcommand = list). Never opens a database
/// other than the one it creates.
pub fn run(cmd: Option<NotebookCmd>, fmt: &Format) -> i32 {
    let r: Result<(), String> = match cmd.unwrap_or(NotebookCmd::List) {
        NotebookCmd::List => {
            let list = notebook::list();
            match fmt {
                Format::Text | Format::Md => list.iter().for_each(|n| print_info(n, fmt)),
                _ => print_json(&serde_json::json!({ "notebooks": list, "count": list.len() })),
            }
            Ok(())
        }
        NotebookCmd::Current => notebook::resolve(&active_key())
            .map(|nb| print_info(&notebook::info(&nb), fmt))
            .map_err(|e| e.to_string()),
        NotebookCmd::Create { name, location } => (|| {
            let name = name.trim().to_string();
            notebook::validate_name(&name).map_err(|e| e.to_string())?;
            let dir = match location.as_deref().map(str::trim).filter(|l| !l.is_empty()) {
                Some(l) => expand_tilde(l),
                None => notebook::default_location(&name),
            };
            let nb = notebook::create_in_folder(&dir, &name).map_err(|e| e.to_string())?;
            print_info(&notebook::info(&nb), fmt);
            Ok(())
        })(),
        NotebookCmd::Open { folder } => notebook::open_folder(&expand_tilde(&folder))
            .map(|nb| print_info(&notebook::info(&nb), fmt))
            .map_err(|e| e.to_string()),
        NotebookCmd::Rename { notebook: sel, new_name } => find(&sel).and_then(|nb| {
            let nb = notebook::rename(&nb.key, new_name.trim()).map_err(|e| e.to_string())?;
            print_info(&notebook::info(&nb), fmt);
            Ok(())
        }),
        NotebookCmd::Delete { notebook: sel, yes } => find(&sel).and_then(|nb| {
            if !yes {
                return Err(format!(
                    "Deleting notebook '{}' removes its database; pass --yes to confirm",
                    nb.name
                ));
            }
            notebook::delete(&nb.key, &active_key()).map_err(|e| e.to_string())?;
            print_json(&serde_json::json!({ "message": format!("Deleted notebook '{}'", nb.name), "key": nb.key }));
            Ok(())
        }),
    };
    match r {
        Ok(()) => 0,
        Err(e) => {
            print_error(&e);
            1
        }
    }
}
