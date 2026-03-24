use chrono::{Local, NaiveDate};
use clap::Subcommand;
use minotes_core::db::Database;

use crate::output::{self, Format, print_error, print_json};

#[derive(Subcommand)]
pub enum JournalCmd {
    /// Create a journal entry
    Create {
        /// Entry content
        content: String,
        /// Date (YYYY-MM-DD), defaults to today
        #[arg(long)]
        date: Option<String>,
    },
}

/// Get or create today's (or specified date's) journal page.
pub fn run_get(db: &Database, date: Option<&str>, actor: &str, fmt: &Format) -> i32 {
    let d = match parse_date(date) {
        Ok(d) => d,
        Err(e) => { print_error(&e); return 1; }
    };
    let title = format!("Journal/{}", d);

    match db.get_page_by_title(&title) {
        Ok(Some(page)) => {
            let blocks = db.get_page_blocks(&page.id).unwrap_or_default();
            let tree = minotes_core::models::PageTree { page, blocks };
            match fmt {
                Format::Text => output::print_page_tree_text(&tree),
                Format::Md => output::print_page_tree_md(&tree),
                Format::Csv => output::print_page_tree_csv(&tree),
                Format::Opml => output::print_page_tree_opml(&tree),
                Format::Json => print_json(&tree),
            }
            0
        }
        Ok(None) => {
            // Auto-create journal page
            match db.create_page(&title, None, true, Some(d), actor) {
                Ok(page) => {
                    let tree = minotes_core::models::PageTree { page, blocks: vec![] };
                    match fmt {
                        Format::Text => output::print_page_tree_text(&tree),
                        Format::Md => output::print_page_tree_md(&tree),
                        Format::Csv => output::print_page_tree_csv(&tree),
                        Format::Opml => output::print_page_tree_opml(&tree),
                        Format::Json => print_json(&tree),
                    }
                    0
                }
                Err(e) => { print_error(&e.to_string()); 1 }
            }
        }
        Err(e) => { print_error(&e.to_string()); 1 }
    }
}

pub fn run_create(db: &Database, content: &str, date: Option<&str>, actor: &str) -> i32 {
    let d = match parse_date(date) {
        Ok(d) => d,
        Err(e) => { print_error(&e); return 1; }
    };
    let title = format!("Journal/{}", d);

    // Get or create journal page
    let page = match db.get_page_by_title(&title) {
        Ok(Some(p)) => p,
        Ok(None) => match db.create_page(&title, None, true, Some(d), actor) {
            Ok(p) => p,
            Err(e) => { print_error(&e.to_string()); return 1; }
        },
        Err(e) => { print_error(&e.to_string()); return 1; }
    };

    match db.create_block(&page.id, content, None, None, actor) {
        Ok(block) => { print_json(&block); 0 }
        Err(e) => { print_error(&e.to_string()); 1 }
    }
}

fn parse_date(date: Option<&str>) -> std::result::Result<NaiveDate, String> {
    match date {
        Some(s) => NaiveDate::parse_from_str(s, "%Y-%m-%d")
            .map_err(|e| format!("Invalid date '{s}': {e}. Use YYYY-MM-DD format.")),
        None => Ok(Local::now().date_naive()),
    }
}
