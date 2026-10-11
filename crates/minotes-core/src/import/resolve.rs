//! The resolver (PRD-import §4.1): final titles (collisions, journals,
//! re-import), note references → page links (Obsidian's rule: exact path, else
//! unique basename), attachment references → `minotes-att:<index>`
//! placeholders, Evernote note links by GUID/title, and the "Unlinked files"
//! page. Pure: no database, no filesystem.

use std::collections::{HashMap, HashSet};

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

use super::model::*;
use super::text::{self, find_md_links, find_wiki_links, has_scheme, join_rel, map_outside_code, percent_decode};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Collision {
    /// Keep both: the imported note gets a suffix ("Title (2)").
    #[default]
    KeepBoth,
    /// Skip the imported note.
    Skip,
}

/// What the resolver needs to know about the destination.
pub struct ResolveCtx<'a> {
    /// Is this title already used in the destination (case-insensitive)?
    pub title_taken: &'a dyn Fn(&str) -> bool,
    /// Re-import: source ref → title of the page an earlier import created.
    pub reimport: &'a HashMap<String, String>,
    pub collisions: Collision,
    pub unlinked_files: bool,
}

/// A note ready for the writer.
#[derive(Debug, Clone, Serialize)]
pub struct ResolvedNote {
    /// Index into `Model::notes`; `None` for pages the resolver adds.
    #[serde(skip)]
    pub src: Option<usize>,
    pub key: String,
    pub source_ref: String,
    pub kind: NoteKind,
    pub folder: Option<String>,
    pub title: String,
    #[serde(skip)]
    pub body: String,
    pub journal: Option<NaiveDate>,
    #[serde(skip)]
    pub tags: Vec<String>,
    #[serde(skip)]
    pub aliases: Vec<String>,
    #[serde(skip)]
    pub properties: Vec<(String, String)>,
    #[serde(skip)]
    pub source_hash: String,
    /// Skipped (title collision with "skip" chosen).
    pub skipped: bool,
    /// Re-import of a page an earlier run created (its current title).
    pub reimport: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Resolved {
    pub notes: Vec<ResolvedNote>,
    pub warnings: Warnings,
    /// (source title, title used) where a title had to change.
    pub title_mappings: Vec<(String, String)>,
    /// Per model attachment: referenced by some page (incl. "Unlinked files").
    pub attachment_used: Vec<bool>,
}

/// Characters MiNotes links can't carry in a title are mapped.
pub fn map_title(t: &str) -> String {
    let n = crate::repo::pages::normalize_name(t).unwrap_or_default();
    let mut s: String = n
        .chars()
        .map(|c| match c {
            '[' => '(',
            ']' => ')',
            '|' => '¦',
            c => c,
        })
        .collect();
    if s.chars().count() > 200 {
        s = s.chars().take(200).collect::<String>().trim_end().to_string();
    }
    if s.trim().is_empty() {
        "Untitled".to_string()
    } else {
        s
    }
}

fn lc(s: &str) -> String {
    s.to_lowercase()
}

fn strip_md_ext(s: &str) -> &str {
    let l = s.to_ascii_lowercase();
    if l.ends_with(".md") {
        &s[..s.len() - 3]
    } else if l.ends_with(".markdown") {
        &s[..s.len() - 9]
    } else {
        s
    }
}

fn dir_of(key: &str) -> &str {
    key.rsplit_once('/').map(|(d, _)| d).unwrap_or("")
}

fn basename(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or(p)
}

fn has_ext(p: &str) -> bool {
    basename(p).rsplit_once('.').map(|(a, e)| !a.is_empty() && !e.is_empty() && e.len() <= 10 && !e.contains(' ')).unwrap_or(false)
}

/// Does `body` contain the Obsidian block anchor `^id`?
pub(crate) fn has_block_anchor(body: &str, id: &str) -> bool {
    let tail = format!(" ^{id}");
    let alone = format!("^{id}");
    body.split('\n').any(|l| {
        let t = l.trim_end();
        t.ends_with(&tail) || t.trim() == alone
    })
}

struct Index {
    by_path: HashMap<String, usize>,
    by_base: HashMap<String, Vec<usize>>,
    by_title: HashMap<String, usize>,
    by_guid: HashMap<String, usize>,
    att_by_path: HashMap<String, usize>,
    att_by_base: HashMap<String, Vec<usize>>,
}

fn build_index(model: &Model) -> Index {
    let mut ix = Index {
        by_path: HashMap::new(),
        by_base: HashMap::new(),
        by_title: HashMap::new(),
        by_guid: HashMap::new(),
        att_by_path: HashMap::new(),
        att_by_base: HashMap::new(),
    };
    for (i, n) in model.notes.iter().enumerate() {
        if matches!(n.kind, NoteKind::Note | NoteKind::Excalidraw) && model.kind != SourceKind::Evernote {
            let p = lc(strip_md_ext(&n.key));
            ix.by_base.entry(lc(basename(&p))).or_default().push(i);
            ix.by_path.insert(p, i);
        }
        ix.by_title.entry(lc(&n.title)).or_insert(i);
        if let Some(g) = &n.guid {
            ix.by_guid.insert(lc(g), i);
        }
    }
    if model.kind != SourceKind::Evernote {
        for (i, a) in model.attachments.iter().enumerate() {
            ix.att_by_path.insert(lc(&a.key), i);
            ix.att_by_base.entry(lc(basename(&a.key))).or_default().push(i);
        }
    }
    ix
}

/// Pick among same-named candidates: the one in `dir`, else the shortest path.
fn pick(cands: &[usize], keys: &dyn Fn(usize) -> String, dir: &str) -> (usize, bool) {
    if cands.len() == 1 {
        return (cands[0], false);
    }
    if let Some(&c) = cands.iter().find(|&&c| dir_of(&keys(c)).eq_ignore_ascii_case(dir)) {
        return (c, true);
    }
    let mut v = cands.to_vec();
    v.sort_by_key(|&c| (keys(c).matches('/').count(), keys(c)));
    (v[0], true)
}

pub fn resolve(model: &Model, ctx: &ResolveCtx) -> Resolved {
    let mut w = Warnings::default();
    w.merge(&model.warnings);
    let ix = build_index(model);
    let n_notes = model.notes.len();

    // ── Titles ──
    let mut titles: Vec<String> = vec![String::new(); n_notes];
    let mut skipped = vec![false; n_notes];
    let mut reimport = vec![false; n_notes];
    let mut journal: Vec<Option<NaiveDate>> = model.notes.iter().map(|n| n.journal).collect();
    let mut used: HashSet<String> = HashSet::new();
    let mut mappings = Vec::new();
    for (i, n) in model.notes.iter().enumerate() {
        if let Some(t) = ctx.reimport.get(&n.source_ref) {
            titles[i] = t.clone();
            reimport[i] = true;
            journal[i] = None;
            used.insert(lc(t));
        }
    }
    for (i, n) in model.notes.iter().enumerate() {
        if reimport[i] {
            continue;
        }
        if let Some(d) = journal[i] {
            let jt = crate::repo::pages::journal_title(d);
            if (ctx.title_taken)(&jt) || used.contains(&lc(&jt)) {
                w.add("journal_exists", Some(&n.key), Some(&jt));
                journal[i] = None;
            } else {
                titles[i] = jt.clone();
                used.insert(lc(&jt));
            }
        }
    }
    let mut assign = |i: usize, src_title: &str, key: &str, used: &mut HashSet<String>, w: &mut Warnings| -> Option<String> {
        let base = map_title(src_title);
        if base != src_title.trim() {
            w.add("title_mapped", Some(key), Some(&format!("{src_title} → {base}")));
            mappings.push((src_title.to_string(), base.clone()));
        }
        let taken_db = (ctx.title_taken)(&base);
        if taken_db && ctx.collisions == Collision::Skip {
            w.add("title_collision_skipped", Some(key), Some(&base));
            return None;
        }
        let mut cand = base.clone();
        let mut n = 2;
        while used.contains(&lc(&cand)) || (ctx.title_taken)(&cand) {
            cand = format!("{base} ({n})");
            n += 1;
        }
        if cand != base {
            if used.contains(&lc(&base)) {
                w.add("duplicate_title", Some(key), Some(&format!("{base} → {cand}")));
            } else {
                w.add("title_collision", Some(key), Some(&format!("{base} → {cand}")));
            }
        }
        let _ = i;
        used.insert(lc(&cand));
        Some(cand)
    };
    for (i, n) in model.notes.iter().enumerate() {
        if reimport[i] || journal[i].is_some() {
            continue;
        }
        match assign(i, &n.title, &n.key, &mut used, &mut w) {
            Some(t) => titles[i] = t,
            None => {
                skipped[i] = true;
                titles[i] = map_title(&n.title);
            }
        }
    }

    // ── Bodies ──
    let mut att_used: Vec<bool> = model.attachments.iter().map(|a| a.referenced).collect();
    let keys_n = |c: usize| model.notes[c].key.clone();
    let keys_a = |c: usize| model.attachments[c].key.clone();
    let folder_title_fallback = true;
    let find_note = |target: &str, dir: &str, key: &str, w: &mut Warnings| -> Option<usize> {
        let t = strip_md_ext(target.trim());
        if t.is_empty() {
            return None;
        }
        let l = lc(t.trim_start_matches('/'));
        if let Some(&i) = ix.by_path.get(&l) {
            return Some(i);
        }
        if let Some(rel) = join_rel(dir, t) {
            if let Some(&i) = ix.by_path.get(&lc(&rel)) {
                return Some(i);
            }
        }
        let Some(cands) = ix.by_base.get(&lc(basename(&l))) else {
            // A frontmatter `title:` names the page in MiNotes too.
            return if folder_title_fallback && !l.contains('/') { ix.by_title.get(&l).copied() } else { None };
        };
        if l.contains('/') {
            // A path that matches nothing: only accept a basename match whose
            // path ends with it.
            let hit: Vec<usize> = cands.iter().copied().filter(|&c| lc(strip_md_ext(&model.notes[c].key)).ends_with(&l)).collect();
            if hit.is_empty() {
                return None;
            }
            let (c, amb) = pick(&hit, &keys_n, dir);
            if amb {
                w.add("ambiguous_link", Some(key), Some(target));
            }
            return Some(c);
        }
        let (c, amb) = pick(cands, &keys_n, dir);
        if amb {
            w.add("ambiguous_link", Some(key), Some(target));
        }
        Some(c)
    };
    let find_att = |target: &str, dir: &str| -> Option<usize> {
        let t = target.trim().trim_start_matches('/');
        if t.is_empty() {
            return None;
        }
        if let Some(&i) = ix.att_by_path.get(&lc(t)) {
            return Some(i);
        }
        if let Some(rel) = join_rel(dir, t) {
            if let Some(&i) = ix.att_by_path.get(&lc(&rel)) {
                return Some(i);
            }
        }
        if t.contains('/') {
            return None;
        }
        let cands = ix.att_by_base.get(&lc(basename(t)))?;
        Some(pick(cands, &keys_a, dir).0)
    };

    let folder_source = model.kind != SourceKind::Evernote;
    let mut out_notes: Vec<ResolvedNote> = Vec::with_capacity(n_notes + 1);
    for (i, n) in model.notes.iter().enumerate() {
        let dir = dir_of(&n.key).to_string();
        let mut body = n.body.clone();
        if !skipped[i] {
            if folder_source {
                body = map_outside_code(&body, &mut |seg: &str| {
                    // Wiki links / embeds.
                    let mut s = String::with_capacity(seg.len());
                    let mut last = 0;
                    for l in find_wiki_links(seg) {
                        s.push_str(&seg[last..l.start]);
                        last = l.end;
                        s.push_str(&wiki(&l, i, &dir, n, model, &titles, &skipped, &mut att_used, &mut w, &find_note, &find_att));
                    }
                    s.push_str(&seg[last..]);
                    // Markdown links / images to files in the source.
                    let seg2 = s;
                    let mut s = String::with_capacity(seg2.len());
                    let mut last = 0;
                    for l in find_md_links(&seg2) {
                        s.push_str(&seg2[last..l.start]);
                        last = l.end;
                        match md_link(&l, &dir, n, model, &titles, &mut att_used, &mut w, &find_note, &find_att) {
                            Some(r) => s.push_str(&r),
                            None => s.push_str(&seg2[l.start..l.end]),
                        }
                    }
                    s.push_str(&seg2[last..]);
                    s
                });
            } else {
                body = map_outside_code(&body, &mut |seg: &str| {
                    let mut s = String::with_capacity(seg.len());
                    let mut last = 0;
                    for l in find_md_links(seg) {
                        s.push_str(&seg[last..l.start]);
                        last = l.end;
                        match evernote_link(&l, n, model, &titles, &ix, &mut w) {
                            Some(r) => s.push_str(&r),
                            None => s.push_str(&seg[l.start..l.end]),
                        }
                    }
                    s.push_str(&seg[last..]);
                    s
                });
            }
        }
        out_notes.push(ResolvedNote {
            src: Some(i),
            key: n.key.clone(),
            source_ref: n.source_ref.clone(),
            kind: n.kind,
            folder: if journal[i].is_some() { None } else { n.folder.clone() },
            title: titles[i].clone(),
            body,
            journal: journal[i],
            tags: n.tags.clone(),
            aliases: n.aliases.clone(),
            properties: n.properties.clone(),
            source_hash: n.source_hash.clone(),
            skipped: skipped[i],
            reimport: reimport[i],
        });
    }

    // ── Unlinked files ──
    if ctx.unlinked_files && folder_source {
        let unlinked: Vec<usize> =
            (0..model.attachments.len()).filter(|&a| !att_used[a] && !model.attachments[a].skipped).collect();
        if !unlinked.is_empty() {
            let mut lines = vec!["Files from the import that no note links to:".to_string(), String::new()];
            for &a in &unlinked {
                let att = &model.attachments[a];
                w.add("unlinked_file", None, Some(&att.key));
                att_used[a] = true;
                let label = att.key.replace(['[', ']'], "_");
                lines.push(if att.is_image() {
                    format!("- {label}\n  ![{}](minotes-att:{a})", att.name.replace(['[', ']'], "_"))
                } else {
                    format!("- [{label}](minotes-att:{a})")
                });
            }
            let src_ref = "unlinked-files".to_string();
            let (title, is_re) = match ctx.reimport.get(&src_ref) {
                Some(t) => (Some(t.clone()), true),
                None => (assign(usize::MAX, "Unlinked files", "Unlinked files", &mut used, &mut w), false),
            };
            let mut h = sha2::Sha256::new();
            use sha2::Digest;
            for &a in &unlinked {
                h.update(model.attachments[a].key.as_bytes());
                h.update(model.attachments[a].size.to_le_bytes());
            }
            let hash: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
            out_notes.push(ResolvedNote {
                src: None,
                key: "Unlinked files".into(),
                source_ref: src_ref,
                kind: NoteKind::UnlinkedFiles,
                folder: None,
                skipped: title.is_none(),
                title: title.unwrap_or_else(|| "Unlinked files".into()),
                body: lines.join("\n"),
                journal: None,
                tags: vec![],
                aliases: vec![],
                properties: vec![],
                source_hash: hash,
                reimport: is_re,
            });
        }
    } else if folder_source {
        for (a, att) in model.attachments.iter().enumerate() {
            if !att_used[a] && !att.skipped {
                w.add("unlinked_file", None, Some(&att.key));
            }
        }
    }

    Resolved { notes: out_notes, warnings: w, title_mappings: mappings, attachment_used: att_used }
}

#[allow(clippy::too_many_arguments)]
fn wiki(
    l: &text::WikiLink,
    i: usize,
    dir: &str,
    n: &SourceNote,
    model: &Model,
    titles: &[String],
    skipped: &[bool],
    att_used: &mut [bool],
    w: &mut Warnings,
    find_note: &dyn Fn(&str, &str, &str, &mut Warnings) -> Option<usize>,
    find_att: &dyn Fn(&str, &str) -> Option<usize>,
) -> String {
    let _ = skipped;
    let display_alias = l.alias;
    // [[#Heading]] — a heading in this same note.
    if l.target.is_empty() {
        let frag = l.fragment.unwrap_or("");
        w.add("heading_link", Some(&n.key), Some(frag));
        let shown = display_alias.map(str::to_string).unwrap_or_else(|| frag.trim_start_matches('^').to_string());
        return format!("[[{}|{shown}]]", titles[i]);
    }
    let ext_non_md = has_ext(l.target) && !l.target.to_ascii_lowercase().ends_with(".md");
    let as_att = |att_used: &mut [bool], a: usize| -> String {
        att_used[a] = true;
        let att = &model.attachments[a];
        if att.skipped {
            return format!("{} (not imported: over the size limit)", att.name);
        }
        let name = att.name.replace(['[', ']'], "_");
        if l.embed && att.is_image() {
            format!("![{name}](minotes-att:{a})")
        } else {
            // `![[img.png|300]]`: the "alias" is a size; keep the name.
            let shown = display_alias.filter(|s| !s.chars().all(|c| c.is_ascii_digit() || c == 'x')).unwrap_or(&name);
            format!("[{}](minotes-att:{a})", shown.replace(['[', ']'], "_"))
        }
    };
    if ext_non_md {
        if let Some(a) = find_att(l.target, dir) {
            return as_att(att_used, a);
        }
    }
    if let Some(t) = find_note(l.target, dir, &n.key, w) {
        let final_title = &titles[t];
        if l.embed {
            w.add("note_embed", Some(&n.key), Some(l.target));
        }
        let shown: String = match l.fragment {
            Some(f) if f.starts_with('^') => {
                let id = &f[1..];
                if !id.is_empty() && has_block_anchor(&model.notes[t].body, id) {
                    w.add("block_link", Some(&n.key), Some(&format!("{}#{f}", l.target)));
                    return format!("((minotes-blockref:{t}:{id}))");
                }
                w.add("block_link_unresolved", Some(&n.key), Some(&format!("{}#{f}", l.target)));
                display_alias.map(str::to_string).unwrap_or_else(|| format!("{} > {f}", l.target))
            }
            Some(f) if !f.is_empty() => {
                w.add("heading_link", Some(&n.key), Some(&format!("{}#{f}", l.target)));
                display_alias.map(str::to_string).unwrap_or_else(|| format!("{} > {f}", l.target))
            }
            _ => display_alias.map(str::to_string).unwrap_or_else(|| strip_md_ext(basename(l.target)).to_string()),
        };
        return if shown == *final_title { format!("[[{final_title}]]") } else { format!("[[{final_title}|{shown}]]") };
    }
    if let Some(a) = find_att(l.target, dir) {
        return as_att(att_used, a);
    }
    // An alias of some note resolves natively in MiNotes.
    let target = l.target;
    let is_alias = model.notes.iter().any(|m| m.aliases.iter().any(|a| a.eq_ignore_ascii_case(target)));
    if !is_alias {
        if ext_non_md {
            w.add("missing_file", Some(&n.key), Some(target));
        } else {
            w.add("unresolved_link", Some(&n.key), Some(target));
        }
    }
    let t = map_title(target);
    match display_alias {
        Some(a) => format!("[[{t}|{a}]]"),
        None => format!("[[{t}]]"),
    }
}

#[allow(clippy::too_many_arguments)]
fn md_link(
    l: &text::MdLink,
    dir: &str,
    n: &SourceNote,
    model: &Model,
    titles: &[String],
    att_used: &mut [bool],
    w: &mut Warnings,
    find_note: &dyn Fn(&str, &str, &str, &mut Warnings) -> Option<usize>,
    find_att: &dyn Fn(&str, &str) -> Option<usize>,
) -> Option<String> {
    let url = l.url.trim();
    if url.is_empty() || has_scheme(url) || url.starts_with('#') || url.starts_with("//") {
        return None;
    }
    let (path, frag) = match url.split_once('#') {
        Some((p, f)) => (p, Some(f)),
        None => (url, None),
    };
    let path = path.split('?').next().unwrap_or(path);
    let decoded = percent_decode(path);
    let Some(rel) = join_rel(dir, &decoded) else {
        w.add("path_outside", Some(&n.key), Some(url));
        return Some(l.text.to_string());
    };
    let is_md = {
        let x = rel.to_ascii_lowercase();
        x.ends_with(".md") || x.ends_with(".markdown") || !has_ext(&rel)
    };
    if is_md {
        // `rel` is already relative to the source root.
        if let Some(t) = find_note(&format!("/{rel}"), "", &n.key, w) {
            if frag.is_some() {
                w.add("heading_link", Some(&n.key), Some(url));
            }
            let text = l.text.trim();
            let final_title = &titles[t];
            return Some(if text.is_empty() || text == final_title { format!("[[{final_title}]]") } else { format!("[[{final_title}|{}]]", text.replace(['[', ']', '|'], "")) });
        }
    }
    if let Some(a) = find_att(&format!("/{rel}"), "") {
        att_used[a] = true;
        let att = &model.attachments[a];
        if att.skipped {
            return Some(format!("{} (not imported: over the size limit)", att.name));
        }
        let text = if l.text.trim().is_empty() { att.name.clone() } else { l.text.to_string() };
        let text = text.replace(['[', ']'], "_");
        return Some(if l.image { format!("![{text}](minotes-att:{a})") } else { format!("[{text}](minotes-att:{a})") });
    }
    if is_md {
        w.add("unresolved_link", Some(&n.key), Some(url));
    } else {
        w.add("missing_file", Some(&n.key), Some(url));
    }
    None
}

/// `evernote:///view/<user>/<shard>/<guid>/<guid>/` or a web note link → its GUID.
fn evernote_guid(url: &str) -> Option<String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("evernote:") || lower.contains("evernote.com/shard/") || lower.contains("evernote.com/l/")) {
        return None;
    }
    lower
        .split(['/', '?', '#'])
        .find(|seg| seg.len() == 36 && seg.chars().filter(|c| *c == '-').count() == 4 && seg.chars().all(|c| c.is_ascii_hexdigit() || c == '-'))
        .map(str::to_string)
}

fn evernote_link(l: &text::MdLink, n: &SourceNote, _model: &Model, titles: &[String], ix: &Index, w: &mut Warnings) -> Option<String> {
    let url = l.url.trim();
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("evernote:") || lower.contains("evernote.com/shard/") || lower.contains("evernote.com/l/")) {
        return None;
    }
    let text = l.text.trim();
    let target = evernote_guid(url)
        .and_then(|g| ix.by_guid.get(&g).copied())
        .or_else(|| ix.by_title.get(&lc(text)).copied());
    match target {
        Some(t) => {
            let final_title = &titles[t];
            Some(if text.is_empty() || text == final_title { format!("[[{final_title}]]") } else { format!("[[{final_title}|{}]]", text.replace(['[', ']', '|'], "")) })
        }
        None => {
            w.add("evernote_link_unresolved", Some(&n.key), Some(text));
            Some(text.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(key: &str, body: &str) -> SourceNote {
        let title = basename(strip_md_ext(key)).to_string();
        SourceNote {
            key: key.into(),
            source_ref: key.into(),
            kind: NoteKind::Note,
            folder: key.rsplit_once('/').map(|(d, _)| d.to_string()),
            title,
            created: None,
            modified: None,
            tags: vec![],
            aliases: vec![],
            properties: vec![],
            body: body.into(),
            journal: None,
            guid: None,
            source_excerpt: String::new(),
            source_hash: String::new(),
        }
    }

    fn att(key: &str) -> SourceAttachment {
        SourceAttachment {
            key: key.into(),
            name: basename(key).into(),
            mime: None,
            size: 3,
            data: None,
            skipped: false,
            referenced: false,
        }
    }

    fn model(notes: Vec<SourceNote>, atts: Vec<SourceAttachment>) -> Model {
        Model {
            kind: SourceKind::Obsidian,
            name: "v".into(),
            root: None,
            folders: vec![],
            notes,
            attachments: atts,
            warnings: Warnings::default(),
            spool: None,
            total_bytes: 0,
        }
    }

    fn run(m: &Model, taken: &[&str]) -> Resolved {
        let taken: HashSet<String> = taken.iter().map(|t| t.to_lowercase()).collect();
        let f = move |t: &str| taken.contains(&t.to_lowercase());
        let re = HashMap::new();
        resolve(m, &ResolveCtx { title_taken: &f, reimport: &re, collisions: Collision::KeepBoth, unlinked_files: true })
    }

    #[test]
    fn links_follow_obsidians_rule() {
        let m = model(
            vec![
                note("Home.md", "[[Alpha]] [[Projects/Alpha|the alpha]] [[Beta#Intro]] [[Beta#^b1]] ![[Beta]] [[Nope]] [[Gamma]] [md](Projects/Alpha.md) [rel](../x.md) ![pic](img/p%20q.png) ![[p q.png]] [[doc.pdf]] `[[code]]` [[#Local]]"),
                note("Projects/Alpha.md", "a"),
                note("Beta.md", "para ^b1"),
                note("Projects/Gamma.md", "g"),
                note("Archive/Gamma.md", "g2"),
                note("Projects/Home.md", "dup title"),
            ],
            vec![att("img/p q.png"), att("files/doc.pdf"), att("loose.zip")],
        );
        let r = run(&m, &[]);
        let home = &r.notes[0].body;
        assert!(home.contains("[[Alpha]] [[Alpha|the alpha]]"), "{home}");
        assert!(home.contains("[[Beta|Beta > Intro]]"), "{home}");
        assert!(home.contains("((minotes-blockref:2:b1))"), "{home}");
        assert!(home.contains(" [[Beta]] [[Nope]]"), "embed → link: {home}");
        assert!(home.contains("[[Gamma]]") || home.contains("[[Gamma (2)|Gamma]]"), "{home}");
        assert!(home.contains("[[Alpha|md]]"), "{home}");
        assert!(home.contains(" rel ![pic]"), "outside the root: link dropped, text kept: {home}");
        assert!(home.contains("![pic](minotes-att:0) ![p q.png](minotes-att:0) [doc.pdf](minotes-att:1)"), "{home}");
        assert!(home.contains("`[[code]]`"));
        assert!(home.contains("[[Home|Local]]"), "{home}");
        assert_eq!(r.warnings.count("unresolved_link"), 1);
        assert_eq!(r.warnings.count("ambiguous_link"), 1);
        assert_eq!(r.warnings.count("note_embed"), 1);
        assert_eq!(r.warnings.count("block_link"), 1);
        assert_eq!(r.warnings.count("path_outside"), 1);
        // Duplicate titles are numbered; the unlinked zip gets its own page.
        assert_eq!(r.notes[5].title, "Home (2)");
        assert_eq!(r.warnings.count("duplicate_title"), 2); // Gamma (2) and Home (2)
        let unlinked = r.notes.last().unwrap();
        assert_eq!(unlinked.kind, NoteKind::UnlinkedFiles);
        assert!(unlinked.body.contains("[loose.zip](minotes-att:2)"));
    }

    #[test]
    fn titles_collide_with_the_destination() {
        let mut m = model(vec![note("A.md", ""), note("B [x].md", "")], vec![]);
        m.notes[1].title = "B [x]|y".into();
        let r = run(&m, &["a"]);
        assert_eq!(r.notes[0].title, "A (2)");
        assert_eq!(r.notes[1].title, "B (x)¦y");
        assert_eq!(r.warnings.count("title_collision"), 1);
        assert_eq!(r.warnings.count("title_mapped"), 1);
        let taken: HashSet<String> = ["a".to_string()].into();
        let f = move |t: &str| taken.contains(&t.to_lowercase());
        let re = HashMap::new();
        let r = resolve(&m, &ResolveCtx { title_taken: &f, reimport: &re, collisions: Collision::Skip, unlinked_files: false });
        assert!(r.notes[0].skipped);
    }
}
