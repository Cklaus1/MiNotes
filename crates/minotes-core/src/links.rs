//! Parse [[wiki links]] and ((block refs)) from markdown content
//! and auto-populate the links table.

use uuid::Uuid;

/// Extracted link from block content.
#[derive(Debug, Clone, PartialEq)]
pub enum ParsedLink {
    /// [[Page Name]] — link to a page by title
    PageLink(String),
    /// ((block-uuid)) — reference to a block by UUID
    BlockRef(Uuid),
}

/// Extract all [[page links]] and ((block refs)) from content.
pub fn extract_links(content: &str) -> Vec<ParsedLink> {
    let mut links = Vec::new();
    let bytes = content.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    while i < len {
        if i + 1 < len {
            // [[Page Name]]
            if bytes[i] == b'[' && bytes[i + 1] == b'[' {
                if let Some(end) = content[i + 2..].find("]]") {
                    let inner = &content[i + 2..i + 2 + end];
                    // `[[Title|alias]]` (and the editor's `[[Title|<page-id>]]`)
                    // target the page named by the part before the pipe.
                    let title = page_link_title(inner);
                    if !title.is_empty() {
                        links.push(ParsedLink::PageLink(title.to_string()));
                    }
                    i += 4 + end;
                    continue;
                }
            }
            // ((block-uuid))
            if bytes[i] == b'(' && bytes[i + 1] == b'(' {
                if let Some(end) = content[i + 2..].find("))") {
                    let ref_str = content[i + 2..i + 2 + end].trim();
                    if let Ok(uuid) = Uuid::parse_str(ref_str) {
                        links.push(ParsedLink::BlockRef(uuid));
                    }
                    i += 4 + end;
                    continue;
                }
            }
        }
        i += 1;
    }

    links
}

/// The target title of a wiki-link's inner text: the part before the first `|`,
/// trimmed. `"Page|alias"` → `"Page"`, `" Page "` → `"Page"`.
pub fn page_link_title(inner: &str) -> &str {
    inner.split('|').next().unwrap_or("").trim()
}

/// Rewrite every `[[old]]` / `[[old|suffix]]` wiki-link (title compared ASCII
/// case-insensitively, like link resolution) to point at `new`, preserving any
/// `|suffix`. Links inside inline code spans and fenced code blocks are left
/// untouched. Returns `None` if nothing changed.
pub fn rewrite_page_links(content: &str, old: &str, new: &str) -> Option<String> {
    let bytes = content.as_bytes();
    let len = bytes.len();
    let mut out = String::with_capacity(content.len());
    let mut i = 0;
    let mut copied = 0; // content[copied..i] not yet pushed
    let mut changed = false;

    while i < len {
        // Fenced code block: skip to the closing fence (or end of content).
        if bytes[i..].starts_with(b"```") {
            let close = content[i + 3..].find("```").map(|p| i + 3 + p + 3).unwrap_or(len);
            i = close;
            continue;
        }
        // Inline code span: skip to the matching backtick if there is one.
        if bytes[i] == b'`' {
            if let Some(p) = content[i + 1..].find('`') {
                i = i + 1 + p + 1;
                continue;
            }
        }
        if bytes[i] == b'[' && i + 1 < len && bytes[i + 1] == b'[' {
            if let Some(end) = content[i + 2..].find("]]") {
                let inner = &content[i + 2..i + 2 + end];
                if page_link_title(inner).eq_ignore_ascii_case(old) {
                    out.push_str(&content[copied..i]);
                    out.push_str("[[");
                    out.push_str(new);
                    if let Some(pipe) = inner.find('|') {
                        out.push_str(&inner[pipe..]);
                    }
                    out.push_str("]]");
                    changed = true;
                    i += 4 + end;
                    copied = i;
                    continue;
                }
                i += 4 + end;
                continue;
            }
        }
        i += 1;
    }
    if !changed {
        return None;
    }
    out.push_str(&content[copied..]);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_page_links() {
        let links = extract_links("See [[Project Alpha]] and [[Research]]");
        assert_eq!(links, vec![
            ParsedLink::PageLink("Project Alpha".into()),
            ParsedLink::PageLink("Research".into()),
        ]);
    }

    #[test]
    fn test_block_refs() {
        let links = extract_links("Ref ((019d1b8c-1ac3-74c3-ad19-6bd01bd5b2a9))");
        assert_eq!(links.len(), 1);
        matches!(&links[0], ParsedLink::BlockRef(_));
    }

    #[test]
    fn test_mixed() {
        let links = extract_links("Link to [[Page]] and ref ((019d1b8c-1ac3-74c3-ad19-6bd01bd5b2a9)) here");
        assert_eq!(links.len(), 2);
    }

    #[test]
    fn test_no_links() {
        let links = extract_links("Just plain text with [single brackets]");
        assert!(links.is_empty());
    }

    #[test]
    fn test_piped_page_link_targets_left_side() {
        let links = extract_links("[[Alpha|shown]] and [[Beta|019d1b8c-1ac3-74c3-ad19-6bd01bd5b2a9]]");
        assert_eq!(links, vec![
            ParsedLink::PageLink("Alpha".into()),
            ParsedLink::PageLink("Beta".into()),
        ]);
    }

    #[test]
    fn test_rewrite_page_links() {
        assert_eq!(
            rewrite_page_links("see [[Old]] and [[old|alias]] not [[Older]]", "Old", "New").as_deref(),
            Some("see [[New]] and [[New|alias]] not [[Older]]")
        );
        assert_eq!(
            rewrite_page_links("`[[Old]]` and\n```\n[[Old]]\n```\n[[Old]]", "Old", "New").as_deref(),
            Some("`[[Old]]` and\n```\n[[Old]]\n```\n[[New]]")
        );
        assert_eq!(rewrite_page_links("no links é", "Old", "New"), None);
        assert_eq!(
            rewrite_page_links("é [[ Émile ]] ü", "Émile", "Zoë").as_deref(),
            Some("é [[Zoë]] ü")
        );
    }

    #[test]
    fn test_empty_brackets() {
        let links = extract_links("Empty [[]] and (())");
        assert!(links.is_empty());
    }
}
