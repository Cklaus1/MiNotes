use std::path::Path;

use clap::Subcommand;
use minotes_core::db::Database;

use crate::output::{print_error, print_json, print_message};

#[derive(Subcommand)]
pub enum ExportCmd {
    /// Export graph as markdown files
    Markdown {
        /// Output directory
        #[arg(long, default_value = "./export")]
        output: String,
    },
    /// Export graph as JSON
    Json,
}

#[derive(Subcommand)]
pub enum ImportCmd {
    /// Import markdown files from a directory
    Dir {
        /// Directory containing .md files
        path: String,
    },
    /// Import a single markdown file
    File {
        /// Path to .md file
        path: String,
        /// Target page title (defaults to filename)
        #[arg(long)]
        title: Option<String>,
    },
}

pub fn run_export(db: &Database, cmd: ExportCmd) -> i32 {
    match cmd {
        ExportCmd::Markdown { output } => {
            match db.export_markdown(Path::new(&output)) {
                Ok(files) => {
                    print_json(&serde_json::json!({
                        "format": "markdown",
                        "files": files,
                        "count": files.len(),
                    }));
                    0
                }
                Err(e) => { print_error(&e.to_string()); 1 }
            }
        }
        ExportCmd::Json => {
            match db.export_json() {
                Ok(json) => { print_json(&json); 0 }
                Err(e) => { print_error(&e.to_string()); 1 }
            }
        }
    }
}

pub fn run_import(db: &Database, cmd: ImportCmd, actor: &str) -> i32 {
    match cmd {
        ImportCmd::Dir { path } => {
            match db.import_markdown_dir(Path::new(&path), actor) {
                Ok(imported) => {
                    print_json(&serde_json::json!({
                        "imported": imported,
                        "count": imported.len(),
                    }));
                    0
                }
                Err(e) => { print_error(&e.to_string()); 1 }
            }
        }
        ImportCmd::File { path, title } => {
            match db.import_markdown_file(Path::new(&path), title.as_deref(), actor) {
                Ok(msg) => { print_message(&msg); 0 }
                Err(e) => { print_error(&e.to_string()); 1 }
            }
        }
    }
}
