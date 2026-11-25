//! The onboarding page ("Getting Started") a fresh install creates for itself.
//!
//! Every device seeds its own copy, with its own id. When a fresh device joins
//! a sync remote that already has one, the import met a different page with the
//! same title and kept both ("Getting Started" + "Getting Started (2)" — UX
//! review C-9). The app records the page it seeded ([`Database::mark_onboarding_seed`]):
//! its id and a fingerprint of what it holds. A page that still matches that
//! record was never touched, so sync may drop it in favour of the other
//! device's same-titled page ([`Database::is_untouched_onboarding_seed`]).
//!
//! The record lives in `ui_state` (this database only, never synced or
//! exported), so another device's copy is never mistaken for this one's seed.

use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::db::Database;
use crate::error::Result;
use crate::models::Page;

const SEED_KEY: &str = "onboarding-seed";

#[derive(serde::Serialize, serde::Deserialize)]
struct SeedRecord {
    page_id: Uuid,
    fingerprint: String,
}

impl Database {
    /// Remember `page_id` as the onboarding page this device just created, as
    /// it is now (title, folder, blocks, properties).
    pub fn mark_onboarding_seed(&self, page_id: &Uuid) -> Result<()> {
        let fingerprint = self.page_fingerprint(page_id)?;
        let rec = SeedRecord { page_id: *page_id, fingerprint };
        self.set_ui_state(SEED_KEY, &serde_json::to_string(&rec).unwrap_or_default())
    }

    /// Is `page` the onboarding page this device seeded, unchanged since — not
    /// edited, renamed, moved, given properties, linked to from another page,
    /// trashed or archived?
    pub fn is_untouched_onboarding_seed(&self, page: &Page) -> Result<bool> {
        let Some(raw) = self.get_ui_state(SEED_KEY)? else { return Ok(false) };
        let Ok(rec) = serde_json::from_str::<SeedRecord>(&raw) else { return Ok(false) };
        if rec.page_id != page.id {
            return Ok(false);
        }
        let parked: i64 = self.conn.query_row(
            "SELECT (SELECT COUNT(*) FROM trash WHERE page_id = ?1) + (SELECT COUNT(*) FROM archive WHERE page_id = ?1)",
            [page.id.to_string()],
            |r| r.get(0),
        )?;
        if parked > 0 {
            return Ok(false);
        }
        // Something else points at it: dropping it would break that link.
        let linked: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM links l JOIN blocks b ON b.id = l.from_block
              WHERE l.to_page = ?1 AND b.page_id != ?1",
            [page.id.to_string()],
            |r| r.get(0),
        )?;
        if linked > 0 {
            return Ok(false);
        }
        Ok(self.page_fingerprint(&page.id)? == rec.fingerprint)
    }

    /// Forget the seed record (its page was replaced or deleted).
    pub(crate) fn forget_onboarding_seed(&self) -> Result<()> {
        self.conn.execute("DELETE FROM ui_state WHERE key = ?1", [SEED_KEY])?;
        Ok(())
    }

    /// What a page holds, as one hash: title, folder, page properties and every
    /// block (id, parent, text, properties) in outline order.
    fn page_fingerprint(&self, page_id: &Uuid) -> Result<String> {
        let Some(page) = self.get_page(page_id)? else { return Ok(String::new()) };
        let mut h = Sha256::new();
        let mut put = |s: &str| {
            h.update((s.len() as u64).to_le_bytes());
            h.update(s.as_bytes());
        };
        put(&page.title);
        put(&page.folder_id.map(|f| f.to_string()).unwrap_or_default());
        let props = |id: &Uuid| -> Result<Vec<String>> {
            let mut v: Vec<String> = self
                .get_properties(id)?
                .into_iter()
                .map(|p| format!("{}={}", p.key, p.value.unwrap_or_default()))
                .collect();
            v.sort();
            Ok(v)
        };
        for p in props(page_id)? {
            put(&p);
        }
        for b in self.get_page_blocks(page_id)? {
            put(&b.id.to_string());
            put(&b.parent_id.map(|p| p.to_string()).unwrap_or_default());
            put(&b.content);
            for p in props(&b.id)? {
                put(&p);
            }
        }
        Ok(format!("{:x}", h.finalize()))
    }
}

#[cfg(test)]
mod tests {
    use crate::db::Database;

    #[test]
    fn untouched_seed_is_recognised_and_any_edit_ends_it() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page("Getting Started", None, false, None, "user").unwrap();
        let b = db.create_block(&p.id, "Welcome", None, None, "user").unwrap();
        assert!(!db.is_untouched_onboarding_seed(&p).unwrap(), "not marked yet");
        db.mark_onboarding_seed(&p.id).unwrap();
        assert!(db.is_untouched_onboarding_seed(&p).unwrap());

        let other = db.create_page("Other", None, false, None, "user").unwrap();
        assert!(!db.is_untouched_onboarding_seed(&other).unwrap(), "only the marked page");

        db.update_block(&b.id, Some("Welcome!"), "user").unwrap();
        assert!(!db.is_untouched_onboarding_seed(&p).unwrap(), "edited");
        db.update_block(&b.id, Some("Welcome"), "user").unwrap();
        assert!(db.is_untouched_onboarding_seed(&p).unwrap(), "same content again");

        let ob = db.create_block(&other.id, "see [[Getting Started]]", None, None, "user").unwrap();
        assert!(!db.is_untouched_onboarding_seed(&p).unwrap(), "linked from another page");
        db.delete_block(&ob.id, "user").unwrap();
        assert!(db.is_untouched_onboarding_seed(&p).unwrap());

        db.set_property(&p.id, "page", "status", "x", "text", "user").unwrap();
        assert!(!db.is_untouched_onboarding_seed(&p).unwrap(), "property added");
    }
}
