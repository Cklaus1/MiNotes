//! What this platform can do with notebooks, and where its data lives.
//!
//! Desktop keeps the user's home layout. Android keeps everything in the app's
//! private data dir (see `minotes_core::notebook` — "Where things live"): no
//! folder picking, revealing or outside editing; notebooks travel as zip copies
//! through the system picker. The frontend asks `get_platform_capabilities`
//! instead of sniffing the user agent.

use minotes_core::notebook;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct PlatformCapabilities {
    /// `std::env::consts::OS`: "linux", "macos", "windows", "android", "ios".
    pub platform: &'static str,
    pub mobile: bool,
    /// Notebooks live in app-private storage (no user-visible folders).
    pub app_storage: bool,
    /// "New notebook…" can put a notebook in a folder the user picks.
    pub choose_location: bool,
    /// "Open notebook…" from a folder, and "Locate…" for a missing one.
    pub open_folder: bool,
    /// "Open folder" / reveal a notebook's files in the file manager.
    pub reveal_folder: bool,
    /// "Move notebook to a folder…" for app-data notebooks.
    pub move_to_folder: bool,
    /// Edits made to the markdown copy by other apps are watched and imported.
    pub outside_edits: bool,
    /// The markdown copy is kept for every notebook (false: only with git sync).
    pub mirror_always: bool,
    /// Import from Obsidian / Evernote / markdown folders (needs real file paths).
    pub import_from_files: bool,
    /// The AI key can be kept in an OS keychain.
    pub keychain: bool,
    /// Export / import a whole notebook as a .zip.
    pub notebook_zip: bool,
}

pub fn capabilities() -> PlatformCapabilities {
    let app = notebook::is_app_storage();
    PlatformCapabilities {
        platform: std::env::consts::OS,
        mobile: cfg!(mobile),
        app_storage: app,
        choose_location: !app,
        open_folder: !app,
        reveal_folder: !app,
        move_to_folder: !app,
        outside_edits: !app,
        mirror_always: !app,
        import_from_files: !app,
        keychain: !cfg!(target_os = "android"),
        notebook_zip: true,
    }
}

#[tauri::command]
pub fn get_platform_capabilities() -> PlatformCapabilities {
    capabilities()
}

/// Refuse a desktop-only notebook action in app storage.
pub fn require_folders(what: &str) -> Result<(), String> {
    if notebook::is_app_storage() {
        return Err(format!("{what} is not available on this device: notebooks live in the app's own storage"));
    }
    Ok(())
}

/// Mobile: put everything in the app's private data dir before anything
/// resolves a path, and give SQLite (VACUUM INTO, big sorts) and our staging
/// a writable temp dir — Android has no writable /tmp.
#[cfg(mobile)]
pub fn init_app_storage(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::Manager;
    let data = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data)?;
    if let Ok(cache) = app.path().app_cache_dir() {
        if std::fs::create_dir_all(&cache).is_ok() {
            std::env::set_var("TMPDIR", &cache);
            std::env::set_var("SQLITE_TMPDIR", &cache);
        }
    }
    notebook::set_app_storage(Some(data));
    Ok(())
}
