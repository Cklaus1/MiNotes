use clap::Subcommand;
use minotes_core::db::Database;
use uuid::Uuid;

use crate::output::{print_error, print_json, print_message};

#[derive(Subcommand)]
pub enum FolderCmd {
    /// Create a new folder
    Create {
        /// Folder name
        name: String,
        /// Parent folder UUID
        #[arg(long)]
        parent: Option<String>,
        /// Icon
        #[arg(long)]
        icon: Option<String>,
        /// Color (hex)
        #[arg(long)]
        color: Option<String>,
    },
    /// List folders (optionally within a parent)
    List {
        /// Parent folder UUID (omit for root)
        #[arg(long)]
        parent: Option<String>,
    },
    /// Show the full folder tree
    Tree,
    /// Rename a folder
    Rename {
        /// Folder UUID
        id: String,
        /// New name
        name: String,
    },
    /// Delete a folder (pages inside are moved to root)
    Delete {
        /// Folder UUID
        id: String,
    },
    /// Move a folder to a new parent
    Move {
        /// Folder UUID
        id: String,
        /// New parent UUID (omit for root)
        #[arg(long)]
        parent: Option<String>,
    },
    /// Move a page into a folder
    AddPage {
        /// Page title or UUID
        page: String,
        /// Target folder UUID
        folder: String,
    },
    /// Remove a page from its folder (move to root)
    RemovePage {
        /// Page title or UUID
        page: String,
    },
}

pub fn run(db: &Database, cmd: FolderCmd, actor: &str) -> i32 {
    match cmd {
        FolderCmd::Create { name, parent, icon, color } => {
            let parent_uuid = parent.as_ref().and_then(|p| Uuid::parse_str(p).ok());
            match db.create_folder(&name, parent_uuid.as_ref(), icon.as_deref(), color.as_deref(), actor) {
                Ok(f) => { print_json(&f); 0 }
                Err(e) => { print_error(&e.to_string()); 1 }
            }
        }
        FolderCmd::List { parent } => {
            let parent_uuid = parent.as_ref().and_then(|p| Uuid::parse_str(p).ok());
            match db.list_folders(parent_uuid.as_ref()) {
                Ok(folders) => { print_json(&folders); 0 }
                Err(e) => { print_error(&e.to_string()); 1 }
            }
        }
        FolderCmd::Tree => {
            match db.get_folder_tree() {
                Ok(tree) => {
                    let root_pages = db.get_pages_in_folder(None).unwrap_or_default();
                    print_json(&serde_json::json!({
                        "folders": tree,
                        "root_pages": root_pages,
                    }));
                    0
                }
                Err(e) => { print_error(&e.to_string()); 1 }
            }
        }
        FolderCmd::Rename { id, name } => {
            let Ok(uuid) = Uuid::parse_str(&id) else {
                print_error("Invalid UUID");
                return 1;
            };
            match db.rename_folder(&uuid, &name, actor) {
                Ok(f) => { print_json(&f); 0 }
                Err(e) => { print_error(&e.to_string()); 1 }
            }
        }
        FolderCmd::Delete { id } => {
            let Ok(uuid) = Uuid::parse_str(&id) else {
                print_error("Invalid UUID");
                return 1;
            };
            match db.delete_folder(&uuid, actor) {
                Ok(true) => { print_message("Folder deleted (pages moved to root)"); 0 }
                Ok(false) => { print_error("Folder not found"); 2 }
                Err(e) => { print_error(&e.to_string()); 1 }
            }
        }
        FolderCmd::Move { id, parent } => {
            let Ok(uuid) = Uuid::parse_str(&id) else {
                print_error("Invalid UUID");
                return 1;
            };
            let parent_uuid = parent.as_ref().and_then(|p| Uuid::parse_str(p).ok());
            match db.move_folder(&uuid, parent_uuid.as_ref(), actor) {
                Ok(f) => { print_json(&f); 0 }
                Err(e) => { print_error(&e.to_string()); 1 }
            }
        }
        FolderCmd::AddPage { page, folder } => {
            let Ok(folder_uuid) = Uuid::parse_str(&folder) else {
                print_error("Invalid folder UUID");
                return 1;
            };
            let page_id = resolve_page_id(db, &page);
            match page_id {
                Some(pid) => match db.move_page_to_folder(&pid, Some(&folder_uuid), actor) {
                    Ok(p) => { print_json(&p); 0 }
                    Err(e) => { print_error(&e.to_string()); 1 }
                },
                None => { print_error(&format!("Page not found: {page}")); 2 }
            }
        }
        FolderCmd::RemovePage { page } => {
            let page_id = resolve_page_id(db, &page);
            match page_id {
                Some(pid) => match db.move_page_to_folder(&pid, None, actor) {
                    Ok(p) => { print_json(&p); 0 }
                    Err(e) => { print_error(&e.to_string()); 1 }
                },
                None => { print_error(&format!("Page not found: {page}")); 2 }
            }
        }
    }
}

fn resolve_page_id(db: &Database, title_or_id: &str) -> Option<Uuid> {
    if let Ok(uuid) = Uuid::parse_str(title_or_id) {
        return Some(uuid);
    }
    db.get_page_by_title(title_or_id).ok().flatten().map(|p| p.id)
}
