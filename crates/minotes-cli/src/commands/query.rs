use minotes_core::db::Database;

use crate::output::{print_error, print_json};

pub fn run(db: &Database, sql: &str) -> i32 {
    // Delegate to core's run_query rather than re-implementing row→JSON here.
    // The old local version read every column as String first, which coerced
    // integers/reals to strings and silently nulled BLOBs — and, because it
    // never went through core, it also bypassed the `stmt.readonly()` guard,
    // so `minotes query "DELETE FROM pages"` would happily run.
    match db.run_query(sql) {
        Ok(result) => {
            let count = result
                .get("rows")
                .and_then(|r| r.as_array())
                .map(|r| r.len())
                .unwrap_or(0);
            // Keep the CLI's historical {columns, count, rows} shape so
            // scripted callers don't break; core returns {columns, rows}.
            let mut out = result;
            if let Some(obj) = out.as_object_mut() {
                obj.insert("count".to_string(), serde_json::json!(count));
            }
            print_json(&out);
            0
        }
        Err(e) => {
            print_error(&format!("Query failed: {e}"));
            1
        }
    }
}
