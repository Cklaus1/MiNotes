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

/// `WITH RECURSIVE` prefix defining `hidden_pages(id)`: every page the user can
/// no longer see — in the trash or the archive, directly or through a trashed /
/// archived ancestor folder. Search, backlinks, unlinked references, the graph
/// and favourites all filter with `NOT IN (SELECT id FROM hidden_pages)`.
pub(crate) fn hidden_pages_cte() -> String {
    format!(
        "WITH RECURSIVE {TRASHED_FOLDER_TREE}, {},
         hidden_pages(id) AS (
            SELECT page_id FROM trash
            UNION SELECT page_id FROM archive
            UNION SELECT p.id FROM pages p
                  WHERE p.folder_id IN (SELECT id FROM trashed_tree)
                     OR p.folder_id IN (SELECT id FROM archived_tree)
         )",
        crate::repo::archive::ARCHIVED_FOLDER_TREE
    )
}

impl Database {
    /// Is this page hidden from the user (trash/archive, directly or via a folder)?
    pub fn is_page_hidden(&self, page_id: &Uuid) -> Result<bool> {
        Ok(self.conn.query_row(
            &format!("{} SELECT EXISTS(SELECT 1 FROM hidden_pages WHERE id = ?1)", hidden_pages_cte()),
            rusqlite::params![page_id.to_string()],
            |row| row.get(0),
        )?)
    }

    /// Titles are unique, but a page in the trash must not keep its title from
    /// the user: if `title` belongs to a trashed page, that page is "parked" under
    /// a unique placeholder title and its real title is kept in
    /// `trash.original_title` (shown by `list_trash`, used again on restore).
    /// Call inside the caller's transaction, before inserting/renaming.
    pub(crate) fn free_title_from_trash(&self, title: &str) -> Result<()> {
        let holder: Option<String> = self
            .conn
            .query_row(
                "SELECT p.id FROM pages p JOIN trash t ON t.page_id = p.id WHERE p.title = ?1",
                rusqlite::params![title],
                |row| row.get(0),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })?;
        let Some(id) = holder else { return Ok(()) };
        let short: String = id.chars().filter(|c| c.is_ascii_hexdigit()).collect();
        let short = &short[short.len().saturating_sub(12)..];
        let mut parked = format!("{title} (deleted {short})");
        let mut n = 2;
        while self.page_title_taken(&parked)? {
            parked = format!("{title} (deleted {short} {n})");
            n += 1;
        }
        // Raw UPDATE, not rename_page: links/aliases must not be rewritten.
        self.conn.execute(
            "UPDATE trash SET original_title = COALESCE(original_title, ?1) WHERE page_id = ?2",
            rusqlite::params![title, id],
        )?;
        self.conn.execute(
            "UPDATE pages SET title = ?1 WHERE id = ?2",
            rusqlite::params![parked, id],
        )?;
        Ok(())
    }

    fn page_title_taken(&self, title: &str) -> Result<bool> {
        Ok(self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM pages WHERE title = ?1)",
            rusqlite::params![title],
            |row| row.get(0),
        )?)
    }

    /// Give a page leaving the trash its real title back: the original one, or
    /// "<title> (restored)" ("(restored 2)", …) if a live page took it meanwhile.
    fn unpark_title(&self, page_id: &Uuid) -> Result<()> {
        let original: Option<String> = self
            .conn
            .query_row(
                "SELECT original_title FROM trash WHERE page_id = ?1",
                rusqlite::params![page_id.to_string()],
                |row| row.get(0),
            )
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })?;
        let Some(original) = original else { return Ok(()) };
        let mut title = original.clone();
        let mut n = 1;
        while self.page_title_taken(&title)? {
            title = if n == 1 {
                format!("{original} (restored)")
            } else {
                format!("{original} (restored {n})")
            };
            n += 1;
        }
        self.conn.execute(
            "UPDATE pages SET title = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![title, Utc::now().to_rfc3339(), page_id.to_string()],
        )?;
        Ok(())
    }

    /// Move a page to trash (soft delete). Its favourite entry is kept (hidden
    /// while trashed) so restoring brings the star back.
    pub fn trash_page(&self, page_id: &Uuid) -> Result<()> {
        self.tx(|| {
            let now = Utc::now();
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
        self.tx(|| {
            self.unpark_title(page_id)?;
            let count = self.conn.execute(
                "DELETE FROM trash WHERE page_id = ?1",
                rusqlite::params![page_id.to_string()],
            )?;
            if count == 0 {
                return Err(Error::NotFound("Page not in trash".to_string()));
            }
            Ok(())
        })
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
            let parked: Vec<String> = {
                let mut stmt = self.conn.prepare(&format!(
                    "WITH RECURSIVE {sub}
                     SELECT t.page_id FROM trash t JOIN pages p ON p.id = t.page_id
                     WHERE p.folder_id IN (SELECT id FROM sub) AND t.original_title IS NOT NULL"
                ))?;
                let rows = stmt
                    .query_map(rusqlite::params![folder_id.to_string()], |row| row.get::<_, String>(0))?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                rows
            };
            for pid in parked {
                if let Ok(pid) = Uuid::parse_str(&pid) {
                    self.unpark_title(&pid)?;
                }
            }
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

    /// The trash view's "Delete forever": only for items that are in the trash.
    /// (`permanently_delete_page` / `_folder` stay unrestricted for the CLI's
    /// `--permanent` and sync.)
    pub fn delete_from_trash(&self, id: &Uuid, item_type: &str, actor: &str) -> Result<()> {
        let in_trash: bool = if item_type == "folder" {
            self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM folder_trash WHERE folder_id = ?1)",
                rusqlite::params![id.to_string()],
                |row| row.get(0),
            )?
        } else {
            self.is_trashed(id)?
        };
        if !in_trash {
            let what = if item_type == "folder" { "folder" } else { "page" };
            return Err(Error::InvalidInput(format!(
                "This {what} is not in the trash; move it to the trash before deleting it permanently"
            )));
        }
        if item_type == "folder" {
            self.permanently_delete_folder(id, actor)
        } else {
            self.permanently_delete_page(id, actor)
        }
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
             SELECT p.id, COALESCE(t.original_title, p.title), t.deleted_at
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

    fn titles(db: &Database) -> Vec<String> {
        let mut t: Vec<String> = db.list_pages(None).unwrap().into_iter().map(|p| p.title).collect();
        t.sort();
        t
    }

    // A page in the trash doesn't block its title: a new page can take it, the
    // trash still shows the old one under its real name, and restoring it while
    // the title is taken appends " (restored)".
    #[test]
    fn test_trashed_title_is_reusable_and_restore_renames() {
        let db = Database::open_in_memory().unwrap();
        let old = db.create_page("Reborn", None, false, None, "user").unwrap();
        db.trash_page(&old.id).unwrap();

        let new = db.create_page("Reborn", None, false, None, "user").unwrap();
        assert_ne!(new.id, old.id);
        assert_eq!(db.get_page_by_title("Reborn").unwrap().unwrap().id, new.id);
        let trash = db.list_trash().unwrap();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].title, "Reborn", "trash shows the real title");

        // Trash the new one too, then a third: two parked pages, no collision.
        db.trash_page(&new.id).unwrap();
        let third = db.create_page("Reborn", None, false, None, "user").unwrap();
        assert_eq!(db.list_trash().unwrap().iter().filter(|t| t.title == "Reborn").count(), 2);

        db.restore_page(&old.id).unwrap();
        assert_eq!(db.get_page(&old.id).unwrap().unwrap().title, "Reborn (restored)");
        db.restore_page(&new.id).unwrap();
        assert_eq!(db.get_page(&new.id).unwrap().unwrap().title, "Reborn (restored 2)");
        assert_eq!(titles(&db), vec!["Reborn", "Reborn (restored 2)", "Reborn (restored)"]);
        assert_eq!(db.get_page(&third.id).unwrap().unwrap().title, "Reborn");

        // Rename onto a trashed page's title works the same way.
        let x = db.create_page("X", None, false, None, "user").unwrap();
        db.trash_page(&x.id).unwrap();
        let y = db.create_page("Y", None, false, None, "user").unwrap();
        db.rename_page(&y.id, "X", "user").unwrap();
        // Restoring with the title FREE gives the original title back.
        db.rename_page(&y.id, "Y", "user").unwrap();
        db.restore_page(&x.id).unwrap();
        assert_eq!(db.get_page(&x.id).unwrap().unwrap().title, "X");
    }

    // Restoring a folder gives its parked pages their titles back.
    #[test]
    fn test_restore_folder_unparks_titles() {
        let db = Database::open_in_memory().unwrap();
        let f = db.create_folder("F", None, None, None, "user").unwrap();
        let p = db.create_page("Inside", None, false, None, "user").unwrap();
        db.move_page_to_folder(&p.id, Some(&f.id), "user").unwrap();
        db.trash_folder(&f.id).unwrap();
        let other = db.create_page("Inside", None, false, None, "user").unwrap();
        db.restore_folder(&f.id).unwrap();
        assert_eq!(db.get_page(&p.id).unwrap().unwrap().title, "Inside (restored)");
        assert_eq!(db.get_page(&other.id).unwrap().unwrap().title, "Inside");
    }

    // Trashed/archived pages don't appear in backlinks, unlinked references or
    // the graph; a block linking twice is ONE backlink.
    #[test]
    fn test_hidden_pages_leave_backlinks_unlinked_and_graph() {
        let db = Database::open_in_memory().unwrap();
        let target = db.create_page("Target", None, false, None, "user").unwrap();
        let live = db.create_page("Live", None, false, None, "user").unwrap();
        let gone = db.create_page("Gone", None, false, None, "user").unwrap();
        let shelved = db.create_page("Shelved", None, false, None, "user").unwrap();
        db.create_block(&live.id, "[[Target]] and again [[Target]]", None, None, "user").unwrap();
        db.create_block(&live.id, "plain Target mention", None, None, "user").unwrap();
        for p in [&gone, &shelved] {
            db.create_block(&p.id, "see [[Target]]", None, None, "user").unwrap();
            db.create_block(&p.id, "Target mentioned", None, None, "user").unwrap();
        }
        assert_eq!(db.get_backlinks(&target.id).unwrap().len(), 3);
        db.trash_page(&gone.id).unwrap();
        db.archive_page(&shelved.id).unwrap();

        let bl = db.get_backlinks(&target.id).unwrap();
        assert_eq!(bl.len(), 1, "one per block, hidden pages excluded");
        let entries = db.get_backlink_blocks(&target.id).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].1.page_title, "Live");
        assert_eq!(entries[0].1.block.content, "[[Target]] and again [[Target]]");

        let un = db.get_unlinked_references(&target.id).unwrap();
        assert_eq!(un.iter().map(|b| b.content.as_str()).collect::<Vec<_>>(), vec!["plain Target mention"]);

        let g = db.get_graph_data().unwrap();
        let names: Vec<&str> = g.nodes.iter().map(|n| n.title.as_str()).collect();
        assert!(!names.contains(&"Gone") && !names.contains(&"Shelved"));
        assert_eq!(g.edges.len(), 1);
        assert_eq!(g.nodes.iter().find(|n| n.id == target.id).unwrap().link_count, 2);

        // Restoring brings them back.
        db.restore_page(&gone.id).unwrap();
        assert_eq!(db.get_backlinks(&target.id).unwrap().len(), 2);
    }

    // Favourites survive a trash/archive round trip (hidden meanwhile).
    #[test]
    fn test_favorite_survives_trash_and_archive() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page("Fav", None, false, None, "user").unwrap();
        db.add_favorite(&p.id, "user").unwrap();
        db.trash_page(&p.id).unwrap();
        assert!(db.list_favorites().unwrap().is_empty());
        db.restore_page(&p.id).unwrap();
        assert_eq!(db.list_favorites().unwrap().len(), 1);
        db.archive_page(&p.id).unwrap();
        assert!(db.list_favorites().unwrap().is_empty());
        db.unarchive_page(&p.id).unwrap();
        assert_eq!(db.list_favorites().unwrap().len(), 1);

        let f = db.create_folder("F", None, None, None, "user").unwrap();
        db.move_page_to_folder(&p.id, Some(&f.id), "user").unwrap();
        db.trash_folder(&f.id).unwrap();
        assert!(db.list_favorites().unwrap().is_empty());
        db.restore_folder(&f.id).unwrap();
        assert_eq!(db.list_favorites().unwrap().len(), 1);
    }

    // "Delete forever" only applies to things in the trash.
    #[test]
    fn test_delete_from_trash_requires_trash() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page("Live", None, false, None, "user").unwrap();
        let err = db.delete_from_trash(&p.id, "page", "user").unwrap_err().to_string();
        assert!(err.contains("not in the trash"), "{err}");
        assert!(db.get_page(&p.id).unwrap().is_some());
        let f = db.create_folder("F", None, None, None, "user").unwrap();
        assert!(db.delete_from_trash(&f.id, "folder", "user").is_err());

        db.trash_page(&p.id).unwrap();
        db.delete_from_trash(&p.id, "page", "user").unwrap();
        assert!(db.get_page(&p.id).unwrap().is_none());
        db.trash_folder(&f.id).unwrap();
        db.delete_from_trash(&f.id, "folder", "user").unwrap();
    }

    // Empty / whitespace-only titles are rejected; collisions say so plainly.
    #[test]
    fn test_title_validation_and_messages() {
        let db = Database::open_in_memory().unwrap();
        for t in ["", "   ", "\t\n"] {
            assert!(db.create_page(t, None, false, None, "user").is_err(), "create {t:?}");
        }
        let a = db.create_page("A", None, false, None, "user").unwrap();
        db.create_page("B", None, false, None, "user").unwrap();
        assert!(db.rename_page(&a.id, "  ", "user").is_err());
        assert_eq!(db.get_page(&a.id).unwrap().unwrap().title, "A");
        let e = db.rename_page(&a.id, "B", "user").unwrap_err().to_string();
        assert_eq!(e, "A page titled 'B' already exists");
        let e = db.create_page("B", None, false, None, "user").unwrap_err().to_string();
        assert_eq!(e, "A page titled 'B' already exists");
    }

    // Today's journal is created on read; a trashed journal doesn't come back.
    #[test]
    fn test_get_or_create_journal() {
        let db = Database::open_in_memory().unwrap();
        let d = chrono::NaiveDate::from_ymd_opt(2026, 1, 2).unwrap();
        assert!(db.find_journal(d).unwrap().is_none());
        let id = uuid::Uuid::now_v7();
        let p = db.get_or_create_journal(d, Some(id), "user").unwrap();
        assert_eq!(p.id, id, "materialised under the id the caller showed");
        assert!(p.is_journal);
        assert_eq!(p.title, "Journal/2026-01-02");
        db.create_block(&p.id, "entry", None, None, "user").unwrap();
        assert_eq!(db.get_or_create_journal(d, None, "user").unwrap().id, id, "idempotent");

        db.trash_page(&id).unwrap();
        let fresh = db.get_or_create_journal(d, None, "user").unwrap();
        assert_ne!(fresh.id, id);
        assert!(db.get_page_blocks(&fresh.id).unwrap().is_empty());
    }

    // create_block on a missing page / parent: readable error, nothing written.
    #[test]
    fn test_create_block_missing_page_or_parent() {
        let db = Database::open_in_memory().unwrap();
        let ghost = uuid::Uuid::now_v7();
        let e = db.create_block(&ghost, "x", None, None, "user").unwrap_err().to_string();
        assert!(e.starts_with("Not found: Page"), "{e}");
        let p = db.create_page("P", None, false, None, "user").unwrap();
        let e = db.create_block(&p.id, "x", Some(&ghost), None, "user").unwrap_err().to_string();
        assert!(e.starts_with("Not found: Parent block"), "{e}");
        assert!(db.get_page_blocks(&p.id).unwrap().is_empty());
    }

    #[test]
    fn test_get_blocks_with_pages_batch() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page("P", None, false, None, "user").unwrap();
        let a = db.create_block(&p.id, "a", None, None, "user").unwrap();
        let b = db.create_block(&p.id, "b", None, None, "user").unwrap();
        let got = db.get_blocks_with_pages(&[b.id, uuid::Uuid::now_v7(), a.id]).unwrap();
        assert_eq!(got.iter().map(|x| x.block.content.as_str()).collect::<Vec<_>>(), vec!["b", "a"]);
        assert!(got.iter().all(|x| x.page_title == "P"));
        let json = serde_json::to_value(&got[0]).unwrap();
        assert_eq!(json["page_title"], "P");
        assert_eq!(json["content"], "b", "block fields are flattened");
    }
}
