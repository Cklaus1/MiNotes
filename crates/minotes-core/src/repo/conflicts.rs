//! Sync conflict copies: compare one with the page it is a version of, and
//! resolve it block by block (UX review Wave 4, PRD-git-sync §6 P0.2).
//!
//! A git-sync conflict keeps the local text in the page and the other device's
//! whole version as a separate page "<title> (conflict from <device>)" (see
//! `repo::sync::merge_into_protected_page`). The copy's block ids are derived
//! from the copy's page id and the original block ids
//! ([`conflict_block_id`]), so every block of the copy can be paired with the
//! block it is a version of — on every device (the ids travel in the file),
//! and for encrypted notebooks too (their copies are ordinary pages once
//! decrypted). Copies made before that (random ids) are paired by aligning the
//! two outlines on equal text.
//!
//! **Resolve** applies the per-block choices (keep mine / keep theirs / keep
//! both) and moves the copy to the Trash in ONE transaction, and returns the
//! page's blocks before and after, so the app can undo and redo it as one step
//! ([`Database::set_conflict_resolution`]).

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::models::{Block, RestoreBlock};
use crate::repo::sync::{conflict_block_id, normalize_content};

const ACTOR: &str = "conflict-resolve";

/// "<title> (conflict from <device>)" (optionally " (2)") → (title, device).
pub fn parse_conflict_title(title: &str) -> Option<(String, String)> {
    let mut t = title.trim_end();
    // A numbered copy: "X (conflict from D) (2)".
    if let Some(open) = t.rfind(" (") {
        let tail = &t[open + 2..];
        if tail.ends_with(')') && tail[..tail.len() - 1].chars().all(|c| c.is_ascii_digit()) && tail.len() > 1 {
            t = &t[..open];
        }
    }
    let t = t.strip_suffix(')')?;
    let at = t.rfind(" (conflict from ")?;
    let base = t[..at].to_string();
    let device = t[at + " (conflict from ".len()..].to_string();
    (!base.is_empty() && !device.is_empty()).then_some((base, device))
}

/// One side of a compare row.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ConflictSide {
    pub block_id: Uuid,
    pub content: String,
    /// Nesting depth on its page (0 = top level), for indentation.
    pub depth: usize,
}

/// One block that differs between the page and the copy.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ConflictRow {
    /// Stable id of the row for [`ConflictChoice::key`]: "<mine id>|<theirs id>".
    pub key: String,
    /// The page's version (None: the block isn't on the page — new on the
    /// other device, or deleted here).
    pub mine: Option<ConflictSide>,
    /// The copy's version (None: only on the page — only from the old
    /// alignment fallback).
    pub theirs: Option<ConflictSide>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConflictCompare {
    pub copy_id: Uuid,
    pub copy_title: String,
    /// The device the copy came from (from its title).
    pub device: String,
    /// The page the copy is a version of (None: it is gone).
    pub page_id: Option<Uuid>,
    pub page_title: Option<String>,
    /// The page is in the Trash.
    pub page_trashed: bool,
    pub rows: Vec<ConflictRow>,
    /// Blocks were paired by id (exact), not by aligning their text.
    pub exact: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Choice {
    Mine,
    Theirs,
    Both,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConflictChoice {
    pub key: String,
    pub choice: Choice,
}

/// What [`Database::resolve_conflict`] did: the page's blocks before and after
/// (outline order, with properties), for undo / redo.
#[derive(Debug, Clone, Serialize)]
pub struct ConflictResolution {
    pub page_id: Uuid,
    pub copy_id: Uuid,
    pub before: Vec<RestoreBlock>,
    pub after: Vec<RestoreBlock>,
    pub kept_mine: usize,
    pub took_theirs: usize,
    pub kept_both: usize,
}

fn depths(blocks: &[Block]) -> HashMap<Uuid, usize> {
    let mut d: HashMap<Uuid, usize> = HashMap::new();
    for b in blocks {
        let v = b.parent_id.and_then(|p| d.get(&p).copied()).map(|x| x + 1).unwrap_or(0);
        d.insert(b.id, v);
    }
    d
}

fn side(b: &Block, depth: &HashMap<Uuid, usize>) -> ConflictSide {
    ConflictSide { block_id: b.id, content: b.content.clone(), depth: depth.get(&b.id).copied().unwrap_or(0) }
}

fn row(mine: Option<ConflictSide>, theirs: Option<ConflictSide>) -> ConflictRow {
    let id = |s: &Option<ConflictSide>| s.as_ref().map(|x| x.block_id.to_string()).unwrap_or_default();
    ConflictRow { key: format!("{}|{}", id(&mine), id(&theirs)), mine, theirs }
}

/// Rows from aligning two outlines on equal (normalized) text: the longest
/// common subsequence anchors; between anchors, blocks pair up in order and
/// the rest are one-sided.
fn align_rows(mine: &[Block], theirs: &[Block], md: &HashMap<Uuid, usize>, td: &HashMap<Uuid, usize>) -> Vec<ConflictRow> {
    let a: Vec<String> = mine.iter().map(|b| normalize_content(&b.content)).collect();
    let b: Vec<String> = theirs.iter().map(|b| normalize_content(&b.content)).collect();
    let (n, m) = (a.len(), b.len());
    let mut l = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            l[i][j] = if a[i] == b[j] { l[i + 1][j + 1] + 1 } else { l[i + 1][j].max(l[i][j + 1]) };
        }
    }
    let mut rows = Vec::new();
    let (mut i, mut j) = (0, 0);
    let mut gap_a: Vec<usize> = Vec::new();
    let mut gap_b: Vec<usize> = Vec::new();
    let flush = |ga: &mut Vec<usize>, gb: &mut Vec<usize>, rows: &mut Vec<ConflictRow>| {
        let k = ga.len().max(gb.len());
        for x in 0..k {
            rows.push(row(ga.get(x).map(|&p| side(&mine[p], md)), gb.get(x).map(|&q| side(&theirs[q], td))));
        }
        ga.clear();
        gb.clear();
    };
    while i < n || j < m {
        if i < n && j < m && a[i] == b[j] {
            flush(&mut gap_a, &mut gap_b, &mut rows);
            i += 1;
            j += 1;
        } else if j < m && (i >= n || l[i][j + 1] >= l[i + 1][j]) {
            gap_b.push(j);
            j += 1;
        } else {
            gap_a.push(i);
            i += 1;
        }
    }
    flush(&mut gap_a, &mut gap_b, &mut rows);
    rows
}

impl Database {
    /// The page `copy_id` is a conflict copy of, and whether its blocks pair by id.
    fn conflict_original(&self, copy_id: &Uuid, base_title: &str, copy_blocks: &[Block]) -> Result<(Option<crate::models::Page>, bool)> {
        let copy_ids: HashSet<Uuid> = copy_blocks.iter().map(|b| b.id).collect();
        let hits = |page: &Uuid| -> Result<usize> {
            Ok(self.get_page_blocks(page)?.iter().filter(|b| copy_ids.contains(&conflict_block_id(copy_id, &b.id))).count())
        };
        let by_title = self.get_page_by_title(base_title)?.filter(|p| p.id != *copy_id);
        if let Some(p) = &by_title {
            if hits(&p.id)? > 0 {
                return Ok((by_title, true));
            }
        }
        // Renamed since (or the title now names another page): find the page
        // whose blocks the copy's ids were derived from.
        if !copy_ids.is_empty() {
            let mut count: HashMap<Uuid, usize> = HashMap::new();
            let mut stmt = self.conn.prepare("SELECT id, page_id FROM blocks WHERE page_id <> ?1")?;
            let rows = stmt.query_map(rusqlite::params![copy_id.to_string()], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            for r in rows {
                let (id, page) = r?;
                let (Ok(id), Ok(page)) = (Uuid::parse_str(&id), Uuid::parse_str(&page)) else { continue };
                if copy_ids.contains(&conflict_block_id(copy_id, &id)) {
                    *count.entry(page).or_default() += 1;
                }
            }
            if let Some((page, _)) = count.into_iter().max_by_key(|(_, n)| *n) {
                return Ok((self.get_page(&page)?, true));
            }
        }
        Ok((by_title, false))
    }

    /// Compare a conflict copy with its page: only the blocks that differ.
    pub fn conflict_compare(&self, copy_id: &Uuid) -> Result<ConflictCompare> {
        let copy = self.get_page(copy_id)?.ok_or_else(|| Error::NotFound(format!("Page {copy_id}")))?;
        let (base_title, device) = parse_conflict_title(&copy.title)
            .ok_or_else(|| Error::InvalidInput(format!("“{}” is not a sync conflict copy", copy.title)))?;
        let theirs = self.get_page_blocks(copy_id)?;
        let (page, exact) = self.conflict_original(copy_id, &base_title, &theirs)?;
        let td = depths(&theirs);
        let mut rows = Vec::new();
        let mut page_trashed = false;
        if let Some(p) = &page {
            page_trashed = self.is_trashed(&p.id)?;
            let mine = self.get_page_blocks(&p.id)?;
            let md = depths(&mine);
            if exact {
                let by_derived: HashMap<Uuid, &Block> = mine.iter().map(|b| (conflict_block_id(copy_id, &b.id), b)).collect();
                for t in &theirs {
                    match by_derived.get(&t.id) {
                        Some(m) if normalize_content(&m.content) == normalize_content(&t.content) => {}
                        Some(m) => rows.push(row(Some(side(m, &md)), Some(side(t, &td)))),
                        None => rows.push(row(None, Some(side(t, &td)))),
                    }
                }
            } else {
                rows = align_rows(&mine, &theirs, &md, &td);
            }
        } else {
            rows = theirs.iter().map(|t| row(None, Some(side(t, &td)))).collect();
        }
        Ok(ConflictCompare {
            copy_id: *copy_id,
            copy_title: copy.title.clone(),
            device,
            page_id: page.as_ref().map(|p| p.id),
            page_title: page.map(|p| p.title),
            page_trashed,
            rows,
            exact,
        })
    }

    /// Position for a new block right after `after` among `parent`'s children
    /// on `page` (or at the end when `after` is None).
    fn position_after(&self, page: &Uuid, parent: Option<&Uuid>, after: Option<&Uuid>) -> Result<f64> {
        let siblings: Vec<(String, f64)> = {
            let mut stmt = self.conn.prepare(
                "SELECT id, position FROM blocks WHERE page_id = ?1 AND parent_id IS ?2 ORDER BY position",
            )?;
            let rows = stmt.query_map(rusqlite::params![page.to_string(), parent.map(|p| p.to_string())], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?))
            })?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        let end = siblings.last().map(|(_, p)| p + 1.0).unwrap_or(1.0);
        let Some(after) = after else { return Ok(end) };
        let Some(i) = siblings.iter().position(|(id, _)| *id == after.to_string()) else { return Ok(end) };
        Ok(match siblings.get(i + 1) {
            Some((_, next)) => (siblings[i].1 + next) / 2.0,
            None => siblings[i].1 + 1.0,
        })
    }

    /// Apply the user's per-block choices to the page, move the copy to the
    /// Trash — all or nothing — and return the page before and after (undo).
    /// Every row of [`conflict_compare`](Self::conflict_compare) needs a choice.
    pub fn resolve_conflict(&self, copy_id: &Uuid, choices: &[ConflictChoice]) -> Result<ConflictResolution> {
        self.tx(|| {
            let cmp = self.conflict_compare(copy_id)?;
            let page_id = cmp.page_id.ok_or_else(|| {
                Error::InvalidInput("The page this copy is a version of is gone — keep the copy as it is, or move it to the Trash".into())
            })?;
            let wanted: HashMap<&str, Choice> = choices.iter().map(|c| (c.key.as_str(), c.choice)).collect();
            if let Some(k) = choices.iter().find(|c| !cmp.rows.iter().any(|r| r.key == c.key)) {
                return Err(Error::InvalidInput(format!("These versions changed meanwhile (unknown block {}) — compare again", k.key)));
            }
            let missing = cmp.rows.iter().filter(|r| !wanted.contains_key(r.key.as_str())).count();
            if missing > 0 {
                return Err(Error::InvalidInput(format!("Choose a version for every block ({missing} left)")));
            }
            let before = crate::outside::snapshot(self, &page_id)?;
            let copy_blocks = self.get_page_blocks(copy_id)?;
            let copy_by_id: HashMap<Uuid, &Block> = copy_blocks.iter().map(|b| (b.id, b)).collect();
            // A copy block → its counterpart on the page (paired, or created now).
            let mut counterpart: HashMap<Uuid, Uuid> = HashMap::new();
            if cmp.exact {
                for b in self.get_page_blocks(&page_id)? {
                    let d = conflict_block_id(copy_id, &b.id);
                    if copy_by_id.contains_key(&d) {
                        counterpart.insert(d, b.id);
                    }
                }
            }
            let (mut kept_mine, mut took_theirs, mut kept_both) = (0, 0, 0);
            for r in &cmp.rows {
                let choice = wanted[r.key.as_str()];
                match choice {
                    Choice::Mine => kept_mine += 1,
                    Choice::Theirs => took_theirs += 1,
                    Choice::Both => kept_both += 1,
                }
                match (&r.mine, &r.theirs, choice) {
                    (_, _, Choice::Mine) => {}
                    (Some(m), Some(t), Choice::Theirs) => {
                        self.update_block(&m.block_id, Some(&t.content), ACTOR)?;
                    }
                    (Some(m), Some(t), Choice::Both) => {
                        let mb = self.get_block(&m.block_id)?.ok_or_else(|| Error::NotFound(format!("Block {}", m.block_id)))?;
                        let pos = self.position_after(&page_id, mb.parent_id.as_ref(), Some(&mb.id))?;
                        let nb = self.create_block(&page_id, &t.content, mb.parent_id.as_ref(), Some(pos), ACTOR)?;
                        self.copy_block_props(&t.block_id, &nb.id)?;
                    }
                    (None, Some(t), Choice::Theirs | Choice::Both) => {
                        // Placed like in the copy: under the counterpart of its
                        // parent, after the counterpart of its previous sibling.
                        let tb = copy_by_id.get(&t.block_id).copied();
                        let parent = tb.and_then(|b| b.parent_id).and_then(|p| counterpart.get(&p).copied());
                        let prev = tb.and_then(|b| {
                            copy_blocks
                                .iter()
                                .filter(|s| s.parent_id == b.parent_id && s.position < b.position)
                                .max_by(|x, y| x.position.total_cmp(&y.position))
                                .and_then(|s| counterpart.get(&s.id).copied())
                        });
                        let pos = self.position_after(&page_id, parent.as_ref(), prev.as_ref())?;
                        let nb = self.create_block(&page_id, &t.content, parent.as_ref(), Some(pos), ACTOR)?;
                        self.copy_block_props(&t.block_id, &nb.id)?;
                        counterpart.insert(t.block_id, nb.id);
                    }
                    (Some(m), None, Choice::Theirs) => {
                        // Only on this page (aligned copy): theirs doesn't have it.
                        self.delete_block(&m.block_id, ACTOR)?;
                    }
                    (Some(_), None, Choice::Both) | (None, None, _) => {}
                }
            }
            self.trash_page(copy_id)?;
            self.touch_page(&page_id)?;
            let after = crate::outside::snapshot(self, &page_id)?;
            Ok(ConflictResolution { page_id, copy_id: *copy_id, before, after, kept_mine, took_theirs, kept_both })
        })
    }

    /// Undo (`blocks` = the resolution's `before`, `copy_in_trash` false) or
    /// redo (`after`, true) a [`resolve_conflict`](Self::resolve_conflict), in
    /// one transaction.
    pub fn set_conflict_resolution(&self, page_id: &Uuid, copy_id: &Uuid, blocks: &[RestoreBlock], copy_in_trash: bool) -> Result<()> {
        self.tx(|| {
            if self.get_page(copy_id)?.is_none() {
                return Err(Error::NotFound(format!("The conflict copy {copy_id} was deleted for good")));
            }
            crate::outside::set_page_blocks(self, page_id, blocks, None, None)?;
            if copy_in_trash {
                self.trash_page(copy_id)?;
            } else if self.is_trashed(copy_id)? {
                self.restore_page(copy_id)?;
            }
            Ok(())
        })
    }

    fn copy_block_props(&self, from: &Uuid, to: &Uuid) -> Result<()> {
        for p in self.get_properties(from)? {
            if let Some(v) = p.value {
                self.set_property(to, "block", &p.key, &v, &p.value_type, ACTOR)?;
            }
        }
        Ok(())
    }

    fn touch_page(&self, page_id: &Uuid) -> Result<()> {
        self.conn.execute(
            "UPDATE pages SET updated_at = ?1 WHERE id = ?2",
            rusqlite::params![chrono::Utc::now().to_rfc3339(), page_id.to_string()],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
