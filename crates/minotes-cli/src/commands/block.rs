use clap::Subcommand;
use minotes_core::db::Database;
use uuid::Uuid;

use crate::output::{print_error, print_json, print_message};

#[derive(Subcommand)]
pub enum BlockCmd {
    /// Create a new block in a page
    Create {
        /// Page title or UUID
        page: String,
        /// Block content (markdown)
        content: String,
        /// Parent block UUID
        #[arg(long)]
        parent: Option<String>,
        /// Position (fractional)
        #[arg(long)]
        position: Option<f64>,
    },
    /// Get a block by UUID
    Get {
        /// Block UUID
        id: String,
    },
    /// Update a block's content
    Update {
        /// Block UUID
        id: String,
        /// New content
        #[arg(long)]
        content: Option<String>,
    },
    /// Delete a block
    Delete {
        /// Block UUID
        id: String,
    },
    /// Move a block to a new parent
    Move {
        /// Block UUID
        id: String,
        /// New parent block UUID
        #[arg(long)]
        parent: String,
        /// Position
        #[arg(long)]
        position: f64,
    },
    /// List children of a block
    Children {
        /// Parent block UUID
        id: String,
    },
}

pub fn run(db: &Database, cmd: BlockCmd, actor: &str) -> i32 {
    match cmd {
        BlockCmd::Create { page, content, parent, position } => {
            // Resolve page by title or UUID
            let page_id = resolve_page_id(db, &page);
            let Some(page_id) = page_id else {
                print_error(&format!("Page not found: {page}"));
                return 2;
            };
            let parent_id = parent.as_ref().and_then(|p| Uuid::parse_str(p).ok());
            match db.create_block(&page_id, &content, parent_id.as_ref(), position, actor) {
                Ok(block) => { print_json(&block); 0 }
                Err(e) => { print_error(&e.to_string()); 1 }
            }
        }
        BlockCmd::Get { id } => {
            let Ok(uuid) = Uuid::parse_str(&id) else {
                print_error("Invalid UUID");
                return 1;
            };
            match db.get_block(&uuid) {
                Ok(Some(block)) => { print_json(&block); 0 }
                Ok(None) => { print_error(&format!("Block not found: {id}")); 2 }
                Err(e) => { print_error(&e.to_string()); 1 }
            }
        }
        BlockCmd::Update { id, content } => {
            let Ok(uuid) = Uuid::parse_str(&id) else {
                print_error("Invalid UUID");
                return 1;
            };
            match db.update_block(&uuid, content.as_deref(), actor) {
                Ok(block) => { print_json(&block); 0 }
                Err(e) => { print_error(&e.to_string()); 1 }
            }
        }
        BlockCmd::Delete { id } => {
            let Ok(uuid) = Uuid::parse_str(&id) else {
                print_error("Invalid UUID");
                return 1;
            };
            match db.delete_block(&uuid, actor) {
                Ok(true) => { print_message(&format!("Deleted block: {id}")); 0 }
                Ok(false) => { print_error(&format!("Block not found: {id}")); 2 }
                Err(e) => { print_error(&e.to_string()); 1 }
            }
        }
        BlockCmd::Move { id, parent, position } => {
            let Ok(uuid) = Uuid::parse_str(&id) else {
                print_error("Invalid UUID");
                return 1;
            };
            let Ok(parent_uuid) = Uuid::parse_str(&parent) else {
                print_error("Invalid parent UUID");
                return 1;
            };
            match db.move_block(&uuid, &parent_uuid, position, actor) {
                Ok(block) => { print_json(&block); 0 }
                Err(e) => { print_error(&e.to_string()); 1 }
            }
        }
        BlockCmd::Children { id } => {
            let Ok(uuid) = Uuid::parse_str(&id) else {
                print_error("Invalid UUID");
                return 1;
            };
            match db.get_children(&uuid) {
                Ok(blocks) => { print_json(&blocks); 0 }
                Err(e) => { print_error(&e.to_string()); 1 }
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
