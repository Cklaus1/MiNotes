use std::path::PathBuf;
use std::sync::Mutex;

use minotes_core::db::Database;
use minotes_core::models::{Block, Page, PageTree, Property};
use minotes_core::repo::graph::GraphStats;
use serde::Serialize;
use tauri::State;

struct AppState {
    db: Mutex<Database>,
}

fn db_path() -> PathBuf {
    let home = dirs_next().unwrap_or_else(|| PathBuf::from("."));
    let dir = home.join(".minotes");
    std::fs::create_dir_all(&dir).ok();
    dir.join("default.db")
}

fn dirs_next() -> Option<PathBuf> {
    std::env::var("HOME").ok().map(PathBuf::from)
}

#[derive(Debug, Serialize)]
struct Link {
    id: String,
    from_block: String,
    to_page: Option<String>,
    link_type: String,
}

// ── Tauri Commands ──

#[tauri::command]
fn list_pages(state: State<'_, AppState>, limit: Option<i64>) -> Result<Vec<Page>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.list_pages(limit).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_page_tree(state: State<'_, AppState>, title_or_id: String) -> Result<PageTree, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;

    let page = if let Ok(uuid) = uuid::Uuid::parse_str(&title_or_id) {
        db.get_page(&uuid).map_err(|e| e.to_string())?
    } else {
        db.get_page_by_title(&title_or_id).map_err(|e| e.to_string())?
    };

    let page = page.ok_or_else(|| format!("Page not found: {title_or_id}"))?;
    let blocks = db.get_page_blocks(&page.id).map_err(|e| e.to_string())?;
    Ok(PageTree { page, blocks })
}

#[tauri::command]
fn create_page(state: State<'_, AppState>, title: String) -> Result<Page, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.create_page(&title, None, false, None, "user")
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_page(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let uuid = uuid::Uuid::parse_str(&id).map_err(|e| e.to_string())?;
    db.delete_page(&uuid, "user").map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_page(state: State<'_, AppState>, id: String, new_title: String) -> Result<Page, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let uuid = uuid::Uuid::parse_str(&id).map_err(|e| e.to_string())?;
    db.rename_page(&uuid, &new_title, "user")
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn create_block(
    state: State<'_, AppState>,
    page_id: String,
    content: String,
    parent_id: Option<String>,
) -> Result<Block, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let page_uuid = uuid::Uuid::parse_str(&page_id).map_err(|e| e.to_string())?;
    let parent_uuid = parent_id
        .as_ref()
        .map(|p| uuid::Uuid::parse_str(p))
        .transpose()
        .map_err(|e| e.to_string())?;
    db.create_block(&page_uuid, &content, parent_uuid.as_ref(), None, "user")
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn update_block(state: State<'_, AppState>, id: String, content: String) -> Result<Block, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let uuid = uuid::Uuid::parse_str(&id).map_err(|e| e.to_string())?;
    db.update_block(&uuid, Some(&content), "user")
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_block(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let uuid = uuid::Uuid::parse_str(&id).map_err(|e| e.to_string())?;
    db.delete_block(&uuid, "user").map_err(|e| e.to_string())
}

#[tauri::command]
fn search_blocks(state: State<'_, AppState>, query: String, limit: Option<i64>) -> Result<Vec<Block>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.search(&query, limit).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_backlinks(state: State<'_, AppState>, page_id: String) -> Result<Vec<Link>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let uuid = uuid::Uuid::parse_str(&page_id).map_err(|e| e.to_string())?;
    let links = db.get_backlinks(&uuid).map_err(|e| e.to_string())?;
    Ok(links
        .into_iter()
        .map(|l| Link {
            id: l.id.to_string(),
            from_block: l.from_block.to_string(),
            to_page: l.to_page.map(|p| p.to_string()),
            link_type: l.link_type,
        })
        .collect())
}

#[tauri::command]
fn get_graph_stats(state: State<'_, AppState>) -> Result<GraphStats, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_graph_stats().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_journal(state: State<'_, AppState>, date: Option<String>) -> Result<PageTree, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let d = match date {
        Some(ref s) => chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
            .map_err(|e| format!("Invalid date: {e}"))?,
        None => chrono::Local::now().date_naive(),
    };
    let title = format!("Journal/{}", d);
    let page = match db.get_page_by_title(&title).map_err(|e| e.to_string())? {
        Some(p) => p,
        None => db
            .create_page(&title, None, true, Some(d), "user")
            .map_err(|e| e.to_string())?,
    };
    let blocks = db.get_page_blocks(&page.id).map_err(|e| e.to_string())?;
    Ok(PageTree { page, blocks })
}

// ── Folder Commands ──

#[tauri::command]
fn get_folder_tree(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let tree = db.get_folder_tree().map_err(|e| e.to_string())?;
    let root_pages = db.get_pages_in_folder(None).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "folders": tree,
        "root_pages": root_pages,
    }))
}

#[tauri::command]
fn create_folder(
    state: State<'_, AppState>,
    name: String,
    parent_id: Option<String>,
) -> Result<minotes_core::models::Folder, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let parent_uuid = parent_id
        .as_ref()
        .map(|p| uuid::Uuid::parse_str(p))
        .transpose()
        .map_err(|e| e.to_string())?;
    db.create_folder(&name, parent_uuid.as_ref(), None, None, "user")
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn move_page_to_folder(
    state: State<'_, AppState>,
    page_id: String,
    folder_id: Option<String>,
) -> Result<Page, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let page_uuid = uuid::Uuid::parse_str(&page_id).map_err(|e| e.to_string())?;
    let folder_uuid = folder_id
        .as_ref()
        .map(|f| uuid::Uuid::parse_str(f))
        .transpose()
        .map_err(|e| e.to_string())?;
    db.move_page_to_folder(&page_uuid, folder_uuid.as_ref(), "user")
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn reorder_page(state: State<'_, AppState>, id: String, new_position: f64) -> Result<Page, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let uuid = uuid::Uuid::parse_str(&id).map_err(|e| e.to_string())?;
    db.reorder_page(&uuid, new_position, "user")
        .map_err(|e| e.to_string())
}

// ── Property Commands ──

#[tauri::command]
fn set_property(
    state: State<'_, AppState>,
    entity_id: String,
    entity_type: String,
    key: String,
    value: String,
    value_type: Option<String>,
) -> Result<Property, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let uuid = uuid::Uuid::parse_str(&entity_id).map_err(|e| e.to_string())?;
    db.set_property(
        &uuid,
        &entity_type,
        &key,
        &value,
        &value_type.unwrap_or_else(|| "text".to_string()),
        "user",
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_properties(state: State<'_, AppState>, entity_id: String) -> Result<Vec<Property>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let uuid = uuid::Uuid::parse_str(&entity_id).map_err(|e| e.to_string())?;
    db.get_properties(&uuid).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_property(
    state: State<'_, AppState>,
    entity_id: String,
    key: String,
) -> Result<bool, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let uuid = uuid::Uuid::parse_str(&entity_id).map_err(|e| e.to_string())?;
    db.delete_property(&uuid, &key, "user")
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_folder(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let uuid = uuid::Uuid::parse_str(&id).map_err(|e| e.to_string())?;
    db.delete_folder(&uuid, "user").map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let path = db_path();
    let db = Database::open(&path).expect("Failed to open database");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            db: Mutex::new(db),
        })
        .invoke_handler(tauri::generate_handler![
            list_pages,
            get_page_tree,
            create_page,
            delete_page,
            rename_page,
            create_block,
            update_block,
            delete_block,
            search_blocks,
            get_backlinks,
            get_graph_stats,
            get_journal,
            get_folder_tree,
            create_folder,
            move_page_to_folder,
            reorder_page,
            delete_folder,
            set_property,
            get_properties,
            delete_property,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
