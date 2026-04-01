use chrono::Utc;
use uuid::Uuid;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::models::{Folder, FolderTree, Page};

impl Database {
    pub fn create_folder(
        &self,
        name: &str,
        parent_id: Option<&Uuid>,
        icon: Option<&str>,
        color: Option<&str>,
        actor: &str,
    ) -> Result<Folder> {
        let now = Utc::now();
        let id = Uuid::now_v7();

        // Auto-position at end of siblings
        let parent_str = parent_id.map(|p| p.to_string());
        let max_pos: Option<f64> = self.conn.query_row(
            "SELECT MAX(position) FROM folders WHERE parent_id IS ?1",
            rusqlite::params![parent_str],
            |row| row.get(0),
        )?;
        let position = max_pos.unwrap_or(0.0) + 1.0;

        self.conn.execute(
            "INSERT INTO folders (id, name, parent_id, icon, color, position, collapsed, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8)",
            rusqlite::params![
                id.to_string(),
                name,
                parent_str,
                icon,
                color,
                position,
                now.to_rfc3339(),
                now.to_rfc3339(),
            ],
        )?;

        let folder = Folder {
            id,
            name: name.to_string(),
            parent_id: parent_id.copied(),
            icon: icon.map(String::from),
            color: color.map(String::from),
            position,
            collapsed: false,
            created_at: now,
            updated_at: now,
        };

        self.emit_event("folder.created", &folder.id, "folder", &folder, actor)?;
        Ok(folder)
    }

    pub fn get_folder(&self, id: &Uuid) -> Result<Option<Folder>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, parent_id, icon, color, position, collapsed, created_at, updated_at
             FROM folders WHERE id = ?1",
        )?;
        let mut rows = stmt.query(rusqlite::params![id.to_string()])?;
        match rows.next()? {
            Some(row) => Ok(Some(row_to_folder(row)?)),
            None => Ok(None),
        }
    }

    pub fn list_folders(&self, parent_id: Option<&Uuid>) -> Result<Vec<Folder>> {
        let parent_str = parent_id.map(|p| p.to_string());
        let mut stmt = self.conn.prepare(
            "SELECT id, name, parent_id, icon, color, position, collapsed, created_at, updated_at
             FROM folders WHERE parent_id IS ?1 AND id NOT IN (SELECT folder_id FROM folder_trash) AND id NOT IN (SELECT folder_id FROM folder_archive) ORDER BY position",
        )?;
        let rows = stmt.query_map(rusqlite::params![parent_str], |row| row_to_folder_sqlite(row))?;
        let mut folders = Vec::new();
        for row in rows {
            folders.push(row.map_err(Error::Database)?);
        }
        Ok(folders)
    }

    pub fn rename_folder(&self, id: &Uuid, new_name: &str, actor: &str) -> Result<Folder> {
        let now = Utc::now();
        let count = self.conn.execute(
            "UPDATE folders SET name = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![new_name, now.to_rfc3339(), id.to_string()],
        )?;
        if count == 0 {
            return Err(Error::NotFound(format!("Folder {id}")));
        }
        let folder = self.get_folder(id)?.ok_or_else(|| Error::NotFound(format!("Folder {id}")))?;
        self.emit_event("folder.renamed", &folder.id, "folder", &folder, actor)?;
        Ok(folder)
    }

    pub fn update_folder_appearance(&self, id: &Uuid, icon: Option<&str>, color: Option<&str>, actor: &str) -> Result<Folder> {
        let now = Utc::now();
        let count = self.conn.execute(
            "UPDATE folders SET icon = ?1, color = ?2, updated_at = ?3 WHERE id = ?4",
            rusqlite::params![icon, color, now.to_rfc3339(), id.to_string()],
        )?;
        if count == 0 {
            return Err(Error::NotFound(format!("Folder {id}")));
        }
        let folder = self.get_folder(id)?.ok_or_else(|| Error::NotFound(format!("Folder {id}")))?;
        self.emit_event("folder.updated", &folder.id, "folder", &folder, actor)?;
        Ok(folder)
    }

    pub fn delete_folder(&self, id: &Uuid, actor: &str) -> Result<bool> {
        // Unparent pages in this folder (set folder_id = NULL)
        self.conn.execute(
            "UPDATE pages SET folder_id = NULL WHERE folder_id = ?1",
            rusqlite::params![id.to_string()],
        )?;
        if let Some(ref f) = self.get_folder(id)? {
            self.emit_event("folder.deleted", &f.id, "folder", f, actor)?;
        }
        let count = self.conn.execute(
            "DELETE FROM folders WHERE id = ?1",
            rusqlite::params![id.to_string()],
        )?;
        Ok(count > 0)
    }

    pub fn move_folder(&self, id: &Uuid, new_parent: Option<&Uuid>, actor: &str) -> Result<Folder> {
        let now = Utc::now();
        let parent_str = new_parent.map(|p| p.to_string());

        // Auto-position at end of new parent's children
        let max_pos: Option<f64> = self.conn.query_row(
            "SELECT MAX(position) FROM folders WHERE parent_id IS ?1",
            rusqlite::params![parent_str],
            |row| row.get(0),
        )?;
        let position = max_pos.unwrap_or(0.0) + 1.0;

        let count = self.conn.execute(
            "UPDATE folders SET parent_id = ?1, position = ?2, updated_at = ?3 WHERE id = ?4",
            rusqlite::params![parent_str, position, now.to_rfc3339(), id.to_string()],
        )?;
        if count == 0 {
            return Err(Error::NotFound(format!("Folder {id}")));
        }
        let folder = self.get_folder(id)?.ok_or_else(|| Error::NotFound(format!("Folder {id}")))?;
        self.emit_event("folder.moved", &folder.id, "folder", &folder, actor)?;
        Ok(folder)
    }

    /// Move a page into a folder (or to root with None).
    pub fn move_page_to_folder(&self, page_id: &Uuid, folder_id: Option<&Uuid>, actor: &str) -> Result<Page> {
        let now = Utc::now();
        let folder_str = folder_id.map(|f| f.to_string());
        let count = self.conn.execute(
            "UPDATE pages SET folder_id = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![folder_str, now.to_rfc3339(), page_id.to_string()],
        )?;
        if count == 0 {
            return Err(Error::NotFound(format!("Page {page_id}")));
        }
        let page = self.get_page(page_id)?.ok_or_else(|| Error::NotFound(format!("Page {page_id}")))?;
        self.emit_event("page.moved", &page.id, "page", &page, actor)?;
        Ok(page)
    }

    /// Get pages in a specific folder (or root pages if None).
    pub fn get_pages_in_folder(&self, folder_id: Option<&Uuid>) -> Result<Vec<Page>> {
        let folder_str = folder_id.map(|f| f.to_string());
        let mut stmt = self.conn.prepare(
            "SELECT id, title, icon, folder_id, position, is_journal, journal_date, created_at, updated_at
             FROM pages WHERE folder_id IS ?1 AND id NOT IN (SELECT page_id FROM trash) AND id NOT IN (SELECT page_id FROM archive) ORDER BY position, title",
        )?;
        let rows = stmt.query_map(rusqlite::params![folder_str], |row| row_to_page_with_folder(row))?;
        let mut pages = Vec::new();
        for row in rows {
            pages.push(row.map_err(Error::Database)?);
        }
        Ok(pages)
    }

    /// Build the full folder tree recursively.
    pub fn get_folder_tree(&self) -> Result<Vec<FolderTree>> {
        self.build_tree(None)
    }

    fn build_tree(&self, parent_id: Option<&Uuid>) -> Result<Vec<FolderTree>> {
        let folders = self.list_folders(parent_id)?;
        let mut tree = Vec::new();
        for folder in folders {
            let children = self.build_tree(Some(&folder.id))?;
            let pages = self.get_pages_in_folder(Some(&folder.id))?;
            tree.push(FolderTree {
                folder,
                children,
                pages,
            });
        }
        Ok(tree)
    }
}

fn row_to_folder(row: &rusqlite::Row<'_>) -> Result<Folder> {
    Ok(row_to_folder_sqlite(row)?)
}

fn row_to_folder_sqlite(row: &rusqlite::Row<'_>) -> rusqlite::Result<Folder> {
    let id_str: String = row.get(0)?;
    let parent_str: Option<String> = row.get(2)?;
    let created_str: String = row.get(7)?;
    let updated_str: String = row.get(8)?;

    Ok(Folder {
        id: Uuid::parse_str(&id_str).unwrap_or_default(),
        name: row.get(1)?,
        parent_id: parent_str.and_then(|s| Uuid::parse_str(&s).ok()),
        icon: row.get(3)?,
        color: row.get(4)?,
        position: row.get(5)?,
        collapsed: row.get::<_, i32>(6)? != 0,
        created_at: chrono::DateTime::parse_from_rfc3339(&created_str)
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .unwrap_or_else(|_| chrono::Utc::now()),
        updated_at: chrono::DateTime::parse_from_rfc3339(&updated_str)
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .unwrap_or_else(|_| chrono::Utc::now()),
    })
}

fn row_to_page_with_folder(row: &rusqlite::Row<'_>) -> rusqlite::Result<Page> {
    // Columns: id, title, icon, folder_id, position, is_journal, journal_date, created_at, updated_at
    let id_str: String = row.get(0)?;
    let folder_str: Option<String> = row.get(3)?;
    let journal_date_str: Option<String> = row.get(6)?;
    let created_str: String = row.get(7)?;
    let updated_str: String = row.get(8)?;

    Ok(Page {
        id: Uuid::parse_str(&id_str).unwrap_or_default(),
        title: row.get(1)?,
        icon: row.get(2)?,
        folder_id: folder_str.and_then(|s| Uuid::parse_str(&s).ok()),
        position: row.get(4)?,
        is_journal: row.get::<_, i32>(5)? != 0,
        journal_date: journal_date_str.and_then(|s| chrono::NaiveDate::parse_from_str(&s, "%Y-%m-%d").ok()),
        created_at: chrono::DateTime::parse_from_rfc3339(&created_str)
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .unwrap_or_else(|_| chrono::Utc::now()),
        updated_at: chrono::DateTime::parse_from_rfc3339(&updated_str)
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .unwrap_or_else(|_| chrono::Utc::now()),
    })
}

#[cfg(test)]
mod tests {
    use crate::db::Database;

    #[test]
    fn test_create_folder() {
        let db = Database::open_in_memory().unwrap();
        let f = db.create_folder("Work", None, None, None, "user").unwrap();
        assert_eq!(f.name, "Work");
        assert!(f.parent_id.is_none());
    }

    #[test]
    fn test_nested_folders() {
        let db = Database::open_in_memory().unwrap();
        let work = db.create_folder("Work", None, None, None, "user").unwrap();
        let proj = db.create_folder("Projects", Some(&work.id), None, None, "user").unwrap();
        assert_eq!(proj.parent_id, Some(work.id));

        let children = db.list_folders(Some(&work.id)).unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].name, "Projects");
    }

    #[test]
    fn test_move_page_to_folder() {
        let db = Database::open_in_memory().unwrap();
        let folder = db.create_folder("Notes", None, None, None, "user").unwrap();
        let page = db.create_page("My Page", None, false, None, "user").unwrap();
        assert!(page.folder_id.is_none());

        let moved = db.move_page_to_folder(&page.id, Some(&folder.id), "user").unwrap();
        assert_eq!(moved.folder_id, Some(folder.id));

        let pages_in_folder = db.get_pages_in_folder(Some(&folder.id)).unwrap();
        assert_eq!(pages_in_folder.len(), 1);
        assert_eq!(pages_in_folder[0].title, "My Page");
    }

    #[test]
    fn test_folder_tree() {
        let db = Database::open_in_memory().unwrap();
        let work = db.create_folder("Work", None, None, None, "user").unwrap();
        let personal = db.create_folder("Personal", None, None, None, "user").unwrap();
        db.create_folder("Projects", Some(&work.id), None, None, "user").unwrap();

        let page = db.create_page("Todo", None, false, None, "user").unwrap();
        db.move_page_to_folder(&page.id, Some(&work.id), "user").unwrap();

        let tree = db.get_folder_tree().unwrap();
        assert_eq!(tree.len(), 2); // Work, Personal
        assert_eq!(tree[0].children.len(), 1); // Work > Projects
        assert_eq!(tree[0].pages.len(), 1); // Work > Todo
    }

    #[test]
    fn test_delete_folder_unparents_pages() {
        let db = Database::open_in_memory().unwrap();
        let folder = db.create_folder("Temp", None, None, None, "user").unwrap();
        let page = db.create_page("Orphan", None, false, None, "user").unwrap();
        db.move_page_to_folder(&page.id, Some(&folder.id), "user").unwrap();

        db.delete_folder(&folder.id, "user").unwrap();

        let p = db.get_page(&page.id).unwrap().unwrap();
        assert!(p.folder_id.is_none()); // page survives, just unparented
    }
}
