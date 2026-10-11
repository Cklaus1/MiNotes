//! Text helpers shared by the readers and the resolver: code-aware rewriting
//! and the markdown/wiki link scanners.

/// Apply `f` to every part of `body` that is not code (fenced blocks and inline
/// code spans are copied unchanged).
pub fn map_outside_code(body: &str, f: &mut dyn FnMut(&str) -> String) -> String {
    let mut out = String::with_capacity(body.len() + 16);
    let mut fence: Option<(char, usize)> = None;
    let mut first = true;
    for line in body.split('\n') {
        if !first {
            out.push('\n');
        }
        first = false;
        let t = line.trim_start();
        if let Some((c, n)) = fence {
            out.push_str(line);
            let tt = t.trim_end();
            if tt.chars().take_while(|&x| x == c).count() >= n && tt.chars().all(|x| x == c) {
                fence = None;
            }
            continue;
        }
        if let Some(c) = t.chars().next().filter(|c| *c == '`' || *c == '~') {
            let n = t.chars().take_while(|&x| x == c).count();
            if n >= 3 {
                fence = Some((c, n));
                out.push_str(line);
                continue;
            }
        }
        // Inline code spans: runs of backticks closed by a run of the same length.
        let b = line.as_bytes();
        let mut i = 0;
        let mut seg_start = 0;
        while i < b.len() {
            if b[i] == b'`' {
                let run = b[i..].iter().take_while(|&&x| x == b'`').count();
                let needle = "`".repeat(run);
                if let Some(close) = line[i + run..].find(&needle) {
                    out.push_str(&f(&line[seg_start..i]));
                    let end = i + run + close + run;
                    out.push_str(&line[i..end]);
                    i = end;
                    seg_start = i;
                    continue;
                }
                i += run;
                continue;
            }
            i += 1;
        }
        out.push_str(&f(&line[seg_start..]));
    }
    out
}

/// Every line of `body` with whether it is inside (or delimits) a code fence.
pub fn lines_with_fence(body: &str) -> Vec<(&str, bool, Option<String>)> {
    let mut v = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    let mut lang: Option<String> = None;
    for line in body.split('\n') {
        let t = line.trim_start();
        if let Some((c, n)) = fence {
            let tt = t.trim_end();
            v.push((line, true, lang.clone()));
            if tt.chars().take_while(|&x| x == c).count() >= n && tt.chars().all(|x| x == c) {
                fence = None;
                lang = None;
            }
            continue;
        }
        if let Some(c) = t.chars().next().filter(|c| *c == '`' || *c == '~') {
            let n = t.chars().take_while(|&x| x == c).count();
            if n >= 3 {
                fence = Some((c, n));
                let l = t[n..].trim().split_whitespace().next().unwrap_or("").to_ascii_lowercase();
                lang = (!l.is_empty()).then_some(l);
                v.push((line, true, lang.clone()));
                continue;
            }
        }
        v.push((line, false, None));
    }
    v
}

/// A `[[wiki link]]` found in text.
#[derive(Debug, Clone, PartialEq)]
pub struct WikiLink<'a> {
    pub start: usize,
    pub end: usize,
    pub embed: bool,
    pub target: &'a str,
    pub fragment: Option<&'a str>,
    pub alias: Option<&'a str>,
}

pub fn find_wiki_links(s: &str) -> Vec<WikiLink<'_>> {
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(p) = s[i..].find("[[") {
        let open = i + p;
        let Some(close_rel) = s[open + 2..].find("]]") else { break };
        let inner = &s[open + 2..open + 2 + close_rel];
        let end = open + 2 + close_rel + 2;
        if inner.contains('\n') || inner.contains("[[") {
            i = open + 2;
            continue;
        }
        let embed = open > 0 && s.as_bytes()[open - 1] == b'!';
        let (main, alias) = match inner.split_once('|') {
            Some((m, a)) => (m, Some(a.trim())),
            None => (inner, None),
        };
        let (target, fragment) = match main.split_once('#') {
            Some((t, f)) => (t.trim(), Some(f.trim())),
            None => (main.trim(), None),
        };
        out.push(WikiLink {
            start: if embed { open - 1 } else { open },
            end,
            embed,
            target,
            fragment,
            alias: alias.filter(|a| !a.is_empty()),
        });
        i = end;
    }
    out
}

/// A `[text](url)` / `![alt](url)` found in text.
#[derive(Debug, Clone, PartialEq)]
pub struct MdLink<'a> {
    pub start: usize,
    pub end: usize,
    pub image: bool,
    pub text: &'a str,
    pub url: String,
    pub title: Option<&'a str>,
}

pub fn find_md_links(s: &str) -> Vec<MdLink<'_>> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'[' || (i + 1 < b.len() && b[i + 1] == b'[') || (i > 0 && b[i - 1] == b'[') {
            i += 1;
            continue;
        }
        // Text: up to the matching `]` (one level of nested brackets allowed).
        let mut depth = 0i32;
        let mut j = i + 1;
        let mut close = None;
        while j < b.len() {
            match b[j] {
                b'[' => depth += 1,
                b']' if depth == 0 => {
                    close = Some(j);
                    break;
                }
                b']' => depth -= 1,
                b'\n' => break,
                _ => {}
            }
            j += 1;
        }
        let Some(tc) = close else {
            i += 1;
            continue;
        };
        if tc + 1 >= b.len() || b[tc + 1] != b'(' {
            i = tc + 1;
            continue;
        }
        // Destination: <...> or balanced parens, then an optional "title".
        let mut k = tc + 2;
        while k < b.len() && b[k] == b' ' {
            k += 1;
        }
        let (url, after_url) = if k < b.len() && b[k] == b'<' {
            match s[k + 1..].find('>') {
                Some(e) => (s[k + 1..k + 1 + e].to_string(), k + 1 + e + 1),
                None => {
                    i = tc + 1;
                    continue;
                }
            }
        } else {
            let mut d = 0i32;
            let mut m = k;
            while m < b.len() {
                match b[m] {
                    b'(' => d += 1,
                    b')' if d == 0 => break,
                    b')' => d -= 1,
                    b' ' | b'\n' => break,
                    _ => {}
                }
                m += 1;
            }
            (s[k..m].to_string(), m)
        };
        let mut m = after_url;
        while m < b.len() && b[m] == b' ' {
            m += 1;
        }
        let mut title = None;
        if m < b.len() && (b[m] == b'"' || b[m] == b'\'') {
            let q = b[m] as char;
            if let Some(e) = s[m + 1..].find(q) {
                title = Some(&s[m + 1..m + 1 + e]);
                m = m + 1 + e + 1;
                while m < b.len() && b[m] == b' ' {
                    m += 1;
                }
            }
        }
        if m >= b.len() || b[m] != b')' {
            i = tc + 1;
            continue;
        }
        let image = i > 0 && b[i - 1] == b'!';
        out.push(MdLink {
            start: if image { i - 1 } else { i },
            end: m + 1,
            image,
            text: &s[i + 1..tc],
            url,
            title,
        });
        i = m + 1;
    }
    out
}

/// Does `url` have a scheme (`https:`, `mailto:`, `evernote:` …)?
pub fn has_scheme(url: &str) -> bool {
    let Some(colon) = url.find(':') else { return false };
    let scheme = &url[..colon];
    scheme.len() >= 2
        && scheme.chars().next().map(|c| c.is_ascii_alphabetic()).unwrap_or(false)
        && scheme.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
}

/// Percent-decode a URL path (lossy).
pub fn percent_decode(s: &str) -> String {
    crate::repo::attachments::decode_name(s)
}

/// Lexically resolve `rel` against `base_dir` (both `/`-separated, relative to
/// the source root). `None` if it climbs above the root.
pub fn join_rel(base_dir: &str, rel: &str) -> Option<String> {
    let mut parts: Vec<&str> = if rel.starts_with('/') {
        Vec::new()
    } else {
        base_dir.split('/').filter(|p| !p.is_empty()).collect()
    };
    for p in rel.split('/') {
        match p {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            x => parts.push(x),
        }
    }
    Some(parts.join("/"))
}

/// Collapse whitespace runs (incl. newlines) to single spaces.
pub fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wiki_links_parse() {
        let s = "a [[Note]] b ![[img.png|300]] [[Dir/N#Head|Alias]] [[N#^abc]] [[#Local]]";
        let l = find_wiki_links(s);
        assert_eq!(l.len(), 5);
        assert_eq!((l[0].target, l[0].embed), ("Note", false));
        assert_eq!((l[1].target, l[1].embed, l[1].alias), ("img.png", true, Some("300")));
        assert_eq!((l[2].target, l[2].fragment, l[2].alias), ("Dir/N", Some("Head"), Some("Alias")));
        assert_eq!(l[3].fragment, Some("^abc"));
        assert_eq!(l[4].target, "");
        assert_eq!(&s[l[1].start..l[1].end], "![[img.png|300]]");
    }

    #[test]
    fn md_links_parse() {
        let s = "x ![alt](a%20b.png) [t](<my file.md> \"T\") [u](https://x.y/(z)) [[wiki]] [no]";
        let l = find_md_links(s);
        assert_eq!(l.len(), 3);
        assert!(l[0].image);
        assert_eq!(l[0].url, "a%20b.png");
        assert_eq!((l[1].url.as_str(), l[1].title), ("my file.md", Some("T")));
        assert_eq!(l[2].url, "https://x.y/(z)");
    }

    #[test]
    fn code_is_untouched() {
        let s = "[[a]] `[[b]]` [[c]]\n```\n[[d]]\n```\n[[e]]";
        let out = map_outside_code(s, &mut |t| t.replace("[[", "{{"));
        assert_eq!(out, "{{a]] `[[b]]` {{c]]\n```\n[[d]]\n```\n{{e]]");
    }

    #[test]
    fn join_rel_confines() {
        assert_eq!(join_rel("a/b", "../c.png").as_deref(), Some("a/c.png"));
        assert_eq!(join_rel("a", "./x/./y.md").as_deref(), Some("a/x/y.md"));
        assert_eq!(join_rel("a", "../../etc/passwd"), None);
        assert_eq!(join_rel("", "../x"), None);
    }
}
