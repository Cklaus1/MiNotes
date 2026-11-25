use minotes_core::db::Database;
use uuid::Uuid;

use crate::output::{print_error, print_json};

pub fn run_backlinks(db: &Database, id: &str) -> i32 {
    let uuid = resolve_id(db, id);
    let Some(uuid) = uuid else {
        print_error(&format!("Not found: {id}"));
        return 2;
    };
    match db.get_backlinks(&uuid) {
        Ok(links) => {
            print_json(&serde_json::json!({
                "target": id,
                "count": links.len(),
                "backlinks": links,
            }));
            0
        }
        Err(e) => { print_error(&e.to_string()); 1 }
    }
}

pub fn run_forward_links(db: &Database, id: &str) -> i32 {
    let uuid = resolve_id(db, id);
    let Some(uuid) = uuid else {
        print_error(&format!("Not found: {id}"));
        return 2;
    };
    match db.get_forward_links(&uuid) {
        Ok(links) => {
            print_json(&serde_json::json!({
                "source": id,
                "count": links.len(),
                "forward_links": links,
            }));
            0
        }
        Err(e) => { print_error(&e.to_string()); 1 }
    }
}

fn resolve_id(db: &Database, title_or_id: &str) -> Option<Uuid> {
    if let Ok(uuid) = Uuid::parse_str(title_or_id) {
        return Some(uuid);
    }
    db.get_page_by_title(title_or_id)
        .ok()
        .flatten()
        .map(|p| p.id)
}
