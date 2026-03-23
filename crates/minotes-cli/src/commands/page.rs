use clap::Subcommand;
use minotes_core::db::Database;
use uuid::Uuid;

use crate::output::{print_error, print_json, print_message};

#[derive(Subcommand)]
pub enum PageCmd {
    /// Create a new page
    Create {
        /// Page title
        title: String,
        /// Optional icon
        #[arg(long)]
        icon: Option<String>,
    },
    /// Get a page by title or ID
    Get {
        /// Page title or UUID
        title_or_id: String,
        /// Include block tree
        #[arg(long)]
        tree: bool,
    },
    /// List all pages
    List {
        /// Max results
        #[arg(long)]
        limit: Option<i64>,
    },
    /// Delete a page
    Delete {
        /// Page title or UUID
        title_or_id: String,
    },
    /// Rename a page
    Rename {
        /// Current title
        old: String,
        /// New title
        new: String,
    },
}

pub fn run(db: &Database, cmd: PageCmd, actor: &str) -> i32 {
    match cmd {
        PageCmd::Create { title, icon } => {
            match db.create_page(&title, icon.as_deref(), false, None, actor) {
                Ok(page) => { print_json(&page); 0 }
                Err(e) => { print_error(&e.to_string()); 1 }
            }
        }
        PageCmd::Get { title_or_id, tree } => {
            let page = if let Ok(uuid) = Uuid::parse_str(&title_or_id) {
                db.get_page(&uuid)
            } else {
                db.get_page_by_title(&title_or_id)
            };
            match page {
                Ok(Some(p)) => {
                    if tree {
                        let blocks = db.get_page_blocks(&p.id).unwrap_or_default();
                        let tree = minotes_core::models::PageTree { page: p, blocks };
                        print_json(&tree);
                    } else {
                        print_json(&p);
                    }
                    0
                }
                Ok(None) => { print_error(&format!("Page not found: {title_or_id}")); 2 }
                Err(e) => { print_error(&e.to_string()); 1 }
            }
        }
        PageCmd::List { limit } => {
            match db.list_pages(limit) {
                Ok(pages) => { print_json(&pages); 0 }
                Err(e) => { print_error(&e.to_string()); 1 }
            }
        }
        PageCmd::Delete { title_or_id } => {
            let id = resolve_page_id(db, &title_or_id);
            match id {
                Some(uuid) => match db.delete_page(&uuid, actor) {
                    Ok(true) => { print_message(&format!("Deleted page: {title_or_id}")); 0 }
                    Ok(false) => { print_error(&format!("Page not found: {title_or_id}")); 2 }
                    Err(e) => { print_error(&e.to_string()); 1 }
                },
                None => { print_error(&format!("Page not found: {title_or_id}")); 2 }
            }
        }
        PageCmd::Rename { old, new } => {
            let id = resolve_page_id(db, &old);
            match id {
                Some(uuid) => match db.rename_page(&uuid, &new, actor) {
                    Ok(page) => { print_json(&page); 0 }
                    Err(e) => { print_error(&e.to_string()); 1 }
                },
                None => { print_error(&format!("Page not found: {old}")); 2 }
            }
        }
    }
}

fn resolve_page_id(db: &Database, title_or_id: &str) -> Option<Uuid> {
    if let Ok(uuid) = Uuid::parse_str(title_or_id) {
        return Some(uuid);
    }
    db.get_page_by_title(title_or_id)
        .ok()
        .flatten()
        .map(|p| p.id)
}
