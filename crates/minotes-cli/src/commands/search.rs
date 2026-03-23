use minotes_core::db::Database;

use crate::output::{print_error, print_json};

pub fn run(db: &Database, query: &str, limit: Option<i64>) -> i32 {
    match db.search(query, limit) {
        Ok(results) => {
            print_json(&serde_json::json!({
                "query": query,
                "count": results.len(),
                "results": results,
            }));
            0
        }
        Err(e) => {
            print_error(&e.to_string());
            1
        }
    }
}
