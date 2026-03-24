use std::path::PathBuf;
use std::sync::Mutex;

use minotes_core::db::Database;
use minotes_core::models::{Block, Card, CssSnippet, GraphInfo, Highlight, Page, PageTree, Plugin, Property, SrsStats, SyncStatus, Template, VersionInfo};
use minotes_core::repo::graph::GraphStats;
use minotes_core::repo::graphs;
use serde::Serialize;
use tauri::State;

struct AppState {
    db: Mutex<Database>,
    current_graph: Mutex<String>,
}

fn base_dir() -> PathBuf {
    let home = dirs_next().unwrap_or_else(|| PathBuf::from("."));
    let dir = home.join(".minotes");
    std::fs::create_dir_all(&dir).ok();
    dir
}

fn db_path() -> PathBuf {
    base_dir().join("default.db")
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
fn get_unlinked_references(state: State<'_, AppState>, page_id: String) -> Result<Vec<Block>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let uuid = uuid::Uuid::parse_str(&page_id).map_err(|e| e.to_string())?;
    db.get_unlinked_references(&uuid).map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
struct FrontendGraphNode {
    id: String,
    title: String,
    block_count: i64,
    link_count: i64,
}

#[derive(Debug, Serialize)]
struct FrontendGraphEdge {
    source: String,
    target: String,
    weight: i64,
}

#[derive(Debug, Serialize)]
struct FrontendGraphData {
    nodes: Vec<FrontendGraphNode>,
    edges: Vec<FrontendGraphEdge>,
}

#[tauri::command]
fn get_graph_data(state: State<'_, AppState>) -> Result<FrontendGraphData, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let data = db.get_graph_data().map_err(|e| e.to_string())?;
    Ok(FrontendGraphData {
        nodes: data.nodes.into_iter().map(|n| FrontendGraphNode {
            id: n.id.to_string(),
            title: n.title,
            block_count: n.block_count,
            link_count: n.link_count,
        }).collect(),
        edges: data.edges.into_iter().map(|e| FrontendGraphEdge {
            source: e.from_page.to_string(),
            target: e.to_page.to_string(),
            weight: e.link_count,
        }).collect(),
    })
}

#[tauri::command]
fn get_graph_stats(state: State<'_, AppState>) -> Result<GraphStats, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_graph_stats().map_err(|e| e.to_string())
}

#[tauri::command]
fn run_query(state: State<'_, AppState>, sql: String) -> Result<serde_json::Value, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.run_query(&sql).map_err(|e| e.to_string())
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
    match db.get_page_by_title(&title).map_err(|e| e.to_string())? {
        Some(p) => {
            let blocks = db.get_page_blocks(&p.id).map_err(|e| e.to_string())?;
            Ok(PageTree { page: p, blocks })
        }
        None => {
            // Return a virtual page — don't persist until user writes content.
            // The page will be created by create_block when the first block is added.
            let virtual_id = uuid::Uuid::now_v7();
            let now = chrono::Utc::now();
            let page = minotes_core::models::Page {
                id: virtual_id,
                title: title.clone(),
                icon: None,
                folder_id: None,
                position: 0.0,
                is_journal: true,
                journal_date: Some(d),
                created_at: now,
                updated_at: now,
            };
            Ok(PageTree { page, blocks: vec![] })
        }
    }
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
fn get_inherited_properties(state: State<'_, AppState>, block_id: String) -> Result<Vec<Property>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let uuid = uuid::Uuid::parse_str(&block_id).map_err(|e| e.to_string())?;
    db.get_inherited_properties(&uuid).map_err(|e| e.to_string())
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

// ── SRS Card Commands ──

#[tauri::command]
fn create_card(state: State<'_, AppState>, block_id: String, card_type: String) -> Result<Card, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let uuid = uuid::Uuid::parse_str(&block_id).map_err(|e| e.to_string())?;
    db.create_card(&uuid, &card_type, "user").map_err(|e| e.to_string())
}

#[tauri::command]
fn get_due_cards(state: State<'_, AppState>, limit: Option<i64>) -> Result<Vec<Card>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_due_cards(limit.unwrap_or(50)).map_err(|e| e.to_string())
}

#[tauri::command]
fn review_card(state: State<'_, AppState>, card_id: String, rating: String) -> Result<Card, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let uuid = uuid::Uuid::parse_str(&card_id).map_err(|e| e.to_string())?;
    db.review_card(&uuid, &rating, "user").map_err(|e| e.to_string())
}

#[tauri::command]
fn get_srs_stats(state: State<'_, AppState>) -> Result<SrsStats, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_srs_stats().map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_card(state: State<'_, AppState>, card_id: String) -> Result<bool, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let uuid = uuid::Uuid::parse_str(&card_id).map_err(|e| e.to_string())?;
    db.delete_card(&uuid, "user").map_err(|e| e.to_string())
}

// ── Favorite Commands ──

#[tauri::command]
fn add_favorite(state: State<'_, AppState>, page_id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let uuid = uuid::Uuid::parse_str(&page_id).map_err(|e| e.to_string())?;
    db.add_favorite(&uuid, "user").map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_favorite(state: State<'_, AppState>, page_id: String) -> Result<bool, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let uuid = uuid::Uuid::parse_str(&page_id).map_err(|e| e.to_string())?;
    db.remove_favorite(&uuid).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_favorites(state: State<'_, AppState>) -> Result<Vec<Page>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.list_favorites().map_err(|e| e.to_string())
}

// ── Alias Commands ──

#[tauri::command]
fn add_alias(state: State<'_, AppState>, page_id: String, alias: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let uuid = uuid::Uuid::parse_str(&page_id).map_err(|e| e.to_string())?;
    db.add_alias(&uuid, &alias, "user").map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_alias(state: State<'_, AppState>, alias: String) -> Result<bool, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.remove_alias(&alias, "user").map_err(|e| e.to_string())
}

#[tauri::command]
fn get_aliases(state: State<'_, AppState>, page_id: String) -> Result<Vec<String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let uuid = uuid::Uuid::parse_str(&page_id).map_err(|e| e.to_string())?;
    db.get_aliases(&uuid).map_err(|e| e.to_string())
}

// ── Template Commands ──

#[tauri::command]
fn create_template(
    state: State<'_, AppState>,
    name: String,
    description: Option<String>,
    content: String,
) -> Result<Template, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.create_template(&name, description.as_deref(), &content, "user")
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_templates(state: State<'_, AppState>) -> Result<Vec<Template>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.list_templates().map_err(|e| e.to_string())
}

#[tauri::command]
fn apply_template(
    state: State<'_, AppState>,
    page_id: String,
    template_name: String,
) -> Result<Vec<Block>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let uuid = uuid::Uuid::parse_str(&page_id).map_err(|e| e.to_string())?;
    db.apply_template(&uuid, &template_name, "user")
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_template(state: State<'_, AppState>, name: String) -> Result<bool, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.delete_template(&name, "user").map_err(|e| e.to_string())
}

// ── Export/Import Commands ──

#[tauri::command]
fn export_opml(state: State<'_, AppState>) -> Result<String, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.export_opml().map_err(|e| e.to_string())
}

#[tauri::command]
fn export_json(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.export_json().map_err(|e| e.to_string())
}

#[tauri::command]
fn publish_site(state: State<'_, AppState>, output_dir: String) -> Result<Vec<String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.publish_static_site(std::path::Path::new(&output_dir))
        .map_err(|e| e.to_string())
}

// ── Undo Command ──

#[tauri::command]
fn undo(state: State<'_, AppState>) -> Result<Option<i64>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.undo_last("user").map_err(|e| e.to_string())
}

// ── Block Move Command ──

#[tauri::command]
fn move_block(
    state: State<'_, AppState>,
    id: String,
    new_parent: String,
    position: f64,
) -> Result<Block, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let uuid = uuid::Uuid::parse_str(&id).map_err(|e| e.to_string())?;
    let parent_uuid = uuid::Uuid::parse_str(&new_parent).map_err(|e| e.to_string())?;
    db.move_block(&uuid, &parent_uuid, position, "user")
        .map_err(|e| e.to_string())
}

// ── Reparent Block Command ──

#[tauri::command]
fn reparent_block(
    state: State<'_, AppState>,
    id: String,
    parent_id: Option<String>,
) -> Result<Block, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let uuid = uuid::Uuid::parse_str(&id).map_err(|e| e.to_string())?;
    let parent_uuid = parent_id
        .as_ref()
        .map(|p| uuid::Uuid::parse_str(p))
        .transpose()
        .map_err(|e| e.to_string())?;
    db.reparent_block(&uuid, parent_uuid.as_ref(), "user")
        .map_err(|e| e.to_string())
}

// ── Plugin Commands ──

#[tauri::command]
fn list_plugins(state: State<'_, AppState>) -> Result<Vec<Plugin>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.list_plugins().map_err(|e| e.to_string())
}

#[tauri::command]
fn register_plugin(
    state: State<'_, AppState>,
    name: String,
    version: String,
    description: Option<String>,
    author: Option<String>,
) -> Result<Plugin, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.register_plugin(
        &name,
        &version,
        description.as_deref(),
        author.as_deref(),
        None,
        None,
        "user",
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn enable_plugin(state: State<'_, AppState>, name: String) -> Result<Plugin, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.enable_plugin(&name).map_err(|e| e.to_string())
}

#[tauri::command]
fn disable_plugin(state: State<'_, AppState>, name: String) -> Result<Plugin, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.disable_plugin(&name).map_err(|e| e.to_string())
}

#[tauri::command]
fn uninstall_plugin(state: State<'_, AppState>, name: String) -> Result<bool, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.uninstall_plugin(&name).map_err(|e| e.to_string())
}

// ── Multi-Graph Management (F-020) ──

#[tauri::command]
fn list_graphs() -> Result<Vec<GraphInfo>, String> {
    let dir = base_dir();
    graphs::list_graphs(&dir).map_err(|e| e.to_string())
}

#[tauri::command]
fn switch_graph(state: State<'_, AppState>, name: String) -> Result<bool, String> {
    let dir = base_dir();
    let new_path = dir.join(format!("{name}.db"));
    if !new_path.exists() {
        return Err(format!("Graph '{name}' does not exist"));
    }
    let new_db = Database::open(&new_path).map_err(|e| e.to_string())?;
    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    *db = new_db;
    let mut current = state.current_graph.lock().map_err(|e| e.to_string())?;
    *current = name;
    Ok(true)
}

#[tauri::command]
fn create_graph_cmd(name: String) -> Result<GraphInfo, String> {
    let dir = base_dir();
    graphs::create_graph(&dir, &name).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_graph_cmd(state: State<'_, AppState>, name: String) -> Result<bool, String> {
    // Prevent deleting the currently active graph
    let current = state.current_graph.lock().map_err(|e| e.to_string())?;
    if *current == name {
        return Err("Cannot delete the currently active graph. Switch to another graph first.".to_string());
    }
    drop(current);

    let dir = base_dir();
    graphs::delete_graph(&dir, &name).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_current_graph(state: State<'_, AppState>) -> Result<String, String> {
    let current = state.current_graph.lock().map_err(|e| e.to_string())?;
    Ok(current.clone())
}

// ── PDF Highlight Commands (F-013) ──

#[tauri::command]
fn create_highlight(
    state: State<'_, AppState>,
    pdf_path: String,
    page_num: i32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    color: String,
    text: Option<String>,
    note: Option<String>,
) -> Result<Highlight, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.create_highlight(
        &pdf_path,
        page_num,
        x, y, width, height,
        &color,
        text.as_deref(),
        note.as_deref(),
        "user",
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_highlights(state: State<'_, AppState>, pdf_path: String) -> Result<Vec<Highlight>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_highlights(&pdf_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_highlight_note(state: State<'_, AppState>, id: String, note: String) -> Result<Highlight, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let uuid = uuid::Uuid::parse_str(&id).map_err(|e| e.to_string())?;
    db.update_highlight_note(&uuid, &note, "user")
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_highlight(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let uuid = uuid::Uuid::parse_str(&id).map_err(|e| e.to_string())?;
    db.delete_highlight(&uuid, "user").map_err(|e| e.to_string())
}

#[tauri::command]
fn search_highlights(state: State<'_, AppState>, query: String) -> Result<Vec<Highlight>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.search_highlights(&query).map_err(|e| e.to_string())
}

// ── CRDT Sync Commands (F-015) ──

#[tauri::command]
fn get_sync_status(state: State<'_, AppState>) -> Result<SyncStatus, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_sync_status().map_err(|e| e.to_string())
}

#[tauri::command]
fn sync_page(state: State<'_, AppState>, page_id: String) -> Result<Vec<u8>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let uuid = uuid::Uuid::parse_str(&page_id).map_err(|e| e.to_string())?;
    db.page_to_automerge(&uuid).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_version_history(
    state: State<'_, AppState>,
    page_id: String,
    limit: Option<usize>,
) -> Result<Vec<VersionInfo>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let uuid = uuid::Uuid::parse_str(&page_id).map_err(|e| e.to_string())?;
    db.get_version_history(&uuid, limit).map_err(|e| e.to_string())
}

#[tauri::command]
fn restore_version(
    state: State<'_, AppState>,
    page_id: String,
    version_hash: String,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let uuid = uuid::Uuid::parse_str(&page_id).map_err(|e| e.to_string())?;
    db.restore_version(&uuid, &version_hash, "user")
        .map_err(|e| e.to_string())
}

// ── Plugin Storage Commands ──

#[tauri::command]
fn plugin_storage_get(state: State<'_, AppState>, plugin_name: String, key: String) -> Result<Option<String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.plugin_storage_get(&plugin_name, &key).map_err(|e| e.to_string())
}

#[tauri::command]
fn plugin_storage_set(state: State<'_, AppState>, plugin_name: String, key: String, value: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.plugin_storage_set(&plugin_name, &key, &value).map_err(|e| e.to_string())
}

// ── CSS Snippet Commands ──

#[tauri::command]
fn add_css_snippet(state: State<'_, AppState>, name: String, css: String, source: String) -> Result<CssSnippet, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.add_snippet(&name, &css, &source, "user").map_err(|e| e.to_string())
}

#[tauri::command]
fn list_css_snippets(state: State<'_, AppState>) -> Result<Vec<CssSnippet>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.list_snippets().map_err(|e| e.to_string())
}

#[tauri::command]
fn toggle_css_snippet(state: State<'_, AppState>, name: String) -> Result<CssSnippet, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.toggle_snippet(&name).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_css_snippet(state: State<'_, AppState>, name: String) -> Result<bool, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.delete_snippet(&name).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_enabled_css_snippets(state: State<'_, AppState>) -> Result<Vec<CssSnippet>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_enabled_snippets().map_err(|e| e.to_string())
}

// ── Web Clipper API (F-021) ──

#[tauri::command]
fn clip_content(
    state: State<'_, AppState>,
    title: String,
    content: String,
    url: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<Page, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;

    // Create the page
    let page = db
        .create_page(&title, None, false, None, "clipper")
        .map_err(|e| e.to_string())?;

    // Add URL as a property if provided
    if let Some(ref u) = url {
        db.set_property(&page.id, "page", "url", u, "url", "clipper")
            .map_err(|e| e.to_string())?;
    }

    // Add tags as properties
    if let Some(ref tag_list) = tags {
        for tag in tag_list {
            db.set_property(&page.id, "page", &format!("tag:{tag}"), tag, "tag", "clipper")
                .map_err(|e| e.to_string())?;
        }
    }

    // Split content into blocks by double newlines (paragraphs)
    let paragraphs: Vec<&str> = content
        .split("\n\n")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();

    for paragraph in &paragraphs {
        db.create_block(&page.id, paragraph, None, None, "clipper")
            .map_err(|e| e.to_string())?;
    }

    // If no paragraphs were found but content is non-empty, create a single block
    if paragraphs.is_empty() && !content.trim().is_empty() {
        db.create_block(&page.id, content.trim(), None, None, "clipper")
            .map_err(|e| e.to_string())?;
    }

    Ok(page)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let path = db_path();
    let db = Database::open(&path).expect("Failed to open database");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            db: Mutex::new(db),
            current_graph: Mutex::new("default".to_string()),
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
            move_block,
            reparent_block,
            search_blocks,
            get_backlinks,
            get_unlinked_references,
            get_graph_data,
            get_graph_stats,
            run_query,
            get_journal,
            get_folder_tree,
            create_folder,
            move_page_to_folder,
            reorder_page,
            delete_folder,
            set_property,
            get_properties,
            get_inherited_properties,
            delete_property,
            create_card,
            get_due_cards,
            review_card,
            get_srs_stats,
            delete_card,
            add_favorite,
            remove_favorite,
            list_favorites,
            add_alias,
            remove_alias,
            get_aliases,
            create_template,
            list_templates,
            apply_template,
            delete_template,
            export_opml,
            export_json,
            publish_site,
            list_plugins,
            register_plugin,
            enable_plugin,
            disable_plugin,
            uninstall_plugin,
            list_graphs,
            switch_graph,
            create_graph_cmd,
            delete_graph_cmd,
            get_current_graph,
            clip_content,
            create_highlight,
            get_highlights,
            update_highlight_note,
            delete_highlight,
            search_highlights,
            get_sync_status,
            sync_page,
            get_version_history,
            restore_version,
            plugin_storage_get,
            plugin_storage_set,
            add_css_snippet,
            list_css_snippets,
            toggle_css_snippet,
            delete_css_snippet,
            get_enabled_css_snippets,
            undo,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
