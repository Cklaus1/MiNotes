use chrono::Utc;
use serde::Serialize;
use uuid::Uuid;

use crate::db::Database;
use crate::error::{Error, Result};

/// A trash item — either a page or a folder (with page count).
#[derive(Debug, Clone, Serialize)]
pub struct TrashItem {
    pub id: String,
    pub title: String,
    pub item_type: String, // "page" or "folder"
    pub page_count: u32,   // for folders: how many pages inside (whole subtree)
    pub deleted_at: String,
}

/// Recursive CTE `trashed_tree(id)`: every folder that is trashed or is inside a
/// trashed folder. `UNION` keeps it terminating even on a corrupt folder cycle.
pub(crate) const TRASHED_FOLDER_TREE: &str = "trashed_tree(id) AS (
    SELECT folder_id FROM folder_trash
    UNION
    SELECT f.id FROM folders f JOIN trashed_tree t ON f.parent_id = t.id
)";

impl Database {
    /// Move a page to trash (soft delete).
    pub fn trash_page(&self, page_id: &Uuid) -> Result<()> {
        self.tx(|| {
            let now = Utc::now();
            self.remove_favorite(page_id)?;
            self.conn.execute(
                "INSERT OR IGNORE INTO trash (page_id, deleted_at) VALUES (?1, ?2)",
                rusqlite::params![page_id.to_string(), now.to_rfc3339()],
            )?;
            Ok(())
        })
    }

    /// Trash a folder and every page in its whole subtree (nested subfolders
    /// included). Only the folder itself is recorded in `folder_trash`; its
    /// subfolders are hidden because their ancestor is. Returns pages trashed.
    pub fn trash_folder(&self, folder_id: &Uuid) -> Result<u32> {
        self.tx(|| {
            let now = Utc::now().to_rfc3339();
            let fid = folder_id.to_string();
            let subtree_pages = format!(
                "WITH RECURSIVE {} SELECT p.id FROM pages p WHERE p.folder_id IN (SELECT id FROM sub)",
                crate::repo::folders::FOLDER_SUBTREE
            );
            self.conn.execute(
                &format!("DELETE FROM favorites WHERE page_id IN ({subtree_pages})"),
                rusqlite::params![fid],
            )?;
            let n = self.conn.execute(
                &format!(
                    "INSERT OR IGNORE INTO trash (page_id, deleted_at)
                     SELECT id, ?2 FROM ({subtree_pages})"
                ),
                rusqlite::params![fid, now],
            )?;
            self.conn.execute(
                "INSERT OR IGNORE INTO folder_trash (folder_id, deleted_at) VALUES (?1, ?2)",
                rusqlite::params![fid, now],
            )?;
            Ok(n as u32)
        })
    }

    /// Restore a page from trash.
    pub fn restore_page(&self, page_id: &Uuid) -> Result<()> {
        let count = self.conn.execute(
            "DELETE FROM trash WHERE page_id = ?1",
            rusqlite::params![page_id.to_string()],
        )?;
        if count == 0 {
            return Err(Error::NotFound("Page not in trash".to_string()));
        }
        Ok(())
    }

    /// Restore a folder, its nested subfolders and all their pages from trash.
    pub fn restore_folder(&self, folder_id: &Uuid) -> Result<()> {
        self.tx(|| {
            // Check for name conflict
            let folder_name: String = self
                .conn
                .query_row(
                    "SELECT name FROM folders WHERE id = ?1",
                    rusqlite::params![folder_id.to_string()],
                    |row| row.get(0),
                )
                .map_err(|_| Error::NotFound("Folder not found".to_string()))?;

            // Check if another folder with this name exists (not trashed)
            let conflict: i64 = self.conn.query_row(
                "SELECT COUNT(*) FROM folders WHERE name = ?1 AND id != ?2 AND id NOT IN (SELECT folder_id FROM folder_trash)",
                rusqlite::params![folder_name, folder_id.to_string()],
                |row| row.get(0),
            )?;
            if conflict > 0 {
                // Rename to avoid conflict
                let new_name = format!("{} (restored)", folder_name);
                self.conn.execute(
                    "UPDATE folders SET name = ?1 WHERE id = ?2",
                    rusqlite::params![new_name, folder_id.to_string()],
                )?;
            }

            let sub = crate::repo::folders::FOLDER_SUBTREE;
            self.conn.execute(
                &format!(
                    "WITH RECURSIVE {sub}
                     DELETE FROM folder_trash WHERE folder_id IN (SELECT id FROM sub)"
                ),
                rusqlite::params![folder_id.to_string()],
            )?;
            self.conn.execute(
                &format!(
                    "WITH RECURSIVE {sub}
                     DELETE FROM trash WHERE page_id IN
                        (SELECT id FROM pages WHERE folder_id IN (SELECT id FROM sub))"
                ),
                rusqlite::params![folder_id.to_string()],
            )?;
            Ok(())
        })
    }

    /// Permanently delete a page (from trash), then collect whiteboards nothing
    /// references any more (see `gc_whiteboards`).
    pub fn permanently_delete_page(&self, page_id: &Uuid, actor: &str) -> Result<()> {
        self.purge_page(page_id, actor)?;
        self.gc_whiteboards_quietly();
        Ok(())
    }

    fn purge_page(&self, page_id: &Uuid, actor: &str) -> Result<()> {
        self.tx(|| {
            self.conn.execute(
                "DELETE FROM trash WHERE page_id = ?1",
                rusqlite::params![page_id.to_string()],
            )?;
            self.delete_page(page_id, actor)?;
            Ok(())
        })
    }

    /// Permanently delete a folder and its pages, then collect whiteboards
    /// nothing references any more (see `gc_whiteboards`).
    pub fn permanently_delete_folder(&self, folder_id: &Uuid, actor: &str) -> Result<()> {
        self.purge_folder(folder_id, actor)?;
        self.gc_whiteboards_quietly();
        Ok(())
    }

    fn purge_folder(&self, folder_id: &Uuid, actor: &str) -> Result<()> {
        self.tx(|| {
            // Bug #30: walk the ENTIRE subtree (subfolders too), not just direct children.
            // `pages.folder_id ON DELETE SET NULL` means subfolder pages would otherwise
            // survive as orphaned root pages — data the user believed they purged.
            let folder_ids = self.folder_subtree_ids(folder_id)?;
            let json = serde_json::to_string(&folder_ids)?;

            // Delete every page in every descendant folder (including trashed ones).
            let page_ids: Vec<String> = {
                let mut stmt = self.conn.prepare(
                    "SELECT id FROM pages WHERE folder_id IN (SELECT value FROM json_each(?1))",
                )?;
                let rows = stmt
                    .query_map(rusqlite::params![json], |row| row.get::<_, String>(0))?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                rows
            };
            for pid in page_ids {
                let Ok(pid) = Uuid::parse_str(&pid) else { continue };
                self.conn.execute(
                    "DELETE FROM trash WHERE page_id = ?1",
                    rusqlite::params![pid.to_string()],
                )?;
                self.delete_page(&pid, actor)?;
            }

            self.conn.execute(
                "DELETE FROM folder_trash WHERE folder_id IN (SELECT value FROM json_each(?1))",
                rusqlite::params![json],
            )?;
            // Deleting the root folder cascades to subfolders via FK.
            self.delete_folder(folder_id, actor)?;
            Ok(())
        })
    }

    /// List all trash items (pages + folders) as a flat recovery list.
    pub fn list_trash(&self) -> Result<Vec<TrashItem>> {
        let mut items = Vec::new();

        // Trashed folders (roots of trashed subtrees)
        let mut stmt = self.conn.prepare(
            "SELECT f.id, f.name, ft.deleted_at
             FROM folder_trash ft
             JOIN folders f ON f.id = ft.folder_id
             ORDER BY ft.deleted_at DESC",
        )?;
        let folder_rows = stmt.query_map([], |row| {
            let id: String = row.get(0)?;
            let name: String = row.get(1)?;
            let deleted_at: String = row.get(2)?;
            Ok((id, name, deleted_at))
        })?;
        for row in folder_rows {
            let (id, name, deleted_at) = row.map_err(Error::Database)?;
            // Count trashed pages anywhere in this folder's subtree
            let count: i64 = self.conn.query_row(
                &format!(
                    "WITH RECURSIVE {}
                     SELECT COUNT(*) FROM trash t JOIN pages p ON p.id = t.page_id
                     WHERE p.folder_id IN (SELECT id FROM sub)",
                    crate::repo::folders::FOLDER_SUBTREE
                ),
                rusqlite::params![id],
                |row| row.get(0),
            )?;
            items.push(TrashItem {
                id,
                title: name,
                item_type: "folder".to_string(),
                page_count: count as u32,
                deleted_at,
            });
        }

        // Trashed pages not inside any trashed folder subtree
        let mut stmt = self.conn.prepare(&format!(
            "WITH RECURSIVE {TRASHED_FOLDER_TREE}
             SELECT p.id, p.title, t.deleted_at
             FROM trash t
             JOIN pages p ON p.id = t.page_id
             WHERE p.folder_id IS NULL
                OR p.folder_id NOT IN (SELECT id FROM trashed_tree)
             ORDER BY t.deleted_at DESC"
        ))?;
        let page_rows = stmt.query_map([], |row| {
            let id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let deleted_at: String = row.get(2)?;
            Ok((id, title, deleted_at))
        })?;
        for row in page_rows {
            let (id, title, deleted_at) = row.map_err(Error::Database)?;
            items.push(TrashItem {
                id,
                title,
                item_type: "page".to_string(),
                page_count: 0,
                deleted_at,
            });
        }

        // Sort all by deleted_at descending
        items.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
        Ok(items)
    }

    /// Empty the entire trash.
    /// Permanently delete everything in the trash. Returns the number of items
    /// actually purged — NOT the number attempted. Each item is atomic.
    pub fn empty_trash(&self, actor: &str) -> Result<u32> {
        let items = self.list_trash()?;
        let mut purged = 0u32;
        // Delete folders first (they cascade to pages)
        for item in &items {
            if item.item_type == "folder" {
                // An unparseable id is a real failure, not a nil-UUID delete
                // that "succeeds" while purging nothing.
                let Ok(uuid) = Uuid::parse_str(&item.id) else { continue };
                if self.purge_folder(&uuid, actor).is_ok() {
                    purged += 1;
                }
            }
        }
        // Delete remaining pages
        for item in &items {
            if item.item_type == "page" {
                let Ok(uuid) = Uuid::parse_str(&item.id) else { continue };
                if self.purge_page(&uuid, actor).is_ok() {
                    purged += 1;
                }
            }
        }
        // One GC pass for the whole batch (boards of purged pages).
        self.gc_whiteboards_quietly();
        Ok(purged)
    }

    /// Check if a page is in the trash.
    pub fn is_trashed(&self, page_id: &Uuid) -> Result<bool> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM trash WHERE page_id = ?1",
            rusqlite::params![page_id.to_string()],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }
}

#[cfg(test)]
mod tests {
    use crate::db::Database;

    // empty_trash used to `let _ =` every delete and return the PRE-count, so it
    // reported success even when items survived. It must report what it purged.
    #[test]
    fn test_empty_trash_returns_actually_purged_count() {
        let db = Database::open_in_memory().unwrap();
        let a = db.create_page("A", None, false, None, "user").unwrap();
        let b = db.create_page("B", None, false, None, "user").unwrap();
        let folder = db.create_folder("F", None, None, None, "user").unwrap();

        db.trash_page(&a.id).unwrap();
        db.trash_page(&b.id).unwrap();
        db.trash_folder(&folder.id).unwrap();
        assert_eq!(db.list_trash().unwrap().len(), 3);

        let purged = db.empty_trash("user").unwrap();
        assert_eq!(purged, 3, "reports the number actually purged");
        assert!(db.list_trash().unwrap().is_empty(), "trash is really empty");

        // Emptying an already-empty trash purges nothing.
        assert_eq!(db.empty_trash("user").unwrap(), 0);
    }

    // trash_folder must hide pages in NESTED subfolders too (list, search, trash
    // list), and restore must bring them back.
    #[test]
    fn test_trash_folder_recurses_subfolders() {
        let db = Database::open_in_memory().unwrap();
        let f = db.create_folder("F", None, None, None, "user").unwrap();
        let s = db.create_folder("S", Some(&f.id), None, None, "user").unwrap();
        let p = db.create_page("Deep", None, false, None, "user").unwrap();
        db.move_page_to_folder(&p.id, Some(&s.id), "user").unwrap();
        db.create_block(&p.id, "the secretword lives here", None, None, "user").unwrap();
        db.add_favorite(&p.id, "user").unwrap();

        assert_eq!(db.trash_folder(&f.id).unwrap(), 1);
        assert!(db.list_pages(None).unwrap().iter().all(|x| x.id != p.id));
        assert!(db.search("secretword", None).unwrap().is_empty());
        assert!(db.list_favorites().unwrap().is_empty());
        let items = db.list_trash().unwrap();
        assert_eq!(items.len(), 1, "nested page is listed under its folder, not standalone");
        assert_eq!(items[0].page_count, 1);

        db.restore_folder(&f.id).unwrap();
        assert!(db.list_pages(None).unwrap().iter().any(|x| x.id == p.id));
        assert_eq!(db.search("secretword", None).unwrap().len(), 1);
        assert!(db.list_trash().unwrap().is_empty());
    }

    #[test]
    fn test_trash_folder_atomic() {
        let db = Database::open_in_memory().unwrap();
        let f = db.create_folder("F", None, None, None, "user").unwrap();
        let p = db.create_page("P", None, false, None, "user").unwrap();
        db.move_page_to_folder(&p.id, Some(&f.id), "user").unwrap();
        db.conn
            .execute_batch(
                "CREATE TRIGGER boom BEFORE INSERT ON folder_trash BEGIN SELECT RAISE(ABORT, 'injected'); END;",
            )
            .unwrap();
        assert!(db.trash_folder(&f.id).is_err());
        assert!(!db.is_trashed(&p.id).unwrap(), "page trash rolled back");
    }

    // Bug #30: permanently deleting a folder must purge pages in NESTED subfolders,
    // not orphan them to root.
    #[test]
    fn test_permanently_delete_folder_recurses_subfolders() {
        let db = Database::open_in_memory().unwrap();
        let parent = db.create_folder("Parent", None, None, None, "user").unwrap();
        let child = db.create_folder("Child", Some(&parent.id), None, None, "user").unwrap();

        let p_root = db.create_page("RootPage", None, false, None, "user").unwrap();
        db.move_page_to_folder(&p_root.id, Some(&parent.id), "user").unwrap();
        let p_nested = db.create_page("NestedPage", None, false, None, "user").unwrap();
        db.move_page_to_folder(&p_nested.id, Some(&child.id), "user").unwrap();

        db.trash_folder(&parent.id).unwrap();
        db.permanently_delete_folder(&parent.id, "user").unwrap();

        // Both pages gone; neither orphaned to root.
        assert!(db.get_page(&p_root.id).unwrap().is_none());
        assert!(db.get_page(&p_nested.id).unwrap().is_none(), "nested page must be purged, not orphaned");
        let roots = db.list_pages(Some(100)).unwrap();
        assert!(roots.iter().all(|p| p.id != p_nested.id && p.id != p_root.id));
    }
}
