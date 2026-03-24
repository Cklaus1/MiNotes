use minotes_core::db::Database;

use crate::output::{self, Format, print_error, print_json};

pub fn run(db: &Database, query: &str, limit: Option<i64>, fmt: &Format) -> i32 {
    match db.search(query, limit) {
        Ok(results) => {
            match fmt {
                Format::Text => output::print_search_text(query, &results),
                Format::Md => output::print_search_md(query, &results),
                Format::Csv => output::print_search_csv(&results),
                _ => {
                    print_json(&serde_json::json!({
                        "query": query,
                        "count": results.len(),
                        "results": results,
                    }));
                }
            }
            0
        }
        Err(e) => {
            print_error(&e.to_string());
            1
        }
    }
}
