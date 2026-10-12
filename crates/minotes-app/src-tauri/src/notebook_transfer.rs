//! "Export notebook…" / "Import notebook…": a whole notebook as one .zip
//! (minotes-core `notebook_zip`), through the system save / open picker.
//!
//! On Android the picker hands out `content://` URIs: the archive is built in
//! the app's cache dir and copied to / from the URI with the fs plugin — the
//! database itself never lives behind a URI. On desktop the zip is written
//! straight to the chosen path (temp file + rename).

use std::path::{Component, Path, PathBuf};

use minotes_core::db::Database;
use minotes_core::notebook::{self, NotebookInfo};
use minotes_core::notebook_zip::{self, ImportLimits};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, FilePath};

use crate::{security, AppState};

#[derive(Debug, Serialize)]
pub struct ZipExportOut {
    /// Where it was saved (a path, or the picker's URI on Android).
    pub path: String,
    pub name: String,
    pub pages: usize,
    pub attachments: usize,
    pub bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct ZipImportOut {
    pub notebook: NotebookInfo,
    pub pages: usize,
    pub attachments: usize,
    /// Attachments left out because their content did not match their name.
    pub skipped: Vec<String>,
    /// The archive's name was taken here; the notebook got `notebook.name`.
    pub renamed_from: Option<String>,
}

/// Scratch space for building / receiving archives (the app's cache dir).
fn staging_parent(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_cache_dir().unwrap_or_else(|_| std::env::temp_dir());
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn home_roots() -> Vec<PathBuf> {
    let mut roots = vec![notebook::home_dir()];
    if let Some(w) = crate::wsl_windows_profile() {
        roots.push(w);
    }
    roots
}

/// An explicit destination (scripts, tests): a new `.zip` file in a folder the
/// app may write to (inside home or on an external drive, not a hidden one).
fn validate_zip_dest(dest: &str) -> Result<PathBuf, String> {
    let p = Path::new(dest.trim());
    if !p.is_absolute() || p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("The export path must be an absolute path without '..'".into());
    }
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if !name.to_lowercase().ends_with(".zip") || name.starts_with('.') {
        return Err("The export file must be a .zip".into());
    }
    if p.exists() {
        return Err(format!("{} already exists", p.display()));
    }
    let parent = p.parent().ok_or("No folder in the export path")?;
    if !parent.is_dir() {
        return Err(format!("{} is not a folder", parent.display()));
    }
    let parent = security::validate_notebook_dir(&parent.to_string_lossy(), &home_roots())?;
    Ok(parent.join(name))
}

enum Target {
    Path(PathBuf),
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    Uri(FilePath),
}

/// Write a .zip of a notebook (default: the open one). `dest` skips the save
/// dialog (scripts and tests); otherwise the user picks where. `None` when the
/// dialog was cancelled.
#[tauri::command(async)]
pub fn export_notebook_zip(
    app: AppHandle,
    state: State<'_, AppState>,
    key: Option<String>,
    dest: Option<String>,
) -> Result<Option<ZipExportOut>, String> {
    let open = state.session.lock().map_err(|e| e.to_string())?.notebook.clone();
    let nb = match key.filter(|k| *k != open.key) {
        Some(k) => notebook::resolve(&k).map_err(|e| e.to_string())?,
        None => open.clone(),
    };
    if !nb.available() {
        return Err(format!("Notebook \u{201c}{}\u{201d} is unavailable", nb.name));
    }
    let suggested = notebook_zip::suggested_file_name(&nb.name);
    let target = match dest.filter(|d| !d.trim().is_empty()) {
        Some(d) => Target::Path(validate_zip_dest(&d)?),
        None => {
            let mut dialog = app.dialog().file().set_file_name(&suggested).add_filter("MiNotes notebook (.zip)", &["zip"]);
            if !notebook::is_app_storage() {
                if let Some(home) = crate::dirs_next() {
                    dialog = dialog.set_directory(home);
                }
            }
            let Some(chosen) = dialog.blocking_save_file() else { return Ok(None) };
            match chosen {
                FilePath::Path(p) => Target::Path(p),
                FilePath::Url(u) if u.scheme() == "file" => {
                    Target::Path(u.to_file_path().map_err(|_| "Unusable file location".to_string())?)
                }
                other => Target::Uri(other),
            }
        }
    };

    let staging = notebook_zip::staging_dir(&staging_parent(&app)).map_err(|e| e.to_string())?;
    let res = (|| -> Result<ZipExportOut, String> {
        // A consistent snapshot, holding the database only for VACUUM INTO.
        let (snap, attachments) = if nb.key == open.key {
            let db = state.db.lock().map_err(|e| e.to_string())?;
            (notebook_zip::snapshot(&db.conn, &staging).map_err(|e| e.to_string())?, notebook_zip::attachments_of(&db.conn))
        } else {
            let db = Database::open_read_only(&nb.db_path()).map_err(|e| e.to_string())?;
            (notebook_zip::snapshot(&db.conn, &staging).map_err(|e| e.to_string())?, notebook_zip::attachments_of(&db.conn))
        };
        let meta = notebook_zip::export_meta(&nb);
        let (summary, shown) = match target {
            Target::Path(p) => {
                let s = notebook_zip::write_snapshot_to_file(&snap, &meta, attachments.as_deref(), &staging, &p)
                    .map_err(|e| e.to_string())?;
                (s, p.display().to_string())
            }
            Target::Uri(uri) => {
                let zip = staging.join(&suggested);
                let s = notebook_zip::write_snapshot_to_file(&snap, &meta, attachments.as_deref(), &staging, &zip)
                    .map_err(|e| e.to_string())?;
                let shown = uri.to_string();
                copy_to_uri(&app, uri, &zip)?;
                (s, shown)
            }
        };
        Ok(ZipExportOut {
            path: shown,
            name: summary.name,
            pages: summary.pages,
            attachments: summary.attachments,
            bytes: summary.bytes,
        })
    })();
    let _ = std::fs::remove_dir_all(&staging);
    res.map(Some)
}

/// Import a notebook .zip as a new notebook (never over an existing one).
/// `source` is what the open picker returned: a path, or on Android a
/// `content://` URI. Does not switch to it.
#[tauri::command(async)]
pub fn import_notebook_zip(app: AppHandle, source: String) -> Result<ZipImportOut, String> {
    let limits = ImportLimits::default();
    let source = source.trim().to_string();
    let staging = notebook_zip::staging_dir(&staging_parent(&app)).map_err(|e| e.to_string())?;
    let res = (|| -> Result<ZipImportOut, String> {
        let zip_path = if source.starts_with("content://") {
            let local = staging.join("import.zip");
            copy_from_uri(&app, &source, &local, limits.max_total_bytes)?;
            local
        } else {
            validate_zip_source(&source, &limits)?
        };
        let out = notebook_zip::import_zip(&zip_path, &limits).map_err(|e| e.to_string())?;
        Ok(ZipImportOut {
            notebook: notebook::info(&out.notebook),
            pages: out.pages,
            attachments: out.attachments,
            skipped: out.skipped,
            renamed_from: out.renamed_from,
        })
    })();
    let _ = std::fs::remove_dir_all(&staging);
    res
}

/// A regular `.zip` file, given by absolute path (what the open dialog returns
/// on desktop). Reading it is harmless: anything but a valid notebook archive
/// is refused by the importer.
fn validate_zip_source(source: &str, limits: &ImportLimits) -> Result<PathBuf, String> {
    let p = Path::new(source);
    if source.is_empty() || source.contains('\0') || !p.is_absolute() {
        return Err("Choose a .zip file".into());
    }
    let canon = std::fs::canonicalize(p).map_err(|e| format!("Cannot open {source}: {e}"))?;
    let meta = std::fs::metadata(&canon).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err(format!("{source} is not a file"));
    }
    if !canon.extension().map(|e| e.eq_ignore_ascii_case("zip")).unwrap_or(false) {
        return Err("Choose a MiNotes notebook .zip".into());
    }
    if meta.len() > limits.max_total_bytes {
        return Err("That archive is too large to import".into());
    }
    Ok(canon)
}

#[cfg(target_os = "android")]
fn copy_to_uri(app: &AppHandle, uri: FilePath, src: &Path) -> Result<(), String> {
    use tauri_plugin_fs::{FsExt, OpenOptions};
    let mut opts = OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    let mut out = app.fs().open(uri, opts).map_err(|e| format!("Cannot write the chosen file: {e}"))?;
    let mut f = std::fs::File::open(src).map_err(|e| e.to_string())?;
    std::io::copy(&mut f, &mut out).map_err(|e| format!("Cannot write the chosen file: {e}"))?;
    let _ = out.sync_all();
    Ok(())
}

#[cfg(not(target_os = "android"))]
fn copy_to_uri(_app: &AppHandle, uri: FilePath, _src: &Path) -> Result<(), String> {
    Err(format!("Cannot save to {uri}"))
}

#[cfg(target_os = "android")]
fn copy_from_uri(app: &AppHandle, uri: &str, dest: &Path, max: u64) -> Result<(), String> {
    use std::io::Read;
    use std::str::FromStr;
    use tauri_plugin_fs::{FsExt, OpenOptions};
    let fp = FilePath::from_str(uri).map_err(|e| e.to_string())?;
    let mut opts = OpenOptions::new();
    opts.read(true);
    let f = app.fs().open(fp, opts).map_err(|e| format!("Cannot read the chosen file: {e}"))?;
    let mut out = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    let n = std::io::copy(&mut f.take(max + 1), &mut out).map_err(|e| format!("Cannot read the chosen file: {e}"))?;
    if n > max {
        return Err("That archive is too large to import".into());
    }
    Ok(())
}

#[cfg(not(target_os = "android"))]
fn copy_from_uri(_app: &AppHandle, uri: &str, _dest: &Path, _max: u64) -> Result<(), String> {
    Err(format!("Cannot open {uri}: choose a file on this computer"))
}
