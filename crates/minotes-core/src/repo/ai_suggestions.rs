use crate::db::Database;
use crate::error::Result;

/// Parse a single line for a *pending* TODO and return its text, or None.
///
/// Canonical detector shared by all TODO scans (Bug #23, #24). Mirrors the
/// frontend `todoExtractor.ts` rules exactly:
/// - Checkbox: optional leading whitespace, marker `-`/`*`/`+`, 1+ spaces, `[ ]`
///   (unchecked only — `[x]`/`[X]` are done, not pending), 1+ spaces, non-empty text.
/// - Action keyword: `TODO:`/`ACTION:`/`FOLLOW UP:`/`FOLLOW-UP:`/`NEXT:`
///   (case-insensitive), then non-empty text.
/// Empty-text matches are NOT counted (matching the frontend).
pub fn parse_pending_todo(line: &str) -> Option<String> {
    let trimmed = line.trim_start();

    // Checkbox form: marker (-/*/+), 1+ spaces, [<state>], 1+ spaces, non-empty text.
    let first = trimmed.chars().next();
    if matches!(first, Some('-') | Some('*') | Some('+')) {
        let after_marker = &trimmed[1..];
        let rest = after_marker.trim_start();
        // Require at least one space between marker and bracket.
        if rest.len() < after_marker.len() {
            let bytes = rest.as_bytes();
            // Need "[x]" shape: '[', one state char, ']'.
            if bytes.len() >= 3 && bytes[0] == b'[' && bytes[2] == b']' {
                let state = bytes[1];
                let after_box = &rest[3..];
                let text = after_box.trim_start();
                // Unchecked only; require a separating space and non-empty text.
                if state == b' ' && text.len() < after_box.len() && !text.is_empty() {
                    return Some(text.trim().to_string());
                }
                return None;
            }
        }
    }

    // Action-keyword form.
    let lower = trimmed.to_lowercase();
    for kw in ["todo:", "action:", "follow up:", "follow-up:", "next:"] {
        if lower.starts_with(kw) {
            let text = trimmed[kw.len()..].trim();
            if !text.is_empty() {
                return Some(text.to_string());
            }
            return None;
        }
    }

    None
}

/// A pending TODO item with its source page.
#[derive(Debug, Clone)]
pub struct PendingTodo {
    pub page_title: String,
    pub text: String,
}

/// A pending TODO item with page_id for navigation.
#[derive(Debug, Clone)]
pub struct PendingTodoWithPageId {
    pub page_id: String,
    pub page_title: String,
    pub text: String,
}

impl Database {
    /// Count pending TODOs across all pages by scanning block content.
    /// Recognizes: - [ ], - [x], TODO:, Action:, Follow up:, Next:
    pub fn count_pending_todos(&self) -> Result<usize> {
        let mut stmt = self.conn.prepare(
            "SELECT b.content FROM blocks b
             JOIN pages p ON b.page_id = p.id",
        )?;

        let mut rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut count = 0;

        while let Some(Ok(content)) = rows.next() {
            for line in content.split('\n') {
                if parse_pending_todo(line).is_some() {
                    count += 1;
                }
            }
        }

        Ok(count)
    }

    /// List all pending TODOs across all pages with their source page titles.
    pub fn list_pending_todos(&self) -> Result<Vec<PendingTodo>> {
        let mut stmt = self.conn.prepare(
            "SELECT b.content, p.title FROM blocks b
             JOIN pages p ON b.page_id = p.id",
        )?;

        let mut rows = stmt.query_map([], |row| {
            let content: String = row.get(0)?;
            let title: String = row.get(1)?;
            Ok((content, title))
        })?;

        let mut todos = Vec::new();

        while let Some(Ok((content, page_title))) = rows.next() {
            for line in content.split('\n') {
                if let Some(text) = parse_pending_todo(line) {
                    todos.push(PendingTodo { page_title: page_title.clone(), text });
                }
            }
        }

        Ok(todos)
    }

    /// List all pending TODOs with page IDs for navigation.
    pub fn list_pending_todos_with_page_ids(&self) -> Result<Vec<PendingTodoWithPageId>> {
        let mut stmt = self.conn.prepare(
            "SELECT b.page_id, p.title, b.content FROM blocks b
             JOIN pages p ON b.page_id = p.id",
        )?;

        let mut rows = stmt.query_map([], |row| {
            let page_id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let content: String = row.get(2)?;
            Ok((page_id, title, content))
        })?;

        let mut todos = Vec::new();

        while let Some(Ok((page_id, page_title, content))) = rows.next() {
            for line in content.split('\n') {
                if let Some(text) = parse_pending_todo(line) {
                    todos.push(PendingTodoWithPageId { page_id: page_id.clone(), page_title: page_title.clone(), text });
                }
            }
        }

        Ok(todos)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn test_db() -> Database {
        Database::open_in_memory().unwrap()
    }

    #[test]
    fn test_count_pending_todos_empty() {
        let db = test_db();
        assert_eq!(db.count_pending_todos().unwrap(), 0);
    }

    #[test]
    fn test_count_pending_todos_checkbox() {
        let db = test_db();
        let page = db.create_page("Test", None, false, None, "test").unwrap();
        db.create_block(&page.id, "- [ ] Task one\n- [ ] Task two\n- [x] Done", None, None, "test").unwrap();
        assert_eq!(db.count_pending_todos().unwrap(), 2);
    }

    #[test]
    fn test_count_pending_todos_action_keywords() {
        let db = test_db();
        let page = db.create_page("Test", None, false, None, "test").unwrap();
        db.create_block(&page.id, "TODO: Fix the bug\nAction: Deploy to staging\nFollow up: Talk to design\nNext: Review PR", None, None, "test").unwrap();
        assert_eq!(db.count_pending_todos().unwrap(), 4);
    }

    #[test]
    fn test_count_pending_todos_mixed() {
        let db = test_db();
        let page = db.create_page("Test", None, false, None, "test").unwrap();
        db.create_block(&page.id, "- [ ] Review PR\nTODO: Fix login\n- [x] Ship release", None, None, "test").unwrap();
        assert_eq!(db.count_pending_todos().unwrap(), 2);
    }

    #[test]
    fn test_count_pending_todos_skips_done() {
        let db = test_db();
        let page = db.create_page("Test", None, false, None, "test").unwrap();
        db.create_block(&page.id, "- [x] All done\n- [x] Also done", None, None, "test").unwrap();
        assert_eq!(db.count_pending_todos().unwrap(), 0);
    }

    #[test]
    fn test_count_pending_todos_includes_trashed_pages() {
        // Pages in trash are still counted because pages table has no trashed_at column.
        // The trash table is a separate audit log, not a filter on pages.
        let db = test_db();
        let page = db.create_page("Test", None, false, None, "test").unwrap();
        db.create_block(&page.id, "- [ ] Active task", None, None, "test").unwrap();
        db.trash_page(&page.id).unwrap();
        assert_eq!(db.count_pending_todos().unwrap(), 1);
    }

    #[test]
    fn test_count_pending_todos_bullet_markers() {
        let db = test_db();
        let page = db.create_page("Test", None, false, None, "test").unwrap();
        db.create_block(&page.id, "* [ ] Bullet task\n+ [ ] Plus task", None, None, "test").unwrap();
        assert_eq!(db.count_pending_todos().unwrap(), 2);
    }

    // Bug #23: checkbox text must not include the stray "]".
    #[test]
    fn test_pending_todo_text_no_stray_bracket() {
        assert_eq!(parse_pending_todo("- [ ] Task one").as_deref(), Some("Task one"));
        assert_eq!(parse_pending_todo("  * [ ] Indented").as_deref(), Some("Indented"));
        assert_eq!(parse_pending_todo("+ [ ] Plus task").as_deref(), Some("Plus task"));
        assert_eq!(parse_pending_todo("TODO: Fix the bug").as_deref(), Some("Fix the bug"));
        assert_eq!(parse_pending_todo("Follow up: Email design").as_deref(), Some("Email design"));
    }

    // Checked boxes and empty-text matches are not pending (Bug #24 alignment).
    #[test]
    fn test_pending_todo_excludes_done_and_empty() {
        assert_eq!(parse_pending_todo("- [x] Done"), None);
        assert_eq!(parse_pending_todo("- [X] Done"), None);
        assert_eq!(parse_pending_todo("- [ ]"), None); // no text
        assert_eq!(parse_pending_todo("- [ ]   "), None); // whitespace only
        assert_eq!(parse_pending_todo("TODO:"), None); // no text
        assert_eq!(parse_pending_todo("plain text"), None);
        assert_eq!(parse_pending_todo("#heading"), None);
    }

    // Flexible whitespace tolerated, matching the frontend regex `\s+`.
    #[test]
    fn test_pending_todo_flexible_whitespace() {
        assert_eq!(parse_pending_todo("-  [ ]  Task").as_deref(), Some("Task"));
    }
}