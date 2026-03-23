use std::path::Path;
use std::process;

use clap::{Parser, Subcommand};
use minotes_core::db::Database;

mod commands;
mod output;

use commands::{block::BlockCmd, journal::JournalCmd, page::PageCmd};

#[derive(Parser)]
#[command(name = "minotes", version, about = "Local-first knowledge management CLI")]
struct Cli {
    /// Path to the graph database file
    #[arg(long, default_value = ".minotes.db")]
    graph: String,

    /// Actor name for event attribution
    #[arg(long, default_value = "user")]
    actor: String,

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
    /// Full-text search across blocks
    Search {
        /// Search query
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
    },
    /// Run a raw SQL query
    Query {
        /// SQL query string
        sql: String,
    },
    /// Show graph statistics
    Stats,
}

fn main() {
    let cli = Cli::parse();

    let db = match Database::open(Path::new(&cli.graph)) {
        Ok(db) => db,
        Err(e) => {
            output::print_error(&format!("Failed to open database: {e}"));
            process::exit(1);
        }
    };

    let exit_code = match cli.command {
        Commands::Page { cmd } => commands::page::run(&db, cmd, &cli.actor),
        Commands::Block { cmd } => commands::block::run(&db, cmd, &cli.actor),
        Commands::Search { query, limit } => commands::search::run(&db, &query, limit),
        Commands::Journal { date, cmd } => match cmd {
            Some(JournalCmd::Create { content, date: d }) => {
                commands::journal::run_create(&db, &content, d.as_deref(), &cli.actor)
            }
            None => commands::journal::run_get(&db, date.as_deref(), &cli.actor),
        },
        Commands::Events { since, types, limit } => {
            commands::events::run(&db, since, types.as_deref(), limit)
        }
        Commands::Query { sql } => commands::query::run(&db, &sql),
        Commands::Stats => {
            match run_stats(&db) {
                Ok(_) => 0,
                Err(e) => { output::print_error(&e.to_string()); 1 }
            }
        }
    };

    process::exit(exit_code);
}

fn run_stats(db: &Database) -> minotes_core::error::Result<()> {
    let pages: i64 = db.conn.query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0))?;
    let blocks: i64 = db.conn.query_row("SELECT COUNT(*) FROM blocks", [], |r| r.get(0))?;
    let links: i64 = db.conn.query_row("SELECT COUNT(*) FROM links", [], |r| r.get(0))?;
    let events: i64 = db.conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?;

    output::print_json(&serde_json::json!({
        "pages": pages,
        "blocks": blocks,
        "links": links,
        "events": events,
    }));
    Ok(())
}
