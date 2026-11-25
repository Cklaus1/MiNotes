use std::path::Path;

use minotes_core::db::Database;

use crate::output::{print_error, print_json};

pub fn run(
    db: &Database,
    dir: &str,
    actor: &str,
    delete_missing: bool,
    write_back: bool,
) -> i32 {
    let path = Path::new(dir);
    if !path.is_dir() {
        print_error(&format!("Not a directory: {dir}"));
        return 1;
    }

    match db.sync_dir(path, actor, delete_missing, write_back) {
        Ok(result) => {
            print_json(&result);
            0
        }
        Err(e) => {
            print_error(&e.to_string());
            1
        }
    }
}
