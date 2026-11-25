//! Scope resolution: the exact set of pages an AI run may read.
//!
//! Every tool filters through `ResolvedScope::contains`, so content outside
//! the scope (other folders, trashed/archived pages) can never reach the model.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use uuid::Uuid;

use super::settings::{ScopeKind, ScopeSetting};
use super::AiError;
use crate::db::Database;
use crate::repo::archive::ARCHIVED_FOLDER_TREE;
use crate::repo::trash::TRASHED_FOLDER_TREE;

#[derive(Debug, Clone)]
pub struct PageMeta {
    pub id: Uuid,
    pub title: String,
    pub folder_id: Option<Uuid>,
    pub is_journal: bool,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct ResolvedScope {
    pub kind: ScopeKind,
    /// Human label, e.g. "this notebook", "Work, Personal", "the page “Ideas”".
    pub label: String,
    /// Non-content description for the run log, e.g. "folders:2".
    pub log_desc: String,
    pages: HashMap<Uuid, PageMeta>,
}

impl ResolvedScope {
    pub fn contains(&self, page_id: &Uuid) -> bool {
        self.pages.contains_key(page_id)
    }
    pub fn page(&self, page_id: &Uuid) -> Option<&PageMeta> {
        self.pages.get(page_id)
    }
    pub fn pages(&self) -> impl Iterator<Item = &PageMeta> {
        self.pages.values()
    }
    pub fn len(&self) -> usize {
        self.pages.len()
    }
    pub fn is_empty(&self) -> bool {
        self.pages.is_empty()
    }
}

/// All pages the user can see (not trashed/archived, directly or via a folder).
fn visible_pages(db: &Database) -> Result<Vec<PageMeta>, AiError> {
    let sql = format!(
        "WITH RECURSIVE {TRASHED_FOLDER_TREE}, {ARCHIVED_FOLDER_TREE}
         SELECT p.id, p.title, p.folder_id, p.is_journal, p.updated_at FROM pages p
         WHERE p.id NOT IN (SELECT page_id FROM trash)
           AND p.id NOT IN (SELECT page_id FROM archive)
           AND (p.folder_id IS NULL OR (p.folder_id NOT IN (SELECT id FROM trashed_tree)
                AND p.folder_id NOT IN (SELECT id FROM archived_tree)))"
    );
    let mut stmt = db.conn.prepare(&sql)?;
    let rows = stmt.query_map([], |r| {
        let id: String = r.get(0)?;
        let folder: Option<String> = r.get(2)?;
        let updated: String = r.get(4)?;
        Ok(PageMeta {
            id: Uuid::parse_str(&id).unwrap_or_default(),
            title: r.get(1)?,
            folder_id: folder.and_then(|f| Uuid::parse_str(&f).ok()),
            is_journal: r.get::<_, i64>(3)? != 0,
            updated_at: DateTime::parse_from_rfc3339(&updated)
                .map(|d| d.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now()),
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// The chosen folders plus every descendant folder.
fn folder_subtree(db: &Database, roots: &[Uuid]) -> Result<HashSet<Uuid>, AiError> {
    let mut stmt = db.conn.prepare("SELECT id, parent_id FROM folders")?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
    })?;
    let mut children: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
    for r in rows {
        let (id, parent) = r?;
        if let (Ok(id), Some(Ok(p))) = (Uuid::parse_str(&id), parent.map(|p| Uuid::parse_str(&p))) {
            children.entry(p).or_default().push(id);
        }
    }
    let mut set: HashSet<Uuid> = HashSet::new();
    let mut stack: Vec<Uuid> = roots.to_vec();
    while let Some(f) = stack.pop() {
        if set.insert(f) {
            if let Some(kids) = children.get(&f) {
                stack.extend(kids.iter().copied());
            }
        }
    }
    Ok(set)
}

pub fn folder_names(db: &Database, ids: &[String]) -> Vec<String> {
    ids.iter()
        .filter_map(|s| Uuid::parse_str(s).ok())
        .filter_map(|id| db.get_folder(&id).ok().flatten())
        .map(|f| f.name)
        .collect()
}

/// Resolve the configured scope into the concrete page set for one run.
pub fn resolve(
    db: &Database,
    setting: &ScopeSetting,
    current_page: Option<Uuid>,
) -> Result<ResolvedScope, AiError> {
    let all = visible_pages(db)?;
    let (pages, label, log_desc): (Vec<PageMeta>, String, String) = match setting.kind {
        ScopeKind::Notebook => (all, "this notebook".into(), "notebook".into()),
        ScopeKind::Folders => {
            let roots: Vec<Uuid> = setting
                .folder_ids
                .iter()
                .filter_map(|s| Uuid::parse_str(s).ok())
                .collect();
            if roots.is_empty() {
                return Err(AiError::NotConfigured(
                    "The AI scope is set to folders, but no folder is selected.".into(),
                ));
            }
            let tree = folder_subtree(db, &roots)?;
            let names = folder_names(db, &setting.folder_ids);
            let pages = all
                .into_iter()
                .filter(|p| p.folder_id.map(|f| tree.contains(&f)).unwrap_or(false))
                .collect();
            let label = if names.is_empty() { "the selected folders".into() } else { names.join(", ") };
            (pages, label, format!("folders:{}", roots.len()))
        }
        ScopeKind::Page => {
            let pid = current_page.ok_or_else(|| {
                AiError::InvalidInput("The AI scope is “current page”: open a page first.".into())
            })?;
            let pages: Vec<PageMeta> = all.into_iter().filter(|p| p.id == pid).collect();
            let label = pages
                .first()
                .map(|p| format!("the page “{}”", p.title))
                .unwrap_or_else(|| "the current page".into());
            (pages, label, "page".into())
        }
    };
    Ok(ResolvedScope {
        kind: setting.kind,
        label,
        log_desc,
        pages: pages.into_iter().map(|p| (p.id, p)).collect(),
    })
}
