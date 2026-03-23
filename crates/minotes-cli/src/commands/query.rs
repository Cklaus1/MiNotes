use minotes_core::db::Database;

use crate::output::{print_error, print_json};

pub fn run(db: &Database, sql: &str) -> i32 {
    let mut stmt = match db.conn.prepare(sql) {
        Ok(s) => s,
        Err(e) => {
            print_error(&format!("SQL error: {e}"));
            return 1;
        }
    };

    let column_names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();

    let rows_result = stmt.query_map([], |row| {
        let mut map = serde_json::Map::new();
        for (i, col) in column_names.iter().enumerate() {
            let val: rusqlite::Result<String> = row.get(i);
            match val {
                Ok(s) => { map.insert(col.clone(), serde_json::Value::String(s)); }
                Err(_) => {
                    // Try as integer
                    if let Ok(n) = row.get::<_, i64>(i) {
                        map.insert(col.clone(), serde_json::json!(n));
                    } else if let Ok(f) = row.get::<_, f64>(i) {
                        map.insert(col.clone(), serde_json::json!(f));
                    } else {
                        map.insert(col.clone(), serde_json::Value::Null);
                    }
                }
            }
        }
        Ok(serde_json::Value::Object(map))
    });

    match rows_result {
        Ok(rows) => {
            let results: Vec<serde_json::Value> = rows.filter_map(|r| r.ok()).collect();
            print_json(&serde_json::json!({
                "columns": column_names,
                "count": results.len(),
                "rows": results,
            }));
            0
        }
        Err(e) => {
            print_error(&format!("Query failed: {e}"));
            1
        }
    }
}
