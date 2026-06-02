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
        // SHA-256 of the serialized version payload. Used as the immutable
        // identity of a version for restore and lookup; collision-resistant
        // so we never restore the wrong snapshot.
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(data);
        let digest = hasher.finalize();
        let mut s = String::with_capacity(digest.len() * 2);
        for b in digest {
            use std::fmt::Write;
            let _ = write!(s, "{:02x}", b);
        }
        s
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
    ///
    /// Merge semantics with a last-writer-wins timestamp guard (Bug #10) and full-state
    /// deletion convergence (Bug #9). A stale snapshot will not clobber newer local data.
    pub fn apply_automerge(&self, doc_bytes: &[u8], actor: &str) -> Result<Uuid> {
        let snapshot: PageSnapshot =
            serde_json::from_slice(doc_bytes).map_err(|e| Error::InvalidInput(e.to_string()))?;
        self.apply_snapshot(&snapshot, actor, false)
    }

    /// Apply a parsed snapshot. `force` bypasses the timestamp guard for an exact
    /// restore (Bug #9: restore must reproduce the snapshot state faithfully,
    /// including removing blocks added after the snapshot).
    fn apply_snapshot(&self, snapshot: &PageSnapshot, actor: &str, force: bool) -> Result<Uuid> {
        let page_id =
            Uuid::parse_str(&snapshot.id).map_err(|e| Error::InvalidInput(e.to_string()))?;

        // Bug #10: last-writer-wins with a timestamp GUARD. Only let the snapshot
        // overwrite page metadata if it is at least as new as the local row (or we're
        // forcing a restore); a stale snapshot must not clobber newer local edits.
        let local_page_updated: Option<String> = self
            .conn
            .query_row(
                "SELECT updated_at FROM pages WHERE id = ?1",
                rusqlite::params![snapshot.id],
                |row| row.get(0),
            )
            .ok();
        let page_is_newer = force || match &local_page_updated {
            Some(local) => snapshot.updated_at >= *local,
            None => true, // page doesn't exist locally → create it
        };

        if page_is_newer {
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
                    snapshot.updated_at, // Bug #10: preserve causal timestamp
                ],
            )?;
        }
        // If the page exists but the snapshot is stale, skip the metadata overwrite
        // entirely (local is newer).

        // Bug #9: a snapshot is a FULL page state, so a block present locally but
        // ABSENT from the snapshot has been deleted remotely — delete it locally so
        // deletions converge (the old code was additive-only and resurrected blocks).
        // Block content is still last-writer-wins, but only when the page as a whole
        // is at least as new as ours (don't let a stale snapshot delete fresh blocks).
        let snapshot_block_ids: std::collections::HashSet<&str> =
            snapshot.blocks.iter().map(|b| b.id.as_str()).collect();

        if page_is_newer {
            let existing = self.get_page_blocks(&page_id)?;
            for b in &existing {
                if !snapshot_block_ids.contains(b.id.to_string().as_str()) {
                    self.delete_block(&b.id, actor)?;
                }
            }
        }

        for block in &snapshot.blocks {
            // Preserve the snapshot's timestamps instead of stamping local `now`
            // (Bug #10), so causal ordering survives and re-applying is idempotent.
            self.conn.execute(
                "INSERT INTO blocks (id, page_id, parent_id, position, content, format, collapsed, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(id) DO UPDATE SET
                   parent_id = excluded.parent_id,
                   position = excluded.position,
                   content = excluded.content,
                   format = excluded.format,
                   collapsed = excluded.collapsed,
                   updated_at = excluded.updated_at",
                rusqlite::params![
                    block.id,
                    snapshot.id,
                    block.parent_id,
                    block.position,
                    block.content,
                    block.format,
                    block.collapsed as i32,
                    snapshot.created_at,
                    snapshot.updated_at,
                ],
            )?;
        }

        // Record version. Re-serialize the snapshot for stable hashing.
        let doc_bytes = serde_json::to_vec(snapshot)?;
        let hash = Self::compute_hash(&doc_bytes);
        let mut log = self.load_version_log(&page_id)?;
        // Bug #10: idempotency — don't append a duplicate version entry when the same
        // snapshot is applied again (e.g. a re-delivered sync message).
        if log.versions.last().map(|v| v.hash.as_str()) != Some(hash.as_str()) {
            log.versions.push(VersionEntry {
                hash,
                timestamp: Utc::now().to_rfc3339(),
                actor: actor.to_string(),
                message: Some("applied remote snapshot".to_string()),
                snapshot: snapshot.clone(),
            });
            if log.versions.len() > 100 {
                let start = log.versions.len() - 100;
                log.versions = log.versions[start..].to_vec();
            }
        }

        let now_str = Utc::now().to_rfc3339();
        self.save_sync_state(&page_id, &doc_bytes, &log, Some(&now_str))?;

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

        // Bug #9: restore must reproduce the snapshot EXACTLY — force past the
        // timestamp guard (the snapshot is older than current) and let apply_snapshot
        // delete blocks added after the snapshot, rather than unioning with them.
        let snapshot = entry.snapshot.clone();
        self.apply_snapshot(&snapshot, actor, true)?;

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

    // Bug #9: deletions propagate — a block removed in the snapshot is removed locally.
    #[test]
    fn test_apply_propagates_deletion() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("Del", None, false, None, "user").unwrap();
        let b1 = db.create_block(&page.id, "keep", None, None, "user").unwrap();
        let b2 = db.create_block(&page.id, "remove", None, None, "user").unwrap();

        // Peer has both blocks.
        let db2 = Database::open_in_memory().unwrap();
        db2.apply_automerge(&db.page_to_automerge(&page.id).unwrap(), "peer").unwrap();
        assert_eq!(db2.get_page_blocks(&page.id).unwrap().len(), 2);

        // Delete b2 locally and re-snapshot, then apply to peer.
        db.delete_block(&b2.id, "user").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        db.update_block(&b1.id, Some("keep"), "user").unwrap(); // bump page updated_at
        let snap = db.page_to_automerge(&page.id).unwrap();
        db2.apply_automerge(&snap, "peer").unwrap();

        let blocks = db2.get_page_blocks(&page.id).unwrap();
        assert_eq!(blocks.len(), 1, "deleted block must not survive on the peer");
        assert_eq!(blocks[0].content, "keep");
    }

    // Bug #9: restore is faithful — blocks added after the snapshot are removed.
    #[test]
    fn test_restore_is_exact_not_union() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page("R", None, false, None, "user").unwrap();
        db.create_block(&page.id, "A", None, None, "user").unwrap();
        let v1 = db.page_to_automerge(&page.id).unwrap();
        let _ = v1;
        let hash_v1 = db.get_version_history(&page.id, None).unwrap().last().unwrap().hash.clone();

        // Add B after the snapshot.
        db.create_block(&page.id, "B", None, None, "user").unwrap();
        assert_eq!(db.get_page_blocks(&page.id).unwrap().len(), 2);

        db.restore_version(&page.id, &hash_v1, "user").unwrap();
        let blocks = db.get_page_blocks(&page.id).unwrap();
        assert_eq!(blocks.len(), 1, "restore must drop post-snapshot blocks, not union");
        assert_eq!(blocks[0].content, "A");
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
