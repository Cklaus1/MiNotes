use chrono::{NaiveDate, Utc};
use uuid::Uuid;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::models::Page;

impl Database {
    pub fn create_page(
        &self,
        title: &str,
        icon: Option<&str>,
        is_journal: bool,
        journal_date: Option<NaiveDate>,
        actor: &str,
    ) -> Result<Page> {
        let now = Utc::now();
        let id = Uuid::now_v7();

        // Check for duplicate title
        if self.get_page_by_title(title)?.is_some() {
            return Err(Error::AlreadyExists(format!("Page '{title}'")));
        }

        self.conn.execute(
            "INSERT INTO pages (id, title, icon, folder_id, is_journal, journal_date, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                id.to_string(),
                title,
                icon,
                Option::<String>::None,
                is_journal as i32,
                journal_date.map(|d| d.to_string()),
                now.to_rfc3339(),
                now.to_rfc3339(),
            ],
        )?;

        let page = Page {
            id,
            title: title.to_string(),
            icon: icon.map(String::from),
            folder_id: None,
            is_journal,
            journal_date,
            created_at: now,
            updated_at: now,
        };

        self.emit_event("page.created", &page.id, "page", &page, actor)?;
        Ok(page)
    }

    pub fn get_page(&self, id: &Uuid) -> Result<Option<Page>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, title, icon, folder_id, is_journal, journal_date, created_at, updated_at FROM pages WHERE id = ?1")?;
        let mut rows = stmt.query(rusqlite::params![id.to_string()])?;
        match rows.next()? {
            Some(row) => Ok(Some(row_to_page(row)?)),
            None => Ok(None),
        }
    }

    pub fn get_page_by_title(&self, title: &str) -> Result<Option<Page>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, title, icon, folder_id, is_journal, journal_date, created_at, updated_at FROM pages WHERE title = ?1")?;
        let mut rows = stmt.query(rusqlite::params![title])?;
        match rows.next()? {
            Some(row) => Ok(Some(row_to_page(row)?)),
            None => Ok(None),
        }
    }

    pub fn list_pages(&self, limit: Option<i64>) -> Result<Vec<Page>> {
        let limit = limit.unwrap_or(100);
        let mut stmt = self.conn.prepare(
            "SELECT id, title, icon, folder_id, is_journal, journal_date, created_at, updated_at FROM pages ORDER BY updated_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(rusqlite::params![limit], |row| {
            row_to_page_sqlite(row)
        })?;
        let mut pages = Vec::new();
        for row in rows {
            pages.push(row.map_err(Error::Database)?);
        }
        Ok(pages)
    }

    pub fn delete_page(&self, id: &Uuid, actor: &str) -> Result<bool> {
        let page = self.get_page(id)?;
        if let Some(ref p) = page {
            self.emit_event("page.deleted", &p.id, "page", p, actor)?;
        }
        let count = self
            .conn
            .execute("DELETE FROM pages WHERE id = ?1", rusqlite::params![id.to_string()])?;
        Ok(count > 0)
    }

    pub fn rename_page(&self, id: &Uuid, new_title: &str, actor: &str) -> Result<Page> {
        let now = Utc::now();
        let count = self.conn.execute(
            "UPDATE pages SET title = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![new_title, now.to_rfc3339(), id.to_string()],
        )?;
        if count == 0 {
            return Err(Error::NotFound(format!("Page {id}")));
        }
        let page = self
            .get_page(id)?
            .ok_or_else(|| Error::NotFound(format!("Page {id}")))?;
        self.emit_event("page.renamed", &page.id, "page", &page, actor)?;
        Ok(page)
    }
}

fn row_to_page(row: &rusqlite::Row<'_>) -> Result<Page> {
    Ok(row_to_page_sqlite(row)?)
}

fn row_to_page_sqlite(row: &rusqlite::Row<'_>) -> rusqlite::Result<Page> {
    // Columns: id, title, icon, folder_id, is_journal, journal_date, created_at, updated_at
    let id_str: String = row.get(0)?;
    let folder_str: Option<String> = row.get(3)?;
    let journal_date_str: Option<String> = row.get(5)?;
    let created_str: String = row.get(6)?;
    let updated_str: String = row.get(7)?;

    Ok(Page {
        id: Uuid::parse_str(&id_str).unwrap_or_default(),
        title: row.get(1)?,
        icon: row.get(2)?,
        folder_id: folder_str.and_then(|s| Uuid::parse_str(&s).ok()),
        is_journal: row.get::<_, i32>(4)? != 0,
        journal_date: journal_date_str.and_then(|s| NaiveDate::parse_from_str(&s, "%Y-%m-%d").ok()),
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
    fn test_create_and_get_page() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("Test Page", None, false, None, "user").unwrap();
        assert_eq!(page.title, "Test Page");

        let fetched = db.get_page(&page.id).unwrap().unwrap();
        assert_eq!(fetched.title, "Test Page");
    }

    #[test]
    fn test_duplicate_page_title() {
        let db = Database::open_in_memory().unwrap();
        db.create_page("Dup", None, false, None, "user").unwrap();
        let err = db.create_page("Dup", None, false, None, "user");
        assert!(err.is_err());
    }

    #[test]
    fn test_list_pages() {
        let db = Database::open_in_memory().unwrap();
        db.create_page("A", None, false, None, "user").unwrap();
        db.create_page("B", None, false, None, "user").unwrap();
        let pages = db.list_pages(None).unwrap();
        assert_eq!(pages.len(), 2);
    }

    #[test]
    fn test_delete_page() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("Del", None, false, None, "user").unwrap();
        assert!(db.delete_page(&page.id, "user").unwrap());
        assert!(db.get_page(&page.id).unwrap().is_none());
    }

    #[test]
    fn test_rename_page() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("Old", None, false, None, "user").unwrap();
        let renamed = db.rename_page(&page.id, "New", "user").unwrap();
        assert_eq!(renamed.title, "New");
    }
}
