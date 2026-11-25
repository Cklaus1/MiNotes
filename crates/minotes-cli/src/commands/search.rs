use std::path::Path;

use minotes_core::cross_notebook::{self, BlockHit, SearchOptions, Skipped};
use minotes_core::db::Database;

use crate::output::{self, csv_escape, print_error, print_json, truncate_chars, Format};

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

/// One labelled hit of `search --all-notebooks`.
struct Hit<'a> {
    notebook: &'a str,
    notebook_key: &'a str,
    current: bool,
    hit: &'a BlockHit,
}

/// `search --all-notebooks`: the open notebook first, then every other one,
/// opened read-only (never migrated, never locked). Unreadable notebooks are
/// reported as skipped, not errors.
pub fn run_all(db: &Database, db_path: &Path, query: &str, limit: Option<i64>, fmt: &Format) -> i32 {
    let opts = SearchOptions { per_notebook: limit.unwrap_or(20), ..Default::default() };
    let current_nb = cross_notebook::notebook_for_db(db_path);
    let current_name = current_nb.as_ref().map(|n| n.name.clone()).unwrap_or_else(|| {
        db_path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
    });
    let current_key = current_nb.as_ref().map(|n| n.key.clone()).unwrap_or_default();
    let mine = match db.search_with_pages(query, opts.per_notebook) {
        Ok(h) => h,
        Err(e) => {
            print_error(&e.to_string());
            return 1;
        }
    };
    let others = cross_notebook::search_other_notebooks(Some(db_path), query, &opts);

    let mut hits: Vec<Hit> = mine
        .iter()
        .map(|hit| Hit { notebook: &current_name, notebook_key: &current_key, current: true, hit })
        .collect();
    for r in &others.results {
        for hit in &r.blocks {
            hits.push(Hit { notebook: &r.notebook_name, notebook_key: &r.notebook_key, current: false, hit });
        }
    }
    let skipped = &others.skipped;

    match fmt {
        Format::Text => {
            println!("Search: \"{}\" — {} results (all notebooks)\n", query, hits.len());
            for h in &hits {
                let preview = truncate_chars(h.hit.block.content.trim(), 80);
                println!(
                    "  [{}] [{}] {} — {}",
                    h.notebook,
                    &h.hit.block.id.to_string()[..8],
                    preview,
                    h.hit.page_title
                );
            }
            print_skipped_text(skipped);
        }
        Format::Md => {
            println!("# Search: \"{}\"\n", query);
            println!("{} results in all notebooks\n", hits.len());
            let mut last: Option<&str> = None;
            for h in &hits {
                if last != Some(h.notebook) {
                    println!("## {}\n", h.notebook);
                    last = Some(h.notebook);
                }
                println!("- {} ({})", h.hit.block.content.trim(), h.hit.page_title);
            }
            print_skipped_text(skipped);
        }
        Format::Csv => {
            println!("notebook,notebook_key,id,page_id,page_title,parent_id,position,content");
            for h in &hits {
                let b = &h.hit.block;
                println!(
                    "{},{},{},{},{},{},{},{}",
                    csv_escape(h.notebook),
                    csv_escape(h.notebook_key),
                    b.id,
                    b.page_id,
                    csv_escape(&h.hit.page_title),
                    b.parent_id.map(|p| p.to_string()).unwrap_or_default(),
                    b.position,
                    csv_escape(&b.content),
                );
            }
            // Keep the CSV itself clean: skipped notebooks go to stderr.
            for s in skipped {
                eprintln!("Skipped: {} ({})", s.notebook_name, s.label);
            }
        }
        _ => {
            let results: Vec<serde_json::Value> = hits
                .iter()
                .map(|h| {
                    let mut v = serde_json::to_value(h.hit.block.clone()).unwrap_or_default();
                    if let Some(o) = v.as_object_mut() {
                        o.insert("notebook".into(), h.notebook.into());
                        o.insert("notebook_key".into(), h.notebook_key.into());
                        o.insert("current_notebook".into(), h.current.into());
                        o.insert("page_title".into(), h.hit.page_title.clone().into());
                    }
                    v
                })
                .collect();
            print_json(&serde_json::json!({
                "query": query,
                "all_notebooks": true,
                "count": results.len(),
                "results": results,
                "skipped": skipped,
            }));
        }
    }
    0
}

fn print_skipped_text(skipped: &[Skipped]) {
    if skipped.is_empty() {
        return;
    }
    let list: Vec<String> = skipped.iter().map(|s| format!("{} ({})", s.notebook_name, s.label)).collect();
    println!("\nSkipped: {}", list.join(", "));
}
