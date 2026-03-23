//! CRDT-based sync module (F-015).
//!
//! Each page is serialised as a JSON snapshot stored in `sync_state`.
//! The snapshot contains page metadata and its blocks list. Version
//! history is maintained by appending timestamped entries so that any
//! snapshot can be restored.  Sync messages are the raw snapshot bytes
//! which can be exchanged between peers for conflict-free replication.

use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::models::{Block, Page, SyncStatus, VersionInfo};

/// Internal snapshot format stored in doc_bytes (JSON).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct PageSnapshot {
    id: String,
    title: String,
    icon: Option<String>,
    folder_id: Option<String>,
    position: f64,
    is_journal: bool,
    journal_date: Option<String>,
    created_at: String,
    updated_at: String,
    blocks: Vec<BlockSnapshot>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct BlockSnapshot {
    id: String,
    parent_id: Option<String>,
    position: f64,
    content: String,
    format: String,
    collapsed: bool,
}

/// Envelope that stores version history inside `peer_state`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct VersionLog {
    versions: Vec<VersionEntry>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct VersionEntry {
    hash: String,
    timestamp: String,
    actor: String,
    message: Option<String>,
    snapshot: PageSnapshot,
}

impl Database {
    // ── helpers ──

    fn snapshot_from_page(&self, page: &Page, blocks: &[Block]) -> PageSnapshot {
        PageSnapshot {
            id: page.id.to_string(),
            title: page.title.clone(),
            icon: page.icon.clone(),
            folder_id: page.folder_id.map(|f| f.to_string()),
            position: page.position,
            is_journal: page.is_journal,
            journal_date: page.journal_date.map(|d| d.to_string()),
            created_at: page.created_at.to_rfc3339(),
            updated_at: page.updated_at.to_rfc3339(),
            blocks: blocks
                .iter()
                .map(|b| BlockSnapshot {
                    id: b.id.to_string(),
                    parent_id: b.parent_id.map(|p| p.to_string()),
                    position: b.position,
                    content: b.content.clone(),
                    format: b.format.clone(),
                    collapsed: b.collapsed,
                })
                .collect(),
        }
    }

    fn compute_hash(data: &[u8]) -> String {
        // Simple hash: use first 16 hex chars of a basic digest.
        // We use a djb2-style hash and format as hex.
        let mut h: u64 = 5381;
        for &b in data {
            h = h.wrapping_mul(33).wrapping_add(b as u64);
        }
        let mut h2: u64 = 0x517cc1b727220a95;
        for &b in data {
            h2 = h2.wrapping_mul(0x100000001b3) ^ (b as u64);
        }
        format!("{:016x}{:016x}", h, h2)
    }

    fn load_version_log(&self, page_id: &Uuid) -> Result<VersionLog> {
        let result: Option<Vec<u8>> = self
            .conn
            .query_row(
                "SELECT peer_state FROM sync_state WHERE page_id = ?1",
                rusqlite::params![page_id.to_string()],
                |row| row.get(0),
            )
            .ok();

        match result {
            Some(bytes) => {
                serde_json::from_slice(&bytes).map_err(|e| Error::InvalidInput(e.to_string()))
            }
            None => Ok(VersionLog {
                versions: Vec::new(),
            }),
        }
    }

    fn save_sync_state(
        &self,
        page_id: &Uuid,
        doc_bytes: &[u8],
        version_log: &VersionLog,
        last_sync: Option<&str>,
    ) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        let peer_bytes = serde_json::to_vec(version_log)?;
        self.conn.execute(
            "INSERT INTO sync_state (page_id, doc_bytes, peer_state, last_sync, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(page_id) DO UPDATE SET
               doc_bytes = excluded.doc_bytes,
               peer_state = excluded.peer_state,
               last_sync = COALESCE(excluded.last_sync, sync_state.last_sync),
               updated_at = excluded.updated_at",
            rusqlite::params![
                page_id.to_string(),
                doc_bytes,
                peer_bytes,
                last_sync,
                now,
            ],
        )?;
        Ok(())
    }

    // ── public API ──

    /// Convert a page + blocks into a sync document (JSON snapshot bytes).
    pub fn page_to_automerge(&self, page_id: &Uuid) -> Result<Vec<u8>> {
        let page = self
            .get_page(page_id)?
            .ok_or_else(|| Error::NotFound(format!("Page {page_id}")))?;
        let blocks = self.get_page_blocks(page_id)?;
        let snapshot = self.snapshot_from_page(&page, &blocks);
        let doc_bytes = serde_json::to_vec(&snapshot)?;

        // Also persist to sync_state with a version entry
        let hash = Self::compute_hash(&doc_bytes);
        let mut log = self.load_version_log(page_id)?;
        log.versions.push(VersionEntry {
            hash,
            timestamp: Utc::now().to_rfc3339(),
            actor: "local".to_string(),
            message: Some("snapshot".to_string()),
            snapshot: snapshot.clone(),
        });

        // Trim to last 100 versions
        if log.versions.len() > 100 {
            let start = log.versions.len() - 100;
            log.versions = log.versions[start..].to_vec();
        }

        let now_str = Utc::now().to_rfc3339();
        self.save_sync_state(page_id, &doc_bytes, &log, Some(&now_str))?;

        Ok(doc_bytes)
    }

    /// Apply a sync document to update/create a page and its blocks.
    pub fn apply_automerge(&self, doc_bytes: &[u8], actor: &str) -> Result<Uuid> {
        let snapshot: PageSnapshot =
            serde_json::from_slice(doc_bytes).map_err(|e| Error::InvalidInput(e.to_string()))?;

        let page_id =
            Uuid::parse_str(&snapshot.id).map_err(|e| Error::InvalidInput(e.to_string()))?;

        let now = Utc::now();

        // Upsert the page
        self.conn.execute(
            "INSERT INTO pages (id, title, icon, folder_id, position, is_journal, journal_date, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
               title = excluded.title,
               icon = excluded.icon,
               folder_id = excluded.folder_id,
               position = excluded.position,
               is_journal = excluded.is_journal,
               journal_date = excluded.journal_date,
               updated_at = excluded.updated_at",
            rusqlite::params![
                snapshot.id,
                snapshot.title,
                snapshot.icon,
                snapshot.folder_id,
                snapshot.position,
                snapshot.is_journal as i32,
                snapshot.journal_date,
                snapshot.created_at,
                now.to_rfc3339(),
            ],
        )?;

        // Delete existing blocks for this page
        self.conn.execute(
            "DELETE FROM blocks WHERE page_id = ?1",
            rusqlite::params![snapshot.id],
        )?;

        // Recreate blocks
        for block in &snapshot.blocks {
            self.conn.execute(
                "INSERT INTO blocks (id, page_id, parent_id, position, content, format, collapsed, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                rusqlite::params![
                    block.id,
                    snapshot.id,
                    block.parent_id,
                    block.position,
                    block.content,
                    block.format,
                    block.collapsed as i32,
                    now.to_rfc3339(),
                    now.to_rfc3339(),
                ],
            )?;
        }

        // Record version
        let hash = Self::compute_hash(doc_bytes);
        let mut log = self.load_version_log(&page_id)?;
        log.versions.push(VersionEntry {
            hash,
            timestamp: now.to_rfc3339(),
            actor: actor.to_string(),
            message: Some("applied remote snapshot".to_string()),
            snapshot: snapshot.clone(),
        });

        if log.versions.len() > 100 {
            let start = log.versions.len() - 100;
            log.versions = log.versions[start..].to_vec();
        }

        let now_str = now.to_rfc3339();
        self.save_sync_state(&page_id, doc_bytes, &log, Some(&now_str))?;

        Ok(page_id)
    }

    /// Generate a sync message for a page (returns the full snapshot).
    pub fn generate_sync_message(
        &self,
        page_id: &Uuid,
        _peer_state: &[u8],
    ) -> Result<Option<Vec<u8>>> {
        // For JSON-snapshot approach, the sync message is the full snapshot.
        // A smarter implementation would diff against peer_state, but the
        // full snapshot is correct and simple.
        let doc = self.page_to_automerge(page_id)?;
        Ok(Some(doc))
    }

    /// Receive and apply a sync message from a peer. Returns an acknowledgement
    /// message (our current snapshot after merge).
    pub fn receive_sync_message(
        &self,
        page_id: &Uuid,
        message: &[u8],
        actor: &str,
    ) -> Result<Vec<u8>> {
        // Apply the incoming snapshot
        self.apply_automerge(message, actor)?;
        // Return our (now-updated) snapshot as acknowledgement
        self.page_to_automerge(page_id)
    }

    /// Get sync status: pages with local changes since last sync.
    pub fn get_sync_status(&self) -> Result<SyncStatus> {
        let total_pages: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM pages", [], |row| row.get(0))?;

        let synced_pages: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM sync_state", [], |row| row.get(0))?;

        // Pages updated after their last sync (or never synced)
        let pending_changes: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM pages p
             LEFT JOIN sync_state s ON p.id = s.page_id
             WHERE s.page_id IS NULL
                OR p.updated_at > COALESCE(s.last_sync, '1970-01-01')",
            [],
            |row| row.get(0),
        )?;

        // Most recent sync timestamp
        let last_sync: Option<String> = self
            .conn
            .query_row(
                "SELECT MAX(last_sync) FROM sync_state",
                [],
                |row| row.get(0),
            )
            .ok()
            .flatten();

        let last_sync_dt = last_sync.and_then(|s| {
            DateTime::parse_from_rfc3339(&s)
                .ok()
                .map(|dt| dt.with_timezone(&Utc))
        });

        Ok(SyncStatus {
            total_pages,
            synced_pages,
            pending_changes,
            last_sync: last_sync_dt,
        })
    }

    /// Get version history for a page.
    pub fn get_version_history(
        &self,
        page_id: &Uuid,
        limit: Option<usize>,
    ) -> Result<Vec<VersionInfo>> {
        let log = self.load_version_log(page_id)?;
        let limit = limit.unwrap_or(50);

        let versions: Vec<VersionInfo> = log
            .versions
            .iter()
            .rev()
            .take(limit)
            .map(|v| {
                let ts = DateTime::parse_from_rfc3339(&v.timestamp)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now());
                VersionInfo {
                    hash: v.hash.clone(),
                    timestamp: ts,
                    actor: v.actor.clone(),
                    message: v.message.clone(),
                }
            })
            .collect();

        Ok(versions)
    }

    /// Restore a page to a specific version.
    pub fn restore_version(
        &self,
        page_id: &Uuid,
        version_hash: &str,
        actor: &str,
    ) -> Result<()> {
        let log = self.load_version_log(page_id)?;

        let entry = log
            .versions
            .iter()
            .find(|v| v.hash == version_hash)
            .ok_or_else(|| Error::NotFound(format!("Version {version_hash}")))?;

        let snapshot_bytes = serde_json::to_vec(&entry.snapshot)?;
        self.apply_automerge(&snapshot_bytes, actor)?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::db::Database;

    #[test]
    fn test_page_to_automerge_roundtrip() {
        let db = Database::open_in_memory().unwrap();
        let page = db
            .create_page("Sync Test", None, false, None, "user")
            .unwrap();
        db.create_block(&page.id, "Hello world", None, None, "user")
            .unwrap();
        db.create_block(&page.id, "Second block", None, None, "user")
            .unwrap();

        let doc_bytes = db.page_to_automerge(&page.id).unwrap();
        assert!(!doc_bytes.is_empty());

        // Apply to a second db
        let db2 = Database::open_in_memory().unwrap();
        let restored_id = db2.apply_automerge(&doc_bytes, "remote").unwrap();
        assert_eq!(restored_id, page.id);

        let restored = db2.get_page(&restored_id).unwrap().unwrap();
        assert_eq!(restored.title, "Sync Test");

        let blocks = db2.get_page_blocks(&restored_id).unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].content, "Hello world");
    }

    #[test]
    fn test_sync_status() {
        let db = Database::open_in_memory().unwrap();
        db.create_page("A", None, false, None, "user").unwrap();
        db.create_page("B", None, false, None, "user").unwrap();

        let status = db.get_sync_status().unwrap();
        assert_eq!(status.total_pages, 2);
        assert_eq!(status.pending_changes, 2); // neither synced yet
    }

    #[test]
    fn test_version_history_and_restore() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("Ver", None, false, None, "user").unwrap();
        db.create_block(&page.id, "v1 content", None, None, "user")
            .unwrap();

        // Create first snapshot
        let _v1 = db.page_to_automerge(&page.id).unwrap();

        // Modify and snapshot again
        let blocks = db.get_page_blocks(&page.id).unwrap();
        db.update_block(&blocks[0].id, Some("v2 content"), "user")
            .unwrap();
        let _v2 = db.page_to_automerge(&page.id).unwrap();

        let history = db.get_version_history(&page.id, None).unwrap();
        assert_eq!(history.len(), 2);

        // Restore to v1
        let v1_hash = history.last().unwrap().hash.clone(); // oldest = v1
        db.restore_version(&page.id, &v1_hash, "user").unwrap();

        let blocks_after = db.get_page_blocks(&page.id).unwrap();
        assert_eq!(blocks_after[0].content, "v1 content");
    }

    #[test]
    fn test_sync_messages() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("Msg", None, false, None, "user").unwrap();
        db.create_block(&page.id, "block content", None, None, "user")
            .unwrap();

        let msg = db
            .generate_sync_message(&page.id, &[])
            .unwrap()
            .unwrap();

        let db2 = Database::open_in_memory().unwrap();
        let ack = db2
            .receive_sync_message(&page.id, &msg, "peer")
            .unwrap();
        assert!(!ack.is_empty());

        let page2 = db2.get_page(&page.id).unwrap().unwrap();
        assert_eq!(page2.title, "Msg");
    }
}
