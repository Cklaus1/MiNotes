use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::db::Database;
use crate::error::Result;
use crate::models::Page;

/// Directory (inside a sync dir) that receives stale/superseded `.md` files instead
/// of deleting them outright. Dot-prefixed, so the importer never reads it.
pub const SYNC_TRASH_DIR: &str = ".minotes-trash";
/// Manifest of page ids written by the last synced export (one per line). Lets the
/// pruner tell "a page we exported that has since been permanently deleted" apart
/// from "a page that arrived from a remote but has not been imported yet".
pub const EXPORT_MANIFEST: &str = ".minotes-exported";

/// Page frontmatter keys owned by the exporter; never treated as properties.
pub(crate) const RESERVED_FM_KEYS: &[&str] = &["id", "title", "type", "date"];

/// Result of a sync-aware export.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct ExportReport {
    pub written: Vec<String>,
    /// Relative paths of stale files moved into `.minotes-trash/`.
    pub pruned: Vec<String>,
}

/// Where each page / folder lands on disk, relative to the export root.
pub(crate) struct ExportPlan {
    pub(crate) folder_dirs: Vec<PathBuf>,
    pub(crate) pages: Vec<(Page, PathBuf)>,
    pub(crate) archived_ids: HashSet<Uuid>,
}

impl Database {
    /// Export entire graph as markdown files into a directory,
    /// mirroring the folder hierarchy as real filesystem directories.
    pub fn export_markdown(&self, output_dir: &Path) -> Result<Vec<String>> {
        Ok(self.export_markdown_inner(output_dir, false)?.written)
    }

    /// Export for sync: like `export_markdown`, but afterwards moves every stale
    /// `.md` (a renamed/moved page's old file, a trashed or deleted page's file) into
    /// `.minotes-trash/`, so a stale copy can never be re-imported and revert the DB.
    pub fn export_markdown_synced(&self, output_dir: &Path) -> Result<ExportReport> {
        self.export_markdown_inner(output_dir, true)
    }

    fn export_markdown_inner(&self, output_dir: &Path, prune: bool) -> Result<ExportReport> {
        fs::create_dir_all(output_dir)
            .map_err(|e| crate::error::Error::InvalidInput(format!("Cannot create dir: {e}")))?;

        let plan = self.plan_export_paths()?;
        for rel in &plan.folder_dirs {
            let dir = safe_join(output_dir, rel)?;
            fs::create_dir_all(&dir)
                .map_err(|e| crate::error::Error::InvalidInput(format!("Cannot create dir: {e}")))?;
        }

        let mut report = ExportReport::default();
        for (page, rel) in &plan.pages {
            let filepath = safe_join(output_dir, rel)?;
            if let Some(parent) = filepath.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| crate::error::Error::InvalidInput(format!("Cannot create dir: {e}")))?;
            }
            let md = self.render_page_markdown(page)?;
            // Skip unchanged files so mtimes stay meaningful (used to break ties).
            let unchanged = fs::read_to_string(&filepath).map(|c| c == md).unwrap_or(false);
            if !unchanged {
                fs::write(&filepath, &md)
                    .map_err(|e| crate::error::Error::InvalidInput(format!("Write failed: {e}")))?;
            }
            report.written.push(filepath.display().to_string());
        }

        if prune {
            report.pruned = self.prune_stale_files(output_dir, &plan)?;
        }
        Ok(report)
    }

    /// Compute a deterministic, collision-free export path for every live page.
    /// Names are unique per directory case-insensitively (macOS/Windows), and ties
    /// are broken by page id so every device picks the same name.
    pub(crate) fn plan_export_paths(&self) -> Result<ExportPlan> {
        let mut taken: HashMap<PathBuf, HashSet<String>> = HashMap::new();
        let mut folder_map: HashMap<Uuid, PathBuf> = HashMap::new();
        let mut folder_dirs = Vec::new();
        self.plan_folder_dirs(Path::new(""), None, &mut taken, &mut folder_map, &mut folder_dirs, 0)?;

        let mut pages = self.list_pages(Some(1_000_000))?;
        pages.sort_by_key(|p| p.id);
        let mut out = Vec::with_capacity(pages.len());
        for page in pages {
            let dir = page
                .folder_id
                .and_then(|f| folder_map.get(&f).cloned())
                .unwrap_or_default();
            let base = sanitize_component(&page.title);
            let set = taken.entry(dir.clone()).or_default();
            let name = unique_name(&base, ".md", &page.id, set);
            out.push((page, dir.join(name)));
        }

        let mut archived_ids = HashSet::new();
        let mut stmt = self.conn.prepare("SELECT page_id FROM archive")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        for r in rows {
            if let Ok(id) = Uuid::parse_str(&r?) {
                archived_ids.insert(id);
            }
        }
        Ok(ExportPlan { folder_dirs, pages: out, archived_ids })
    }

    fn plan_folder_dirs(
        &self,
        base: &Path,
        parent_id: Option<&Uuid>,
        taken: &mut HashMap<PathBuf, HashSet<String>>,
        map: &mut HashMap<Uuid, PathBuf>,
        dirs: &mut Vec<PathBuf>,
        depth: usize,
    ) -> Result<()> {
        if depth > 64 {
            return Ok(()); // guard against a folder parent cycle
        }
        let mut folders = self.list_folders(parent_id)?;
        folders.sort_by_key(|f| f.id);
        for folder in &folders {
            let set = taken.entry(base.to_path_buf()).or_default();
            let name = unique_name(&sanitize_component(&folder.name), "", &folder.id, set);
            let dir_path = base.join(&name);
            map.insert(folder.id, dir_path.clone());
            dirs.push(dir_path.clone());
            self.plan_folder_dirs(&dir_path, Some(&folder.id), taken, map, dirs, depth + 1)?;
        }
        Ok(())
    }

    /// Move stale `.md` files into `.minotes-trash/` (see `export_markdown_synced`).
    /// A file is stale when its frontmatter id belongs to a page that is trashed,
    /// lives at a different path now, or was exported before but no longer exists.
    /// Files with an id this DB has never seen are left alone: they may be pages
    /// pulled from a remote that simply haven't been imported yet.
    fn prune_stale_files(&self, root: &Path, plan: &ExportPlan) -> Result<Vec<String>> {
        let expected: HashMap<Uuid, &PathBuf> = plan.pages.iter().map(|(p, rel)| (p.id, rel)).collect();
        let mut known: HashSet<Uuid> = HashSet::new();
        let mut trashed: HashSet<Uuid> = HashSet::new();
        {
            let mut stmt = self.conn.prepare(
                "SELECT id, id IN (SELECT page_id FROM trash) FROM pages",
            )?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?)))?;
            for r in rows {
                let (id, is_trashed) = r?;
                if let Ok(id) = Uuid::parse_str(&id) {
                    known.insert(id);
                    if is_trashed {
                        trashed.insert(id);
                    }
                }
            }
        }
        let manifest_path = root.join(EXPORT_MANIFEST);
        let previously_exported: HashSet<Uuid> = fs::read_to_string(&manifest_path)
            .map(|s| s.lines().filter_map(|l| Uuid::parse_str(l.trim()).ok()).collect())
            .unwrap_or_default();

        let scan = crate::repo::sync::scan_markdown_tree(root);
        let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.3f").to_string();
        let mut pruned = Vec::new();
        for file in &scan.files {
            let Ok(content) = fs::read_to_string(&file.abs) else { continue };
            let Some(id) = crate::repo::sync::parse_frontmatter_id(&content) else { continue };
            let stale = if trashed.contains(&id) {
                true
            } else if let Some(exp) = expected.get(&id) {
                file.rel != **exp
            } else if known.contains(&id) {
                false // archived: not exported, leave its file untouched
            } else {
                previously_exported.contains(&id) // permanently deleted locally
            };
            if !stale {
                continue;
            }
            let mut dest = root.join(SYNC_TRASH_DIR).join(&stamp).join(&file.rel);
            if dest.exists() {
                dest = dest.with_extension(format!("{}.md", Uuid::now_v7().simple()));
            }
            if let Some(parent) = dest.parent() {
                let _ = fs::create_dir_all(parent);
            }
            match fs::rename(&file.abs, &dest) {
                Ok(()) => pruned.push(file.rel.display().to_string()),
                Err(e) => eprintln!("[minotes-sync] could not prune stale {}: {e}", file.abs.display()),
            }
        }

        // Remove directories left empty that no longer correspond to a folder, so an
        // old (renamed) folder name can't be resurrected on the next import.
        let wanted: HashSet<PathBuf> = plan
            .folder_dirs
            .iter()
            .flat_map(|d| d.ancestors().map(Path::to_path_buf).collect::<Vec<_>>())
            .collect();
        let mut dirs = scan.dirs.clone();
        dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
        for d in dirs {
            if !wanted.contains(&d) {
                let _ = fs::remove_dir(root.join(&d)); // only succeeds when empty
            }
        }

        let mut ids: Vec<String> = plan.pages.iter().map(|(p, _)| p.id.to_string()).collect();
        ids.extend(plan.archived_ids.iter().filter(|i| known.contains(i)).map(|i| i.to_string()));
        ids.sort();
        let _ = fs::write(&manifest_path, ids.join("\n") + "\n");
        Ok(pruned)
    }

    /// Render a page as markdown with YAML frontmatter.
    fn render_page_markdown(&self, page: &crate::models::Page) -> Result<String> {
        let blocks = self.get_page_blocks(&page.id)?;
        let properties = self.get_properties(&page.id)?;

        let mut md = String::new();

        // YAML frontmatter. Always emit a frontmatter block carrying the stable page
        // UUID (Bug #3) so import reconciles by identity, not by title/filename.
        // The title is written as a JSON (= YAML double-quoted) string so quotes,
        // colons and newlines survive; import prefers it over the lossy filename.
        {
            md.push_str("---\n");
            md.push_str(&format!("id: {}\n", page.id));
            md.push_str(&format!("title: {}\n", quote_fm_value(&page.title, true)));
            if page.is_journal {
                md.push_str("type: journal\n");
                if let Some(ref d) = page.journal_date {
                    md.push_str(&format!("date: {d}\n"));
                }
            }
            for prop in &properties {
                let key = prop.key.trim();
                if key.is_empty()
                    || key.contains(':')
                    || key.contains('\n')
                    || key.contains('\r')
                    || key.starts_with("---")
                    || RESERVED_FM_KEYS.contains(&key)
                {
                    continue; // not representable as a frontmatter key
                }
                if let Some(ref v) = prop.value {
                    md.push_str(&format!("{key}: {}\n", quote_fm_value(v, false)));
                }
            }
            md.push_str("---\n\n");
        }

        // Bug #12: emit blocks depth-first by walking the parent→children tree, with
        // children sorted by position WITHIN each parent. The previous code iterated
        // the globally position-ordered flat list and only computed indent depth, so
        // a child at position 1.0 could sort ahead of a root sibling at 2.0 and the
        // outline order scrambled. Build the tree and walk it instead.
        use std::collections::HashMap;
        let mut children: HashMap<Option<uuid::Uuid>, Vec<&crate::models::Block>> = HashMap::new();
        for block in &blocks {
            children.entry(block.parent_id).or_default().push(block);
        }
        for kids in children.values_mut() {
            kids.sort_by(|a, b| a.position.partial_cmp(&b.position).unwrap_or(std::cmp::Ordering::Equal));
        }

        // Iterative DFS (explicit stack) to avoid recursion-depth limits on deep trees.
        let mut stack: Vec<(Option<uuid::Uuid>, usize)> = Vec::new();
        if let Some(roots) = children.get(&None) {
            for root in roots.iter().rev() {
                stack.push((Some(root.id), 0));
            }
        }
        let mut emitted = 0usize;
        while let Some((Some(id), depth)) = stack.pop() {
            if let Some(block) = blocks.iter().find(|b| b.id == id) {
                md.push_str(&render_block_lines(&block.content, depth, &block.id));
                emitted += 1;
            }
            if let Some(kids) = children.get(&Some(id)) {
                for child in kids.iter().rev() {
                    stack.push((Some(child.id), depth + 1));
                }
            }
            if emitted > 100_000 { break; } // safety cap against cycles
        }

        Ok(md)
    }

    /// Export entire graph as OPML (outline format).
    pub fn export_opml(&self) -> Result<String> {
        let pages = self.list_pages(Some(10000))?;
        let mut opml = String::new();
        opml.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
        opml.push_str("<opml version=\"2.0\">\n");
        opml.push_str("  <head>\n");
        opml.push_str("    <title>MiNotes Export</title>\n");
        opml.push_str(&format!("    <dateCreated>{}</dateCreated>\n", chrono::Utc::now().to_rfc2822()));
        opml.push_str("  </head>\n");
        opml.push_str("  <body>\n");

        for page in &pages {
            let blocks = self.get_page_blocks(&page.id)?;
            let escaped_title = xml_escape_attr(&page.title);
            opml.push_str(&format!("    <outline text=\"{}\">\n", escaped_title));
            for block in &blocks {
                let escaped = xml_escape_attr(&block.content);
                opml.push_str(&format!("      <outline text=\"{}\"/>\n", escaped));
            }
            opml.push_str("    </outline>\n");
        }

        opml.push_str("  </body>\n");
        opml.push_str("</opml>\n");
        Ok(opml)
    }

    /// Export entire graph as a single JSON object.
    pub fn export_json(&self) -> Result<serde_json::Value> {
        let pages = self.list_pages(Some(10000))?;
        let mut pages_with_blocks = Vec::new();

        for page in &pages {
            let blocks = self.get_page_blocks(&page.id)?;
            let properties = self.get_properties(&page.id)?;
            pages_with_blocks.push(serde_json::json!({
                "page": page,
                "blocks": blocks,
                "properties": properties,
            }));
        }

        Ok(serde_json::json!({
            "version": "1.0",
            "exported_at": chrono::Utc::now().to_rfc3339(),
            "pages": pages_with_blocks,
        }))
    }

    /// Parse markdown body text into blocks (hierarchy + multi-line continuations)
    /// and create them under `page_id`. Shared by the directory and single-file
    /// importers so the export→import round-trip is faithful (Bug #12, #13).
    fn import_blocks_into_page(&self, page_id: &uuid::Uuid, body: &[&str], actor: &str) -> Result<usize> {
        let parsed = crate::repo::sync::parse_markdown_blocks(body);
        // Recreate parent_id from indent depth using an ancestor stack (mirrors
        // create_blocks_with_hierarchy, but counts created blocks locally).
        let mut stack: Vec<(usize, uuid::Uuid)> = Vec::new();
        let mut count = 0usize;
        for pb in &parsed {
            while let Some(&(d, _)) = stack.last() {
                if d >= pb.depth { stack.pop(); } else { break; }
            }
            let parent = stack.last().map(|(_, id)| *id);
            // Bug #1: preserve stable block id if the marker was present.
            let block = match pb.id {
                Some(id) => self.create_block_with_id(id, page_id, &pb.content, parent.as_ref(), None, actor)?,
                None => self.create_block(page_id, &pb.content, parent.as_ref(), None, actor)?,
            };
            count += 1;
            stack.push((pb.depth, block.id));
        }
        Ok(count)
    }

    /// Import markdown files from a directory into the graph.
    pub fn import_markdown_dir(&self, input_dir: &Path, actor: &str) -> Result<Vec<String>> {
        let mut imported = Vec::new();

        let entries = fs::read_dir(input_dir)
            .map_err(|e| crate::error::Error::InvalidInput(format!("Cannot read dir: {e}")))?;

        for entry in entries {
            let entry = entry
                .map_err(|e| crate::error::Error::InvalidInput(format!("Dir entry error: {e}")))?;
            let path = entry.path();

            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }

            let content = fs::read_to_string(&path)
                .map_err(|e| crate::error::Error::InvalidInput(format!("Read failed: {e}")))?;

            // Prefer the frontmatter title: filenames are a lossy encoding of it.
            let title = crate::repo::sync::parse_frontmatter(&content)
                .title
                .unwrap_or_else(|| {
                    path.file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("Untitled")
                        .to_string()
                });

            // Skip if page already exists
            if self.get_page_by_title(&title)?.is_some() {
                continue;
            }

            let page = self.create_page(&title, None, false, None, actor)?;

            // Parse blocks preserving hierarchy + multi-line content (Bug #12, #13).
            let lines = strip_frontmatter(&content);
            self.import_blocks_into_page(&page.id, &lines, actor)?;

            imported.push(title);
        }

        Ok(imported)
    }

    /// Import a single markdown file.
    pub fn import_markdown_file(&self, file_path: &Path, target_title: Option<&str>, actor: &str) -> Result<String> {
        let content = fs::read_to_string(file_path)
            .map_err(|e| crate::error::Error::InvalidInput(format!("Read failed: {e}")))?;

        let title = target_title
            .map(String::from)
            .unwrap_or_else(|| {
                file_path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Untitled")
                    .to_string()
            });

        let page = if let Some(existing) = self.get_page_by_title(&title)? {
            existing
        } else {
            self.create_page(&title, None, false, None, actor)?
        };

        let lines = strip_frontmatter(&content);
        let count = self.import_blocks_into_page(&page.id, &lines, actor)?;

        Ok(format!("Imported {count} blocks into '{title}'"))
    }

    /// Import an Org-mode file, converting headings and content to pages and blocks.
    pub fn import_org_file(&self, file_path: &Path, actor: &str) -> Result<String> {
        let content = fs::read_to_string(file_path)
            .map_err(|e| crate::error::Error::InvalidInput(format!("Read failed: {e}")))?;

        let title = file_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Untitled")
            .to_string();

        let page = if let Some(existing) = self.get_page_by_title(&title)? {
            existing
        } else {
            self.create_page(&title, None, false, None, actor)?
        };

        let mut count = 0;
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            // Convert org headings (* / ** / ***) to markdown headings
            let clean = if trimmed.starts_with("*** ") {
                format!("### {}", &trimmed[4..])
            } else if trimmed.starts_with("** ") {
                format!("## {}", &trimmed[3..])
            } else if trimmed.starts_with("* ") {
                format!("# {}", &trimmed[2..])
            } else if trimmed.starts_with("- ") || trimmed.starts_with("+ ") {
                trimmed.to_string()
            } else if trimmed.starts_with("#+") {
                // Skip org-mode directives
                continue;
            } else {
                trimmed.to_string()
            };
            if !clean.is_empty() {
                self.create_block(&page.id, &clean, None, None, actor)?;
                count += 1;
            }
        }

        Ok(format!("Imported {count} blocks from org-mode into '{title}'"))
    }

    /// Export a page to Org-mode format.
    pub fn export_org(&self, page_id: &uuid::Uuid) -> Result<String> {
        let page = self.get_page(page_id)?
            .ok_or_else(|| crate::error::Error::NotFound("Page not found".into()))?;
        let blocks = self.get_page_blocks(page_id)?;
        let properties = self.get_properties(page_id)?;

        let mut org = String::new();
        // Org-mode properties drawer
        if !properties.is_empty() {
            org.push_str(":PROPERTIES:\n");
            org.push_str(&format!(":TITLE: {}\n", page.title));
            for prop in &properties {
                if let Some(ref v) = prop.value {
                    org.push_str(&format!(":{}: {v}\n", prop.key.to_uppercase()));
                }
            }
            org.push_str(":END:\n\n");
        }

        for block in &blocks {
            let c = &block.content;
            // Convert markdown headings back to org
            if c.starts_with("### ") {
                org.push_str(&format!("*** {}\n", &c[4..]));
            } else if c.starts_with("## ") {
                org.push_str(&format!("** {}\n", &c[3..]));
            } else if c.starts_with("# ") {
                org.push_str(&format!("* {}\n", &c[2..]));
            } else {
                org.push_str(&format!("{c}\n"));
            }
        }

        Ok(org)
    }

    /// Generate a static HTML site from the graph.
    pub fn publish_static_site(&self, output_dir: &Path) -> Result<Vec<String>> {
        fs::create_dir_all(output_dir)
            .map_err(|e| crate::error::Error::InvalidInput(format!("Cannot create dir: {e}")))?;

        let pages = self.list_pages(Some(10000))?;
        let mut published = Vec::new();

        // Write index.html
        let mut index_html = String::new();
        index_html.push_str("<!DOCTYPE html><html><head><meta charset=\"utf-8\">\n");
        index_html.push_str("<title>MiNotes</title>\n");
        index_html.push_str("<style>body{font-family:system-ui;max-width:800px;margin:0 auto;padding:20px;background:#1e1e2e;color:#cdd6f4}");
        index_html.push_str("a{color:#89b4fa}h1{border-bottom:1px solid #45475a;padding-bottom:8px}");
        index_html.push_str("ul{list-style:none;padding:0}li{padding:4px 0}</style>\n");
        index_html.push_str("</head><body>\n<h1>MiNotes</h1>\n<ul>\n");
        for page in &pages {
            if page.is_journal { continue; }
            let slug = sanitize_filename(&page.title);
            index_html.push_str(&format!("<li><a href=\"{slug}.html\">{}</a></li>\n", xml_escape(&page.title)));
        }
        index_html.push_str("</ul>\n</body></html>");
        let index_path = output_dir.join("index.html");
        fs::write(&index_path, &index_html)
            .map_err(|e| crate::error::Error::InvalidInput(format!("Write failed: {e}")))?;
        published.push("index.html".to_string());

        // Write individual page HTMLs
        for page in &pages {
            let blocks = self.get_page_blocks(&page.id)?;
            let slug = sanitize_filename(&page.title);

            let mut html = String::new();
            html.push_str("<!DOCTYPE html><html><head><meta charset=\"utf-8\">\n");
            html.push_str(&format!("<title>{}</title>\n", xml_escape(&page.title)));
            html.push_str("<style>body{font-family:system-ui;max-width:800px;margin:0 auto;padding:20px;background:#1e1e2e;color:#cdd6f4}");
            html.push_str("a{color:#89b4fa}pre{background:#181825;padding:12px;border-radius:6px;overflow-x:auto}");
            html.push_str("code{background:#313244;padding:2px 4px;border-radius:3px}</style>\n");
            html.push_str("</head><body>\n");
            html.push_str(&format!("<p><a href=\"index.html\">← Back</a></p>\n"));
            html.push_str(&format!("<h1>{}</h1>\n", xml_escape(&page.title)));

            for block in &blocks {
                let escaped = xml_escape(&block.content);
                // Simple markdown-to-HTML conversion for publishing
                if escaped.starts_with("# ") {
                    html.push_str(&format!("<h2>{}</h2>\n", &escaped[2..]));
                } else if escaped.starts_with("## ") {
                    html.push_str(&format!("<h3>{}</h3>\n", &escaped[3..]));
                } else if escaped.starts_with("- [ ] ") {
                    html.push_str(&format!("<p>☐ {}</p>\n", &escaped[6..]));
                } else if escaped.starts_with("- [x] ") {
                    html.push_str(&format!("<p>☑ {}</p>\n", &escaped[6..]));
                } else {
                    html.push_str(&format!("<p>{escaped}</p>\n"));
                }
            }

            html.push_str("</body></html>");
            let file_path = output_dir.join(format!("{slug}.html"));
            fs::write(&file_path, &html)
                .map_err(|e| crate::error::Error::InvalidInput(format!("Write failed: {e}")))?;
            published.push(format!("{slug}.html"));
        }

        Ok(published)
    }
}

/// Render one block as a bullet at `depth`, encoding multi-line content safely
/// (Bug #13). The first line follows `- `; any further lines are written as
/// continuation lines indented two spaces DEEPER than a child bullet and WITHOUT a
/// bullet marker, so the importer folds them back into a single block instead of
/// splitting one block into several.
fn render_block_lines(content: &str, depth: usize, id: &uuid::Uuid) -> String {
    let bullet_indent = "  ".repeat(depth);
    // Continuation lines are indented one level deeper than this block's *children*
    // would be, and carry no bullet, so they're unambiguous on import.
    let cont_indent = "  ".repeat(depth + 1);
    let mut out = String::new();
    let mut lines = content.split('\n');
    let first = lines.next().unwrap_or("");
    // Bug #1: append a stable id marker on the first line. Continuation lines come
    // after, so the marker sits at the end of the block's first line only.
    out.push_str(&format!("{bullet_indent}- {first} <!-- id:{id} -->\n"));
    for line in lines {
        // Mark continuations with a zero-width-safe sentinel: deeper indent + no
        // bullet. A literal empty line is preserved as an empty continuation.
        out.push_str(&format!("{cont_indent}\\ {line}\n"));
    }
    out
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Escape for an XML *attribute* value. Beyond the element-content escapes,
/// literal newlines/CR/tabs must become character references: XML parsers
/// normalize raw whitespace in attributes to spaces, so an unescaped newline
/// in `text="..."` silently mangles the value (or breaks the document).
fn xml_escape_attr(s: &str) -> String {
    xml_escape(s)
        .replace('\n', "&#10;")
        .replace('\r', "&#13;")
        .replace('\t', "&#9;")
}

fn sanitize_filename(name: &str) -> String {
    sanitize_component(name)
}

/// Turn an arbitrary page title / folder name into ONE safe path component.
/// Separators, reserved characters and control chars (incl. NUL) become `_`;
/// trailing dots/spaces are dropped (Windows); a name that is empty or starts with
/// `.` (`.`, `..`, `.git`, hidden) gets a `_` prefix so it can never escape the
/// sync dir, land in `.git`, or be skipped by the importer (which ignores
/// dot-folders). Long names are truncated to stay under filesystem limits.
pub(crate) fn sanitize_component(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    while s.ends_with('.') || s.ends_with(' ') {
        s.pop();
    }
    if s.is_empty() || s.starts_with('.') {
        s.insert(0, '_');
    }
    const MAX_BYTES: usize = 180;
    if s.len() > MAX_BYTES {
        let mut cut = MAX_BYTES;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
    }
    s
}

/// Pick `base + ext`, or `base--<id suffix> + ext` if that name is already taken in
/// this directory (compared case-insensitively). Records the chosen name.
fn unique_name(base: &str, ext: &str, id: &Uuid, taken: &mut HashSet<String>) -> String {
    let simple = id.simple().to_string();
    let candidates = [
        format!("{base}{ext}"),
        format!("{base}--{}{ext}", &simple[simple.len() - 8..]),
        format!("{base}--{simple}{ext}"),
    ];
    for c in candidates.iter() {
        if taken.insert(c.to_lowercase()) {
            return c.clone();
        }
    }
    let mut n = 2u32;
    loop {
        let c = format!("{base}--{simple}-{n}{ext}");
        if taken.insert(c.to_lowercase()) {
            return c;
        }
        n += 1;
    }
}

/// Join a planned relative path onto `root`, refusing anything that could escape it.
fn safe_join(root: &Path, rel: &Path) -> Result<PathBuf> {
    use std::path::Component;
    for c in rel.components() {
        match c {
            Component::Normal(n) if n != ".git" => {}
            _ => {
                return Err(crate::error::Error::InvalidInput(format!(
                    "Refusing unsafe export path: {}",
                    rel.display()
                )))
            }
        }
    }
    let full = root.join(rel);
    debug_assert!(full.starts_with(root));
    Ok(full)
}

/// Encode a frontmatter value. Titles are always JSON-quoted; property values only
/// when they would otherwise not round-trip (newlines, edge whitespace, quotes).
fn quote_fm_value(v: &str, always: bool) -> String {
    if always || v.contains('\n') || v.contains('\r') || v.starts_with('"') || v.trim() != v {
        serde_json::to_string(v).unwrap_or_else(|_| v.to_string())
    } else {
        v.to_string()
    }
}

fn strip_frontmatter(content: &str) -> Vec<&str> {
    let lines: Vec<&str> = content.lines().collect();
    if lines.first().map(|l| l.trim()) == Some("---") {
        // Find closing ---
        if let Some(end) = lines[1..].iter().position(|l| l.trim() == "---") {
            return lines[end + 2..].to_vec();
        }
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use std::io::Write;
    use tempfile::TempDir;

    fn temp_dir() -> TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn test_export_import_roundtrip() {
        let db = Database::open_in_memory().unwrap();
        db.create_page("Test Export", None, false, None, "user").unwrap();
        let page = db.get_page_by_title("Test Export").unwrap().unwrap();
        db.create_block(&page.id, "First block", None, None, "user").unwrap();
        db.create_block(&page.id, "Second block", None, None, "user").unwrap();

        let dir = temp_dir();
        let exported = db.export_markdown(dir.path()).unwrap();
        assert_eq!(exported.len(), 1);

        // Import into a fresh DB
        let db2 = Database::open_in_memory().unwrap();
        let imported = db2.import_markdown_dir(dir.path(), "user").unwrap();
        assert_eq!(imported, vec!["Test Export"]);

        let blocks = db2.get_page_blocks(&db2.get_page_by_title("Test Export").unwrap().unwrap().id).unwrap();
        assert_eq!(blocks.len(), 2);
    }

    #[test]
    fn test_export_json() {
        let db = Database::open_in_memory().unwrap();
        db.create_page("JSON Test", None, false, None, "user").unwrap();
        let json = db.export_json().unwrap();
        assert_eq!(json["pages"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn test_import_single_file() {
        let dir = temp_dir();
        let file = dir.path().join("notes.md");
        let mut f = fs::File::create(&file).unwrap();
        writeln!(f, "---\ntitle: Notes\n---\n\n- Alpha\n- Beta\n- Gamma").unwrap();

        let db = Database::open_in_memory().unwrap();
        let result = db.import_markdown_file(&file, None, "user").unwrap();
        assert!(result.contains("3 blocks"));
    }

    // Bug #12 + #13: hierarchy and multi-line block content survive an export→import
    // round-trip (order correct, nesting preserved, one block stays one block).
    #[test]
    fn test_roundtrip_preserves_hierarchy_and_multiline() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("Tree", None, false, None, "user").unwrap();
        let a = db.create_block(&page.id, "Parent A", None, None, "user").unwrap();
        db.create_block(&page.id, "Child A1", Some(&a.id), None, "user").unwrap();
        db.create_block(&page.id, "Child A2", Some(&a.id), None, "user").unwrap();
        // A root sibling AFTER the children — the old global position sort scrambled this.
        db.create_block(&page.id, "Root B", None, None, "user").unwrap();
        // A multi-line block (e.g. a fenced code block stored as one block).
        db.create_block(&page.id, "line one\nline two\nline three", None, None, "user").unwrap();

        let dir = temp_dir();
        db.export_markdown(dir.path()).unwrap();

        let db2 = Database::open_in_memory().unwrap();
        db2.import_markdown_dir(dir.path(), "user").unwrap();
        let imported = db2.get_page_by_title("Tree").unwrap().unwrap();
        let blocks = db2.get_page_blocks(&imported.id).unwrap();

        // 5 blocks, not split: Parent A, Child A1, Child A2, Root B, multi-line.
        assert_eq!(blocks.len(), 5, "multi-line block must not split: {:?}", blocks.iter().map(|b| &b.content).collect::<Vec<_>>());

        let parent = blocks.iter().find(|b| b.content == "Parent A").unwrap();
        let c1 = blocks.iter().find(|b| b.content == "Child A1").unwrap();
        let c2 = blocks.iter().find(|b| b.content == "Child A2").unwrap();
        assert_eq!(c1.parent_id, Some(parent.id), "Child A1 nested under Parent A");
        assert_eq!(c2.parent_id, Some(parent.id), "Child A2 nested under Parent A");
        let root_b = blocks.iter().find(|b| b.content == "Root B").unwrap();
        assert_eq!(root_b.parent_id, None, "Root B stays a root");
        let multi = blocks.iter().find(|b| b.content.contains("line two")).unwrap();
        assert_eq!(multi.content, "line one\nline two\nline three");
        assert_eq!(multi.parent_id, None);
    }

    #[test]
    fn test_export_respects_folder_hierarchy() {
        let db = Database::open_in_memory().unwrap();

        // Create folder structure: Work > Projects
        let work = db.create_folder("Work", None, None, None, "user").unwrap();
        let projects = db.create_folder("Projects", Some(&work.id), None, None, "user").unwrap();

        // Create pages in different locations
        let root_page = db.create_page("README", None, false, None, "user").unwrap();
        db.create_block(&root_page.id, "Root page", None, None, "user").unwrap();

        let work_page = db.create_page("Q1 Goals", None, false, None, "user").unwrap();
        db.move_page_to_folder(&work_page.id, Some(&work.id), "user").unwrap();
        db.create_block(&work_page.id, "Hit targets", None, None, "user").unwrap();

        let proj_page = db.create_page("Alpha", None, false, None, "user").unwrap();
        db.move_page_to_folder(&proj_page.id, Some(&projects.id), "user").unwrap();
        db.create_block(&proj_page.id, "Project Alpha notes", None, None, "user").unwrap();

        let dir = temp_dir();
        let exported = db.export_markdown(dir.path()).unwrap();
        assert_eq!(exported.len(), 3);

        // Verify filesystem structure
        assert!(dir.path().join("README.md").exists(), "Root page should be at root");
        assert!(dir.path().join("Work").is_dir(), "Work folder should exist");
        assert!(dir.path().join("Work/Q1 Goals.md").exists(), "Q1 Goals should be in Work/");
        assert!(dir.path().join("Work/Projects").is_dir(), "Projects subfolder should exist");
        assert!(dir.path().join("Work/Projects/Alpha.md").exists(), "Alpha should be in Work/Projects/");
    }
}
