//! Page-title queries that don't depend on the notebook's size (UX review U-6).
//!
//! The app used to fetch the first N pages (`list_pages(100)`, by position) and
//! filter them in the frontend, so `[[` autocomplete, link suggestions, the
//! journal lookup and the rename clash check silently missed every page past
//! the first hundred or two. These look at every live page instead.
//!
//! "Live" = not hidden: not in the trash or the archive, directly or through
//! a project (`hidden_pages_cte`).
//! Matching is case-insensitive with Unicode lowercasing (done here, not with
//! SQLite's ASCII-only `lower()` / NOCASE).

use chrono::NaiveDate;
use uuid::Uuid;

use crate::db::Database;
use crate::error::Result;
use crate::models::Page;
use crate::repo::pages::row_to_page_sqlite;

const PAGE_COLS: &str = "id, title, icon, folder_id, position, is_journal, journal_date, created_at, updated_at";

fn words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect()
}

impl Database {
    fn live_pages(&self, extra_where: &str, params: &[&dyn rusqlite::ToSql]) -> Result<Vec<Page>> {
        let sql = format!(
            "{} SELECT {PAGE_COLS} FROM pages WHERE id NOT IN (SELECT id FROM hidden_pages) {extra_where}",
            crate::repo::trash::hidden_pages_cte()
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params, row_to_page_sqlite)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Live pages whose title contains `query` (case-insensitive), best first:
    /// exact title, then title prefix, then a word of the title starting with
    /// it, then anywhere; shorter titles and recently updated pages first among
    /// equals. Every word of a multi-word query must appear. An empty query
    /// returns the most recently updated pages.
    pub fn find_pages_by_title(&self, query: &str, limit: usize) -> Result<Vec<Page>> {
        let q = query.trim().to_lowercase();
        let mut pages = self.live_pages("", &[])?;
        if q.is_empty() {
            pages.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            pages.truncate(limit);
            return Ok(pages);
        }
        let terms: Vec<&str> = q.split_whitespace().collect();
        let mut ranked: Vec<(u8, Page)> = pages
            .into_iter()
            .filter_map(|p| {
                let t = p.title.to_lowercase();
                if !terms.iter().all(|w| t.contains(w)) {
                    return None;
                }
                let rank = if t == q {
                    0
                } else if t.starts_with(&q) {
                    1
                } else if words(&t).iter().any(|w| w.starts_with(terms[0])) && t.contains(&q) {
                    2
                } else if t.contains(&q) {
                    3
                } else {
                    4 // every word, not as one phrase
                };
                Some((rank, p))
            })
            .collect();
        ranked.sort_by(|(ra, a), (rb, b)| {
            ra.cmp(rb)
                .then(a.title.chars().count().cmp(&b.title.chars().count()))
                .then(b.updated_at.cmp(&a.updated_at))
        });
        Ok(ranked.into_iter().take(limit).map(|(_, p)| p).collect())
    }

    /// Does a page other than `exclude` hold exactly this title (or alias)? The
    /// rename clash check, matching `rename_page`: a trashed page gives its title
    /// up, so it doesn't count (an archived one keeps it).
    pub fn title_in_use(&self, title: &str, exclude: Option<&Uuid>) -> Result<bool> {
        match self.get_page_by_title(title.trim())? {
            Some(p) if Some(&p.id) != exclude => Ok(!self.is_trashed(&p.id)?),
            _ => Ok(false),
        }
    }

    /// Journal pages, newest date first (live ones only).
    pub fn list_journal_pages(&self, limit: usize) -> Result<Vec<Page>> {
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        self.live_pages("AND is_journal = 1 ORDER BY journal_date DESC LIMIT ?1", &[&limit])
    }

    /// The live journal page for a date without creating it (soft lookup).
    pub fn find_journal_page(&self, date: NaiveDate) -> Result<Option<Page>> {
        match self.find_journal(date)? {
            Some(p) if !self.is_page_hidden(&p.id)? => Ok(Some(p)),
            _ => Ok(None),
        }
    }

    /// Candidates for "suggested links" from a page's text: live pages (other
    /// than `exclude`) whose title appears in the text, or that share a word of
    /// four or more letters with it. The frontend scores them
    /// (lib/linkSuggestions.ts); every title containing one of the text's words
    /// is here, so its "how many titles share this word" count stays right.
    pub fn link_candidates(&self, text: &str, exclude: Option<&Uuid>, limit: usize) -> Result<Vec<Page>> {
        let text_lower = text.to_lowercase();
        let text_words: std::collections::HashSet<String> =
            words(text).into_iter().filter(|w| w.chars().count() >= 4).collect();
        if text_words.is_empty() && text_lower.trim().is_empty() {
            return Ok(Vec::new());
        }
        let mut out: Vec<Page> = self
            .live_pages("", &[])?
            .into_iter()
            .filter(|p| Some(&p.id) != exclude)
            .filter(|p| {
                let t = p.title.trim().to_lowercase();
                (t.chars().count() >= 3 && text_lower.contains(&t))
                    || words(&t).iter().any(|w| text_words.contains(w))
            })
            .collect();
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        out.truncate(limit);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use crate::db::Database;
    use chrono::NaiveDate;

    fn many(db: &Database, n: usize) {
        for i in 0..n {
            db.create_page(&format!("Filler page {i:03}"), None, false, None, "user").unwrap();
        }
    }

    #[test]
    fn search_finds_a_page_past_the_first_hundred() {
        let db = Database::open_in_memory().unwrap();
        many(&db, 150);
        db.create_page("Kestrel Engine", None, false, None, "user").unwrap();
        // The old frontend path: the first 100 by position never had it.
        assert!(!db.list_pages(Some(100)).unwrap().iter().any(|p| p.title == "Kestrel Engine"));
        let hits = db.find_pages_by_title("kestrel", 8).unwrap();
        assert_eq!(hits.first().map(|p| p.title.as_str()), Some("Kestrel Engine"));
    }

    #[test]
    fn search_ranks_exact_then_prefix_then_word_then_anywhere() {
        let db = Database::open_in_memory().unwrap();
        for t in ["My Alpha notes", "Alphabet", "Project Alpha", "Alpha", "Xalpha"] {
            db.create_page(t, None, false, None, "user").unwrap();
        }
        let titles: Vec<String> =
            db.find_pages_by_title("alpha", 10).unwrap().into_iter().map(|p| p.title).collect();
        assert_eq!(titles, ["Alpha", "Alphabet", "Project Alpha", "My Alpha notes", "Xalpha"]);
        // Words in any order; Unicode lowercasing.
        db.create_page("Über Café", None, false, None, "user").unwrap();
        let hits = db.find_pages_by_title("café über", 10).unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn trashed_and_archived_pages_are_not_offered() {
        let db = Database::open_in_memory().unwrap();
        let a = db.create_page("Gone Kestrel", None, false, None, "user").unwrap();
        let b = db.create_page("Shelved Kestrel", None, false, None, "user").unwrap();
        db.create_page("Live Kestrel", None, false, None, "user").unwrap();
        db.trash_page(&a.id).unwrap();
        db.archive_page(&b.id).unwrap();
        let titles: Vec<String> =
            db.find_pages_by_title("kestrel", 10).unwrap().into_iter().map(|p| p.title).collect();
        assert_eq!(titles, ["Live Kestrel"]);
    }

    #[test]
    fn title_taken_sees_every_page_but_not_the_trash_or_itself() {
        let db = Database::open_in_memory().unwrap();
        many(&db, 120);
        let late = db.create_page("Late Title", None, false, None, "user").unwrap();
        let other = db.create_page("Other", None, false, None, "user").unwrap();
        assert!(db.title_in_use("Late Title", Some(&other.id)).unwrap());
        assert!(!db.title_in_use("Late Title", Some(&late.id)).unwrap());
        assert!(!db.title_in_use("late title", Some(&other.id)).unwrap());
        db.trash_page(&late.id).unwrap();
        assert!(!db.title_in_use("Late Title", Some(&other.id)).unwrap());
    }

    #[test]
    fn journal_lookup_and_list_ignore_notebook_size() {
        let db = Database::open_in_memory().unwrap();
        many(&db, 250);
        let d = NaiveDate::from_ymd_opt(2026, 10, 1).unwrap();
        assert!(db.find_journal_page(d).unwrap().is_none());
        let j = db.get_or_create_journal(d, None, "user").unwrap();
        db.get_or_create_journal(NaiveDate::from_ymd_opt(2026, 9, 1).unwrap(), None, "user").unwrap();
        assert!(!db.list_pages(Some(200)).unwrap().iter().any(|p| p.id == j.id));
        assert_eq!(db.find_journal_page(d).unwrap().map(|p| p.id), Some(j.id));
        let js = db.list_journal_pages(10).unwrap();
        assert_eq!(js.len(), 2);
        assert_eq!(js[0].journal_date, Some(d)); // newest first
    }

    #[test]
    fn link_candidates_cover_mentions_and_shared_words_in_a_big_notebook() {
        let db = Database::open_in_memory().unwrap();
        many(&db, 150);
        let me = db.create_page("This page", None, false, None, "user").unwrap();
        db.create_page("Kestrel Engine", None, false, None, "user").unwrap();
        db.create_page("Q4", None, false, None, "user").unwrap();
        db.create_page("Unrelated", None, false, None, "user").unwrap();
        let titles: Vec<String> = db
            .link_candidates("We tuned the kestrel engine for the q4 launch. This page", Some(&me.id), 50)
            .unwrap()
            .into_iter()
            .map(|p| p.title)
            .collect();
        assert!(titles.contains(&"Kestrel Engine".to_string()), "{titles:?}");
        assert!(!titles.contains(&"Unrelated".to_string()));
        assert!(!titles.contains(&"This page".to_string()));
        assert!(!titles.contains(&"Q4".to_string()), "two letters: too short to be a mention");
    }
}
