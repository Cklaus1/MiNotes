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

        // YAML frontmatter
        if !properties.is_empty() || page.is_journal || page.folder_id.is_some() {
            md.push_str("---\n");
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

        // Render blocks as bullet list
        for block in &blocks {
            let depth = if block.parent_id.is_some() { 1 } else { 0 };
            let indent = "  ".repeat(depth);
            md.push_str(&format!("{indent}- {}\n", block.content));
        }

        Ok(md)
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

            // Split content into blocks by line, skip frontmatter
            let lines = strip_frontmatter(&content);
            for line in lines {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                // Strip leading bullet markers
                let clean = trimmed
                    .strip_prefix("- ")
                    .or_else(|| trimmed.strip_prefix("* "))
                    .or_else(|| trimmed.strip_prefix("+ "))
                    .unwrap_or(trimmed);
                if !clean.is_empty() {
                    self.create_block(&page.id, clean, None, None, actor)?;
                }
            }

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
        let mut count = 0;
        for line in lines {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let clean = trimmed
                .strip_prefix("- ")
                .or_else(|| trimmed.strip_prefix("* "))
                .or_else(|| trimmed.strip_prefix("+ "))
                .unwrap_or(trimmed);
            if !clean.is_empty() {
                self.create_block(&page.id, clean, None, None, actor)?;
                count += 1;
            }
        }

        Ok(format!("Imported {count} blocks into '{title}'"))
    }
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
