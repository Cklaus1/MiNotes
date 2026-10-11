//! Splitting a note (a document) into outliner blocks (PRD-import §4.3).
//!
//! - **Outline** (default): each heading is a block and the content under it
//!   becomes its children; list items become nested blocks following their
//!   indentation; consecutive non-list lines form one paragraph block; code
//!   fences, tables, blockquotes, math blocks and HTML comments are single blocks.
//! - **Paragraph**: one root block per blank-line separated chunk.
//! - **Note**: the whole note is one block (always lossless).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SplitMode {
    #[default]
    Outline,
    Paragraph,
    Note,
}

impl SplitMode {
    pub fn parse(s: &str) -> Option<SplitMode> {
        match s {
            "outline" => Some(SplitMode::Outline),
            "paragraph" | "paragraphs" => Some(SplitMode::Paragraph),
            "note" | "none" | "single" => Some(SplitMode::Note),
            _ => None,
        }
    }
}

/// One block: depth 0 is a root block of the page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OutBlock {
    pub depth: usize,
    pub content: String,
}

pub fn split(body: &str, mode: SplitMode) -> Vec<OutBlock> {
    let body = body.replace("\r\n", "\n").replace('\r', "\n");
    match mode {
        SplitMode::Note => {
            let t = body.trim_matches('\n').trim_end();
            if t.trim().is_empty() {
                vec![]
            } else {
                vec![OutBlock { depth: 0, content: t.to_string() }]
            }
        }
        SplitMode::Paragraph => split_paragraphs(&body),
        SplitMode::Outline => Outliner::default().run(&body),
    }
}

fn fence_marker(line: &str) -> Option<(char, usize)> {
    let t = line.trim_start();
    let c = t.chars().next()?;
    if c != '`' && c != '~' {
        return None;
    }
    let n = t.chars().take_while(|&x| x == c).count();
    (n >= 3).then_some((c, n))
}

fn closes_fence(line: &str, open: (char, usize)) -> bool {
    let t = line.trim();
    t.chars().take_while(|&x| x == open.0).count() >= open.1 && t.chars().all(|x| x == open.0)
}

fn split_paragraphs(body: &str) -> Vec<OutBlock> {
    let mut out = Vec::new();
    let mut cur: Vec<&str> = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    for line in body.split('\n') {
        if let Some(f) = fence {
            cur.push(line);
            if closes_fence(line, f) {
                fence = None;
            }
            continue;
        }
        if let Some(f) = fence_marker(line) {
            fence = Some(f);
            cur.push(line);
            continue;
        }
        if line.trim().is_empty() {
            flush_lines(&mut cur, 0, &mut out);
        } else {
            cur.push(line);
        }
    }
    flush_lines(&mut cur, 0, &mut out);
    out
}

fn flush_lines(cur: &mut Vec<&str>, depth: usize, out: &mut Vec<OutBlock>) {
    let text = cur.join("\n");
    cur.clear();
    let t = text.trim_matches('\n').trim_end();
    if !t.trim().is_empty() {
        out.push(OutBlock { depth, content: dedent(t) });
    }
}

/// Remove the indentation common to every non-blank line.
fn dedent(s: &str) -> String {
    let min = s
        .split('\n')
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.len() - l.trim_start_matches([' ', '\t']).len())
        .min()
        .unwrap_or(0);
    if min == 0 {
        return s.to_string();
    }
    s.split('\n')
        .map(|l| if l.len() >= min && l[..min].trim().is_empty() { &l[min..] } else { l.trim_start() })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Width of the leading whitespace (a tab counts 4).
fn indent_width(line: &str) -> usize {
    let mut w = 0;
    for c in line.chars() {
        match c {
            ' ' => w += 1,
            '\t' => w += 4,
            _ => break,
        }
    }
    w
}

/// `- x`, `* x`, `+ x`, `1. x`, `1) x` → (marker, rest).
fn list_item(line: &str) -> Option<(String, String)> {
    let t = line.trim_start();
    for m in ["- ", "* ", "+ "] {
        if let Some(rest) = t.strip_prefix(m) {
            return Some((m.trim().to_string(), rest.to_string()));
        }
    }
    if matches!(t, "-" | "*" | "+") {
        return Some((t.to_string(), String::new()));
    }
    let digits = t.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits > 0 && digits <= 9 {
        let after = &t[digits..];
        for d in [". ", ") "] {
            if let Some(rest) = after.strip_prefix(d) {
                return Some((format!("{}{}", &t[..digits], d.trim()), rest.to_string()));
            }
        }
    }
    None
}

fn heading(line: &str) -> Option<(usize, &str)> {
    let t = line.trim_start();
    if indent_width(line) > 3 {
        return None;
    }
    let n = t.chars().take_while(|&c| c == '#').count();
    if n == 0 || n > 6 {
        return None;
    }
    let rest = &t[n..];
    if rest.is_empty() {
        return Some((n, ""));
    }
    rest.strip_prefix(' ').or_else(|| rest.strip_prefix('\t')).map(|r| (n, r.trim()))
}

fn is_image_line(t: &str) -> bool {
    if !t.starts_with("![") || !t.ends_with(')') {
        return false;
    }
    let links = crate::import::text::find_md_links(t);
    links.len() == 1 && links[0].image && links[0].start == 0 && links[0].end == t.len()
}

fn is_hr(line: &str) -> bool {
    let t: String = line.trim().chars().filter(|c| !c.is_whitespace()).collect();
    t.len() >= 3 && (t.chars().all(|c| c == '-') || t.chars().all(|c| c == '*') || t.chars().all(|c| c == '_'))
}

#[derive(Default)]
struct Outliner {
    out: Vec<OutBlock>,
    /// (heading level, block depth)
    headings: Vec<(usize, usize)>,
    /// (indent width, block depth, content indent width)
    list: Vec<(usize, usize, usize)>,
    para: Vec<String>,
    para_depth: usize,
    /// Index of the last list-item block (continuation lines append to it).
    last_item: Option<usize>,
    blank_since_item: bool,
}

#[derive(PartialEq)]
enum Multi {
    Fence((char, usize)),
    Table,
    Quote,
    Math,
    Comment,
}

impl Outliner {
    fn base(&self) -> usize {
        self.headings.last().map(|&(_, d)| d + 1).unwrap_or(0)
    }

    fn emit(&mut self, depth: usize, content: String) {
        let t = content.trim_matches('\n').trim_end().to_string();
        if !t.trim().is_empty() {
            self.out.push(OutBlock { depth, content: t });
        }
    }

    fn flush_para(&mut self) {
        if !self.para.is_empty() {
            let text = self.para.join("\n");
            self.para.clear();
            let d = self.para_depth;
            self.emit(d, dedent(&text));
        }
    }

    /// Depth for a nested construct starting at `indent`: under the open list
    /// item if indented into it, else at the heading level (and the list ends).
    fn nested_depth(&mut self, indent: usize) -> usize {
        while let Some(&(li, _, _)) = self.list.last() {
            if indent > li {
                break;
            }
            self.list.pop();
        }
        match self.list.last() {
            Some(&(_, d, _)) => d + 1,
            None => {
                self.last_item = None;
                self.base()
            }
        }
    }

    fn run(mut self, body: &str) -> Vec<OutBlock> {
        let lines: Vec<&str> = body.split('\n').collect();
        let mut i = 0;
        while i < lines.len() {
            let line = lines[i];
            let indent = indent_width(line);
            let trimmed = line.trim();

            // Multi-line constructs: collect, emit as one block.
            let multi = if let Some(f) = fence_marker(line) {
                Some(Multi::Fence(f))
            } else if trimmed.starts_with('|') {
                Some(Multi::Table)
            } else if trimmed.starts_with('>') {
                Some(Multi::Quote)
            } else if trimmed == "$$" || (trimmed.starts_with("$$") && !(trimmed.len() > 4 && trimmed.ends_with("$$"))) {
                Some(Multi::Math)
            } else if trimmed.starts_with("<!--") && !trimmed.contains("-->") {
                Some(Multi::Comment)
            } else {
                None
            };
            if let Some(kind) = multi {
                self.flush_para();
                let depth = self.nested_depth(indent);
                let mut buf = vec![line];
                i += 1;
                match kind {
                    Multi::Fence(f) => {
                        while i < lines.len() {
                            buf.push(lines[i]);
                            i += 1;
                            if closes_fence(buf.last().unwrap(), f) {
                                break;
                            }
                        }
                    }
                    Multi::Table => {
                        while i < lines.len() && lines[i].trim().starts_with('|') {
                            buf.push(lines[i]);
                            i += 1;
                        }
                    }
                    Multi::Quote => {
                        while i < lines.len() && lines[i].trim().starts_with('>') {
                            buf.push(lines[i]);
                            i += 1;
                        }
                    }
                    Multi::Math => {
                        while i < lines.len() {
                            buf.push(lines[i]);
                            i += 1;
                            if buf.last().unwrap().trim().ends_with("$$") {
                                break;
                            }
                        }
                    }
                    Multi::Comment => {
                        while i < lines.len() {
                            buf.push(lines[i]);
                            i += 1;
                            if buf.last().unwrap().contains("-->") {
                                break;
                            }
                        }
                    }
                }
                self.emit(depth, dedent(&buf.join("\n")));
                self.last_item = None;
                self.blank_since_item = false;
                continue;
            }
            i += 1;

            if trimmed.is_empty() {
                self.flush_para();
                self.blank_since_item = true;
                continue;
            }

            if let Some((level, text)) = heading(line) {
                self.flush_para();
                self.list.clear();
                self.last_item = None;
                while let Some(&(l, _)) = self.headings.last() {
                    if l >= level {
                        self.headings.pop();
                    } else {
                        break;
                    }
                }
                let depth = self.base();
                // MiNotes renders heading levels 1–4.
                let shown = level.min(4);
                self.emit(depth, format!("{} {}", "#".repeat(shown), text));
                self.headings.push((level, depth));
                continue;
            }

            if is_hr(line) && indent < 4 {
                self.flush_para();
                let d = self.nested_depth(indent);
                self.emit(d, "---".into());
                self.last_item = None;
                continue;
            }

            if let Some((marker, rest)) = list_item(line) {
                self.flush_para();
                let depth = match self.list.last().copied() {
                    None => self.base(),
                    Some(_) => {
                        // Close deeper (or equally deep) items.
                        let mut d = None;
                        while let Some(&(li, ld, _)) = self.list.last() {
                            if indent > li {
                                d = Some(ld + 1);
                                break;
                            }
                            self.list.pop();
                            if indent == li {
                                d = Some(ld);
                                break;
                            }
                            // indent < li: keep popping to find the matching level
                            d = Some(ld);
                        }
                        d.unwrap_or_else(|| self.base())
                    }
                };
                let content = if matches!(marker.as_str(), "-" | "*" | "+") {
                    let r = rest.trim_end();
                    let lower = r.to_ascii_lowercase();
                    if lower.starts_with("[ ]") || lower.starts_with("[x]") || r.starts_with("[-]") || r.starts_with("[/]") {
                        format!("- {r}")
                    } else {
                        r.to_string()
                    }
                } else {
                    format!("{marker} {}", rest.trim_end())
                };
                let content_indent = indent + marker.len() + 1;
                self.out.push(OutBlock { depth, content });
                self.last_item = Some(self.out.len() - 1);
                self.blank_since_item = false;
                self.list.push((indent, depth, content_indent));
                continue;
            }

            // A line that is just an image becomes its own block.
            if is_image_line(trimmed) {
                self.flush_para();
                let d = if self.list.last().map(|&(li, _, _)| indent > li).unwrap_or(false) {
                    self.list.last().map(|&(_, ld, _)| ld + 1).unwrap()
                } else {
                    self.list.clear();
                    self.last_item = None;
                    self.base()
                };
                self.emit(d, trimmed.to_string());
                continue;
            }

            // Plain text.
            if let Some(&(li, ld, _)) = self.list.last() {
                if indent > li {
                    if let (Some(idx), false) = (self.last_item, self.blank_since_item) {
                        if self.para.is_empty() {
                            // Continuation of the item's own text.
                            let c = &mut self.out[idx].content;
                            c.push('\n');
                            c.push_str(trimmed);
                            continue;
                        }
                    }
                    // A paragraph inside the item.
                    if self.para.is_empty() {
                        self.para_depth = ld + 1;
                    }
                    self.para.push(line.to_string());
                    self.last_item = None;
                    continue;
                }
                // Not indented: the list is over.
                self.list.clear();
                self.last_item = None;
            }
            if self.para.is_empty() {
                self.para_depth = self.base();
            }
            self.para.push(line.to_string());
        }
        self.flush_para();
        self.out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(depth: usize, c: &str) -> OutBlock {
        OutBlock { depth, content: c.into() }
    }

    #[test]
    fn outline_headings_lists_and_paragraphs() {
        let md = "Intro line one\nintro line two\n\n# Top\nUnder top\n\n## Sub\n- a\n  - a1\n    continued\n  - a2\n- [ ] task\n- [x] done\n1. first\n2. second\n\nAfter list\n# Second\n```rust\nfn x() {}\n\n# not a heading\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n> quote\n> more\n";
        let got = split(md, SplitMode::Outline);
        assert_eq!(
            got,
            vec![
                b(0, "Intro line one\nintro line two"),
                b(0, "# Top"),
                b(1, "Under top"),
                b(1, "## Sub"),
                b(2, "a"),
                b(3, "a1\ncontinued"),
                b(3, "a2"),
                b(2, "- [ ] task"),
                b(2, "- [x] done"),
                b(2, "1. first"),
                b(2, "2. second"),
                b(2, "After list"),
                b(0, "# Second"),
                b(1, "```rust\nfn x() {}\n\n# not a heading\n```"),
                b(1, "| a | b |\n|---|---|\n| 1 | 2 |"),
                b(1, "> quote\n> more"),
            ]
        );
    }

    #[test]
    fn deeper_heading_first_and_dedent() {
        let got = split("### Deep\ntext\n# Shallow\n- x\n    - way deeper\n  - mid\n", SplitMode::Outline);
        assert_eq!(
            got,
            vec![b(0, "### Deep"), b(1, "text"), b(0, "# Shallow"), b(1, "x"), b(2, "way deeper"), b(2, "mid")]
        );
    }

    #[test]
    fn paragraph_and_note_modes() {
        let md = "a\nb\n\n```\nx\n\ny\n```\n\nc";
        assert_eq!(split(md, SplitMode::Paragraph), vec![b(0, "a\nb"), b(0, "```\nx\n\ny\n```"), b(0, "c")]);
        assert_eq!(split(md, SplitMode::Note), vec![b(0, md)]);
        assert!(split("  \n\n", SplitMode::Note).is_empty());
    }

    #[test]
    fn list_paragraph_child_and_code_in_item() {
        let md = "- item\n\n  para in item\n  ```\n  code\n  ```\nend";
        assert_eq!(
            split(md, SplitMode::Outline),
            vec![b(0, "item"), b(1, "para in item"), b(1, "```\ncode\n```"), b(0, "end")]
        );
    }
}
