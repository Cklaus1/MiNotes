//! The neutral model every reader produces (PRD-import §4.1). Readers never
//! touch the database; the resolver and writer only see this.

use std::collections::BTreeMap;
use std::path::PathBuf;

use chrono::NaiveDate;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    Obsidian,
    Markdown,
    Evernote,
}

impl SourceKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            SourceKind::Obsidian => "obsidian",
            SourceKind::Markdown => "markdown",
            SourceKind::Evernote => "evernote",
        }
    }
    pub fn label(&self) -> &'static str {
        match self {
            SourceKind::Obsidian => "Obsidian vault",
            SourceKind::Markdown => "Markdown folder",
            SourceKind::Evernote => "Evernote export",
        }
    }
    pub fn parse(s: &str) -> Option<SourceKind> {
        match s {
            "obsidian" => Some(SourceKind::Obsidian),
            "markdown" | "md" => Some(SourceKind::Markdown),
            "evernote" | "enex" => Some(SourceKind::Evernote),
            _ => None,
        }
    }
}

/// Everything a reader found.
#[derive(Debug)]
pub struct Model {
    pub kind: SourceKind,
    /// Source name (vault folder name, `.enex` file stem).
    pub name: String,
    /// The folder read (folder sources).
    pub root: Option<PathBuf>,
    /// Parents before children.
    pub folders: Vec<SourceFolder>,
    pub notes: Vec<SourceNote>,
    pub attachments: Vec<SourceAttachment>,
    pub warnings: Warnings,
    /// Decoded Evernote resources live here until the model is dropped.
    pub spool: Option<super::Spool>,
    pub total_bytes: u64,
}

/// A folder (Obsidian/markdown directory, Evernote notebook = one `.enex`).
#[derive(Debug, Clone, Serialize)]
pub struct SourceFolder {
    /// Source path, `/`-separated (`Projects/Alpha`); unique.
    pub path: String,
    /// Display name (last path component, or the `.enex` file stem).
    pub name: String,
    pub parent: Option<String>,
}

/// What a note is, beyond an ordinary note.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NoteKind {
    Note,
    /// A page created for an attached Obsidian `.canvas`.
    Canvas,
    /// A page created for an attached Excalidraw drawing.
    Excalidraw,
    /// The "Unlinked files" page.
    UnlinkedFiles,
}

#[derive(Debug, Clone, Serialize)]
pub struct SourceNote {
    /// Unique key within the source (vault-relative path; `<file>.enex#<n>`).
    pub key: String,
    /// What `import_ref` records: vault-relative path, or the Evernote GUID
    /// (else `<file>.enex#<title>#<n>`).
    pub source_ref: String,
    pub kind: NoteKind,
    /// Source folder path (see [`SourceFolder::path`]), `None` = top level.
    pub folder: Option<String>,
    /// The title the source gives (filename / frontmatter `title:` / `<title>`).
    pub title: String,
    pub created: Option<String>,
    pub modified: Option<String>,
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
    pub properties: Vec<(String, String)>,
    /// Markdown body. References to attachments are `](minotes-att:<index>)`.
    pub body: String,
    /// Daily note → journal page for this date.
    pub journal: Option<NaiveDate>,
    /// Evernote note GUID, if the export carried one.
    pub guid: Option<String>,
    /// The start of the original source text (preview samples).
    #[serde(skip)]
    pub source_excerpt: String,
    /// Hash of everything the source contributes (re-import change detection).
    #[serde(skip)]
    pub source_hash: String,
}

#[derive(Debug, Clone)]
pub enum AttachmentData {
    /// A file inside the source folder.
    File(PathBuf),
    /// Decoded into the reader's spool directory (Evernote resources).
    Spooled(PathBuf),
}

#[derive(Debug, Clone, Serialize)]
pub struct SourceAttachment {
    /// Unique key: vault-relative path, or `md5:<hex>` for Evernote resources.
    pub key: String,
    pub name: String,
    pub mime: Option<String>,
    pub size: u64,
    #[serde(skip)]
    pub data: Option<AttachmentData>,
    /// Over the size cap: not imported (references become text).
    pub skipped: bool,
    /// Referenced by at least one note.
    pub referenced: bool,
}

impl SourceAttachment {
    pub fn is_image(&self) -> bool {
        match &self.mime {
            Some(m) => m.starts_with("image/"),
            None => {
                let ext = crate::repo::attachments::sanitize_ext(&self.name, None);
                crate::repo::attachments::mime_for_ext(&ext).starts_with("image/")
            }
        }
    }
}

/// One warning category: a count, the notes it affects, a few examples.
#[derive(Debug, Clone, Default, Serialize)]
pub struct WarningEntry {
    pub category: String,
    pub label: String,
    pub count: usize,
    /// Keys of the affected notes (first 200), in first-seen order.
    pub notes: Vec<String>,
    /// A few concrete examples (link targets, file names, …).
    pub examples: Vec<String>,
}

/// Every lossy rule increments a named counter (PRD §6).
#[derive(Debug, Clone, Default)]
pub struct Warnings {
    pub entries: BTreeMap<String, WarningEntry>,
}

impl Warnings {
    pub fn add(&mut self, category: &str, note: Option<&str>, example: Option<&str>) {
        let e = self.entries.entry(category.to_string()).or_insert_with(|| WarningEntry {
            category: category.to_string(),
            label: label(category).to_string(),
            ..Default::default()
        });
        e.count += 1;
        if let Some(n) = note {
            if e.notes.len() < 200 && !e.notes.iter().any(|x| x == n) {
                e.notes.push(n.to_string());
            }
        }
        if let Some(x) = example {
            if e.examples.len() < 5 && !e.examples.iter().any(|y| y == x) {
                e.examples.push(x.chars().take(120).collect());
            }
        }
    }

    pub fn merge(&mut self, other: &Warnings) {
        for (k, v) in &other.entries {
            let e = self.entries.entry(k.clone()).or_insert_with(|| WarningEntry {
                category: k.clone(),
                label: v.label.clone(),
                ..Default::default()
            });
            e.count += v.count;
            for n in &v.notes {
                if e.notes.len() < 200 && !e.notes.contains(n) {
                    e.notes.push(n.clone());
                }
            }
            for x in &v.examples {
                if e.examples.len() < 5 && !e.examples.contains(x) {
                    e.examples.push(x.clone());
                }
            }
        }
    }

    pub fn count(&self, category: &str) -> usize {
        self.entries.get(category).map(|e| e.count).unwrap_or(0)
    }

    pub fn list(&self) -> Vec<WarningEntry> {
        self.entries.values().cloned().collect()
    }
}

/// Human wording of a warning category ("12 Dataview blocks kept as code").
pub fn label(category: &str) -> &'static str {
    match category {
        "unresolved_link" => "links to notes that aren't in the import — kept as [[links]]",
        "ambiguous_link" => "links matching several notes with the same name — the closest was used",
        "heading_link" => "links to a heading — they link to the page (heading kept in the link text)",
        "block_link" => "links to a block — turned into block references",
        "block_link_unresolved" => "links to a block that wasn't found — they link to the page",
        "note_embed" => "embedded notes — shown as links (whole-page embeds aren't supported)",
        "callout" => "callouts — kept as quotes with the type in bold",
        "comment" => "%%comments%% — kept as HTML comments",
        "math" => "math expressions — kept as text",
        "dataview" => "Dataview queries — kept as code",
        "tasks_query" => "Tasks queries — kept as code",
        "canvas" => "Canvas files — attached, with a page linking to them",
        "excalidraw" => "Excalidraw drawings — attached, with a page linking to them",
        "unlinked_file" => "files no note links to — attached to the \"Unlinked files\" page",
        "missing_file" => "references to files that aren't in the source — kept as text",
        "path_outside" => "references pointing outside the source folder — ignored",
        "too_large" => "files over the size limit — skipped",
        "note_too_large" => "notes over the size limit — skipped",
        "unreadable" => "files that could not be read — skipped",
        "title_mapped" => "titles with characters MiNotes links can't use — renamed",
        "duplicate_title" => "notes with the same title — numbered (\"Title (2)\")",
        "title_collision" => "titles already used in this notebook — kept both with a suffix",
        "title_collision_skipped" => "titles already used in this notebook — skipped",
        "alias_conflict" => "aliases already used by another page — not added",
        "property_rejected" => "properties the notebook's schema rejected — left out",
        "journal_exists" => "daily notes whose journal page already exists — imported as ordinary pages",
        "en_crypt" => "encrypted Evernote text — kept as an opaque block",
        "missing_resource" => "Evernote media whose file isn't in the export — kept as a placeholder",
        "nested_table" => "nested tables — flattened",
        "heavy_clip" => "web clips over 200 blocks",
        "evernote_link_unresolved" => "Evernote note links to notes outside the import — kept as text",
        "unknown_entity" => "unknown XML entities — kept as text",
        "unsupported_element" => "unsupported Evernote elements — their text was kept",
        "reminder" => "Evernote reminders — kept as properties",
        "symlink_skipped" => "symbolic links — not followed",
        "reimport_conflict" => "notes changed both at the source and in MiNotes — imported as \"(reimported)\" copies",
        "frontmatter_unparsed" => "frontmatter lines that weren't key: value — kept as properties text",
        _ => "other conversions",
    }
}
