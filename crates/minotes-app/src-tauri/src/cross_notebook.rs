//! Cross-notebook search and `[[Notebook::Page]]` links (see
//! `minotes_core::cross_notebook`). Other notebooks are only ever opened
//! read-only, off the UI thread (async commands + `spawn_blocking`), and never
//! through the notebook lock.

use std::path::PathBuf;

use minotes_core::cross_notebook::{self, CrossSearch, LinkRef, LinkTarget, PageHit, SearchOptions};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::AppState;

/// The open notebook's database file and whether this window has it read-only.
fn current(state: &AppState) -> Result<(PathBuf, bool), String> {
    let s = state.session.lock().map_err(|e| e.to_string())?;
    Ok((s.notebook.db_path(), s.held_by.is_some()))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

/// Search every notebook except the open one (the frontend searches that one
/// itself and lists it first). Capped per notebook and in total time.
#[tauri::command]
pub async fn search_other_notebooks(
    state: State<'_, AppState>,
    query: String,
    per_notebook: Option<i64>,
) -> Result<CrossSearch, String> {
    let (db_path, _) = current(&state)?;
    let opts = SearchOptions {
        per_notebook: per_notebook.unwrap_or(cross_notebook::DEFAULT_PER_NOTEBOOK).clamp(1, 50),
        ..Default::default()
    };
    blocking(move || cross_notebook::search_other_notebooks(Some(&db_path), &query, &opts)).await
}

/// Resolve `[[Notebook::Page]]` links for display/navigation. Newly resolved
/// targets are remembered (`notebook_links`) unless this window is read-only.
#[tauri::command]
pub async fn resolve_notebook_links(app: AppHandle, links: Vec<LinkRef>) -> Result<Vec<LinkTarget>, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let (db_path, read_only) = current(&state)?;
        let db = state.db_guard()?;
        Ok(cross_notebook::resolve_links(&db, Some(&db_path), &links, !read_only))
    })
    .await?
}

#[derive(Serialize)]
pub struct NotebookPages {
    pub notebook_key: String,
    pub notebook_name: String,
    pub current: bool,
    pub pages: Vec<PageHit>,
}

/// Page titles of a notebook named `notebook` (link autocomplete after
/// `[[Work::`), read-only. Unknown or unreadable notebook: an error.
#[tauri::command]
pub async fn list_notebook_pages(
    state: State<'_, AppState>,
    notebook: String,
    query: String,
    limit: Option<i64>,
) -> Result<NotebookPages, String> {
    let (db_path, _) = current(&state)?;
    let limit = limit.unwrap_or(8).clamp(1, 50);
    blocking(move || {
        let nb = cross_notebook::find_notebook_by_name(&notebook)
            .ok_or_else(|| format!("No notebook named \u{201c}{notebook}\u{201d}"))?;
        let pages = cross_notebook::notebook_pages(&nb, &query, limit)
            .map_err(|s| format!("Notebook \u{201c}{}\u{201d} is {}", s.notebook_name, s.label))?;
        Ok(NotebookPages {
            current: cross_notebook::same_file(&nb.db_path(), &db_path),
            notebook_key: nb.key,
            notebook_name: nb.name,
            pages,
        })
    })
    .await?
}
