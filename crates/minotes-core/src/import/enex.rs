//! Evernote `.enex` reader (PRD-import §4.4).
//!
//! - Streaming: the file is parsed event by event and each resource's base64
//!   `<data>` is decoded straight into a spool file (hashing as it goes), so a
//!   multi-gigabyte export is never held in memory.
//! - Safe XML: entity declarations in the DOCTYPE are never expanded (only the
//!   five XML entities, character references and a fixed table of HTML entity
//!   names are), so an entity bomb stays a few bytes of literal text; element
//!   nesting is capped; resources over the size cap are discarded while read.
//! - ENML → markdown with the §4.4 rules (en-todo, en-media by MD5, en-crypt,
//!   tables, lists, links, highlights).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use base64::Engine;
use md5::Md5;
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use sha2::{Digest, Sha256};

use super::model::*;
use super::split::{split, SplitMode};
use super::{Cancelled, Limits, Progress, Spool};
use crate::error::{Error, Result};

const MAX_DEPTH: usize = 256;

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn xml_err(file: &Path, e: impl std::fmt::Display) -> Error {
    Error::InvalidInput(format!("{} is not a readable .enex file: {e}", file.display()))
}

/// Resolve `&name;`: the XML five, character references, and common HTML names.
/// Anything else (incl. DTD-declared entities) is returned as `None`.
fn resolve_entity(name: &str) -> Option<String> {
    if let Some(num) = name.strip_prefix('#') {
        let v = if let Some(h) = num.strip_prefix(['x', 'X']) { u32::from_str_radix(h, 16).ok()? } else { num.parse().ok()? };
        return char::from_u32(v).filter(|c| *c != '\0').map(|c| c.to_string());
    }
    let c = match name {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => '\u{a0}',
        "ensp" => '\u{2002}',
        "emsp" => '\u{2003}',
        "thinsp" => '\u{2009}',
        "copy" => '©',
        "reg" => '®',
        "trade" => '™',
        "mdash" => '—',
        "ndash" => '–',
        "hellip" => '…',
        "lsquo" => '‘',
        "rsquo" => '’',
        "ldquo" => '“',
        "rdquo" => '”',
        "bull" => '•',
        "middot" => '·',
        "laquo" => '«',
        "raquo" => '»',
        "times" => '×',
        "divide" => '÷',
        "deg" => '°',
        "plusmn" => '±',
        "euro" => '€',
        "pound" => '£',
        "yen" => '¥',
        "cent" => '¢',
        "sect" => '§',
        "para" => '¶',
        "frac12" => '½',
        "frac14" => '¼',
        "frac34" => '¾',
        "larr" => '←',
        "rarr" => '→',
        "uarr" => '↑',
        "darr" => '↓',
        "zwnj" => '\u{200c}',
        "zwj" => '\u{200d}',
        _ => return None,
    };
    Some(c.to_string())
}

fn enex_date(s: &str) -> Option<String> {
    let s = s.trim();
    chrono::NaiveDateTime::parse_from_str(s, "%Y%m%dT%H%M%SZ")
        .ok()
        .map(|d| d.and_utc().to_rfc3339())
}

#[derive(Default)]
struct Resource {
    mime: Option<String>,
    file_name: Option<String>,
    md5: Option<String>,
    sha256: Option<String>,
    spooled: Option<PathBuf>,
    size: u64,
    too_large: bool,
    /// The base64 did not decode.
    bad: bool,
}

#[derive(Default)]
struct NoteBuild {
    title: String,
    content: String,
    content_too_large: bool,
    created: Option<String>,
    updated: Option<String>,
    tags: Vec<String>,
    guid: Option<String>,
    attrs: Vec<(String, String)>,
    resources: Vec<Resource>,
}

/// Decode a base64 `<data>` element from the raw stream into a spool file,
/// hashing (MD5 for en-media matching, SHA-256 for the store) on the way.
fn stream_data<R: BufRead>(reader: &mut Reader<R>, spool: &Path, cap: u64) -> std::io::Result<Resource> {
    let engine = base64::engine::GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        base64::engine::GeneralPurposeConfig::new()
            .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    let path = spool.join(format!("{}.bin", uuid::Uuid::now_v7().simple()));
    let mut out = Some(std::io::BufWriter::new(fs::File::create(&path)?));
    let mut md5 = Md5::new();
    let mut sha = Sha256::new();
    let mut size = 0u64;
    let mut too_large = false;
    let mut carry: Vec<u8> = Vec::with_capacity(64 * 1024);
    let mut bad = false;
    let mut flush = |carry: &mut Vec<u8>, last: bool, out: &mut Option<std::io::BufWriter<fs::File>>, size: &mut u64, too_large: &mut bool| {
        let take = if last { carry.len() } else { carry.len() / 4 * 4 };
        if take == 0 {
            return;
        }
        let chunk: Vec<u8> = carry.drain(..take).collect();
        let chunk: Vec<u8> = chunk.into_iter().filter(|b| *b != b'=').collect();
        if chunk.is_empty() {
            return;
        }
        match engine.decode(&chunk) {
            Ok(bytes) => {
                *size += bytes.len() as u64;
                if *size > cap {
                    *too_large = true;
                    *out = None; // stop writing; keep consuming the stream
                } else {
                    md5.update(&bytes);
                    sha.update(&bytes);
                    if let Some(w) = out.as_mut() {
                        let _ = w.write_all(&bytes);
                    }
                }
            }
            Err(_) => bad = true,
        }
    };
    {
        let mut stream = reader.stream();
        loop {
            let buf = stream.fill_buf()?;
            if buf.is_empty() {
                break;
            }
            let (n, done) = match buf.iter().position(|b| *b == b'<') {
                Some(p) => (p, true),
                None => (buf.len(), false),
            };
            for &b in &buf[..n] {
                if b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=' {
                    carry.push(b);
                }
            }
            stream.consume(n);
            if carry.len() >= 64 * 1024 {
                flush(&mut carry, false, &mut out, &mut size, &mut too_large);
            }
            if done {
                break;
            }
        }
    }
    flush(&mut carry, true, &mut out, &mut size, &mut too_large);
    if let Some(mut w) = out.take() {
        w.flush()?;
    }
    let ok = !too_large && !bad && size > 0;
    if !ok {
        let _ = fs::remove_file(&path);
    }
    Ok(Resource {
        md5: ok.then(|| hex(&md5.finalize())),
        sha256: ok.then(|| hex(&sha.finalize())),
        spooled: ok.then_some(path),
        size,
        too_large,
        bad,
        ..Default::default()
    })
}

fn local_name(e: &BytesStart) -> String {
    String::from_utf8_lossy(e.local_name().as_ref()).to_ascii_lowercase()
}

pub fn read(
    files: &[PathBuf],
    parent: Option<&str>,
    limits: &Limits,
    cancel: &AtomicBool,
    progress: &dyn Fn(Progress),
) -> Result<Model> {
    if files.is_empty() {
        return Err(Error::InvalidInput("Choose at least one .enex file".into()));
    }
    let spool = Spool::new()?;
    let mut warnings = Warnings::default();
    let mut notes = Vec::new();
    let mut attachments: Vec<SourceAttachment> = Vec::new();
    let mut folders = Vec::new();
    let mut total_bytes = 0u64;
    let parent = parent.map(str::trim).filter(|p| !p.is_empty());
    if let Some(p) = parent {
        folders.push(SourceFolder { path: p.to_string(), name: p.to_string(), parent: None });
    }
    let total_size: u64 = files.iter().filter_map(|f| fs::metadata(f).ok()).map(|m| m.len()).sum();
    let mut used_folder_paths: HashSet<String> = HashSet::new();

    for file in files {
        let meta = fs::metadata(file).map_err(|e| Error::InvalidInput(format!("Cannot read {}: {e}", file.display())))?;
        if !meta.is_file() {
            return Err(Error::InvalidInput(format!("{} is not a file", file.display())));
        }
        let stem = file.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "Evernote".into());
        let mut folder_path = match parent {
            Some(p) => format!("{p}/{stem}"),
            None => stem.clone(),
        };
        let mut n = 2;
        while !used_folder_paths.insert(folder_path.clone()) {
            folder_path = match parent {
                Some(p) => format!("{p}/{stem} ({n})"),
                None => format!("{stem} ({n})"),
            };
            n += 1;
        }
        let folder_name = folder_path.rsplit('/').next().unwrap_or(&stem).to_string();
        folders.push(SourceFolder { path: folder_path.clone(), name: folder_name, parent: parent.map(str::to_string) });
        let file_label = file.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();

        let fh = fs::File::open(file).map_err(|e| Error::InvalidInput(format!("Cannot read {}: {e}", file.display())))?;
        let mut reader = Reader::from_reader(BufReader::with_capacity(256 * 1024, RetryRead(fh)));
        {
            let cfg = reader.config_mut();
            cfg.check_end_names = false;
            cfg.trim_text(false);
        }
        let mut buf = Vec::new();
        let mut path: Vec<String> = Vec::new();
        let mut note: Option<NoteBuild> = None;
        let mut res: Option<Resource> = None;
        let mut text = String::new();
        let mut index_in_file = 0usize;
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(Cancelled.into());
            }
            let ev = reader.read_event_into(&mut buf).map_err(|e| xml_err(file, e))?;
            match ev {
                Event::Start(e) => {
                    let name = local_name(&e);
                    if path.len() >= MAX_DEPTH {
                        return Err(xml_err(file, "elements nested too deeply"));
                    }
                    match name.as_str() {
                        "note" if note.is_none() => note = Some(NoteBuild::default()),
                        "resource" if note.is_some() => res = Some(Resource::default()),
                        "data" if res.is_some() && path.last().map(|p| p == "resource").unwrap_or(false) => {
                            let r = stream_data(&mut reader, spool.path(), limits.max_attachment_bytes)
                                .map_err(|e| xml_err(file, e))?;
                            if let Some(cur) = res.as_mut() {
                                cur.md5 = r.md5;
                                cur.sha256 = r.sha256;
                                cur.spooled = r.spooled;
                                cur.size = r.size;
                                cur.too_large = r.too_large;
                            }
                        }
                        _ => {}
                    }
                    path.push(name);
                    text.clear();
                }
                Event::Empty(_) => {}
                Event::Text(t) => {
                    if text.len() < limits.max_note_bytes as usize {
                        text.push_str(&t.decode().map_err(|e| xml_err(file, e))?);
                    } else if path.last().map(|p| p == "content").unwrap_or(false) {
                        if let Some(n) = note.as_mut() {
                            n.content_too_large = true;
                        }
                    }
                }
                Event::CData(t) => {
                    if text.len() + t.len() <= limits.max_note_bytes as usize {
                        text.push_str(&String::from_utf8_lossy(&t));
                    } else if let Some(n) = note.as_mut() {
                        n.content_too_large = true;
                    }
                }
                Event::GeneralRef(r) => {
                    let name = String::from_utf8_lossy(r.as_ref()).to_string();
                    match resolve_entity(&name) {
                        Some(s) => text.push_str(&s),
                        None => {
                            warnings.add("unknown_entity", None, Some(&format!("&{name};")));
                            text.push_str(&format!("&{name};"));
                        }
                    }
                }
                Event::End(_) => {
                    let name = path.pop().unwrap_or_default();
                    let parent_el = path.last().cloned().unwrap_or_default();
                    let value = std::mem::take(&mut text);
                    if let Some(r) = res.as_mut() {
                        match (parent_el.as_str(), name.as_str()) {
                            ("resource", "mime") => r.mime = Some(value.trim().to_string()),
                            ("resource-attributes", "file-name") => r.file_name = Some(value.trim().to_string()),
                            _ => {}
                        }
                    }
                    if let Some(n) = note.as_mut() {
                        match (parent_el.as_str(), name.as_str()) {
                            ("note", "title") => n.title = value.trim().to_string(),
                            ("note", "content") => n.content = value,
                            ("note", "created") => n.created = enex_date(&value),
                            ("note", "updated") => n.updated = enex_date(&value),
                            ("note", "tag") => {
                                let t = value.trim().to_string();
                                if !t.is_empty() && !n.tags.contains(&t) {
                                    n.tags.push(t);
                                }
                            }
                            ("note", "guid") => n.guid = Some(value.trim().to_string()).filter(|g| !g.is_empty()),
                            ("note-attributes", k) => {
                                let v = value.trim();
                                if !v.is_empty() {
                                    let key = match k {
                                        "source-url" | "author" | "latitude" | "longitude" | "altitude" | "place-name"
                                        | "source" | "source-application" | "content-class" | "subject-date"
                                        | "reminder-time" | "reminder-done-time" | "reminder-order" => k.to_string(),
                                        _ => format!("evernote-{k}"),
                                    };
                                    let v = if k.ends_with("-time") || k == "subject-date" { enex_date(v).unwrap_or(v.to_string()) } else { v.to_string() };
                                    n.attrs.push((key, v));
                                }
                            }
                            _ => {}
                        }
                    }
                    if name == "resource" && parent_el == "note" {
                        if let (Some(n), Some(r)) = (note.as_mut(), res.take()) {
                            n.resources.push(r);
                        }
                    }
                    if name == "note" {
                        if let Some(n) = note.take() {
                            index_in_file += 1;
                            let done_bytes = reader.buffer_position();
                            progress(Progress {
                                phase: "scan".into(),
                                done: done_bytes as usize,
                                total: total_size as usize,
                                current: n.title.clone(),
                            });
                            finish_note(n, &folder_path, &stem, &file_label, index_in_file, limits, &mut notes, &mut attachments, &mut warnings, &mut total_bytes);
                        }
                    }
                }
                Event::Eof => break,
                _ => {}
            }
            buf.clear();
        }
        total_bytes += meta.len();
    }
    let name = if files.len() == 1 {
        files[0].file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "Evernote".into())
    } else {
        parent.map(str::to_string).unwrap_or_else(|| "Evernote".into())
    };
    Ok(Model {
        kind: SourceKind::Evernote,
        name,
        root: None,
        folders,
        notes,
        attachments,
        warnings,
        spool: Some(spool),
        total_bytes,
    })
}

#[allow(clippy::too_many_arguments)]
fn finish_note(
    n: NoteBuild,
    folder: &str,
    stem: &str,
    file_label: &str,
    index: usize,
    limits: &Limits,
    notes: &mut Vec<SourceNote>,
    attachments: &mut Vec<SourceAttachment>,
    w: &mut Warnings,
    _total: &mut u64,
) {
    let title = if n.title.trim().is_empty() { "Untitled".to_string() } else { n.title.clone() };
    let key = format!("{file_label}#{index}");
    if n.content_too_large {
        w.add("note_too_large", Some(&key), Some(&title));
        return;
    }
    // Resources → attachments (deduplicated by content across the import).
    let mut media: HashMap<String, (usize, bool, String)> = HashMap::new();
    let mut res_order = Vec::new();
    for r in &n.resources {
        let name = r.file_name.clone().filter(|f| !f.is_empty()).unwrap_or_else(|| {
            let ext = crate::repo::attachments::sanitize_ext("", r.mime.as_deref());
            format!("attachment.{ext}")
        });
        if r.too_large {
            w.add("too_large", Some(&key), Some(&format!("{name} ({} MB)", r.size / (1024 * 1024))));
            continue;
        }
        let (Some(md5), Some(path)) = (r.md5.clone(), r.spooled.clone()) else {
            // Evernote exports zero-byte resources too: nothing to keep.
            w.add(if r.size == 0 && !r.bad { "empty_resource" } else { "unreadable" }, Some(&key), Some(&name));
            continue;
        };
        let is_image = r.mime.as_deref().map(|m| m.starts_with("image/")).unwrap_or(false) || sniff_image(&path);
        let akey = format!("md5:{md5}");
        let idx = match attachments.iter().position(|a| a.key == akey) {
            Some(i) => {
                let _ = fs::remove_file(&path);
                i
            }
            None => {
                attachments.push(SourceAttachment {
                    key: akey,
                    name: name.clone(),
                    mime: r.mime.clone(),
                    size: r.size,
                    data: Some(AttachmentData::Spooled(path)),
                    skipped: false,
                    referenced: true,
                });
                attachments.len() - 1
            }
        };

        media.insert(md5.clone(), (idx, is_image, name));
        res_order.push(md5);
    }

    let mut conv = Converter { key: &key, w, media: &media, used: HashSet::new(), layout_depth: 0, inside: Vec::new() };
    let mut body = conv.convert(&n.content);
    // Resources no en-media points at are still the note's attachments.
    let unused: Vec<&String> = res_order.iter().filter(|h| !conv.used.contains(*h)).collect();
    if !unused.is_empty() {
        let mut seen = HashSet::new();
        let mut lines = vec!["**Attachments**".to_string()];
        for h in unused {
            if !seen.insert(h.clone()) {
                continue;
            }
            let (idx, img, name) = &media[h];
            let label = name.replace(['[', ']'], "_");
            lines.push(if *img { format!("- ![{label}](minotes-att:{idx})") } else { format!("- [{label}](minotes-att:{idx})") });
        }
        body = format!("{}\n\n{}", body.trim_end(), lines.join("\n"));
    }
    let mut properties = Vec::new();
    for (k, v) in &n.attrs {
        if k.starts_with("reminder") {
            w.add("reminder", Some(&key), None);
        }
        properties.push((k.clone(), v.clone()));
    }
    if let Some(c) = &n.created {
        properties.push(("created".into(), c.clone()));
    }
    if let Some(u) = &n.updated {
        properties.push(("updated".into(), u.clone()));
    }
    let blocks = split(&body, SplitMode::Outline).len();
    if blocks > 200 {
        w.add("heavy_clip", Some(&key), Some(&format!("{title} ({blocks} blocks)")));
    }
    let _ = limits;
    let mut h = Sha256::new();
    h.update(title.as_bytes());
    h.update(n.content.as_bytes());
    for t in &n.tags {
        h.update(t.as_bytes());
    }
    for m in &res_order {
        h.update(m.as_bytes());
    }
    let source_ref = match &n.guid {
        Some(g) => g.clone(),
        None => format!("{stem}/{}/{}", n.created.clone().unwrap_or_else(|| index.to_string()), title),
    };
    notes.push(SourceNote {
        key,
        source_ref,
        kind: NoteKind::Note,
        folder: Some(folder.to_string()),
        title,
        created: n.created.clone(),
        modified: n.updated.clone(),
        tags: n.tags.clone(),
        aliases: vec![],
        properties,
        body,
        journal: None,
        guid: n.guid.clone(),
        source_excerpt: n.content.chars().take(3000).collect(),
        source_hash: hex(&h.finalize()),
    });
}

// ── ENML → markdown ──

#[derive(Debug)]
enum Node {
    El { name: String, attrs: Vec<(String, String)>, children: Vec<Node> },
    Text(String),
}

fn attr<'a>(attrs: &'a [(String, String)], k: &str) -> Option<&'a str> {
    attrs.iter().find(|(a, _)| a == k).map(|(_, v)| v.as_str())
}

fn parse_enml(content: &str, w: &mut Warnings, key: &str) -> Vec<Node> {
    let mut reader = Reader::from_str(content);
    {
        let cfg = reader.config_mut();
        cfg.check_end_names = false;
        cfg.trim_text(false);
    }
    // Stack of open elements: (name, attrs, children).
    let mut stack: Vec<(String, Vec<(String, String)>, Vec<Node>)> = vec![(String::new(), vec![], vec![])];
    let mut too_deep = 0usize;
    let read_attrs = |e: &BytesStart| -> Vec<(String, String)> {
        e.attributes()
            .flatten()
            .map(|a| {
                let k = String::from_utf8_lossy(a.key.local_name().as_ref()).to_ascii_lowercase();
                let v = a
                    .unescape_value()
                    .map(|c| c.into_owned())
                    .unwrap_or_else(|_| String::from_utf8_lossy(&a.value).into_owned());
                (k, v)
            })
            .collect()
    };
    loop {
        let ev = match reader.read_event() {
            Ok(e) => e,
            Err(_) => break, // malformed tail: keep what was parsed
        };
        match ev {
            Event::Start(e) => {
                if stack.len() > MAX_DEPTH {
                    too_deep += 1;
                    continue;
                }
                stack.push((local_name(&e), read_attrs(&e), vec![]));
            }
            Event::Empty(e) => {
                let node = Node::El { name: local_name(&e), attrs: read_attrs(&e), children: vec![] };
                stack.last_mut().unwrap().2.push(node);
            }
            Event::End(e) => {
                if too_deep > 0 {
                    too_deep -= 1;
                    continue;
                }
                let name = String::from_utf8_lossy(e.local_name().as_ref()).to_ascii_lowercase();
                // Close up to the matching open element (tolerates bad nesting).
                if let Some(pos) = stack.iter().rposition(|(n, _, _)| *n == name) {
                    if pos == 0 {
                        continue;
                    }
                    while stack.len() > pos {
                        let (n, a, c) = stack.pop().unwrap();
                        stack.last_mut().unwrap().2.push(Node::El { name: n, attrs: a, children: c });
                    }
                }
            }
            Event::Text(t) => {
                let s = t.decode().map(|c| c.into_owned()).unwrap_or_default();
                stack.last_mut().unwrap().2.push(Node::Text(s));
            }
            Event::CData(t) => {
                stack.last_mut().unwrap().2.push(Node::Text(String::from_utf8_lossy(&t).into_owned()));
            }
            Event::GeneralRef(r) => {
                let name = String::from_utf8_lossy(r.as_ref()).to_string();
                let s = match resolve_entity(&name) {
                    Some(s) => s,
                    None => {
                        w.add("unknown_entity", Some(key), Some(&format!("&{name};")));
                        format!("&{name};")
                    }
                };
                stack.last_mut().unwrap().2.push(Node::Text(s));
            }
            Event::Eof => break,
            _ => {}
        }
    }
    while stack.len() > 1 {
        let (n, a, c) = stack.pop().unwrap();
        stack.last_mut().unwrap().2.push(Node::El { name: n, attrs: a, children: c });
    }
    stack.pop().map(|(_, _, c)| c).unwrap_or_default()
}

const TODO_OPEN: char = '\u{E000}';
const TODO_DONE: char = '\u{E001}';

fn is_block(name: &str) -> bool {
    matches!(
        name,
        "en-note" | "div" | "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "ul" | "ol" | "li" | "table" | "blockquote"
            | "pre" | "hr" | "en-crypt" | "center" | "section" | "article" | "header" | "footer" | "figure" | "address"
            | "dl" | "dt" | "dd" | "tbody" | "thead" | "tfoot" | "tr" | "main" | "nav" | "aside"
    )
}

/// Web clips often store pictures as `application/octet-stream`: is the file
/// really an image (PNG, JPEG, GIF, WebP or SVG)? Read from its first bytes.
fn sniff_image(path: &Path) -> bool {
    use std::io::Read;
    let mut head = [0u8; 256];
    let n = fs::File::open(path).and_then(|mut f| f.read(&mut head)).unwrap_or(0);
    let h = &head[..n];
    h.starts_with(b"\x89PNG")
        || h.starts_with(b"\xFF\xD8\xFF")
        || h.starts_with(b"GIF8")
        || (h.len() >= 12 && &h[..4] == b"RIFF" && &h[8..12] == b"WEBP")
        || String::from_utf8_lossy(h).trim_start().starts_with("<svg")
}

/// Split `[label](minotes-att:N)` file links (not images) out of link text.
fn take_file_links(text: &str) -> (String, String) {
    let (mut rest, mut files, mut out) = (text, Vec::new(), String::new());
    while let Some(i) = rest.find("](minotes-att:") {
        let start = rest[..i].rfind('[');
        let end = rest[i..].find(')').map(|e| i + e + 1);
        match (start, end) {
            (Some(st), Some(en)) if !rest[..st].ends_with('!') => {
                out.push_str(&rest[..st]);
                files.push(rest[st..en].to_string());
                rest = &rest[en..];
            }
            (_, Some(en)) => {
                out.push_str(&rest[..en]);
                rest = &rest[en..];
            }
            _ => break,
        }
    }
    out.push_str(rest);
    (out, files.join(" "))
}

/// `## Title` → `Title` (a heading's markdown mark at the start of a line).
fn strip_heading_mark(l: &str) -> &str {
    let t = l.trim_start();
    let n = t.chars().take_while(|c| *c == '#').count();
    if (1..=6).contains(&n) && t[n..].starts_with(' ') {
        t[n + 1..].trim_start()
    } else {
        l
    }
}

/// `**a****b**` → `**a b**`-style join: a run of exactly four stars where a
/// bold run is open is "close + open" of two touching bold runs (links in bold,
/// split elements). Elsewhere (`****1234`, a masked card number) it is text.
fn merge_bold_runs(line: &str) -> String {
    if !line.contains("****") {
        return line.to_string();
    }
    let b = line.as_bytes();
    let (mut out, mut open, mut i) = (String::with_capacity(line.len()), false, 0);
    let mut last = 0;
    while i < b.len() {
        if b[i] == b'*' {
            let j = i + b[i..].iter().take_while(|c| **c == b'*').count();
            match j - i {
                2 | 3 => open = !open,
                4 if open => {
                    out.push_str(&line[last..i]);
                    last = j;
                }
                _ => {}
            }
            i = j;
        } else {
            i += 1;
        }
        if b.get(i).is_some_and(|c| *c == b'\n') {
            open = false;
        }
    }
    out.push_str(&line[last..]);
    out
}

/// A source file read that retries a transient failure. A Windows drive seen
/// from WSL (`/mnt/c`) refuses a read now and then with ENOMEM when memory is
/// tight, and a multi-GB export would otherwise fail at the first one.
struct RetryRead<R>(R);

impl<R: std::io::Read> std::io::Read for RetryRead<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let mut wait = std::time::Duration::from_millis(50);
        for attempt in 0.. {
            match self.0.read(buf) {
                Err(e) if attempt < 8 && is_transient(&e) => {
                    std::thread::sleep(wait);
                    wait = (wait * 2).min(std::time::Duration::from_secs(2));
                }
                other => return other,
            }
        }
        unreachable!()
    }
}

fn is_transient(e: &std::io::Error) -> bool {
    matches!(e.kind(), std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock | std::io::ErrorKind::OutOfMemory)
        || matches!(e.raw_os_error(), Some(4) | Some(11) | Some(12)) // EINTR, EAGAIN, ENOMEM
}

/// Inline elements whose own formatting can be dropped when they wrap blocks.
fn is_wrapper(name: &str) -> bool {
    matches!(
        name,
        "span" | "font" | "u" | "b" | "strong" | "i" | "em" | "small" | "big" | "mark" | "label" | "sup" | "sub" | "s"
            | "strike" | "del" | "ins" | "abbr" | "q" | "cite" | "code"
    )
}

/// Does any descendant of `nodes` start a block?
fn has_block(nodes: &[Node]) -> bool {
    nodes.iter().any(|n| match n {
        Node::El { name, children, .. } => is_block(name) || has_block(children),
        Node::Text(_) => false,
    })
}

/// The cells of a table's rows (`tr` directly or under thead/tbody/tfoot).
fn table_rows(nodes: &[Node]) -> Vec<Vec<&[Node]>> {
    let mut rows = Vec::new();
    for n in nodes {
        if let Node::El { name, children, .. } = n {
            match name.as_str() {
                "tr" => rows.push(
                    children
                        .iter()
                        .filter_map(|c| match c {
                            Node::El { name, children, .. } if name == "td" || name == "th" => Some(children.as_slice()),
                            _ => None,
                        })
                        .collect(),
                ),
                "thead" | "tbody" | "tfoot" => rows.extend(table_rows(children)),
                _ => {}
            }
        }
    }
    rows
}

/// A table used for page layout, not data: a single column, cells holding
/// headings, lists, quotes or rules, or a cell holding a table that is itself
/// layout or several rows long. (Evernote's own tables wrap cell text in <div>s,
/// so plain divs don't count, and a small one-row table in a cell is still data:
/// it is flattened into that cell.)
fn is_layout_table(rows: &[Vec<&[Node]>]) -> bool {
    let cols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
    !rows.is_empty() && (cols <= 1 || heavy_cells(rows))
}

/// Cells with layout content: headings, lists, quotes, rules, or a table that
/// has several rows or layout content of its own.
fn heavy_cells(rows: &[Vec<&[Node]>]) -> bool {
    fn heavy(nodes: &[Node]) -> bool {
        nodes.iter().any(|n| match n {
            Node::El { name, children, .. } if name == "table" => {
                let inner = table_rows(children);
                inner.len() > 1 || heavy_cells(&inner)
            }
            Node::El { name, children, .. } => {
                matches!(name.as_str(), "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "ul" | "ol" | "blockquote" | "hr" | "pre")
                    || heavy(children)
            }
            Node::Text(_) => false,
        })
    }
    rows.iter().flatten().any(|c| heavy(c))
}

struct Converter<'a> {
    key: &'a str,
    w: &'a mut Warnings,
    media: &'a HashMap<String, (usize, bool, String)>,
    used: HashSet<String>,
    /// How many layout tables we are inside (a one-row table there is layout too).
    layout_depth: usize,
    /// Marks (`**`, `*`, `~~`) we are inside: the same mark again is a no-op
    /// (<b>Jan 6<b>th</b></b> is bold once, not `**Jan 6****th****`).
    inside: Vec<&'static str>,
}

/// Link text with stray `[`/`]` removed (they would end the link early) while
/// images inside the link — `![label](target)`, as Evernote web clips wrap
/// pictures in `<a>` — are kept whole, so their attachment is still found.
fn link_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("![") {
        out.extend(rest[..i].chars().filter(|c| *c != '[' && *c != ']'));
        let after = &rest[i + 2..];
        let img = after.find(']').filter(|&j| !after[..j].contains('[')).and_then(|j| {
            let tail = &after[j + 1..];
            tail.strip_prefix('(').and_then(|t| t.find(')')).map(|k| j + 1 + k + 2)
        });
        match img {
            Some(end) => {
                out.push_str(&rest[i..i + 2 + end]);
                rest = &rest[i + 2 + end..];
            }
            None => {
                out.push('!');
                rest = &rest[i + 2..];
            }
        }
    }
    out.extend(rest.chars().filter(|c| *c != '[' && *c != ']'));
    out
}

impl Converter<'_> {
    fn convert(&mut self, content: &str) -> String {
        let nodes = parse_enml(content, self.w, self.key);
        let mut lines: Vec<String> = Vec::new();
        self.blocks(&nodes, &mut lines, 0);
        // Fix up to-do markers: a line that starts with one becomes `- [ ] …`.
        let mut out: Vec<String> = Vec::new();
        for l in lines {
            let indent_len = l.len() - l.trim_start().len();
            let (ind, rest) = l.split_at(indent_len);
            let rest = if let Some(r) = rest.strip_prefix("- ").filter(|r| r.starts_with([TODO_OPEN, TODO_DONE])) {
                r.to_string()
            } else {
                rest.to_string()
            };
            let fixed = if rest.starts_with(TODO_OPEN) || rest.starts_with(TODO_DONE) {
                let done = rest.starts_with(TODO_DONE);
                let body = rest[TODO_OPEN.len_utf8()..].trim_start();
                format!("{ind}- [{}] {body}", if done { "x" } else { " " })
            } else {
                format!("{ind}{rest}")
            };
            out.push(fixed.replace(TODO_OPEN, "[ ] ").replace(TODO_DONE, "[x] "));
        }
        // Collapse runs of blank lines.
        let mut res = String::new();
        let mut blank = true;
        for l in out {
            let is_blank = l.trim().is_empty();
            if is_blank && blank {
                continue;
            }
            res.push_str(l.trim_end());
            res.push('\n');
            blank = is_blank;
        }
        res.trim().to_string()
    }

    /// Render `nodes` as block-level lines (prefix: list nesting indent).
    fn blocks(&mut self, nodes: &[Node], out: &mut Vec<String>, indent: usize) {
        let mut line = String::new();
        let mut pending: Option<usize> = None;
        let pad = " ".repeat(indent);
        let flush = |line: &mut String, out: &mut Vec<String>| {
            let merged = merge_bold_runs(line);
            let t = merged.trim();
            if !t.is_empty() {
                for l in t.split('\n') {
                    out.push(format!("{pad}{}", escape_line_start(l.trim())));
                }
            }
            line.clear();
        };
        for (i, n) in nodes.iter().enumerate() {
            match n {
                Node::El { name, attrs, children } if is_block(name) => {
                    flush(&mut line, out);
                    self.block_el(name, attrs, children, out, indent);
                }
                // An inline wrapper around block content (web clips put a <span> or
                // <font> around a whole article) is laid out as blocks, as a browser
                // does — inlining it would run every heading and paragraph into one line.
                Node::El { name, children, .. } if is_wrapper(name) && has_block(children) => {
                    flush(&mut line, out);
                    self.blocks(children, out, indent);
                }
                Node::El { name, attrs, .. } if name == "en-media" && self.is_lone_media(nodes) => {
                    flush(&mut line, out);
                    let m = self.media_md(attrs);
                    out.push(format!("{pad}{m}"));
                }
                _ => {
                    // Consecutive inline nodes go through inline() together, so
                    // neighbouring bold runs merge.
                    if pending.is_none() {
                        pending = Some(i);
                    }
                    let next_inline = nodes.get(i + 1).is_some_and(|m| match m {
                        Node::El { name, children, .. } => {
                            !(is_block(name) || (is_wrapper(name) && has_block(children)) || (name == "en-media" && self.is_lone_media(nodes)))
                        }
                        Node::Text(_) => true,
                    });
                    if !next_inline {
                        let from = pending.take().unwrap();
                        line.push_str(&self.inline(&nodes[from..=i]));
                    }
                }
            }
        }
        flush(&mut line, out);
    }

    fn is_lone_media(&self, siblings: &[Node]) -> bool {
        siblings.iter().filter(|n| !matches!(n, Node::Text(t) if t.trim().is_empty())).count() == 1
    }

    fn block_el(&mut self, name: &str, attrs: &[(String, String)], children: &[Node], out: &mut Vec<String>, indent: usize) {
        let pad = " ".repeat(indent);
        match name {
            "en-note" | "center" | "section" | "article" | "header" | "footer" | "figure" | "address" | "main" | "nav"
            | "aside" | "tbody" | "thead" | "tfoot" | "dl" => self.blocks(children, out, indent),
            "div" | "dt" | "dd" => {
                let only_br = children.iter().all(|c| match c {
                    Node::El { name, .. } => name == "br",
                    Node::Text(t) => t.trim().is_empty(),
                });
                if only_br {
                    out.push(String::new());
                } else {
                    self.blocks(children, out, indent);
                }
            }
            "p" => {
                out.push(String::new());
                self.blocks(children, out, indent);
                out.push(String::new());
            }
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                let level = (name.as_bytes()[1] - b'0') as usize;
                let text = crate::import::text::collapse_ws(&self.inline(children));
                // A page that shows its own markdown ("<h2>## Title</h2>").
                let text = strip_heading_mark(&text).to_string();
                out.push(String::new());
                if !text.is_empty() {
                    out.push(format!("{pad}{} {text}", "#".repeat(level.min(4))));
                }
                out.push(String::new());
            }
            "ul" | "ol" => {
                let mut n = 0;
                for c in children {
                    if let Node::El { name: cn, children: cc, .. } = c {
                        if cn == "li" {
                            n += 1;
                            let marker = if name == "ol" { format!("{n}.") } else { "-".into() };
                            self.list_item(&marker, cc, out, indent);
                            continue;
                        }
                        if cn == "ul" || cn == "ol" {
                            self.block_el(cn, &[], children_of(c), out, indent + 2);
                            continue;
                        }
                    }
                    let t = crate::import::text::collapse_ws(&self.inline(std::slice::from_ref(c)));
                    if !t.is_empty() {
                        out.push(format!("{pad}- {t}"));
                    }
                }
            }
            "li" => self.list_item("-", children, out, indent),
            "table" => self.table(children, out, indent),
            "tr" => self.table(std::slice::from_ref(&Node::El { name: "tr".into(), attrs: attrs.to_vec(), children: Vec::new() }), out, indent),
            "blockquote" => {
                let mut inner = Vec::new();
                self.blocks(children, &mut inner, 0);
                // Layout-heavy mail leaves runs of empty lines: keep one.
                inner.dedup_by(|a, b| a.trim().is_empty() && b.trim().is_empty());
                while inner.first().is_some_and(|l| l.trim().is_empty()) {
                    inner.remove(0);
                }
                while inner.last().is_some_and(|l| l.trim().is_empty()) {
                    inner.pop();
                }
                out.push(String::new());
                for l in inner {
                    out.push(if l.is_empty() { format!("{pad}>") } else { format!("{pad}> {l}") });
                }
                out.push(String::new());
            }
            "pre" => {
                let raw = raw_text(children);
                out.push(String::new());
                out.push(format!("{pad}```"));
                for l in raw.trim_matches('\n').split('\n') {
                    out.push(format!("{pad}{l}"));
                }
                out.push(format!("{pad}```"));
                out.push(String::new());
            }
            "hr" => {
                out.push(String::new());
                out.push(format!("{pad}---"));
                out.push(String::new());
            }
            "en-crypt" => {
                self.w.add("en_crypt", Some(self.key), None);
                let hint = attr(attrs, "hint").unwrap_or("");
                let cipher = attr(attrs, "cipher").unwrap_or("RC2");
                out.push(String::new());
                out.push(format!("{pad}**Encrypted Evernote text — not imported**"));
                out.push(String::new());
                out.push(format!("{pad}```en-crypt cipher={cipher}{}", if hint.is_empty() { String::new() } else { format!(" hint={}", hint.replace(['\n', '`'], " ")) }));
                out.push(format!("{pad}{}", raw_text(children).trim()));
                out.push(format!("{pad}```"));
                out.push(String::new());
            }
            _ => self.blocks(children, out, indent),
        }
    }

    fn list_item(&mut self, marker: &str, children: &[Node], out: &mut Vec<String>, indent: usize) {
        let pad = " ".repeat(indent);
        // Inline part (up to the first nested list / block), then nested blocks.
        let mut inline_nodes = Vec::new();
        let mut rest_start = children.len();
        for (i, c) in children.iter().enumerate() {
            if let Node::El { name, .. } = c {
                if matches!(name.as_str(), "ul" | "ol" | "table" | "blockquote" | "pre") {
                    rest_start = i;
                    break;
                }
            }
            inline_nodes.push(i);
        }
        let mut text = String::new();
        for i in inline_nodes {
            let c = &children[i];
            match c {
                Node::El { name, children: cc, .. } if name == "div" || name == "p" => {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(&self.inline(cc));
                }
                // A heading in a list item: its own line, bold.
                Node::El { name, children: cc, .. } if matches!(name.as_str(), "h1" | "h2" | "h3" | "h4" | "h5" | "h6") => {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(&self.wrap("**", cc));
                    text.push('\n');
                }
                _ => text.push_str(&self.inline(std::slice::from_ref(c))),
            }
        }
        let text = text.split('\n').map(crate::import::text::collapse_ws).filter(|l| !l.is_empty()).collect::<Vec<_>>();
        let first = text.first().cloned().unwrap_or_default();
        out.push(format!("{pad}{marker} {first}"));
        for l in text.iter().skip(1) {
            out.push(format!("{pad}{}{l}", " ".repeat(marker.len() + 1)));
        }
        for c in &children[rest_start..] {
            if let Node::El { name, attrs, children: cc } = c {
                self.block_el(name, attrs, cc, out, indent + marker.len() + 1);
            }
        }
    }

    fn table(&mut self, children: &[Node], out: &mut Vec<String>, indent: usize) {
        // HTML email (and some web clips) positions everything with tables: a
        // markdown table of that is a wall of `| --- |`. Lay its cells out as
        // ordinary blocks instead; real data tables inside it stay tables.
        let rows = table_rows(children);
        if is_layout_table(&rows) || (self.layout_depth > 0 && rows.len() <= 1) {
            self.w.add("layout_table", Some(self.key), None);
            self.layout_depth += 1;
            for row in rows {
                for cell in row {
                    self.blocks(cell, out, indent);
                }
            }
            self.layout_depth -= 1;
            return;
        }
        let pad = " ".repeat(indent);
        let mut rows: Vec<Vec<String>> = Vec::new();
        let collect_rows = |nodes: &[Node], rows: &mut Vec<Vec<String>>, this: &mut Self| {
            fn walk(nodes: &[Node], rows: &mut Vec<Vec<String>>, this: &mut Converter) {
                for n in nodes {
                    if let Node::El { name, children, .. } = n {
                        match name.as_str() {
                            "tr" => {
                                let mut cells = Vec::new();
                                for c in children {
                                    if let Node::El { name: cn, children: cc, .. } = c {
                                        if cn == "td" || cn == "th" {
                                            if contains(cc, "table") {
                                                this.w.add("nested_table", Some(this.key), None);
                                            }
                                            let t = crate::import::text::collapse_ws(&this.inline(cc)).replace('|', "\\|");
                                            cells.push(t);
                                        }
                                    }
                                }
                                rows.push(cells);
                            }
                            "thead" | "tbody" | "tfoot" => walk(children, rows, this),
                            _ => {}
                        }
                    }
                }
            }
            walk(nodes, rows, this);
        };
        collect_rows(children, &mut rows, self);
        // A row of empty cells (spacers in mail and web tables) is no data.
        rows.retain(|r| r.iter().any(|c| !c.trim().is_empty()));
        if rows.is_empty() {
            return;
        }
        let cols = rows.iter().map(|r| r.len()).max().unwrap_or(1).max(1);
        out.push(String::new());
        for (i, r) in rows.iter().enumerate() {
            let mut cells = r.clone();
            cells.resize(cols, String::new());
            out.push(format!("{pad}| {} |", cells.join(" | ")));
            if i == 0 {
                out.push(format!("{pad}|{}", " --- |".repeat(cols)));
            }
        }
        out.push(String::new());
    }

    fn media_md(&mut self, attrs: &[(String, String)]) -> String {
        let hash = attr(attrs, "hash").unwrap_or("").to_ascii_lowercase();
        match self.media.get(&hash) {
            Some((idx, img, name)) => {
                self.used.insert(hash.clone());
                let label = name.replace(['[', ']'], "_");
                if *img {
                    format!("![{label}](minotes-att:{idx})")
                } else {
                    format!("[{label}](minotes-att:{idx})")
                }
            }
            None => {
                self.w.add("missing_resource", Some(self.key), Some(&hash));
                format!("[missing attachment {hash}]")
            }
        }
    }

    /// Inline markdown for `nodes` (whitespace collapsed, `<br>` → newline).
    fn inline(&mut self, nodes: &[Node]) -> String {
        let mut s = String::new();
        let mut bold_ended = false;
        for n in nodes {
            match n {
                Node::Text(t) => {
                    let mut collapsed = String::with_capacity(t.len());
                    let mut ws = false;
                    for c in t.chars() {
                        if c.is_whitespace() && c != '\u{a0}' {
                            if !ws {
                                collapsed.push(' ');
                            }
                            ws = true;
                        } else {
                            collapsed.push(c);
                            ws = false;
                        }
                    }
                    s.push_str(&collapsed);
                }
                Node::El { name, attrs, children } => {
                    let piece = self.inline_el(name, attrs, children);
                    // <b>a</b><b>b</b> is one bold run, not `**a****b**`.
                    if matches!(name.as_str(), "b" | "strong") && piece.starts_with("**") && s.ends_with("**") && bold_ended {
                        s.truncate(s.len() - 2);
                        s.push_str(&piece[2..]);
                    } else {
                        s.push_str(&piece);
                    }
                    bold_ended = matches!(name.as_str(), "b" | "strong") && piece.ends_with("**");
                    continue;
                }
            }
            bold_ended = false;
        }
        s
    }

    /// [`Self::wrap`], unless already inside `mark`.
    fn mark(&mut self, mark: &'static str, children: &[Node]) -> String {
        if self.inside.contains(&mark) {
            return self.inline(children);
        }
        self.inside.push(mark);
        let s = self.wrap(mark, children);
        self.inside.pop();
        s
    }

    fn wrap(&mut self, mark: &str, children: &[Node]) -> String {
        let inner = self.inline(children);
        let t = inner.trim();
        if t.is_empty() {
            return inner;
        }
        let lead = if inner.starts_with(' ') { " " } else { "" };
        let trail = if inner.ends_with(' ') { " " } else { "" };
        // <b><strong>x</strong></b> (common in forwarded mail) is bold once,
        // not `****x****`.
        if t.len() > 2 * mark.len() && t.starts_with(mark) && t.ends_with(mark) && !t[mark.len()..t.len() - mark.len()].contains(mark) {
            return format!("{lead}{t}{trail}");
        }
        format!("{lead}{mark}{t}{mark}{trail}")
    }

    fn inline_el(&mut self, name: &str, attrs: &[(String, String)], children: &[Node]) -> String {
        match name {
            "br" => "\n".into(),
            "en-todo" => {
                let checked = attr(attrs, "checked").map(|v| v == "true").unwrap_or(false);
                (if checked { TODO_DONE } else { TODO_OPEN }).to_string()
            }
            "en-media" => self.media_md(attrs),
            "b" | "strong" => self.mark("**", children),
            "i" | "em" | "cite" => self.mark("*", children),
            "s" | "strike" | "del" => self.mark("~~", children),
            "code" | "tt" | "kbd" | "samp" => {
                let t = raw_text(children);
                if t.contains('`') {
                    format!("`` {t} ``")
                } else if t.is_empty() {
                    String::new()
                } else {
                    format!("`{t}`")
                }
            }
            "a" => {
                let href = attr(attrs, "href").unwrap_or("").trim().to_string();
                let text = crate::import::text::collapse_ws(&self.inline(children));
                let lower = href.to_ascii_lowercase();
                if href.is_empty() || lower.starts_with("javascript:") || lower.starts_with("vbscript:") || lower.starts_with("data:") {
                    return text;
                }
                let href = href.replace(' ', "%20").replace(')', "%29").replace('(', "%28");
                if text.is_empty() {
                    // An empty <a> shows nothing in a browser (Outlook writes one
                    // before every real link); don't turn it into a bare URL.
                    String::new()
                } else {
                {
                    // A file attachment can't sit inside a link: put it after it.
                    let (text, files) = take_file_links(&text);
                    let text = text.trim();
                    let link = if text.is_empty() { String::new() } else { format!("[{}]({href})", link_text(text)) };
                    [link, files].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" ")
                }
                }
            }
            "img" => {
                let src = attr(attrs, "src").unwrap_or("");
                let alt = attr(attrs, "alt").unwrap_or("image");
                if src.starts_with("http://") || src.starts_with("https://") {
                    format!("![{}]({})", alt.replace(['[', ']'], ""), src.replace(' ', "%20"))
                } else {
                    self.w.add("unsupported_element", Some(self.key), Some("img"));
                    String::new()
                }
            }
            "span" | "font" | "u" | "sup" | "sub" | "small" | "big" | "abbr" | "q" | "mark" | "label" => {
                let style = attr(attrs, "style").unwrap_or("").to_ascii_lowercase().replace(' ', "");
                let highlighted = name == "mark"
                    || style.contains("--en-highlight")
                    || (style.contains("background-color:") && !style.contains("background-color:transparent")
                        && !style.contains("background-color:rgb(255,255,255)") && !style.contains("background-color:#fff")
                        && !style.contains("background-color:white"));
                let mut s = self.inline(children);
                if style.contains("font-weight:bold") || style.contains("font-weight:700") {
                    s = wrap_str("**", &s);
                }
                if style.contains("font-style:italic") {
                    s = wrap_str("*", &s);
                }
                if style.contains("line-through") {
                    s = wrap_str("~~", &s);
                }
                if highlighted {
                    s = wrap_str("==", &s);
                }
                s
            }
            "script" | "style" | "object" | "embed" | "iframe" | "applet" | "form" | "input" | "button" | "select"
            | "textarea" | "map" | "area" | "svg" | "canvas" | "video" | "audio" => {
                self.w.add("unsupported_element", Some(self.key), Some(name));
                if matches!(name, "script" | "style") {
                    String::new()
                } else {
                    self.inline(children)
                }
            }
            // A nested table (inside a cell): flattened to its cell texts.
            "table" => {
                fn cells(nodes: &[Node], c: &mut Converter, out: &mut Vec<String>) {
                    for n in nodes {
                        if let Node::El { name, children, .. } = n {
                            if name == "td" || name == "th" {
                                let t = crate::import::text::collapse_ws(&c.inline(children));
                                if !t.is_empty() {
                                    out.push(t);
                                }
                            } else {
                                cells(children, c, out);
                            }
                        }
                    }
                }
                let mut v = Vec::new();
                cells(children, self, &mut v);
                format!(" {} ", v.join(" "))
            }
            // A block element in inline context (e.g. inside a table cell).
            _ if is_block(name) => {
                let mut lines = Vec::new();
                self.block_el(name, attrs, children, &mut lines, 0);
                // Inside a line (a link, a cell) a heading can't be one: keep its text.
                let lines: Vec<String> = lines
                    .into_iter()
                    .map(|l| strip_heading_mark(&l).to_string())
                    .filter(|l| !l.trim().is_empty())
                    .collect();
                format!(" {} ", lines.join(" "))
            }
            _ => self.inline(children),
        }
    }
}

fn wrap_str(mark: &str, s: &str) -> String {
    let t = s.trim();
    if t.is_empty() {
        return s.to_string();
    }
    let lead = if s.starts_with(' ') { " " } else { "" };
    let trail = if s.ends_with(' ') { " " } else { "" };
    format!("{lead}{mark}{t}{mark}{trail}")
}

fn children_of(n: &Node) -> &[Node] {
    match n {
        Node::El { children, .. } => children,
        Node::Text(_) => &[],
    }
}

fn contains(nodes: &[Node], tag: &str) -> bool {
    nodes.iter().any(|n| match n {
        Node::El { name, children, .. } => name == tag || contains(children, tag),
        Node::Text(_) => false,
    })
}

fn raw_text(nodes: &[Node]) -> String {
    let mut s = String::new();
    for n in nodes {
        match n {
            Node::Text(t) => s.push_str(t),
            Node::El { name, children, .. } => {
                if name == "br" {
                    s.push('\n');
                } else {
                    s.push_str(&raw_text(children));
                    if name == "div" || name == "p" {
                        s.push('\n');
                    }
                }
            }
        }
    }
    s
}

/// Keep text that merely looks like markdown structure at a line start literal.
fn escape_line_start(l: &str) -> String {
    if l.starts_with(TODO_OPEN) || l.starts_with(TODO_DONE) {
        return l.to_string();
    }
    let needs = l.starts_with('#')
        || l.starts_with('>')
        || l.starts_with("- ")
        || l.starts_with("* ")
        || l.starts_with("+ ")
        || l.starts_with('|')
        || l.starts_with("```")
        || {
            let d = l.chars().take_while(|c| c.is_ascii_digit()).count();
            d > 0 && l[d..].starts_with(". ")
        };
    if needs {
        format!("\\{l}")
    } else {
        l.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conv(enml: &str, media: &HashMap<String, (usize, bool, String)>) -> (String, Warnings) {
        let mut w = Warnings::default();
        let mut c = Converter { key: "k", w: &mut w, media, used: HashSet::new(), layout_depth: 0, inside: Vec::new() };
        let s = c.convert(enml);
        (s, w)
    }

    #[test]
    fn enml_rules() {
        let mut media = HashMap::new();
        media.insert("abc".to_string(), (0usize, true, "pic.png".to_string()));
        let enml = r#"<?xml version="1.0"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note><div><b>Bold</b> and <i>it</i>&nbsp;x</div><div><en-todo checked="true"/>Done task</div><div><en-todo/>Open task</div><ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul><div><en-media hash="abc" type="image/png"/></div><div><en-media hash="nope" type="image/png"/></div><h2>Head</h2><table><tr><td>a</td><td>b|c</td></tr><tr><td>1</td><td><table><tr><td>in</td></tr></table></td></tr></table><div><span style="background-color: rgb(255, 250, 165);">hi</span> <a href="https://x.y">link</a> <a href="javascript:alert(1)">bad</a></div><en-crypt hint="pw" cipher="AES">QUJD</en-crypt><div># not heading</div><div><br/></div><pre>code  line
two</pre><hr/></en-note>"#;
        let (md, w) = conv(enml, &media);
        let expected = "**Bold** and *it*\u{a0}x\n- [x] Done task\n- [ ] Open task\n- one\n- two\n  - nested\n![pic.png](minotes-att:0)\n[missing attachment nope]\n\n## Head\n\n| a | b\\|c |\n| --- | --- |\n| 1 | in |\n\n==hi== [link](https://x.y) bad\n\n**Encrypted Evernote text — not imported**\n\n```en-crypt cipher=AES hint=pw\nQUJD\n```\n\n\\# not heading\n\n```\ncode  line\ntwo\n```\n\n---";
        assert_eq!(md, expected, "full:\n{md}");
        assert_eq!(w.count("missing_resource"), 1);
        assert_eq!(w.count("nested_table"), 1);
        assert_eq!(w.count("en_crypt"), 1);
    }

    /// Web clips wrap pictures in links: the image (and so its attachment) must
    /// survive inside the link, while stray brackets in link text still go.
    #[test]
    fn image_inside_a_link_keeps_its_attachment() {
        let mut media = HashMap::new();
        media.insert("abc".to_string(), (3usize, true, "hotel [1].jpg".to_string()));
        let (md, w) = conv(
            r#"<en-note><div><a href="https://h.example/x?a=1">[Book] <en-media hash="abc" type="image/jpeg"/> now</a></div><div><a href="https://h.example/y"><img src="https://h.example/p.png" alt="p"/></a></div></en-note>"#,
            &media,
        );
        assert!(md.contains("[Book ![hotel _1_.jpg](minotes-att:3) now](https://h.example/x?a=1)"), "{md}");
        assert!(md.contains("[![p](https://h.example/p.png)](https://h.example/y)"), "{md}");
        assert_eq!(w.count("missing_resource"), 0);
        assert_eq!(link_text("a [b] ![c](d) e]"), "a b ![c](d) e");
        assert_eq!(link_text("![unclosed"), "!unclosed");
    }

    /// A web clip wraps the whole article in a <span>: its headings and
    /// paragraphs must still become separate lines, not one run-on paragraph.
    #[test]
    fn span_around_blocks_keeps_the_structure() {
        let (md, _) = conv(
            r#"<en-note><div><span style="x"><div><h1>Title</h1><div>Intro <b>bold</b></div><p>Para</p><h3>Sub</h3></div></span></div><div><span>plain</span> text</div></en-note>"#,
            &HashMap::new(),
        );
        assert_eq!(md, "# Title\n\nIntro **bold**\n\nPara\n\n### Sub\n\nplain text", "full:\n{md}");
    }

    #[test]
    fn nested_bold_is_bold_once() {
        let (md, _) = conv("<en-note><div><b><strong>From:</strong></b> x <b>a <b>b</b> c</b></div></en-note>", &HashMap::new());
        assert_eq!(md, "**From:** x **a b c**", "{md}");
    }

    /// HTML email lays everything out with tables: the cells become ordinary
    /// lines, while a real data table inside stays a table.
    #[test]
    fn layout_tables_become_blocks() {
        let (md, w) = conv(
            r#"<en-note><table><tr><td><table><tr><td><b>Hotels.com</b></td></tr><tr><td><a href="https://h.example/r">Print receipt</a></td></tr></table></td></tr><tr><td><div>Dear guest,</div><table><tr><th>Night</th><th>Price</th></tr><tr><td>1</td><td>$90</td></tr></table></td></tr></table></en-note>"#,
            &HashMap::new(),
        );
        assert_eq!(md, "**Hotels.com**\n[Print receipt](https://h.example/r)\nDear guest,\n\n| Night | Price |\n| --- | --- |\n| 1 | $90 |", "full:\n{md}");
        assert!(w.count("layout_table") >= 1);
        // Inside layout, a one-row "icon | text" table is layout too; an empty
        // Outlook <a> adds nothing; empty quote lines collapse to one.
        let (md, _) = conv(
            r#"<en-note><blockquote><div><br/></div><div><br/></div><table><tr><td><table><tr><td><a href="https://x.example"></a><a href="https://x.example">Go</a></td><td>paperless</td></tr></table></td></tr></table><div><br/></div><div><br/></div><div>end</div></blockquote></en-note>"#,
            &HashMap::new(),
        );
        assert_eq!(md, "> [Go](https://x.example)\n> paperless\n>\n> end", "full:\n{md}");
        // Evernote's own table (div-wrapped cells, two columns) stays a table.
        let (md, _) = conv("<en-note><table><tr><td><div>a</div></td><td><div>b</div></td></tr><tr><td> </td><td></td></tr></table></en-note>", &HashMap::new());
        assert_eq!(md, "| a | b |\n| --- | --- |", "{md}");
    }

    /// Found importing real exports: neighbouring bold runs, headings inside
    /// links and list items, a file inside a link, masked card numbers.
    #[test]
    fn real_export_cases() {
        let mut media = HashMap::new();
        media.insert("f1".to_string(), (4usize, false, "card.bin".to_string()));
        media.insert("i1".to_string(), (5usize, true, "logo.svg".to_string()));
        let (md, _) = conv(
            r#"<en-note><div><b>May 11, 2017</b><b>:</b> text, card ****1234</div><div><a href="https://n.example/1"><h3>Part 1</h3><h2>States</h2></a></div><ul><li><b>Numbers</b><h3><a href="https://n.example/2">Article</a></h3></li></ul><div><a href="https://g.example"><div>Repo</div><en-media hash="i1" type="image/svg+xml"/><en-media hash="f1" type="application/octet-stream"/></a></div></en-note>"#,
            &media,
        );
        assert!(md.contains("**May 11, 2017:** text, card ****1234"), "{md}");
        assert!(md.contains("[Part 1 States](https://n.example/1)"), "{md}");
        assert!(md.contains("- **Numbers**\n  **[Article](https://n.example/2)**"), "{md}");
        assert!(md.contains("[Repo ![logo.svg](minotes-att:5)](https://g.example) [card.bin](minotes-att:4)"), "{md}");
        assert!(!md.contains("###") && !md.contains("****:"), "{md}");
        assert_eq!(merge_bold_runs("**[a](u)****[b](v)** card ****1234 3**********5"), "**[a](u)[b](v)** card ****1234 3**********5");
        let (md, _) = conv("<en-note><h2><span>## </span>Title</h2></en-note>", &HashMap::new());
        assert_eq!(md, "## Title", "{md}");
        let (md, _) = conv("<en-note><div><b>Jan 6<sup><b>th</b></sup>, 2019</b> and <i>a <em>b</em></i></div></en-note>", &HashMap::new());
        assert_eq!(md, "**Jan 6th, 2019** and *a b*", "{md}");
    }

    #[test]
    fn a_transient_read_error_is_retried() {
        use std::io::Read;
        struct Flaky(u32);
        impl Read for Flaky {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if self.0 > 0 {
                    self.0 -= 1;
                    return Err(std::io::Error::from_raw_os_error(12));
                }
                buf[0] = b'x';
                Ok(1)
            }
        }
        let mut b = [0u8; 4];
        assert_eq!(RetryRead(Flaky(3)).read(&mut b).unwrap(), 1);
        assert!(RetryRead(Flaky(50)).read(&mut b).is_err(), "gives up eventually");
    }

    #[test]
    fn octet_stream_pictures_are_images() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("a");
        std::fs::write(&png, b"\x89PNG\r\n\x1a\nrest").unwrap();
        let txt = dir.path().join("b");
        std::fs::write(&txt, b"hello").unwrap();
        assert!(sniff_image(&png));
        assert!(!sniff_image(&txt));
    }

    #[test]
    fn entities_are_never_expanded_from_the_dtd() {
        let (md, w) = conv("<en-note><div>&lol9; &amp; &#65; &copy;</div></en-note>", &HashMap::new());
        assert_eq!(md, "&lol9; & A ©");
        assert_eq!(w.count("unknown_entity"), 1);
    }
}
