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
    // ── Import (PRD-import) ──
    /// Import an Obsidian vault (folder with .obsidian/) — into a new notebook by default
    Obsidian {
        /// The vault folder
        vault: String,
        #[command(flatten)]
        args: crate::commands::import::ImportArgs,
    },
    /// Import a folder of markdown files (subfolders become Projects)
    Markdown {
        /// The folder
        folder: String,
        #[command(flatten)]
        args: crate::commands::import::ImportArgs,
    },
    /// Import Evernote .enex exports (one Project per file)
    Evernote {
        /// One or more .enex files
        #[arg(required = true)]
        files: Vec<String>,
        /// Group the notebooks under this parent Project
        #[arg(long)]
        parent: Option<String>,
        #[command(flatten)]
        args: crate::commands::import::ImportArgs,
    },
    /// Undo an import run (refuses pages edited since, listing them)
    Undo {
        /// Run id (from the report, or `import runs`)
        run: String,
        /// Undo everything else and keep the edited pages
        #[arg(long)]
        keep_edited: bool,
    },
    /// List import runs in this notebook
    Runs,
    // ── End import ──
    /// Import markdown files from a directory (alias of `import markdown <dir>
    /// --into <this notebook>`)
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
            // ── Import: the markdown-folder importer, into this notebook ──
            let _ = actor;
            use minotes_core::import::{self, Destination, ImportOptions, Limits, SourceKind, SourceSpec};
            let cancel = std::sync::atomic::AtomicBool::new(false);
            let none = |_p: import::Progress| {};
            let opts = ImportOptions::default();
            let spec = SourceSpec { kind: SourceKind::Markdown, paths: vec![Path::new(&path).to_path_buf()] };
            let r = import::scan(&spec, &opts, &Limits::default(), &cancel, &none)
                .and_then(|m| import::import(db, &m, &opts, &Destination::NewProject { name: None }, &cancel, &none));
            match r {
                Ok(rep) => {
                    let mut v = serde_json::to_value(&rep).unwrap_or_default();
                    v["count"] = serde_json::json!(rep.pages_created);
                    print_json(&v);
                    0
                }
                Err(e) => { print_error(&e.to_string()); 1 }
            }
        }
        ImportCmd::Undo { run, keep_edited } => crate::commands::import::run_undo(db, &run, keep_edited),
        ImportCmd::Runs => crate::commands::import::run_runs(db),
        ImportCmd::Obsidian { .. } | ImportCmd::Markdown { .. } | ImportCmd::Evernote { .. } => {
            unreachable!("handled before the database is opened")
        }
        ImportCmd::File { path, title } => {
            match db.import_markdown_file(Path::new(&path), title.as_deref(), actor) {
                Ok(msg) => { print_message(&msg); 0 }
                Err(e) => { print_error(&e.to_string()); 1 }
            }
        }
    }
}
