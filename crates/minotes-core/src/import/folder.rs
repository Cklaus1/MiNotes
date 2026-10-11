//! Reader for a folder of markdown: an Obsidian vault (PRD-import §4.2) or a
//! plain markdown folder (§4.5). Produces the neutral model; link resolution
//! (which needs every note) is the resolver's job. Only files inside the chosen
//! folder are read: dot-directories (`.obsidian/`, `.trash/`, `.git/`) are
//! ignored and symbolic links are never followed.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use chrono::NaiveDate;
use sha2::{Digest, Sha256};

use super::frontmatter::{self, FmValue};
use super::model::*;
use super::text;
use super::{Cancelled, Limits, Progress};
use crate::error::{Error, Result};

/// One file found by the walk.
struct Found {
    rel: String,
    abs: PathBuf,
    size: u64,
}

fn walk(root: &Path, warnings: &mut Warnings, limits: &Limits, cancel: &AtomicBool) -> Result<(Vec<Found>, Vec<String>)> {
    let mut files = Vec::new();
    let mut dirs = Vec::new();
    let mut stack = vec![String::new()];
    while let Some(rel_dir) = stack.pop() {
        if cancel.load(Ordering::Relaxed) {
            return Err(Cancelled.into());
        }
        let abs_dir = if rel_dir.is_empty() { root.to_path_buf() } else { root.join(&rel_dir) };
        let rd = match fs::read_dir(&abs_dir) {
            Ok(rd) => rd,
            Err(e) => {
                warnings.add("unreadable", None, Some(&format!("{rel_dir}: {e}")));
                continue;
            }
        };
        let mut entries: Vec<_> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name().to_string_lossy().to_string();
            let rel = if rel_dir.is_empty() { name.clone() } else { format!("{rel_dir}/{name}") };
            // Never follow symlinks: the walk stays inside the chosen folder.
            let Ok(meta) = fs::symlink_metadata(e.path()) else {
                warnings.add("unreadable", None, Some(&rel));
                continue;
            };
            if meta.file_type().is_symlink() {
                warnings.add("symlink_skipped", None, Some(&rel));
                continue;
            }
            if name.starts_with('.') {
                continue; // .obsidian/, .trash/, .git/, dotfiles
            }
            if meta.is_dir() {
                dirs.push(rel.clone());
                stack.push(rel);
            } else if meta.is_file() {
                if files.len() >= limits.max_files {
                    return Err(Error::InvalidInput(format!(
                        "The folder holds more than {} files — import a smaller folder",
                        limits.max_files
                    )));
                }
                files.push(Found { rel, abs: e.path(), size: meta.len() });
            }
        }
    }
    files.sort_by(|a, b| a.rel.cmp(&b.rel));
    dirs.sort();
    Ok((files, dirs))
}

/// `.obsidian/daily-notes.json`: (folder, moment.js format).
fn daily_notes_config(root: &Path) -> (String, String) {
    let mut folder = String::new();
    let mut format = "YYYY-MM-DD".to_string();
    if let Ok(t) = fs::read_to_string(root.join(".obsidian").join("daily-notes.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
            if let Some(f) = v.get("folder").and_then(|x| x.as_str()) {
                folder = f.trim_matches('/').to_string();
            }
            if let Some(f) = v.get("format").and_then(|x| x.as_str()).filter(|f| !f.trim().is_empty()) {
                format = f.to_string();
            }
        }
    }
    (folder, format)
}

/// moment.js date format → chrono (the tokens daily-note formats use).
pub(crate) fn moment_to_chrono(fmt: &str) -> String {
    let mut out = String::new();
    let mut rest = fmt;
    const TOKENS: &[(&str, &str)] = &[
        ("YYYY", "%Y"),
        ("YY", "%y"),
        ("MMMM", "%B"),
        ("MMM", "%b"),
        ("MM", "%m"),
        ("M", "%-m"),
        ("DDDD", "%j"),
        ("DD", "%d"),
        ("Do", "%-d"),
        ("D", "%-d"),
        ("dddd", "%A"),
        ("ddd", "%a"),
        ("ww", "%V"),
    ];
    'outer: while !rest.is_empty() {
        if let Some(r) = rest.strip_prefix('[') {
            if let Some(e) = r.find(']') {
                out.push_str(&r[..e].replace('%', "%%"));
                rest = &r[e + 1..];
                continue;
            }
        }
        for (t, c) in TOKENS {
            if let Some(r) = rest.strip_prefix(t) {
                out.push_str(c);
                rest = r;
                continue 'outer;
            }
        }
        let ch = rest.chars().next().unwrap();
        if ch == '%' {
            out.push_str("%%");
        } else {
            out.push(ch);
        }
        rest = &rest[ch.len_utf8()..];
    }
    out
}

fn parse_daily(stem_path: &str, chrono_fmt: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(stem_path, chrono_fmt)
        .ok()
        .filter(|d| d.format(chrono_fmt).to_string() == stem_path)
}

fn sha_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn excerpt(s: &str) -> String {
    s.chars().take(3000).collect()
}

/// Obsidian-only, note-local conversions (links are resolved later):
/// callouts → quote with the type in bold; `%%comments%%` → HTML comments;
/// math / Dataview / Tasks are counted.
fn convert_obsidian_body(body: &str, key: &str, w: &mut Warnings) -> String {
    let mut out_lines: Vec<String> = Vec::new();
    let mut in_comment = false;
    for (line, in_fence, lang) in text::lines_with_fence(body) {
        if in_fence {
            if line.trim_start().starts_with("```") || line.trim_start().starts_with("~~~") {
                if let Some(l) = &lang {
                    if line.trim_start().trim_start_matches(['`', '~']).trim().starts_with(l.as_str()) {
                        match l.as_str() {
                            "dataview" | "dataviewjs" => w.add("dataview", Some(key), None),
                            "tasks" => w.add("tasks_query", Some(key), None),
                            _ => {}
                        }
                    }
                }
            }
            out_lines.push(line.to_string());
            continue;
        }
        let mut line = line.to_string();
        // Callouts: `> [!type]± Title`.
        let stripped = line.trim_start_matches(|c: char| c == '>' || c == ' ').to_string();
        let quote_prefix_len = line.len() - stripped.len();
        if quote_prefix_len > 0 && line.trim_start().starts_with('>') {
            if let Some(rest) = stripped.strip_prefix("[!") {
                if let Some(end) = rest.find(']') {
                    let kind = &rest[..end];
                    let mut title = rest[end + 1..].trim_start_matches(['-', '+']).trim().to_string();
                    let mut label: String = kind.chars().take(1).flat_map(|c| c.to_uppercase()).collect();
                    label.push_str(&kind.chars().skip(1).collect::<String>());
                    if !title.is_empty() {
                        title = format!(" {title}");
                    }
                    let prefix = line[..quote_prefix_len].to_string();
                    line = format!("{prefix}**{label}**{title}");
                    w.add("callout", Some(key), Some(kind));
                }
            }
        }
        // %%comments%% (inline or spanning lines) → <!-- -->.
        if line.contains("%%") {
            let mut s = String::new();
            let mut rest = line.as_str();
            while let Some(i) = rest.find("%%") {
                s.push_str(&rest[..i]);
                if in_comment {
                    s.push_str("-->");
                } else {
                    s.push_str("<!--");
                    w.add("comment", Some(key), None);
                }
                in_comment = !in_comment;
                rest = &rest[i + 2..];
            }
            s.push_str(rest);
            line = s;
        }
        // Math: `$$` blocks and `$inline$` (counted, kept as text).
        if !in_comment && (line.contains("$$") || has_inline_math(&line)) {
            w.add("math", Some(key), None);
        }
        out_lines.push(line);
    }
    out_lines.join("\n")
}

fn has_inline_math(line: &str) -> bool {
    let b = line.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'$' && i + 1 < b.len() && b[i + 1] != b' ' && b[i + 1] != b'$' && (i == 0 || b[i - 1] != b'\\') {
            if let Some(e) = line[i + 1..].find('$') {
                let inner = &line[i + 1..i + 1 + e];
                if !inner.ends_with(' ') && !inner.is_empty() && !inner.chars().all(|c| c.is_ascii_digit() || c == '.' || c == ',') {
                    return true;
                }
                i += e + 2;
                continue;
            }
        }
        i += 1;
    }
    false
}

fn tags_from(v: &FmValue) -> Vec<String> {
    let mut out = Vec::new();
    for item in v.items() {
        for t in item.split_whitespace() {
            let t = t.trim_start_matches('#').trim_end_matches(',');
            if !t.is_empty() && !out.iter().any(|x: &String| x == t) {
                out.push(t.to_string());
            }
        }
    }
    out
}

fn is_excalidraw(rel: &str, text_head: &str) -> bool {
    let lower = rel.to_ascii_lowercase();
    lower.ends_with(".excalidraw.md") || lower.ends_with(".excalidraw") || text_head.contains("excalidraw-plugin:")
}

pub struct FolderOptions {
    pub kind: SourceKind,
    pub daily_notes: bool,
}

pub fn read(root: &Path, opts: &FolderOptions, limits: &Limits, cancel: &AtomicBool, progress: &dyn Fn(Progress)) -> Result<Model> {
    let root = root
        .canonicalize()
        .map_err(|e| Error::InvalidInput(format!("Cannot open {}: {e}", root.display())))?;
    if !root.is_dir() {
        return Err(Error::InvalidInput(format!("{} is not a folder", root.display())));
    }
    let mut warnings = Warnings::default();
    let (files, _dirs) = walk(&root, &mut warnings, limits, cancel)?;
    let total = files.len();
    let obsidian = opts.kind == SourceKind::Obsidian;
    let (daily_folder, daily_fmt) = daily_notes_config(&root);
    let chrono_fmt = moment_to_chrono(&daily_fmt);

    let mut notes: Vec<SourceNote> = Vec::new();
    let mut attachments: Vec<SourceAttachment> = Vec::new();
    let mut folder_set: BTreeSet<String> = BTreeSet::new();
    let mut total_bytes = 0u64;
    let mut seen_dates: BTreeMap<NaiveDate, String> = BTreeMap::new();

    for (i, f) in files.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Err(Cancelled.into());
        }
        if i % 200 == 0 {
            progress(Progress { phase: "scan".into(), done: i, total, current: f.rel.clone() });
        }
        total_bytes += f.size;
        let lower = f.rel.to_ascii_lowercase();
        let dir = f.rel.rsplit_once('/').map(|(d, _)| d.to_string());
        let file_name = f.rel.rsplit('/').next().unwrap_or(&f.rel).to_string();

        let add_attachment = |attachments: &mut Vec<SourceAttachment>, warnings: &mut Warnings, referenced: bool| -> usize {
            let skipped = f.size > limits.max_attachment_bytes;
            if skipped {
                warnings.add("too_large", None, Some(&format!("{} ({} MB)", f.rel, f.size / (1024 * 1024))));
            }
            let ext = crate::repo::attachments::sanitize_ext(&file_name, None);
            attachments.push(SourceAttachment {
                key: f.rel.clone(),
                name: file_name.clone(),
                mime: Some(crate::repo::attachments::mime_for_ext(&ext).to_string()),
                size: f.size,
                data: Some(AttachmentData::File(f.abs.clone())),
                skipped,
                referenced,
            });
            attachments.len() - 1
        };

        if lower.ends_with(".md") || lower.ends_with(".markdown") {
            if f.size > limits.max_note_bytes {
                warnings.add("note_too_large", None, Some(&f.rel));
                continue;
            }
            let bytes = match fs::read(&f.abs) {
                Ok(b) => b,
                Err(e) => {
                    warnings.add("unreadable", None, Some(&format!("{}: {e}", f.rel)));
                    continue;
                }
            };
            let raw = String::from_utf8_lossy(&bytes).into_owned();
            let head: String = raw.chars().take(600).collect();
            if obsidian && is_excalidraw(&f.rel, &head) {
                // Attached as a file, with a page linking to it.
                let idx = add_attachment(&mut attachments, &mut warnings, true);
                let stem = file_name.trim_end_matches(".md").trim_end_matches(".excalidraw");
                warnings.add("excalidraw", Some(&f.rel), Some(&f.rel));
                if let Some(d) = &dir {
                    folder_set.insert(d.clone());
                }
                notes.push(SourceNote {
                    key: f.rel.clone(),
                    source_ref: f.rel.clone(),
                    kind: NoteKind::Excalidraw,
                    folder: dir.clone(),
                    title: format!("{stem} (Excalidraw)"),
                    created: None,
                    modified: None,
                    tags: vec![],
                    aliases: vec![],
                    properties: vec![],
                    body: format!(
                        "Excalidraw drawing from Obsidian, attached as a file (open it with Excalidraw):\n\n[{}](minotes-att:{idx})",
                        file_name.replace(['[', ']'], "_")
                    ),
                    journal: None,
                    guid: None,
                    source_excerpt: excerpt(&raw),
                    source_hash: sha_hex(&bytes),
                });
                continue;
            }
            let stem = file_name
                .rsplit_once('.')
                .map(|(s, _)| s.to_string())
                .unwrap_or_else(|| file_name.clone());
            let (fm, body) = frontmatter::split(&raw);
            let mut title = stem.clone();
            let mut tags = Vec::new();
            let mut aliases = Vec::new();
            let mut properties = Vec::new();
            if let Some(fm) = &fm {
                for (k, v) in &fm.entries {
                    match k.to_ascii_lowercase().as_str() {
                        "title" if !v.text().trim().is_empty() => title = v.text().trim().to_string(),
                        "tags" | "tag" => tags.extend(tags_from(v)),
                        "aliases" | "alias" => aliases.extend(v.items()),
                        _ => properties.push((k.clone(), v.text())),
                    }
                }
                for u in &fm.unparsed {
                    warnings.add("frontmatter_unparsed", Some(&f.rel), Some(u));
                }
                if !fm.unparsed.is_empty() {
                    properties.push(("frontmatter".to_string(), fm.unparsed.join("\n")));
                }
            }
            let body = if obsidian { convert_obsidian_body(body, &f.rel, &mut warnings) } else { body.to_string() };
            // Daily notes → journal pages.
            let mut journal = None;
            if obsidian && opts.daily_notes {
                let in_folder = if daily_folder.is_empty() {
                    Some(f.rel.as_str())
                } else {
                    f.rel.strip_prefix(&format!("{daily_folder}/"))
                };
                if let Some(rest) = in_folder {
                    let stem_path = rest.trim_end_matches(".md").trim_end_matches(".markdown");
                    if let Some(d) = parse_daily(stem_path, &chrono_fmt) {
                        if seen_dates.contains_key(&d) {
                            warnings.add("journal_exists", Some(&f.rel), Some(&f.rel));
                        } else {
                            seen_dates.insert(d, f.rel.clone());
                            journal = Some(d);
                        }
                    }
                }
            }
            let modified = fs::metadata(&f.abs)
                .and_then(|m| m.modified())
                .ok()
                .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339());
            if journal.is_none() {
                if let Some(d) = &dir {
                    folder_set.insert(d.clone());
                }
            }
            notes.push(SourceNote {
                key: f.rel.clone(),
                source_ref: f.rel.clone(),
                kind: NoteKind::Note,
                folder: if journal.is_some() { None } else { dir.clone() },
                title,
                created: None,
                modified,
                tags,
                aliases,
                properties,
                body,
                journal,
                guid: None,
                source_excerpt: excerpt(&raw),
                source_hash: sha_hex(&bytes),
            });
        } else if obsidian && lower.ends_with(".canvas") {
            let idx = add_attachment(&mut attachments, &mut warnings, true);
            warnings.add("canvas", Some(&f.rel), Some(&f.rel));
            let mut lines = vec![format!(
                "Obsidian Canvas, attached as a file (open it in Obsidian to see the board):\n\n[{}](minotes-att:{idx})",
                file_name.replace(['[', ']'], "_")
            )];
            // The notes and cards on the board, as links / text.
            if f.size <= limits.max_note_bytes {
                if let Ok(t) = fs::read_to_string(&f.abs) {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
                        let mut items = Vec::new();
                        for n in v.get("nodes").and_then(|n| n.as_array()).into_iter().flatten() {
                            match n.get("type").and_then(|x| x.as_str()) {
                                Some("file") => {
                                    if let Some(p) = n.get("file").and_then(|x| x.as_str()) {
                                        items.push(format!("- [[{p}]]"));
                                    }
                                }
                                Some("text") => {
                                    if let Some(t) = n.get("text").and_then(|x| x.as_str()) {
                                        items.push(format!("- {}", text::collapse_ws(t)));
                                    }
                                }
                                Some("link") => {
                                    if let Some(u) = n.get("url").and_then(|x| x.as_str()) {
                                        items.push(format!("- <{u}>"));
                                    }
                                }
                                _ => {}
                            }
                        }
                        if !items.is_empty() {
                            lines.push(format!("## On the board\n{}", items.join("\n")));
                        }
                    }
                }
            }
            if let Some(d) = &dir {
                folder_set.insert(d.clone());
            }
            let stem = file_name.trim_end_matches(".canvas");
            let bytes = fs::read(&f.abs).unwrap_or_default();
            notes.push(SourceNote {
                key: format!("{}#canvas", f.rel),
                source_ref: f.rel.clone(),
                kind: NoteKind::Canvas,
                folder: dir.clone(),
                title: format!("{stem} (canvas)"),
                created: None,
                modified: None,
                tags: vec![],
                aliases: vec![],
                properties: vec![],
                body: lines.join("\n\n"),
                journal: None,
                guid: None,
                source_excerpt: excerpt(&String::from_utf8_lossy(&bytes)),
                source_hash: sha_hex(&bytes),
            });
        } else {
            add_attachment(&mut attachments, &mut warnings, false);
        }
    }
    progress(Progress { phase: "scan".into(), done: total, total, current: String::new() });

    // Every ancestor of a folder that holds notes becomes a Project.
    let mut all: BTreeSet<String> = BTreeSet::new();
    for d in &folder_set {
        let mut cur = String::new();
        for part in d.split('/') {
            cur = if cur.is_empty() { part.to_string() } else { format!("{cur}/{part}") };
            all.insert(cur.clone());
        }
    }
    let folders = all
        .into_iter()
        .map(|p| {
            let (parent, name) = match p.rsplit_once('/') {
                Some((par, n)) => (Some(par.to_string()), n.to_string()),
                None => (None, p.clone()),
            };
            SourceFolder { path: p, name, parent }
        })
        .collect();

    let name = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "Import".into());
    Ok(Model {
        kind: opts.kind,
        name,
        root: Some(root),
        folders,
        notes,
        attachments,
        warnings,
        spool: None,
        total_bytes,
    })
}

/// Does this folder look like an Obsidian vault?
pub fn is_obsidian_vault(root: &Path) -> bool {
    root.join(".obsidian").is_dir()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moment_formats() {
        assert_eq!(moment_to_chrono("YYYY-MM-DD"), "%Y-%m-%d");
        assert_eq!(moment_to_chrono("YYYY/MM/[Day] DD"), "%Y/%m/Day %d");
        assert_eq!(parse_daily("2024-01-05", "%Y-%m-%d"), NaiveDate::from_ymd_opt(2024, 1, 5));
        assert_eq!(parse_daily("2024-1-5", "%Y-%m-%d"), None);
    }

    #[test]
    fn obsidian_local_conversions() {
        let mut w = Warnings::default();
        let out = convert_obsidian_body(
            "> [!warning]- Careful\n> body\nText %%hidden%% end\n%%\nmulti\n%%\n$x^2$ and $5 and $6\n```dataview\nLIST\n```\n```js\n%% not a comment %%\n```",
            "n.md",
            &mut w,
        );
        assert!(out.starts_with("> **Warning** Careful\n> body\nText <!--hidden--> end\n<!--\nmulti\n-->"), "{out}");
        assert!(out.contains("%% not a comment %%"));
        assert_eq!(w.count("callout"), 1);
        assert_eq!(w.count("comment"), 2);
        assert_eq!(w.count("math"), 1);
        assert_eq!(w.count("dataview"), 1);
    }
}
