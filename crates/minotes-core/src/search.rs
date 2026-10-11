use crate::db::Database;
use crate::error::{Error, Result};
use crate::models::Block;

/// One piece of a parsed search query.
#[derive(Debug, Clone, PartialEq)]
enum Term {
    /// A bare word: matches blocks with a word that STARTS with it
    /// (search-as-you-type). `foo:bar` is the two-word prefix phrase `foo bar*`.
    Prefix(Vec<String>),
    /// A "quoted phrase": the exact words, adjacent, in order.
    Phrase(Vec<String>),
}

/// Split text into index tokens the way the FTS `unicode61` tokenizer does:
/// runs of letters/digits, everything else is a separator. Lower-cased.
fn tokens(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(str::to_lowercase)
        .collect()
}

/// Parse a user query: `"quoted text"` is an exact phrase, every other
/// whitespace-separated word is a prefix term, and all terms must match (AND).
/// An unbalanced `"` is ignored. Punctuation never reaches FTS5 as syntax: terms
/// are rebuilt from their letter/digit runs only (`C++`, `foo:bar`, `(`, `-x`, `*`).
fn parse_query(query: &str) -> Vec<Term> {
    let mut terms = Vec::new();
    let push_words = |text: &str, terms: &mut Vec<Term>| {
        for w in text.split_whitespace() {
            let t = tokens(w);
            if !t.is_empty() {
                terms.push(Term::Prefix(t));
            }
        }
    };
    let mut rest = query;
    while let Some(open) = rest.find('"') {
        let after = &rest[open + 1..];
        match after.find('"') {
            Some(close) => {
                push_words(&rest[..open], &mut terms);
                let t = tokens(&after[..close]);
                if !t.is_empty() {
                    terms.push(Term::Phrase(t));
                }
                rest = &after[close + 1..];
            }
            None => {
                // Unbalanced quote: treat the remainder as plain words.
                push_words(&rest[..open], &mut terms);
                rest = after;
                break;
            }
        }
    }
    push_words(rest, &mut terms);
    terms
}

/// FTS5 expression for parsed terms: `"a b"* AND "exact phrase"`. Tokens are
/// letters/digits only, so wrapping them in quotes can never produce a syntax error.
fn fts_expression(terms: &[Term]) -> String {
    terms
        .iter()
        .map(|t| match t {
            Term::Prefix(w) => format!("\"{}\"*", w.join(" ")),
            Term::Phrase(w) => format!("\"{}\"", w.join(" ")),
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

/// CJK scripts are written without spaces, so `unicode61` indexes a whole run
/// (`東京都の天気`) as ONE token and a substring (`京都`) can never match it.
fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x1100..=0x11FF | 0x2E80..=0x2FDF | 0x3040..=0x30FF | 0x3100..=0x318F
        | 0x31A0..=0x31FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xA960..=0xA97F
        | 0xAC00..=0xD7FF | 0xF900..=0xFAFF | 0xFF66..=0xFF9F | 0x20000..=0x3FFFF)
}

fn like_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

impl Database {
    /// Full-text search over blocks.
    ///
    /// Words match as prefixes (`alpha` finds `alphabet`), several words must ALL
    /// appear (in any order), `"quoted text"` matches that exact phrase, and
    /// punctuation is never query syntax. Queries containing CJK text fall back to
    /// substring matching (no word boundaries to index on), which costs a scan of
    /// `blocks` but no extra index.
    ///
    /// Excludes blocks belonging to trashed or archived pages (Bug #6) — those are
    /// hidden from the user everywhere else, so they must not leak through search.
    pub fn search(&self, query: &str, limit: Option<i64>) -> Result<Vec<Block>> {
        let limit = limit.unwrap_or(20);
        let terms = parse_query(query);
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let hidden = crate::repo::trash::hidden_pages_cte();
        let cols = "b.id, b.page_id, b.parent_id, b.position, b.content, b.format, b.collapsed, b.created_at, b.updated_at";

        let blocks = if query.chars().any(is_cjk) {
            // Substring match of every term's raw text (case-insensitive for ASCII).
            let needles: Vec<String> = query
                .replace('"', " ")
                .split_whitespace()
                .map(|w| format!("%{}%", like_escape(w)))
                .collect();
            let conds = (0..needles.len())
                .map(|i| format!("b.content LIKE ?{} ESCAPE '\\'", i + 2))
                .collect::<Vec<_>>()
                .join(" AND ");
            let sql = format!(
                "{hidden}
                 SELECT {cols} FROM blocks b
                 WHERE {conds} AND b.page_id NOT IN (SELECT id FROM hidden_pages)
                 ORDER BY b.updated_at DESC
                 LIMIT ?1"
            );
            let mut stmt = self.conn.prepare(&sql)?;
            let mut params: Vec<&dyn rusqlite::ToSql> = vec![&limit];
            for n in &needles {
                params.push(n);
            }
            let rows = stmt.query_map(params.as_slice(), row_to_block)?;
            rows.collect::<std::result::Result<Vec<_>, _>>().map_err(Error::Database)?
        } else {
            let sql = format!(
                "{hidden}
                 SELECT {cols}
                 FROM blocks_fts f
                 JOIN blocks b ON b.rowid = f.rowid
                 WHERE blocks_fts MATCH ?1
                   AND b.page_id NOT IN (SELECT id FROM hidden_pages)
                 ORDER BY rank
                 LIMIT ?2"
            );
            let mut stmt = self.conn.prepare(&sql)?;
            let rows = stmt.query_map(rusqlite::params![fts_expression(&terms), limit], row_to_block)?;
            rows.collect::<std::result::Result<Vec<_>, _>>().map_err(Error::Database)?
        };
        Ok(blocks)
    }
}

fn row_to_block(row: &rusqlite::Row<'_>) -> rusqlite::Result<Block> {
    use chrono::Utc;
    use uuid::Uuid;

    let id_str: String = row.get(0)?;
    let page_id_str: String = row.get(1)?;
    let parent_id_str: Option<String> = row.get(2)?;
    let created_str: String = row.get(7)?;
    let updated_str: String = row.get(8)?;

    Ok(Block {
        id: Uuid::parse_str(&id_str).unwrap_or_default(),
        page_id: Uuid::parse_str(&page_id_str).unwrap_or_default(),
        parent_id: parent_id_str.and_then(|s| Uuid::parse_str(&s).ok()),
        position: row.get(3)?,
        content: row.get(4)?,
        format: row.get(5)?,
        collapsed: row.get::<_, i32>(6)? != 0,
        created_at: chrono::DateTime::parse_from_rfc3339(&created_str)
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now()),
        updated_at: chrono::DateTime::parse_from_rfc3339(&updated_str)
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now()),
    })
}

#[cfg(test)]
mod tests {
    use crate::db::Database;

    #[test]
    fn test_fts_search() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("P", None, false, None, "user").unwrap();
        db.create_block(&page.id, "The quick brown fox", None, None, "user").unwrap();
        db.create_block(&page.id, "Lazy dog sleeping", None, None, "user").unwrap();

        let results = db.search("quick brown", None).unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].content.contains("quick"));
    }

    #[test]
    fn test_fts_no_results() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("P", None, false, None, "user").unwrap();
        db.create_block(&page.id, "Hello world", None, None, "user").unwrap();

        let results = db.search("nonexistent", None).unwrap();
        assert!(results.is_empty());
    }

    // Bug #6: trashed/archived page content must not appear in search.
    #[test]
    fn test_fts_excludes_trashed_and_archived() {
        let db = Database::open_in_memory().unwrap();
        let trashed = db.create_page("Trashed", None, false, None, "user").unwrap();
        db.create_block(&trashed.id, "launch codes secret", None, None, "user").unwrap();
        let archived = db.create_page("Archived", None, false, None, "user").unwrap();
        db.create_block(&archived.id, "launch codes secret", None, None, "user").unwrap();
        let live = db.create_page("Live", None, false, None, "user").unwrap();
        db.create_block(&live.id, "launch codes secret", None, None, "user").unwrap();

        db.trash_page(&trashed.id).unwrap();
        db.archive_page(&archived.id).unwrap();

        let results = db.search("launch codes", None).unwrap();
        assert_eq!(results.len(), 1, "only the live page's block should match");
        assert_eq!(results[0].page_id, live.id);
    }

    // Bug #7: punctuation must not raise an FTS syntax error.
    #[test]
    fn test_fts_handles_punctuation() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("P", None, false, None, "user").unwrap();
        db.create_block(&page.id, "use C++ for speed", None, None, "user").unwrap();

        // These previously raised "fts5: syntax error"; now they return cleanly.
        assert!(db.search("C++", None).is_ok());
        assert!(db.search("\"unterminated", None).is_ok());
        assert!(db.search("foo:bar", None).is_ok());
        assert!(db.search("*", None).is_ok());
        // And a literal phrase still matches.
        let results = db.search("C++", None).unwrap();
        assert_eq!(results.len(), 1);
    }

    fn hits(db: &Database, q: &str) -> Vec<String> {
        let mut v: Vec<String> = db.search(q, Some(50)).unwrap().into_iter().map(|b| b.content).collect();
        v.sort();
        v
    }

    // Search-as-you-type: a word prefix matches; the middle of a word does not.
    #[test]
    fn test_search_matches_word_prefixes() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("P", None, false, None, "user").unwrap();
        db.create_block(&page.id, "the alphabet soup", None, None, "user").unwrap();
        db.create_block(&page.id, "running late", None, None, "user").unwrap();
        assert_eq!(hits(&db, "alpha"), vec!["the alphabet soup"]);
        assert_eq!(hits(&db, "ALPH"), vec!["the alphabet soup"]);
        // Every prefix of a word while typing (no stemming surprises).
        for q in ["r", "ru", "run", "runn", "runni", "runnin", "running"] {
            assert_eq!(hits(&db, q), vec!["running late"], "query {q}");
        }
        assert!(hits(&db, "phabet").is_empty(), "mid-word is not a match");
    }

    // Several words: all must appear, any order, not necessarily adjacent.
    // Quotes ask for the exact phrase.
    #[test]
    fn test_search_multi_word_is_and_and_quotes_are_phrase() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("P", None, false, None, "user").unwrap();
        db.create_block(&page.id, "brown quick fox", None, None, "user").unwrap();
        db.create_block(&page.id, "the quick brown dog", None, None, "user").unwrap();
        db.create_block(&page.id, "only quick here", None, None, "user").unwrap();
        assert_eq!(hits(&db, "quick brown"), vec!["brown quick fox", "the quick brown dog"]);
        assert_eq!(hits(&db, "qui bro"), vec!["brown quick fox", "the quick brown dog"]);
        assert_eq!(hits(&db, "\"quick brown\""), vec!["the quick brown dog"]);
        assert_eq!(hits(&db, "\"quick brown\" dog"), vec!["the quick brown dog"]);
        // A quoted phrase is exact: no prefix on its last word.
        assert!(hits(&db, "\"quick bro\"").is_empty());
    }

    // FTS5 syntax characters are literal text and never raise an error.
    #[test]
    fn test_search_special_characters_never_error() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("P", None, false, None, "user").unwrap();
        db.create_block(&page.id, "foo:bar and (baz) NEAR x-ray", None, None, "user").unwrap();
        for q in ["\"", "\"\"", "*", "(", ")", "-", ":", "^", "+", "a OR", "NOT", "AND",
                  "NEAR(", "x*", "\"open", "{col}:x", "-x-", "a\"b", "''", "%", "_", "\\"] {
            assert!(db.search(q, None).is_ok(), "query {q:?} errored");
        }
        assert_eq!(hits(&db, "foo:bar").len(), 1);
        assert_eq!(hits(&db, "(baz)").len(), 1);
        assert_eq!(hits(&db, "x-ray").len(), 1);
        assert_eq!(hits(&db, "near").len(), 1, "operator words are plain words");
        assert!(hits(&db, "*").is_empty());
    }

    // CJK has no spaces, so substrings must be findable; accents are folded.
    #[test]
    fn test_search_cjk_substring_and_accents() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("P", None, false, None, "user").unwrap();
        db.create_block(&page.id, "東京都の天気", None, None, "user").unwrap();
        db.create_block(&page.id, "un café noir", None, None, "user").unwrap();
        db.create_block(&page.id, "100%_done", None, None, "user").unwrap();
        assert_eq!(hits(&db, "京都"), vec!["東京都の天気"]);
        assert_eq!(hits(&db, "天気"), vec!["東京都の天気"]);
        assert!(hits(&db, "大阪").is_empty());
        assert_eq!(hits(&db, "cafe"), vec!["un café noir"]);
        assert_eq!(hits(&db, "café"), vec!["un café noir"]);
        // LIKE wildcards in a CJK query are literal.
        assert!(hits(&db, "京 %").is_empty());
    }
}
