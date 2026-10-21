use crate::db::Database;
use crate::error::Result;
use crate::repo::archive::ARCHIVED_FOLDER_TREE;
use crate::repo::trash::TRASHED_FOLDER_TREE;

/// Excludes trashed/archived pages and pages inside a trashed/archived folder
/// subtree, and sync conflict copies "(conflict from <device>)" — their TODOs
/// are the same TODOs again (UX review: they inflated the sidebar count).
/// Requires the `trashed_tree` / `archived_tree` CTEs.
const VISIBLE_PAGE_FILTER: &str = "p.id NOT IN (SELECT page_id FROM trash)
               AND p.id NOT IN (SELECT page_id FROM archive)
               AND (p.folder_id IS NULL OR (p.folder_id NOT IN (SELECT id FROM trashed_tree)
                    AND p.folder_id NOT IN (SELECT id FROM archived_tree)))
               AND p.title NOT LIKE '% (conflict from %)'";

/// Parse a single line for a *pending* TODO and return its text, or None.
///
/// Canonical detector shared by all TODO scans (Bug #23, #24). Mirrors the
/// frontend `todoExtractor.ts` rules exactly:
/// - Checkbox: optional leading whitespace, marker `-`/`*`/`+`, 1+ spaces, `[ ]`
///   (unchecked only — `[x]`/`[X]` are done, not pending), 1+ spaces, non-empty text.
/// - Action keyword: `TODO:`/`ACTION:`/`FOLLOW UP:`/`FOLLOW-UP:`/`NEXT:`
///   (case-insensitive), then non-empty text.
/// - App state markers (written by Ctrl+Enter / the TODO badge): a line starting
///   with `TODO ` or `DOING ` (UPPERCASE, exactly that keyword + a space) followed
///   by non-empty text is pending; `DONE ` is done (never pending).
/// - `{{todo:pending}}` / `{{todo:doing}}` / `{{todo:done}}` macros are NOT
///   counted: they are the aggregated "All TODOs" page's own mirror entries and
///   counting them would double-count every TODO.
/// - A leading UTF-8 BOM (U+FEFF) is ignored.
///
/// Empty-text matches are NOT counted (matching the frontend).
pub fn parse_pending_todo(line: &str) -> Option<String> {
    let line = line.strip_prefix('\u{feff}').unwrap_or(line);
    let trimmed = line.trim_start();

    // App state markers (case-sensitive, as the editor writes them).
    for kw in ["TODO ", "DOING "] {
        if let Some(rest) = trimmed.strip_prefix(kw) {
            let text = rest.trim();
            return (!text.is_empty()).then(|| text.to_string());
        }
    }
    if trimmed.starts_with("DONE ") || trimmed.starts_with("{{todo:") {
        return None;
    }

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
        let mut stmt = self.conn.prepare(&format!(
            "WITH RECURSIVE {TRASHED_FOLDER_TREE}, {ARCHIVED_FOLDER_TREE}
             SELECT b.content FROM blocks b
             JOIN pages p ON b.page_id = p.id
             WHERE {VISIBLE_PAGE_FILTER}"
        ))?;

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
        let mut stmt = self.conn.prepare(&format!(
            "WITH RECURSIVE {TRASHED_FOLDER_TREE}, {ARCHIVED_FOLDER_TREE}
             SELECT b.content, p.title FROM blocks b
             JOIN pages p ON b.page_id = p.id
             WHERE {VISIBLE_PAGE_FILTER}"
        ))?;

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
        let mut stmt = self.conn.prepare(&format!(
            "WITH RECURSIVE {TRASHED_FOLDER_TREE}, {ARCHIVED_FOLDER_TREE}
             SELECT b.page_id, p.title, b.content FROM blocks b
             JOIN pages p ON b.page_id = p.id
             WHERE {VISIBLE_PAGE_FILTER}"
        ))?;

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

    /// Every task line (TODO / DOING / DONE, `- [ ]` / `- [x]`, `todo:`-style
    /// keywords) on visible pages, for the app's Tasks view. Pages are ordered by
    /// last edit (newest first), tasks within a page in outline order. A line is
    /// pending exactly when [`parse_pending_todo`] says so.
    pub fn list_tasks(&self) -> Result<Vec<TaskItem>> {
        let mut stmt = self.conn.prepare(&format!(
            "WITH RECURSIVE {TRASHED_FOLDER_TREE}, {ARCHIVED_FOLDER_TREE}
             SELECT DISTINCT p.id, p.title, p.is_journal, p.journal_date FROM blocks b
             JOIN pages p ON b.page_id = p.id
             WHERE {VISIBLE_PAGE_FILTER}
               AND (b.content LIKE '%TODO %' OR b.content LIKE '%DOING %' OR b.content LIKE '%DONE %'
                    OR b.content LIKE '%[%]%' OR b.content LIKE '%:%')
             ORDER BY p.updated_at DESC"
        ))?;
        let pages = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut tasks = Vec::new();
        for (page_id, page_title, is_journal, journal_date) in pages {
            let Ok(pid) = uuid::Uuid::parse_str(&page_id) else { continue };
            for block in self.get_page_blocks(&pid)? {
                for (line, text) in block.content.split('\n').enumerate() {
                    if let Some(t) = parse_task_line(text) {
                        tasks.push(TaskItem {
                            block_id: block.id.to_string(),
                            page_id: page_id.clone(),
                            page_title: page_title.clone(),
                            is_journal,
                            journal_date: journal_date.clone(),
                            line,
                            state: t.state,
                            kind: t.kind,
                            text: t.text,
                        });
                    }
                }
            }
        }
        Ok(tasks)
    }

    /// Move the "All TODOs" pages the old TODO badge generated to the Trash, and
    /// return them (id, title). Only a page with exactly that title whose every
    /// block is empty or a top-level `{{todo:pending}} [[Title|<page uuid>]] text`
    /// line — the exact shape the badge wrote — is touched: anything a person
    /// typed there keeps the page. Trash, not a hard delete, so it can be restored.
    pub fn trash_generated_todo_pages(&self) -> Result<Vec<(String, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title FROM pages
             WHERE title = 'All TODOs' AND is_journal = 0
               AND id NOT IN (SELECT page_id FROM trash)",
        )?;
        let candidates = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut trashed = Vec::new();
        for (id, title) in candidates {
            let Ok(pid) = uuid::Uuid::parse_str(&id) else { continue };
            let blocks = self.get_page_blocks(&pid)?;
            let generated = blocks.iter().all(|b| {
                b.content.trim().is_empty() || (b.parent_id.is_none() && is_generated_todo_line(&b.content))
            });
            if generated {
                self.trash_page(&pid)?;
                trashed.push((id, title));
            }
        }
        Ok(trashed)
    }
}

/// A task in the Tasks view: one line of a block.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TaskItem {
    pub block_id: String,
    pub page_id: String,
    pub page_title: String,
    pub is_journal: bool,
    pub journal_date: Option<String>,
    /// Line index inside the block's content.
    pub line: usize,
    /// "todo" | "doing" | "done"
    pub state: &'static str,
    /// "marker" (TODO/DOING/DONE), "checkbox" (`- [ ]`), "keyword" (`todo:` …)
    pub kind: &'static str,
    pub text: String,
}

#[derive(Debug, PartialEq)]
pub struct TaskLine {
    pub state: &'static str,
    pub kind: &'static str,
    pub text: String,
}

/// One line as a task (pending or done), or None. The pending ones are exactly
/// what [`parse_pending_todo`] finds; DONE markers and `- [x]` are the done ones.
/// `{{todo:…}}` lines (the old generated "All TODOs" page) are not tasks.
pub fn parse_task_line(line: &str) -> Option<TaskLine> {
    let trimmed = line.strip_prefix('\u{feff}').unwrap_or(line).trim_start();
    for (kw, state) in [("TODO ", "todo"), ("DOING ", "doing"), ("DONE ", "done")] {
        if let Some(rest) = trimmed.strip_prefix(kw) {
            let text = rest.trim();
            return (!text.is_empty()).then(|| TaskLine { state, kind: "marker", text: text.to_string() });
        }
    }
    if trimmed.starts_with("{{todo:") {
        return None;
    }
    if let Some(text) = parse_pending_todo(line) {
        let kind = if matches!(trimmed.chars().next(), Some('-' | '*' | '+')) { "checkbox" } else { "keyword" };
        return Some(TaskLine { state: "todo", kind, text });
    }
    // A ticked checkbox: marker, 1+ spaces, [x]/[X], 1+ spaces, text.
    let first = trimmed.chars().next();
    if matches!(first, Some('-' | '*' | '+')) {
        let rest = trimmed[1..].trim_start();
        if rest.len() < trimmed.len() - 1 {
            if let Some(after) = rest.strip_prefix("[x]").or_else(|| rest.strip_prefix("[X]")) {
                let text = after.trim_start();
                if text.len() < after.len() && !text.trim().is_empty() {
                    return Some(TaskLine { state: "done", kind: "checkbox", text: text.trim().to_string() });
                }
            }
        }
    }
    None
}

/// `{{todo:pending}} [[<title>|<36-char uuid>]] <text>`: a line the old TODO
/// badge wrote into its "All TODOs" page.
fn is_generated_todo_line(content: &str) -> bool {
    let Some(rest) = content.strip_prefix("{{todo:pending}} [[") else { return false };
    if content.contains('\n') {
        return false;
    }
    // The link ends at the first "]] " after a "|<uuid>".
    let Some(end) = rest.find("]] ") else { return false };
    let link = &rest[..end];
    let Some(bar) = link.rfind('|') else { return false };
    uuid::Uuid::parse_str(&link[bar + 1..]).is_ok() && link[bar + 1..].len() == 36
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
    fn test_conflict_copies_do_not_count_twice() {
        let db = test_db();
        let page = db.create_page("Roadmap", None, false, None, "test").unwrap();
        db.create_block(&page.id, "TODO ship it", None, None, "test").unwrap();
        let copy = db.create_page("Roadmap (conflict from laptop)", None, false, None, "test").unwrap();
        db.create_block(&copy.id, "TODO ship it", None, None, "test").unwrap();
        assert_eq!(db.count_pending_todos().unwrap(), 1);
        assert_eq!(db.list_pending_todos().unwrap().len(), 1);
        assert_eq!(db.list_pending_todos_with_page_ids().unwrap()[0].page_id, page.id.to_string());
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
    fn test_count_pending_todos_excludes_trashed_and_archived_pages() {
        // Trash/archive are soft deletes hidden everywhere else; their TODOs must
        // not inflate the badge or appear in TODO lists.
        let db = test_db();
        let live = db.create_page("Live", None, false, None, "test").unwrap();
        db.create_block(&live.id, "- [ ] Active task", None, None, "test").unwrap();
        let trashed = db.create_page("Trashed", None, false, None, "test").unwrap();
        db.create_block(&trashed.id, "- [ ] Trashed task", None, None, "test").unwrap();
        db.trash_page(&trashed.id).unwrap();
        let archived = db.create_page("Archived", None, false, None, "test").unwrap();
        db.create_block(&archived.id, "TODO archived task", None, None, "test").unwrap();
        db.archive_page(&archived.id).unwrap();
        let f = db.create_folder("F", None, None, None, "test").unwrap();
        let s = db.create_folder("S", Some(&f.id), None, None, "test").unwrap();
        let nested = db.create_page("Nested", None, false, None, "test").unwrap();
        db.move_page_to_folder(&nested.id, Some(&s.id), "test").unwrap();
        db.create_block(&nested.id, "TODO nested task", None, None, "test").unwrap();
        db.trash_folder(&f.id).unwrap();

        assert_eq!(db.count_pending_todos().unwrap(), 1);
        assert_eq!(db.list_pending_todos().unwrap().len(), 1);
        assert_eq!(db.list_pending_todos_with_page_ids().unwrap().len(), 1);
    }

    // The app's own Ctrl+Enter markers are counted; DONE and {{todo:*}} are not.
    #[test]
    fn test_app_state_markers() {
        assert_eq!(parse_pending_todo("TODO buy milk").as_deref(), Some("buy milk"));
        assert_eq!(parse_pending_todo("DOING write report").as_deref(), Some("write report"));
        assert_eq!(parse_pending_todo("  TODO indented").as_deref(), Some("indented"));
        assert_eq!(parse_pending_todo("\u{feff}TODO bom").as_deref(), Some("bom"));
        assert_eq!(parse_pending_todo("\u{feff}- [ ] bom box").as_deref(), Some("bom box"));
        assert_eq!(parse_pending_todo("DONE shipped"), None);
        assert_eq!(parse_pending_todo("TODO "), None);
        assert_eq!(parse_pending_todo("DOING"), None);
        assert_eq!(parse_pending_todo("todo lowercase prose"), None);
        assert_eq!(parse_pending_todo("TODOS are fun"), None);
        assert_eq!(parse_pending_todo("{{todo:pending}}"), None);
        assert_eq!(parse_pending_todo("{{todo:pending}} [[P|id]] mirror"), None);
        assert_eq!(parse_pending_todo("{{todo:doing}}"), None);
        // Colon form still works via the keyword rule.
        assert_eq!(parse_pending_todo("TODO: colon form").as_deref(), Some("colon form"));
    }

    #[test]
    fn test_count_app_state_markers() {
        let db = test_db();
        let page = db.create_page("Test", None, false, None, "test").unwrap();
        db.create_block(&page.id, "TODO one", None, None, "test").unwrap();
        db.create_block(&page.id, "DOING two", None, None, "test").unwrap();
        db.create_block(&page.id, "DONE three", None, None, "test").unwrap();
        db.create_block(&page.id, "{{todo:pending}} [[Test|x]] one", None, None, "test").unwrap();
        assert_eq!(db.count_pending_todos().unwrap(), 2);
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

    #[test]
    fn task_lines_have_a_state_and_pending_matches_the_badge() {
        let t = |l: &str| parse_task_line(l).map(|t| (t.state, t.kind, t.text));
        assert_eq!(t("TODO buy milk"), Some(("todo", "marker", "buy milk".into())));
        assert_eq!(t("DOING write"), Some(("doing", "marker", "write".into())));
        assert_eq!(t("DONE shipped"), Some(("done", "marker", "shipped".into())));
        assert_eq!(t("- [ ] call bob"), Some(("todo", "checkbox", "call bob".into())));
        assert_eq!(t("  * [x] paid"), Some(("done", "checkbox", "paid".into())));
        assert_eq!(t("Follow up: Ann"), Some(("todo", "keyword", "Ann".into())));
        assert_eq!(t("{{todo:pending}} [[A|x]] y"), None);
        assert_eq!(t("DONE "), None);
        assert_eq!(t("-[x] no space"), None);
        assert_eq!(t("plain"), None);
        for l in ["TODO a", "DOING b", "DONE c", "- [ ] d", "- [x] e", "next: f", "{{todo:done}} g", "- [ ]", "x"] {
            let pending = parse_task_line(l).map(|t| t.state != "done").unwrap_or(false);
            assert_eq!(pending, parse_pending_todo(l).is_some(), "line {l:?}");
        }
    }

    #[test]
    fn list_tasks_groups_by_page_in_outline_order_and_skips_hidden_pages() {
        let db = test_db();
        let p = db.create_page("Plans", None, false, None, "test").unwrap();
        let a = db.create_block(&p.id, "TODO first", None, None, "test").unwrap();
        db.create_block(&p.id, "DONE child", Some(&a.id), None, "test").unwrap();
        db.create_block(&p.id, "notes\n- [ ] second", None, None, "test").unwrap();
        let gone = db.create_page("Gone", None, false, None, "test").unwrap();
        db.create_block(&gone.id, "TODO hidden", None, None, "test").unwrap();
        db.trash_page(&gone.id).unwrap();
        let tasks = db.list_tasks().unwrap();
        let got: Vec<_> = tasks.iter().map(|t| (t.text.as_str(), t.state, t.line)).collect();
        assert_eq!(got, vec![("first", "todo", 0), ("child", "done", 0), ("second", "todo", 1)]);
        assert!(tasks.iter().all(|t| t.page_title == "Plans"));
    }

    #[test]
    fn only_generated_all_todos_pages_are_trashed() {
        let db = test_db();
        let src = db.create_page("Work", None, false, None, "test").unwrap();
        let gen = db.create_page("All TODOs", None, false, None, "test").unwrap();
        db.create_block(&gen.id, "", None, None, "test").unwrap();
        db.create_block(&gen.id, &format!("{{{{todo:pending}}}} [[Work|{}]] ship it", src.id), None, None, "test").unwrap();
        let trashed = db.trash_generated_todo_pages().unwrap();
        assert_eq!(trashed, vec![(gen.id.to_string(), "All TODOs".to_string())]);
        assert!(db.trash_generated_todo_pages().unwrap().is_empty(), "already in the trash");

        // Someone wrote in it (or it isn't the generated shape): kept.
        db.permanently_delete_page(&gen.id, "test").unwrap();
        let mine = db.create_page("All TODOs", None, false, None, "test").unwrap();
        db.create_block(&mine.id, &format!("{{{{todo:pending}}}} [[Work|{}]] ship it", src.id), None, None, "test").unwrap();
        db.create_block(&mine.id, "my own note", None, None, "test").unwrap();
        assert!(db.trash_generated_todo_pages().unwrap().is_empty());
        assert!(!is_generated_todo_line("{{todo:pending}} [[Work|not-a-uuid]] x"));
        assert!(!is_generated_todo_line("{{todo:done}} [[Work|0e1d2c3b-4a59-4687-a6b5-c4d3e2f1a0b9]] x"));
    }
}