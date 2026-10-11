//! Import from Obsidian vaults, Evernote `.enex` exports and markdown folders
//! (PRD-import). Shared by the CLI and the app.
//!
//! ```text
//! reader (folder / enex) ──► neutral model ──► resolver ──► writer (batched transactions)
//! ```
//!
//! - [`scan`] reads the source (read-only, cancellable, with progress) into a
//!   [`Model`]; [`preview`] resolves it and shows what would be created (tree,
//!   three converted samples beside their source, warnings by category).
//! - [`import`] resolves against the destination database and writes it; every
//!   page gets `import_source` / `import_origin` / `import_ref` / `import_run`
//!   properties, and the run is recorded so [`undo`] removes exactly what it
//!   created. Running it again on the same source is a re-import (§4.6).

pub mod enex;
pub mod folder;
pub mod frontmatter;
pub mod model;
pub mod resolve;
pub mod split;
pub mod text;
pub mod undo;
pub mod writer;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::{Error, Result};
pub use model::{Model, NoteKind, SourceKind, WarningEntry, Warnings};
pub use resolve::{Collision, Resolved};
pub use split::{OutBlock, SplitMode};
pub use undo::{list_runs, RunInfo, UndoReport};
pub use writer::ImportReport;

const CANCELLED: &str = "Import cancelled";

/// Returned (as an error) when the user cancels.
pub struct Cancelled;

impl From<Cancelled> for Error {
    fn from(_: Cancelled) -> Error {
        Error::InvalidInput(CANCELLED.into())
    }
}

pub fn is_cancelled(e: &Error) -> bool {
    matches!(e, Error::InvalidInput(m) if m == CANCELLED)
}

/// Progress of a scan (`done`/`total` files or bytes) or an import (notes).
#[derive(Debug, Clone, Serialize)]
pub struct Progress {
    pub phase: String,
    pub done: usize,
    pub total: usize,
    pub current: String,
}

/// Size limits (PRD §5 "Limits", §6 malformed input).
#[derive(Debug, Clone)]
pub struct Limits {
    pub max_files: usize,
    pub max_note_bytes: u64,
    pub max_attachment_bytes: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_files: 500_000,
            max_note_bytes: 20 * 1024 * 1024,
            max_attachment_bytes: crate::repo::attachments::MAX_ATTACHMENT_BYTES,
        }
    }
}

/// A temporary directory removed when dropped (decoded Evernote resources).
#[derive(Debug)]
pub struct Spool(PathBuf);

impl Spool {
    pub fn new() -> Result<Spool> {
        let p = std::env::temp_dir().join(format!("minotes-import-{}", uuid::Uuid::now_v7().simple()));
        std::fs::create_dir_all(&p).map_err(|e| Error::InvalidInput(format!("Cannot create {}: {e}", p.display())))?;
        Ok(Spool(p))
    }
    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Spool {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Options shown under "Options" in the dialog (sensible defaults).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ImportOptions {
    pub split: SplitMode,
    /// Obsidian daily notes → journal pages.
    pub daily_notes: bool,
    /// Files no note links to → an "Unlinked files" page.
    pub unlinked_files: bool,
    pub collisions: Collision,
    /// Evernote: group the selected notebooks under this parent Project.
    pub parent_project: Option<String>,
    /// Notes per transaction.
    pub batch_size: usize,
}

impl Default for ImportOptions {
    fn default() -> Self {
        ImportOptions {
            split: SplitMode::Outline,
            daily_notes: true,
            unlinked_files: true,
            collisions: Collision::KeepBoth,
            parent_project: None,
            batch_size: 200,
        }
    }
}

/// Where the imported pages go inside the destination database.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Destination {
    /// At the top level (a new notebook created for the import).
    Root,
    /// Into a new top-level Project ("Imported from … (date)").
    NewProject { name: Option<String> },
}

/// What to read.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceSpec {
    pub kind: SourceKind,
    pub paths: Vec<PathBuf>,
}

/// Database access for the writer: the CLI passes its `Database`; the app
/// passes a wrapper that takes its mutex per batch (so the UI stays live).
pub trait DbAccess {
    fn with<R>(&self, f: &mut dyn FnMut(&Database) -> Result<R>) -> Result<R>;
}

impl DbAccess for Database {
    fn with<R>(&self, f: &mut dyn FnMut(&Database) -> Result<R>) -> Result<R> {
        f(self)
    }
}

impl Model {
    /// Identity of the source for re-import (`import_origin`): the vault /
    /// folder name, or the `.enex` file names.
    pub fn origin(&self) -> String {
        match self.kind {
            SourceKind::Evernote => {
                // The .enex notebooks (leaf folders; a grouping parent isn't one).
                let mut v: Vec<&str> = self
                    .folders
                    .iter()
                    .filter(|f| !self.folders.iter().any(|g| g.parent.as_deref() == Some(f.path.as_str())))
                    .map(|f| f.name.as_str())
                    .collect();
                v.sort();
                format!("enex:{}", v.join("+"))
            }
            _ => self.name.clone(),
        }
    }
}

/// Guess the kind of a folder: a `.obsidian/` directory marks a vault.
pub fn detect(path: &Path) -> SourceKind {
    if path.is_file() {
        return SourceKind::Evernote;
    }
    if folder::is_obsidian_vault(path) {
        SourceKind::Obsidian
    } else {
        SourceKind::Markdown
    }
}

/// Read the source into the neutral model (no database involved).
pub fn scan(spec: &SourceSpec, opts: &ImportOptions, limits: &Limits, cancel: &AtomicBool, progress: &dyn Fn(Progress)) -> Result<Model> {
    match spec.kind {
        SourceKind::Evernote => enex::read(&spec.paths, opts.parent_project.as_deref(), limits, cancel, progress),
        k => {
            let root = spec.paths.first().ok_or_else(|| Error::InvalidInput("Choose a folder".into()))?;
            folder::read(root, &folder::FolderOptions { kind: k, daily_notes: opts.daily_notes }, limits, cancel, progress)
        }
    }
}

// ── Preview ──

#[derive(Debug, Clone, Serialize)]
pub struct TreeNode {
    pub name: String,
    /// "project" | "page" | "journal"
    pub kind: String,
    pub children: Vec<TreeNode>,
    /// Pages left out of this Project's listing (shown as "and N more").
    pub more: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct Sample {
    pub title: String,
    pub source_path: String,
    pub source: String,
    pub blocks: Vec<OutBlock>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Counts {
    pub notes: usize,
    pub pages: usize,
    pub journals: usize,
    pub folders: usize,
    pub attachments: usize,
    pub attachment_bytes: u64,
    pub total_bytes: u64,
    pub skipped: usize,
    pub reimport: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct Preview {
    pub source: SourceKind,
    pub source_label: String,
    pub source_name: String,
    pub counts: Counts,
    pub tree: Vec<TreeNode>,
    pub samples: Vec<Sample>,
    pub warnings: Vec<WarningEntry>,
    pub title_mappings: Vec<(String, String)>,
}

const TREE_PAGES_PER_PROJECT: usize = 40;

/// Resolve without a destination (or with `taken` titles) and describe it.
pub fn preview(model: &Model, opts: &ImportOptions, taken: &dyn Fn(&str) -> bool, reimport: &std::collections::HashMap<String, String>) -> Preview {
    let r = resolve::resolve(
        model,
        &resolve::ResolveCtx { title_taken: taken, reimport, collisions: opts.collisions, unlinked_files: opts.unlinked_files },
    );
    preview_resolved(model, &r, opts)
}

pub fn preview_resolved(model: &Model, r: &Resolved, opts: &ImportOptions) -> Preview {
    let mut counts = Counts {
        notes: model.notes.iter().filter(|n| n.kind == NoteKind::Note).count(),
        folders: model.folders.len(),
        total_bytes: model.total_bytes,
        ..Default::default()
    };
    for (i, a) in model.attachments.iter().enumerate() {
        if r.attachment_used.get(i).copied().unwrap_or(false) && !a.skipped {
            counts.attachments += 1;
            counts.attachment_bytes += a.size;
        }
    }
    // Tree: Projects (source folders) with their pages.
    let mut by_folder: BTreeMap<Option<String>, Vec<(String, bool)>> = BTreeMap::new();
    for n in &r.notes {
        if n.skipped {
            counts.skipped += 1;
            continue;
        }
        if n.reimport {
            counts.reimport += 1;
        }
        counts.pages += 1;
        if n.journal.is_some() {
            counts.journals += 1;
        }
        by_folder.entry(n.folder.clone()).or_default().push((n.title.clone(), n.journal.is_some()));
    }
    fn build(path: Option<&str>, model: &Model, by_folder: &BTreeMap<Option<String>, Vec<(String, bool)>>) -> Vec<TreeNode> {
        let mut out = Vec::new();
        for f in model.folders.iter().filter(|f| f.parent.as_deref() == path) {
            let mut node = TreeNode { name: f.name.clone(), kind: "project".into(), children: build(Some(&f.path), model, by_folder), more: 0 };
            let pages = by_folder.get(&Some(f.path.clone())).cloned().unwrap_or_default();
            push_pages(&mut node, pages);
            out.push(node);
        }
        out
    }
    fn push_pages(node: &mut TreeNode, mut pages: Vec<(String, bool)>) {
        pages.sort();
        let total = pages.len();
        for (t, j) in pages.into_iter().take(TREE_PAGES_PER_PROJECT) {
            node.children.push(TreeNode { name: t, kind: if j { "journal".into() } else { "page".into() }, children: vec![], more: 0 });
        }
        node.more = total.saturating_sub(TREE_PAGES_PER_PROJECT);
    }
    let mut root = TreeNode { name: model.name.clone(), kind: "project".into(), children: build(None, model, &by_folder), more: 0 };
    push_pages(&mut root, by_folder.get(&None).cloned().unwrap_or_default());

    // Samples: the three notes that exercise the most conversions.
    let mut scored: Vec<(usize, &resolve::ResolvedNote)> = r
        .notes
        .iter()
        .filter(|n| !n.skipped && n.kind == NoteKind::Note && n.src.is_some())
        .map(|n| {
            let b = &n.body;
            let score = b.matches("[[").count() + b.matches("](").count() * 2 + b.matches("\n#").count() + b.matches("- [").count()
                + b.matches("((").count() * 3 + b.matches('>').count().min(3);
            (score, n)
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.key.cmp(&b.1.key)));
    let samples = scored
        .into_iter()
        .take(3)
        .map(|(_, n)| {
            let src = &model.notes[n.src.unwrap()];
            let shown = sample_body(&n.body, model);
            let mut blocks = split::split(&shown, opts.split);
            for b in &mut blocks {
                // Obsidian block anchors are stripped on import.
                if let Some(pos) = b.content.rfind(" ^") {
                    let id = &b.content[pos + 2..];
                    if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                        b.content.truncate(pos);
                    }
                }
            }
            Sample { title: n.title.clone(), source_path: n.key.clone(), source: src.source_excerpt.clone(), blocks }
        })
        .collect();
    Preview {
        source: model.kind,
        source_label: model.kind.label().into(),
        source_name: model.name.clone(),
        counts,
        tree: vec![root],
        samples,
        warnings: r.warnings.list(),
        title_mappings: r.title_mappings.clone(),
    }
}

/// Placeholders as the user will see them.
fn sample_body(body: &str, model: &Model) -> String {
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    const P: &str = "](minotes-att:";
    while let Some(i) = rest.find(P) {
        out.push_str(&rest[..i]);
        let after = &rest[i + P.len()..];
        let d = after.chars().take_while(|c| c.is_ascii_digit()).count();
        let idx: usize = after[..d].parse().unwrap_or(usize::MAX);
        let name = model.attachments.get(idx).map(|a| crate::repo::attachments::encode_name(&a.name)).unwrap_or_default();
        out.push_str(&format!("](attachment:…/{name}"));
        rest = &after[d..];
    }
    out.push_str(rest);
    let mut s = String::new();
    let mut rest = out.as_str();
    while let Some(i) = rest.find("((minotes-blockref:") {
        s.push_str(&rest[..i]);
        let after = &rest[i..];
        let end = after.find("))").map(|e| e + 2).unwrap_or(after.len());
        s.push_str("((block reference))");
        rest = &after[end..];
    }
    s.push_str(rest);
    s
}

/// Preview against a destination database (titles in use, earlier imports).
pub fn preview_for<A: DbAccess>(acc: &A, model: &Model, opts: &ImportOptions) -> Result<Preview> {
    let prep = writer::prepare(acc, model, opts)?;
    Ok(preview_resolved(model, &prep.resolved, opts))
}

/// Resolve against the destination and write. Cancelling (`cancel` set) rolls
/// everything back and returns an error for which [`is_cancelled`] is true.
pub fn import<A: DbAccess>(
    acc: &A,
    model: &Model,
    opts: &ImportOptions,
    dest: &Destination,
    cancel: &AtomicBool,
    progress: &dyn Fn(Progress),
) -> Result<ImportReport> {
    let prep = writer::prepare(acc, model, opts)?;
    writer::write(acc, prep, opts, dest, cancel, progress)
}

/// Undo an import run (see [`undo::undo_run`]).
pub fn undo(db: &Database, run: &str, keep_edited: bool) -> Result<UndoReport> {
    undo::undo_run(db, run, keep_edited, false)
}

impl Database {
    /// Idempotent migration: the import run log.
    pub fn migrate_import_runs(&self) -> Result<()> {
        self.conn.execute_batch(writer::RUNS_SCHEMA)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
