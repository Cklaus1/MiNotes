use chrono::Utc;
use serde::Serialize;
use uuid::Uuid;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::repo::folders::FOLDER_SUBTREE;

#[derive(Debug, Clone, Serialize)]
pub struct ArchiveItem {
    pub id: String,
    pub title: String,
    pub item_type: String, // "page" or "folder"
    pub page_count: u32,
    pub archived_at: String,
}

/// Recursive CTE `archived_tree(id)`: every folder that is archived or inside an
/// archived folder (cycle-safe via `UNION`).
pub(crate) const ARCHIVED_FOLDER_TREE: &str = "archived_tree(id) AS (
    SELECT folder_id FROM folder_archive
    UNION
    SELECT f.id FROM folders f JOIN archived_tree t ON f.parent_id = t.id
)";

impl Database {
    pub fn archive_page(&self, page_id: &Uuid) -> Result<()> {
        self.tx(|| {
            let now = Utc::now();
            self.remove_favorite(page_id)?;
            self.conn.execute(
                "INSERT OR IGNORE INTO archive (page_id, archived_at) VALUES (?1, ?2)",
                rusqlite::params![page_id.to_string(), now.to_rfc3339()],
            )?;
            Ok(())
        })
    }

    pub fn unarchive_page(&self, page_id: &Uuid) -> Result<()> {
        self.conn.execute(
            "DELETE FROM archive WHERE page_id = ?1",
            rusqlite::params![page_id.to_string()],
        )?;
        Ok(())
    }

    /// Archive a folder and every page in its whole subtree. Only the folder
    /// itself is recorded in `folder_archive`. Returns pages archived.
    pub fn archive_folder(&self, folder_id: &Uuid) -> Result<u32> {
        self.tx(|| {
            let now = Utc::now().to_rfc3339();
            let fid = folder_id.to_string();
            let subtree_pages = format!(
                "WITH RECURSIVE {FOLDER_SUBTREE} SELECT p.id FROM pages p WHERE p.folder_id IN (SELECT id FROM sub)"
            );
            self.conn.execute(
                &format!("DELETE FROM favorites WHERE page_id IN ({subtree_pages})"),
                rusqlite::params![fid],
            )?;
            let n = self.conn.execute(
                &format!(
                    "INSERT OR IGNORE INTO archive (page_id, archived_at)
                     SELECT id, ?2 FROM ({subtree_pages})"
                ),
                rusqlite::params![fid, now],
            )?;
            self.conn.execute(
                "INSERT OR IGNORE INTO folder_archive (folder_id, archived_at) VALUES (?1, ?2)",
                rusqlite::params![fid, now],
            )?;
            Ok(n as u32)
        })
    }

    /// Unarchive a folder, its subfolders and every page in the subtree.
    pub fn unarchive_folder(&self, folder_id: &Uuid) -> Result<()> {
        self.tx(|| {
            self.conn.execute(
                &format!(
                    "WITH RECURSIVE {FOLDER_SUBTREE}
                     DELETE FROM folder_archive WHERE folder_id IN (SELECT id FROM sub)"
                ),
                rusqlite::params![folder_id.to_string()],
            )?;
            self.conn.execute(
                &format!(
                    "WITH RECURSIVE {FOLDER_SUBTREE}
                     DELETE FROM archive WHERE page_id IN
                        (SELECT id FROM pages WHERE folder_id IN (SELECT id FROM sub))"
                ),
                rusqlite::params![folder_id.to_string()],
            )?;
            Ok(())
        })
    }

    /// List all archived items as a flat recovery list (folders + standalone pages).
    pub fn list_archived_items(&self) -> Result<Vec<ArchiveItem>> {
        let mut items = Vec::new();

        // Archived folders
        let mut stmt = self.conn.prepare(
            "SELECT f.id, f.name, fa.archived_at
             FROM folder_archive fa
             JOIN folders f ON f.id = fa.folder_id
             ORDER BY fa.archived_at DESC",
        )?;
        let folder_rows = stmt.query_map([], |row| {
            let id: String = row.get(0)?;
            let name: String = row.get(1)?;
            let archived_at: String = row.get(2)?;
            Ok((id, name, archived_at))
        })?;
        for row in folder_rows {
            let (id, name, archived_at) = row.map_err(Error::Database)?;
            let count: i64 = self.conn.query_row(
                &format!(
                    "WITH RECURSIVE {FOLDER_SUBTREE}
                     SELECT COUNT(*) FROM archive a JOIN pages p ON p.id = a.page_id
                     WHERE p.folder_id IN (SELECT id FROM sub)"
                ),
                rusqlite::params![id],
                |row| row.get(0),
            )?;
            items.push(ArchiveItem {
                id,
                title: name,
                item_type: "folder".to_string(),
                page_count: count as u32,
                archived_at,
            });
        }

        // Archived standalone pages (not inside any archived folder subtree)
        let mut stmt = self.conn.prepare(&format!(
            "WITH RECURSIVE {ARCHIVED_FOLDER_TREE}
             SELECT p.id, p.title, a.archived_at
             FROM archive a
             JOIN pages p ON p.id = a.page_id
             WHERE p.folder_id IS NULL
                OR p.folder_id NOT IN (SELECT id FROM archived_tree)
             ORDER BY a.archived_at DESC"
        ))?;
        let page_rows = stmt.query_map([], |row| {
            let id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let archived_at: String = row.get(2)?;
            Ok((id, title, archived_at))
        })?;
        for row in page_rows {
            let (id, title, archived_at) = row.map_err(Error::Database)?;
            items.push(ArchiveItem {
                id,
                title,
                item_type: "page".to_string(),
                page_count: 0,
                archived_at,
            });
        }

        items.sort_by(|a, b| b.archived_at.cmp(&a.archived_at));
        Ok(items)
    }

    pub fn archived_count(&self) -> Result<u32> {
        let folders: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM folder_archive", [], |row| row.get(0),
        )?;
        let pages: i64 = self.conn.query_row(
            &format!(
                "WITH RECURSIVE {ARCHIVED_FOLDER_TREE}
                 SELECT COUNT(*) FROM archive a JOIN pages p ON p.id = a.page_id
                 WHERE p.folder_id IS NULL OR p.folder_id NOT IN (SELECT id FROM archived_tree)"
            ),
            [], |row| row.get(0),
        )?;
        Ok((folders + pages) as u32)
    }
}

#[cfg(test)]
mod tests {
    use crate::db::Database;

    fn nested(db: &Database) -> (uuid::Uuid, uuid::Uuid) {
        let f = db.create_folder("F", None, None, None, "user").unwrap();
        let s = db.create_folder("S", Some(&f.id), None, None, "user").unwrap();
        let p = db.create_page("Deep", None, false, None, "user").unwrap();
        db.move_page_to_folder(&p.id, Some(&s.id), "user").unwrap();
        db.create_block(&p.id, "the secretword lives here", None, None, "user").unwrap();
        (f.id, p.id)
    }

    #[test]
    fn test_archive_folder_recurses_subfolders() {
        let db = Database::open_in_memory().unwrap();
        let (f, p) = nested(&db);
        assert_eq!(db.archive_folder(&f).unwrap(), 1);
        assert!(db.list_pages(None).unwrap().iter().all(|x| x.id != p));
        assert!(db.search("secretword", None).unwrap().is_empty());
        let items = db.list_archived_items().unwrap();
        assert_eq!(items.len(), 1, "only the folder is listed, not the nested page");
        assert_eq!(items[0].page_count, 1);
        assert_eq!(db.archived_count().unwrap(), 1);

        db.unarchive_folder(&f).unwrap();
        assert!(db.list_pages(None).unwrap().iter().any(|x| x.id == p));
        assert_eq!(db.search("secretword", None).unwrap().len(), 1);
        assert_eq!(db.archived_count().unwrap(), 0);
    }
}
