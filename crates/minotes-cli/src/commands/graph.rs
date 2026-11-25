use clap::Subcommand;
use minotes_core::db::Database;
use uuid::Uuid;

use crate::output::{print_error, print_json};

#[derive(Subcommand)]
pub enum GraphCmd {
    /// Get full graph data (nodes + edges) for visualization
    Data,
    /// Get N-hop neighbors of a page
    Neighbors {
        /// Page title or UUID
        page: String,
        /// Hop depth
        #[arg(long, default_value = "1")]
        depth: i32,
    },
    /// Show detailed graph statistics
    Stats,
}

pub fn run(db: &Database, cmd: GraphCmd) -> i32 {
    match cmd {
        GraphCmd::Data => {
            match db.get_graph_data() {
                Ok(data) => { print_json(&data); 0 }
                Err(e) => { print_error(&e.to_string()); 1 }
            }
        }
        GraphCmd::Neighbors { page, depth } => {
            let page_id = if let Ok(uuid) = Uuid::parse_str(&page) {
                uuid
            } else {
                match db.get_page_by_title(&page) {
                    Ok(Some(p)) => p.id,
                    Ok(None) => { print_error(&format!("Page not found: {page}")); return 2; }
                    Err(e) => { print_error(&e.to_string()); return 1; }
                }
            };
            match db.get_neighbors(&page_id, Some(depth)) {
                Ok(neighbors) => {
                    print_json(&serde_json::json!({
                        "center": page,
                        "depth": depth,
                        "count": neighbors.len(),
                        "neighbors": neighbors,
                    }));
                    0
                }
                Err(e) => { print_error(&e.to_string()); 1 }
            }
        }
        GraphCmd::Stats => {
            match db.get_graph_stats() {
                Ok(stats) => { print_json(&stats); 0 }
                Err(e) => { print_error(&e.to_string()); 1 }
            }
        }
    }
}
