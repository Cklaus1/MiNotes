use minotes_core::db::Database;

use crate::output::{print_error, print_json};

pub fn run(db: &Database, since: Option<i64>, types: Option<&str>, limit: Option<i64>) -> i32 {
    let type_list: Option<Vec<&str>> = types.map(|t| t.split(',').collect());
    let type_refs: Option<Vec<&str>> = type_list.as_deref().map(|s| s.to_vec());

    match db.get_events(since, type_refs.as_deref(), limit) {
        Ok(events) => {
            print_json(&serde_json::json!({
                "count": events.len(),
                "events": events,
            }));
            0
        }
        Err(e) => {
            print_error(&e.to_string());
            1
        }
    }
}
