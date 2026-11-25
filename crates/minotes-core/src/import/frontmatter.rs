//! A small, forgiving YAML-frontmatter reader: the subset Obsidian notes use
//! (scalars, quoted strings, flow and block lists, block scalars). Anything it
//! doesn't understand is kept as text rather than dropped.

#[derive(Debug, Clone, PartialEq)]
pub enum FmValue {
    Str(String),
    List(Vec<String>),
}

impl FmValue {
    /// Values as a list (a scalar is split on commas — `tags: a, b`).
    pub fn items(&self) -> Vec<String> {
        match self {
            FmValue::List(v) => v.clone(),
            FmValue::Str(s) => s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect(),
        }
    }
    /// A single text value (lists joined with ", ").
    pub fn text(&self) -> String {
        match self {
            FmValue::Str(s) => s.clone(),
            FmValue::List(v) => v.join(", "),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Frontmatter {
    pub entries: Vec<(String, FmValue)>,
    /// Lines that weren't `key: value` (kept so nothing is silently lost).
    pub unparsed: Vec<String>,
}

impl Frontmatter {
    pub fn get(&self, key: &str) -> Option<&FmValue> {
        self.entries.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v)
    }
}

/// Split `text` into (frontmatter, body). No frontmatter → `(None, text)`.
pub fn split(text: &str) -> (Option<Frontmatter>, &str) {
    let t = text.strip_prefix('\u{feff}').unwrap_or(text);
    let first_end = t.find('\n').unwrap_or(t.len());
    if t[..first_end].trim_end() != "---" {
        return (None, t);
    }
    let mut pos = first_end + 1;
    let mut lines = Vec::new();
    while pos <= t.len() {
        let end = t[pos..].find('\n').map(|i| pos + i).unwrap_or(t.len());
        let line = t[pos..end].trim_end_matches('\r');
        if line.trim_end() == "---" || line.trim_end() == "..." {
            let body = if end < t.len() { &t[end + 1..] } else { "" };
            return (Some(parse(&lines)), body);
        }
        lines.push(line);
        if end >= t.len() {
            break;
        }
        pos = end + 1;
    }
    (None, t) // unterminated: not frontmatter
}

fn unquote(v: &str) -> String {
    let v = v.trim();
    if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') {
        if let Ok(s) = serde_json::from_str::<String>(v) {
            return s;
        }
        return v[1..v.len() - 1].to_string();
    }
    if v.len() >= 2 && v.starts_with('\'') && v.ends_with('\'') {
        return v[1..v.len() - 1].replace("''", "'");
    }
    v.to_string()
}

/// Strip a trailing ` # comment` from a plain scalar (YAML needs the space).
fn strip_comment(v: &str) -> &str {
    if v.starts_with('"') || v.starts_with('\'') {
        return v;
    }
    match v.find(" #") {
        Some(i) => v[..i].trim_end(),
        None => v,
    }
}

fn flow_list(v: &str) -> Vec<String> {
    let inner = &v[1..v.len() - 1];
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    for c in inner.chars() {
        match (quote, c) {
            (None, '"') | (None, '\'') => {
                quote = Some(c);
                cur.push(c);
            }
            (Some(q), c2) if c2 == q => {
                quote = None;
                cur.push(c2);
            }
            (None, ',') => {
                out.push(unquote(&cur));
                cur.clear();
            }
            _ => cur.push(c),
        }
    }
    if !cur.trim().is_empty() {
        out.push(unquote(&cur));
    }
    out.into_iter().filter(|s| !s.is_empty()).collect()
}

fn indent_of(l: &str) -> usize {
    l.len() - l.trim_start().len()
}

fn parse(lines: &[&str]) -> Frontmatter {
    let mut fm = Frontmatter::default();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            i += 1;
            continue;
        }
        if indent_of(line) > 0 || trimmed.starts_with("- ") || trimmed == "-" {
            fm.unparsed.push(line.to_string());
            i += 1;
            continue;
        }
        let Some((k, v)) = split_key(trimmed) else {
            fm.unparsed.push(line.to_string());
            i += 1;
            continue;
        };
        let key = unquote(k);
        let v = v.trim();
        i += 1;
        let value = if v.is_empty() {
            // Block list / nested map / nothing.
            let mut items = Vec::new();
            let mut nested = Vec::new();
            while i < lines.len() {
                let l = lines[i];
                if l.trim().is_empty() {
                    i += 1;
                    continue;
                }
                let lt = l.trim_start();
                if indent_of(l) == 0 && !lt.starts_with("- ") && lt != "-" {
                    break;
                }
                if let Some(item) = lt.strip_prefix("- ") {
                    items.push(unquote(strip_comment(item.trim())));
                } else if lt != "-" {
                    nested.push(lt.to_string());
                }
                i += 1;
            }
            if !items.is_empty() {
                FmValue::List(items.into_iter().filter(|s| !s.is_empty()).collect())
            } else {
                FmValue::Str(nested.join("; "))
            }
        } else if v == "|" || v == ">" || v.starts_with("|-") || v.starts_with(">-") || v.starts_with("|+") || v.starts_with(">+") {
            let folded = v.starts_with('>');
            let mut parts = Vec::new();
            while i < lines.len() && (lines[i].trim().is_empty() || indent_of(lines[i]) > 0) {
                parts.push(lines[i].trim().to_string());
                i += 1;
            }
            while parts.last().map(|p| p.is_empty()).unwrap_or(false) {
                parts.pop();
            }
            FmValue::Str(if folded { parts.join(" ") } else { parts.join("\n") })
        } else if v.starts_with('[') && v.ends_with(']') {
            FmValue::List(flow_list(v))
        } else {
            FmValue::Str(unquote(strip_comment(v)))
        };
        if !key.is_empty() {
            fm.entries.push((key, value));
        }
    }
    fm
}

/// `key: value` — the colon must be followed by a space or end the line, so
/// `url: https://x` splits at the first `: ` and a bare `a:b` is not a key.
fn split_key(line: &str) -> Option<(&str, &str)> {
    let bytes = line.as_bytes();
    let mut in_quote: Option<u8> = None;
    for (i, &b) in bytes.iter().enumerate() {
        match (in_quote, b) {
            (None, b'"') | (None, b'\'') if i == 0 => in_quote = Some(b),
            (Some(q), c) if c == q => in_quote = None,
            (None, b':') if i + 1 == bytes.len() || bytes[i + 1] == b' ' || bytes[i + 1] == b'\t' => {
                let k = line[..i].trim();
                if k.is_empty() {
                    return None;
                }
                return Some((k, &line[i + 1..]));
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_obsidian_subset() {
        let text = "---\ntitle: \"Real: Title\"\ntags: [alpha, \"beta\"]\naliases:\n  - One\n  - 'Two'\ncssclass: wide # comment\nsummary: |\n  line one\n  line two\nempty:\nurl: https://example.com/a:b\nweird line\n---\nBody here\n";
        let (fm, body) = split(text);
        let fm = fm.unwrap();
        assert_eq!(body, "Body here\n");
        assert_eq!(fm.get("title"), Some(&FmValue::Str("Real: Title".into())));
        assert_eq!(fm.get("tags").unwrap().items(), vec!["alpha", "beta"]);
        assert_eq!(fm.get("aliases").unwrap().items(), vec!["One", "Two"]);
        assert_eq!(fm.get("cssclass").unwrap().text(), "wide");
        assert_eq!(fm.get("summary").unwrap().text(), "line one\nline two");
        assert_eq!(fm.get("url").unwrap().text(), "https://example.com/a:b");
        assert_eq!(fm.get("empty").unwrap().text(), "");
        assert_eq!(fm.unparsed, vec!["weird line".to_string()]);
    }

    #[test]
    fn no_or_unterminated_frontmatter_is_body() {
        assert_eq!(split("# Hi\n").0, None);
        let (fm, body) = split("---\ntitle: x\nno end");
        assert!(fm.is_none());
        assert_eq!(body, "---\ntitle: x\nno end");
        let (fm, body) = split("---\n---\n");
        assert_eq!(fm.unwrap().entries.len(), 0);
        assert_eq!(body, "");
    }
}
