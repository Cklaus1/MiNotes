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
                    let title = &content[i + 2..i + 2 + end];
                    let title = title.trim();
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
    fn test_empty_brackets() {
        let links = extract_links("Empty [[]] and (())");
        assert!(links.is_empty());
    }
}
