use std::fs;
use std::path::Path;

use crate::db::Database;
use crate::error::Result;

impl Database {
    /// Export entire graph as markdown files into a directory,
    /// mirroring the folder hierarchy as real filesystem directories.
    pub fn export_markdown(&self, output_dir: &Path) -> Result<Vec<String>> {
        fs::create_dir_all(output_dir)
            .map_err(|e| crate::error::Error::InvalidInput(format!("Cannot create dir: {e}")))?;

        // Build a map of folder_id -> filesystem path
        let mut folder_paths: std::collections::HashMap<String, std::path::PathBuf> =
            std::collections::HashMap::new();
        self.build_folder_paths(output_dir, None, &mut folder_paths)?;

        let pages = self.list_pages(Some(10000))?;
        let mut exported = Vec::new();

        for page in &pages {
            // Determine target directory from folder_id
            let target_dir = match &page.folder_id {
                Some(fid) => folder_paths
                    .get(&fid.to_string())
                    .cloned()
                    .unwrap_or_else(|| output_dir.to_path_buf()),
                None => output_dir.to_path_buf(),
            };
            fs::create_dir_all(&target_dir)
                .map_err(|e| crate::error::Error::InvalidInput(format!("Cannot create dir: {e}")))?;

            let md = self.render_page_markdown(page)?;

            let filename = sanitize_filename(&page.title);
            let filepath = target_dir.join(format!("{filename}.md"));
            fs::write(&filepath, &md)
                .map_err(|e| crate::error::Error::InvalidInput(format!("Write failed: {e}")))?;
            exported.push(filepath.display().to_string());
        }

        Ok(exported)
    }

    /// Recursively build folder_id -> filesystem path mapping.
    fn build_folder_paths(
        &self,
        base: &Path,
        parent_id: Option<&uuid::Uuid>,
        map: &mut std::collections::HashMap<String, std::path::PathBuf>,
    ) -> Result<()> {
        let folders = self.list_folders(parent_id)?;
        for folder in &folders {
            let dir_name = sanitize_filename(&folder.name);
            let dir_path = base.join(&dir_name);
            fs::create_dir_all(&dir_path)
                .map_err(|e| crate::error::Error::InvalidInput(format!("Cannot create dir: {e}")))?;
            map.insert(folder.id.to_string(), dir_path.clone());
            self.build_folder_paths(&dir_path, Some(&folder.id), map)?;
        }
        Ok(())
    }

    /// Render a page as markdown with YAML frontmatter.
    fn render_page_markdown(&self, page: &crate::models::Page) -> Result<String> {
        let blocks = self.get_page_blocks(&page.id)?;
        let properties = self.get_properties(&page.id)?;

        let mut md = String::new();

        // YAML frontmatter. Always emit a frontmatter block carrying the stable page
        // UUID (Bug #3) so import reconciles by identity, not by title/filename.
        {
            md.push_str("---\n");
            md.push_str(&format!("id: {}\n", page.id));
            md.push_str(&format!("title: \"{}\"\n", page.title));
            if page.is_journal {
                md.push_str("type: journal\n");
                if let Some(ref d) = page.journal_date {
                    md.push_str(&format!("date: {d}\n"));
                }
            }
            for prop in &properties {
                if let Some(ref v) = prop.value {
                    md.push_str(&format!("{}: {v}\n", prop.key));
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
            let escaped_title = xml_escape(&page.title);
            opml.push_str(&format!("    <outline text=\"{}\">\n", escaped_title));
            for block in &blocks {
                let escaped = xml_escape(&block.content);
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

            let title = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Untitled")
                .to_string();

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

fn sanitize_filename(name: &str) -> String {
    name.replace('/', "_")
        .replace('\\', "_")
        .replace(':', "_")
        .replace('*', "_")
        .replace('?', "_")
        .replace('"', "_")
        .replace('<', "_")
        .replace('>', "_")
        .replace('|', "_")
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
