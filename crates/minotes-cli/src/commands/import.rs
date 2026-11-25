//! `minotes import obsidian|markdown|evernote|undo|runs` (PRD-import §4.1).
//!
//! Destination: `--into <notebook name or folder>` imports into an existing
//! notebook (a new Project "Imported from … (date)"); `--notebook <name|folder|path>`
//! does the same for that database; otherwise a NEW folder notebook named
//! after the source is created (at `--location`, default `~/MiNotes/<name>`).

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use clap::Args;
use minotes_core::db::Database;
use minotes_core::import::{self, Collision, Destination, ImportOptions, Limits, SourceKind, SourceSpec, SplitMode};
use minotes_core::notebook;

use crate::output::{print_error, print_json};

#[derive(Args, Debug, Clone)]
pub struct ImportArgs {
    /// Import into this existing notebook (name or folder), in a new Project
    #[arg(long)]
    pub into: Option<String>,
    /// Name of the new notebook (default: the source's name)
    #[arg(long)]
    pub name: Option<String>,
    /// Folder for the new notebook (default ~/MiNotes/<name>)
    #[arg(long)]
    pub location: Option<String>,
    /// Scan and print the preview/report; write nothing
    #[arg(long)]
    pub dry_run: bool,
    /// Print JSON (default: a readable summary)
    #[arg(long)]
    pub json: bool,
    /// How notes become blocks: outline (default), paragraph, note
    #[arg(long, default_value = "outline")]
    pub split: String,
    /// Don't turn daily notes into journal pages
    #[arg(long)]
    pub no_daily_notes: bool,
    /// Don't attach unreferenced files to an "Unlinked files" page
    #[arg(long)]
    pub no_unlinked_files: bool,
    /// Title collisions with existing pages: keep-both (default) or skip
    #[arg(long, default_value = "keep-both")]
    pub collisions: String,
}

fn options(a: &ImportArgs, parent: Option<String>) -> Result<ImportOptions, String> {
    Ok(ImportOptions {
        split: SplitMode::parse(&a.split).ok_or_else(|| format!("Unknown --split '{}': use outline, paragraph or note", a.split))?,
        daily_notes: !a.no_daily_notes,
        unlinked_files: !a.no_unlinked_files,
        collisions: match a.collisions.as_str() {
            "keep-both" | "keep_both" => Collision::KeepBoth,
            "skip" => Collision::Skip,
            o => return Err(format!("Unknown --collisions '{o}': use keep-both or skip")),
        },
        parent_project: parent,
        ..ImportOptions::default()
    })
}

fn expand(p: &str) -> PathBuf {
    match p.strip_prefix("~/") {
        Some(r) => notebook::home_dir().join(r),
        None if p == "~" => notebook::home_dir(),
        None => PathBuf::from(p),
    }
}

/// Where the import writes: (database path, destination, created notebook).
fn destination(a: &ImportArgs, explicit_db: Option<PathBuf>, source_name: &str) -> Result<(PathBuf, Destination, Option<String>), String> {
    if let Some(into) = &a.into {
        let p = expand(into);
        let db = if p.is_dir() {
            p.join(notebook::DB_FILE)
        } else if p.is_file() {
            p
        } else {
            let nb = notebook::find_by_name(into).map_err(|e| e.to_string())?;
            nb.db_path()
        };
        if !db.is_file() {
            return Err(format!("No notebook database at {}", db.display()));
        }
        return Ok((db, Destination::NewProject { name: None }, None));
    }
    if let Some(db) = explicit_db {
        return Ok((db, Destination::NewProject { name: None }, None));
    }
    // A new notebook named after the source.
    let base: String = a
        .name
        .clone()
        .unwrap_or_else(|| source_name.chars().map(|c| if matches!(c, '/' | '\\' | '.' | '\0') || c.is_control() { ' ' } else { c }).collect::<String>().trim().to_string());
    let base = if base.is_empty() { "Imported".to_string() } else { base };
    let names: Vec<String> = notebook::list().into_iter().map(|n| n.name).collect();
    let mut name = base.clone();
    let mut n = 2;
    while names.contains(&name) {
        name = format!("{base} {n}");
        n += 1;
    }
    notebook::validate_name(&name).map_err(|e| e.to_string())?;
    let mut loc = a.location.as_deref().map(expand).unwrap_or_else(|| notebook::default_location(&name));
    if a.location.is_none() {
        let mut k = 2;
        while loc.exists() {
            loc = notebook::default_location(&format!("{name} {k}"));
            k += 1;
        }
    }
    let nb = notebook::create_in_folder(&loc, &name).map_err(|e| e.to_string())?;
    Ok((nb.db_path(), Destination::Root, Some(name)))
}

/// Run an import subcommand. `explicit_db` is the `--notebook` database, if given.
pub fn run(kind: SourceKind, paths: Vec<String>, parent: Option<String>, a: &ImportArgs, explicit_db: Option<PathBuf>) -> i32 {
    let opts = match options(a, parent) {
        Ok(o) => o,
        Err(e) => {
            print_error(&e);
            return 1;
        }
    };
    let paths: Vec<PathBuf> = paths.iter().map(|p| expand(p)).collect();
    for p in &paths {
        if !p.exists() {
            print_error(&format!("{} does not exist", p.display()));
            return 1;
        }
    }
    if kind != SourceKind::Evernote && !paths[0].is_dir() {
        print_error(&format!("{} is not a folder", paths[0].display()));
        return 1;
    }
    let cancel = AtomicBool::new(false);
    let quiet = |_p: import::Progress| {};
    let model = match import::scan(&SourceSpec { kind, paths }, &opts, &Limits::default(), &cancel, &quiet) {
        Ok(m) => m,
        Err(e) => {
            print_error(&e.to_string());
            return 1;
        }
    };
    if a.dry_run {
        // Against the destination when it already exists (collisions, re-import).
        let preview = match (&a.into, &explicit_db) {
            (None, None) => import::preview(&model, &opts, &|_| false, &Default::default()),
            _ => {
                let db_path = match &explicit_db {
                    Some(p) => p.clone(),
                    None => match destination(a, None, &model.name) {
                        Ok((p, _, _)) => p,
                        Err(e) => {
                            print_error(&e);
                            return 1;
                        }
                    },
                };
                match crate::unlock::open_db(&db_path).and_then(|db| import::preview_for(&db, &model, &opts).map_err(|e| e.to_string())) {
                    Ok(p) => p,
                    Err(e) => {
                        print_error(&e.to_string());
                        return 1;
                    }
                }
            }
        };
        if a.json {
            print_json(&serde_json::to_value(&preview).unwrap_or_default());
        } else {
            print_preview(&preview);
        }
        return 0;
    }
    let (db_path, dest, created) = match destination(a, explicit_db, &model.name) {
        Ok(x) => x,
        Err(e) => {
            print_error(&e);
            return 1;
        }
    };
    let db = match crate::unlock::open_db(&db_path) {
        Ok(d) => d,
        Err(e) => {
            print_error(&e);
            return 1;
        }
    };
    let progress = |p: import::Progress| {
        if !a.json && p.phase == "import" && p.total > 0 {
            eprint!("\rImporting {}/{} notes", p.done, p.total);
        }
    };
    match import::import(&db, &model, &opts, &dest, &cancel, &progress) {
        Ok(rep) => {
            if !a.json {
                eprintln!();
            }
            let _ = notebook::checkpoint(&db);
            let mut v = serde_json::to_value(&rep).unwrap_or_default();
            v["database"] = serde_json::Value::String(db_path.display().to_string());
            if let Some(n) = created {
                v["notebook_created"] = serde_json::Value::String(n);
            }
            if a.json {
                print_json(&v);
            } else {
                print_report(&rep, &db_path);
            }
            0
        }
        Err(e) => {
            print_error(&e.to_string());
            1
        }
    }
}

fn mb(b: u64) -> String {
    format!("{:.1} MB", b as f64 / (1024.0 * 1024.0))
}

fn print_preview(p: &import::Preview) {
    let c = &p.counts;
    println!("{} \"{}\" (dry run — nothing written)", p.source_label, p.source_name);
    println!(
        "  {} pages ({} journal), {} Projects, {} attachments ({}), {} skipped",
        c.pages, c.journals, c.folders, c.attachments, mb(c.attachment_bytes), c.skipped
    );
    fn tree(n: &import::TreeNode, d: usize) {
        println!("  {}{}{}", "  ".repeat(d), if n.kind == "project" { "▸ " } else { "· " }, n.name);
        for ch in &n.children {
            tree(ch, d + 1);
        }
        if n.more > 0 {
            println!("  {}  … and {} more", "  ".repeat(d), n.more);
        }
    }
    for t in &p.tree {
        tree(t, 0);
    }
    if !p.warnings.is_empty() {
        println!("Warnings:");
        for w in &p.warnings {
            println!("  {:>5}  {}", w.count, w.label);
        }
    }
}

fn print_report(r: &import::ImportReport, db: &Path) {
    println!("Imported {} \"{}\" into {}", r.source, r.source_name, db.display());
    println!(
        "  {} pages ({} journal), {} Projects, {} attachments ({}) — {} ms",
        r.pages_created, r.journals_created, r.folders_created, r.attachments_created, mb(r.attachment_bytes), r.duration_ms
    );
    if r.pages_updated + r.pages_unchanged + r.reimported_copies > 0 {
        println!("  re-import: {} updated, {} unchanged, {} copies", r.pages_updated, r.pages_unchanged, r.reimported_copies);
    }
    for w in &r.warnings {
        println!("  {:>5}  {}", w.count, w.label);
    }
    println!("Report page: {}", r.report_page_title.clone().unwrap_or_default());
    println!("Undo with: minotes import undo {}", r.run_id);
}

pub fn run_undo(db: &Database, run: &str, keep_edited: bool) -> i32 {
    match import::undo(db, run, keep_edited) {
        Ok(r) => {
            print_json(&serde_json::to_value(&r).unwrap_or_default());
            if r.undone {
                0
            } else {
                eprintln!("Refused: {} page(s) were edited since the import (pass --keep-edited to undo the rest)", r.edited.len());
                2
            }
        }
        Err(e) => {
            print_error(&e.to_string());
            1
        }
    }
}

pub fn run_runs(db: &Database) -> i32 {
    match import::list_runs(db) {
        Ok(r) => {
            print_json(&serde_json::json!({ "runs": r, "count": r.len() }));
            0
        }
        Err(e) => {
            print_error(&e.to_string());
            1
        }
    }
}
