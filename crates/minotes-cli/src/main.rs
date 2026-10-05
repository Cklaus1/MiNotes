use std::io::{self, BufRead};
use std::path::PathBuf;
use std::process;

use clap::{Parser, Subcommand};
use minotes_core::db::Database;

mod commands;
mod output;

use commands::{
    block::BlockCmd, export::{ExportCmd, ImportCmd}, folder::FolderCmd,
    graph::GraphCmd, journal::JournalCmd, page::PageCmd, property::PropertyCmd,
};
use output::Format;

#[derive(Parser)]
#[command(name = "minotes", version, about = "Local-first knowledge management CLI")]
struct Cli {
    /// Path to the graph database file. Defaults to the desktop app's active
    /// graph (~/.minotes/<active_graph>.db). A leading ~ is expanded.
    #[arg(long)]
    graph: Option<String>,

    /// Create the --graph database if it does not exist (otherwise a missing
    /// explicit path is an error, to catch typos)
    #[arg(long)]
    create: bool,

    /// Actor name for event attribution
    #[arg(long, default_value = "user")]
    actor: String,

    /// Output format: json, text, md, csv, opml
    #[arg(long, short, default_value = "json")]
    format: Format,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Manage pages
    Page {
        #[command(subcommand)]
        cmd: PageCmd,
    },
    /// Manage blocks
    Block {
        #[command(subcommand)]
        cmd: BlockCmd,
    },
    /// Manage folders
    Folder {
        #[command(subcommand)]
        cmd: FolderCmd,
    },
    /// Manage properties on blocks and pages
    Property {
        #[command(subcommand)]
        cmd: PropertyCmd,
    },
    /// Full-text search across blocks
    Search {
        /// Search query
        #[arg(allow_hyphen_values = true)]
        query: String,
        /// Max results
        #[arg(long)]
        limit: Option<i64>,
    },
    /// Daily journal
    Journal {
        /// Date (YYYY-MM-DD), defaults to today
        date: Option<String>,
        #[command(subcommand)]
        cmd: Option<JournalCmd>,
    },
    /// View event log
    Events {
        /// Show events after this ID
        #[arg(long)]
        since: Option<i64>,
        /// Filter by event types (comma-separated)
        #[arg(long)]
        types: Option<String>,
        /// Max results
        #[arg(long)]
        limit: Option<i64>,
        /// Stream events in real-time (like tail -f)
        #[arg(long)]
        follow: bool,
    },
    /// Run a raw SQL query
    Query {
        /// SQL query string
        sql: String,
    },
    /// Show pages/blocks linking TO a page (backlinks)
    Backlinks {
        /// Page title or UUID
        id: String,
    },
    /// Show links FROM a page to other pages
    ForwardLinks {
        /// Page title or UUID
        id: String,
    },
    /// Graph data and analysis
    Graph {
        #[command(subcommand)]
        cmd: GraphCmd,
    },
    /// Export graph data
    Export {
        #[command(subcommand)]
        cmd: ExportCmd,
    },
    /// Import data into graph
    Import {
        #[command(subcommand)]
        cmd: ImportCmd,
    },
    /// Sync a directory tree with the database (bidirectional)
    #[command(name = "sync-dir")]
    SyncDir {
        /// Directory path to sync
        dir: String,
        /// Delete pages from DB if their source file is gone
        #[arg(long)]
        delete_missing: bool,
        /// Write DB changes back to the filesystem
        #[arg(long)]
        write_back: bool,
    },
    /// Rebuild the full-text search index
    Reindex,
    /// Show graph statistics
    Stats,
    /// Batch create blocks from stdin (JSON array)
    #[command(name = "batch-create")]
    BatchCreate {
        /// Page title or UUID
        page: String,
    },
}

fn main() {
    let cli = Cli::parse();

    let graph_path = match resolve_graph_path(cli.graph.as_deref(), cli.create) {
        Ok(p) => p,
        Err(msg) => {
            output::print_error(&msg);
            process::exit(1);
        }
    };

    let db = match Database::open(&graph_path) {
        Ok(db) => db,
        Err(e) => {
            output::print_error(&format!("Failed to open database: {e}"));
            process::exit(1);
        }
    };

    let fmt = &cli.format;

    let exit_code = match cli.command {
        Commands::Page { cmd } => commands::page::run(&db, cmd, &cli.actor, fmt),
        Commands::Block { cmd } => commands::block::run(&db, cmd, &cli.actor, fmt),
        Commands::Folder { cmd } => commands::folder::run(&db, cmd, &cli.actor),
        Commands::Property { cmd } => commands::property::run(&db, cmd, &cli.actor),
        Commands::Search { query, limit } => commands::search::run(&db, &query, limit, fmt),
        Commands::Journal { date, cmd } => match cmd {
            Some(JournalCmd::Create { content, date: d }) => {
                commands::journal::run_create(&db, &content, d.as_deref(), &cli.actor)
            }
            None => commands::journal::run_get(&db, date.as_deref(), &cli.actor, fmt),
        },
        Commands::Events { since, types, limit, follow } => {
            if follow {
                run_events_follow(&db, since, types.as_deref())
            } else {
                commands::events::run(&db, since, types.as_deref(), limit)
            }
        }
        Commands::Query { sql } => commands::query::run(&db, &sql),
        Commands::Backlinks { id } => commands::links::run_backlinks(&db, &id),
        Commands::ForwardLinks { id } => commands::links::run_forward_links(&db, &id),
        Commands::Graph { cmd } => commands::graph::run(&db, cmd),
        Commands::Export { cmd } => commands::export::run_export(&db, cmd),
        Commands::Import { cmd } => commands::export::run_import(&db, cmd, &cli.actor),
        Commands::SyncDir { dir, delete_missing, write_back } => {
            commands::sync::run(&db, &dir, &cli.actor, delete_missing, write_back)
        }
        Commands::Reindex => run_reindex(&db),
        Commands::Stats => run_stats(&db, fmt),
        Commands::BatchCreate { page } => run_batch_create(&db, &page, &cli.actor),
    };

    process::exit(exit_code);
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").filter(|h| !h.is_empty()).map(PathBuf::from)
}

/// Expand a leading `~` / `~/` to the home directory.
fn expand_tilde(p: &str) -> PathBuf {
    if p == "~" {
        if let Some(h) = home_dir() { return h; }
    } else if let Some(rest) = p.strip_prefix("~/") {
        if let Some(h) = home_dir() { return h.join(rest); }
    }
    PathBuf::from(p)
}

/// The desktop app's active graph DB: ~/.minotes/<active_graph>.db, where the
/// name is read from ~/.minotes/active_graph (default "default").
fn default_graph_path() -> Result<PathBuf, String> {
    let home = home_dir().ok_or("HOME is not set; pass --graph <path>")?;
    let base = home.join(".minotes");
    let name = std::fs::read_to_string(base.join("active_graph"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "default".to_string());
    Ok(base.join(format!("{name}.db")))
}

/// Resolve which DB file to open. The default (app) graph is created on
/// demand, like the app does; an explicit --graph path must already exist
/// unless --create is given.
fn resolve_graph_path(explicit: Option<&str>, create: bool) -> Result<PathBuf, String> {
    let (path, is_default) = match explicit {
        Some(p) => (expand_tilde(p), false),
        None => (default_graph_path()?, true),
    };
    if !path.exists() {
        if !is_default && !create {
            return Err(format!(
                "Graph database not found: {} (pass --create to create a new graph)",
                path.display()
            ));
        }
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create directory {}: {e}", parent.display()))?;
        }
    }
    Ok(path)
}

fn run_reindex(db: &Database) -> i32 {
    // blocks_fts is an external-content FTS5 table (content='blocks'), so the
    // built-in 'rebuild' command regenerates it from the blocks table. It runs
    // inside a transaction so a failure leaves the old index intact.
    let r = || -> minotes_core::error::Result<i64> {
        let tx = db.conn.unchecked_transaction()?;
        tx.execute_batch("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild');")?;
        let count: i64 = tx.query_row("SELECT COUNT(*) FROM blocks", [], |r| r.get(0))?;
        tx.commit()?;
        Ok(count)
    };
    match r() {
        Ok(count) => {
            output::print_json(&serde_json::json!({
                "message": "Reindex complete",
                "blocks_indexed": count,
            }));
            0
        }
        Err(e) => { output::print_error(&e.to_string()); 1 }
    }
}

fn run_stats(db: &Database, fmt: &Format) -> i32 {
    let r = || -> minotes_core::error::Result<()> {
        let pages: i64 = db.conn.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0))?;
        let blocks: i64 = db.conn.query_row("SELECT COUNT(*) FROM blocks", [], |r| r.get(0))?;
        let links: i64 = db.conn.query_row("SELECT COUNT(*) FROM links", [], |r| r.get(0))?;
        let events: i64 = db.conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?;
        let properties: i64 = db.conn.query_row("SELECT COUNT(*) FROM properties", [], |r| r.get(0))?;

        match fmt {
            Format::Text | Format::Md => {
                println!("Pages:      {}", pages);
                println!("Blocks:     {}", blocks);
                println!("Links:      {}", links);
                println!("Properties: {}", properties);
                println!("Events:     {}", events);
            }
            Format::Csv => {
                println!("metric,count");
                println!("pages,{}", pages);
                println!("blocks,{}", blocks);
                println!("links,{}", links);
                println!("properties,{}", properties);
                println!("events,{}", events);
            }
            _ => {
                output::print_json(&serde_json::json!({
                    "pages": pages,
                    "blocks": blocks,
                    "links": links,
                    "properties": properties,
                    "events": events,
                }));
            }
        }
        Ok(())
    };
    match r() {
        Ok(_) => 0,
        Err(e) => { output::print_error(&e.to_string()); 1 }
    }
}

fn run_batch_create(db: &Database, page: &str, actor: &str) -> i32 {
    let page_id = if let Ok(uuid) = uuid::Uuid::parse_str(page) {
        uuid
    } else {
        match db.get_page_by_title(page) {
            Ok(Some(p)) => p.id,
            Ok(None) => { output::print_error(&format!("Page not found: {page}")); return 2; }
            Err(e) => { output::print_error(&e.to_string()); return 1; }
        }
    };

    let stdin = io::stdin();
    let mut input = String::new();
    for line in stdin.lock().lines() {
        match line {
            Ok(l) => input.push_str(&l),
            Err(e) => { output::print_error(&format!("stdin read error: {e}")); return 1; }
        }
    }

    let items: Vec<serde_json::Value> = match serde_json::from_str(&input) {
        Ok(v) => v,
        Err(e) => { output::print_error(&format!("Invalid JSON array: {e}")); return 1; }
    };

    // All-or-nothing: an invalid item or failed insert rolls back every block
    // (dropping `tx` without commit rolls back).
    let tx = match db.conn.unchecked_transaction() {
        Ok(tx) => tx,
        Err(e) => { output::print_error(&e.to_string()); return 1; }
    };
    let mut created = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let content = item.get("content").and_then(|c| c.as_str()).unwrap_or("");
        let parent = match item.get("parent_id") {
            None | Some(serde_json::Value::Null) => None,
            Some(v) => match v.as_str().and_then(|s| uuid::Uuid::parse_str(s).ok()) {
                Some(u) => Some(u),
                None => {
                    output::print_error(&format!("Item {i}: invalid parent_id {v}; no blocks were created"));
                    return 1;
                }
            },
        };
        let position = item.get("position").and_then(|p| p.as_f64());

        match db.create_block(&page_id, content, parent.as_ref(), position, actor) {
            Ok(block) => created.push(serde_json::to_value(&block).unwrap_or_default()),
            Err(e) => {
                output::print_error(&format!("Item {i}: block creation failed: {e}; no blocks were created"));
                return 1;
            }
        }
    }
    if let Err(e) = tx.commit() {
        output::print_error(&format!("Commit failed: {e}; no blocks were created"));
        return 1;
    }

    output::print_json(&serde_json::json!({
        "created": created.len(),
        "blocks": created,
    }));
    0
}

fn run_events_follow(db: &Database, since: Option<i64>, types: Option<&str>) -> i32 {
    let type_list: Option<Vec<&str>> = types.map(|t| t.split(',').collect());
    let mut cursor = since.unwrap_or(0);

    if since.is_none() {
        if let Ok(max_id) = db.conn.query_row("SELECT COALESCE(MAX(id), 0) FROM events", [], |r| r.get::<_, i64>(0)) {
            cursor = max_id;
        }
    }

    eprintln!("Tailing events from cursor {}... (Ctrl+C to stop)", cursor);

    loop {
        let type_refs: Option<Vec<&str>> = type_list.as_deref().map(|s| s.to_vec());
        match db.get_events(Some(cursor), type_refs.as_deref(), Some(100)) {
            Ok(events) => {
                for event in &events {
                    println!("{}", serde_json::to_string(event).unwrap_or_default());
                    if event.id > cursor {
                        cursor = event.id;
                    }
                }
            }
            Err(e) => {
                output::print_error(&format!("Event poll error: {e}"));
                return 1;
            }
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
}
