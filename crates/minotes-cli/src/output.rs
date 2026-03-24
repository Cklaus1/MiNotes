use minotes_core::models::{Block, Page, PageTree};
use serde::Serialize;

#[derive(Clone, Default, clap::ValueEnum)]
pub enum Format {
    /// JSON output (default) — for scripting and piping to jq
    #[default]
    Json,
    /// Human-readable text with indentation and icons
    Text,
    /// Raw markdown — suitable for piping to files or other tools
    Md,
    /// CSV — for tabular data (page list, search results)
    Csv,
    /// OPML — for import into other outliners
    Opml,
}

// ── JSON (default) ──

pub fn print_json<T: Serialize>(data: &T) {
    println!("{}", serde_json::to_string_pretty(data).unwrap_or_default());
}

pub fn print_message(msg: &str) {
    println!("{}", serde_json::json!({"message": msg}));
}

pub fn print_error(err: &str) {
    eprintln!("{}", serde_json::json!({"error": err}));
}

// ── Text (human-friendly) ──

pub fn print_page_text(page: &Page) {
    let icon = page.icon.as_deref().unwrap_or(if page.is_journal { "📅" } else { "📄" });
    println!("{} {}", icon, page.title);
    if let Some(date) = &page.journal_date {
        println!("  Date: {}", date);
    }
    println!("  Created: {}", page.created_at.format("%Y-%m-%d %H:%M"));
    println!("  Updated: {}", page.updated_at.format("%Y-%m-%d %H:%M"));
}

pub fn print_page_tree_text(tree: &PageTree) {
    let icon = tree.page.icon.as_deref().unwrap_or(if tree.page.is_journal { "📅" } else { "📄" });
    println!("{} {}", icon, tree.page.title);
    if tree.blocks.is_empty() {
        println!("  (empty)");
        return;
    }
    print_blocks_text(&tree.blocks, None, 1);
}

fn print_blocks_text(blocks: &[Block], parent_id: Option<&uuid::Uuid>, depth: usize) {
    let children: Vec<&Block> = blocks
        .iter()
        .filter(|b| b.parent_id.as_ref() == parent_id)
        .collect();

    for block in children {
        let indent = "  ".repeat(depth);
        let content = block.content.trim();
        if content.is_empty() {
            println!("{}(empty)", indent);
        } else {
            for (i, line) in content.lines().enumerate() {
                if i == 0 {
                    println!("{}{}", indent, line);
                } else {
                    println!("{}  {}", indent, line);
                }
            }
        }
        print_blocks_text(blocks, Some(&block.id), depth + 1);
    }
}

pub fn print_page_list_text(pages: &[Page]) {
    for page in pages {
        let icon = page.icon.as_deref().unwrap_or(if page.is_journal { "📅" } else { "📄" });
        let date = page.updated_at.format("%Y-%m-%d %H:%M");
        println!("{} {:<40} {}", icon, page.title, date);
    }
    println!("\n{} pages", pages.len());
}

pub fn print_search_text(query: &str, results: &[Block]) {
    println!("Search: \"{}\" — {} results\n", query, results.len());
    for block in results {
        let content = block.content.trim();
        let preview = if content.len() > 80 { &content[..80] } else { content };
        println!("  [{}] {}", &block.id.to_string()[..8], preview);
    }
}

pub fn print_block_text(block: &Block) {
    println!("[{}] {}", &block.id.to_string()[..8], block.content.trim());
}

pub fn print_blocks_list_text(blocks: &[Block]) {
    for block in blocks {
        print_block_text(block);
    }
}

// ── Markdown ──

pub fn print_page_tree_md(tree: &PageTree) {
    println!("# {}\n", tree.page.title);
    if tree.blocks.is_empty() {
        return;
    }
    print_blocks_md(&tree.blocks, None, 0);
}

fn print_blocks_md(blocks: &[Block], parent_id: Option<&uuid::Uuid>, depth: usize) {
    let children: Vec<&Block> = blocks
        .iter()
        .filter(|b| b.parent_id.as_ref() == parent_id)
        .collect();

    for block in children {
        let content = block.content.trim();
        if depth == 0 {
            // Root blocks are paragraphs or already-formatted markdown
            if !content.is_empty() {
                println!("{}\n", content);
            }
        } else {
            // Nested blocks as indented list items
            let indent = "  ".repeat(depth - 1);
            if content.is_empty() {
                println!("{}-", indent);
            } else {
                for (i, line) in content.lines().enumerate() {
                    if i == 0 {
                        println!("{}- {}", indent, line);
                    } else {
                        println!("{}  {}", indent, line);
                    }
                }
            }
        }
        print_blocks_md(blocks, Some(&block.id), depth + 1);
    }
}

pub fn print_page_list_md(pages: &[Page]) {
    println!("# Pages\n");
    for page in pages {
        let icon = page.icon.as_deref().unwrap_or(if page.is_journal { "📅" } else { "📄" });
        println!("- {} {}", icon, page.title);
    }
}

pub fn print_search_md(query: &str, results: &[Block]) {
    println!("# Search: \"{}\"\n", query);
    println!("{} results\n", results.len());
    for block in results {
        println!("- {}", block.content.trim());
    }
}

// ── CSV ──

pub fn print_page_list_csv(pages: &[Page]) {
    println!("id,title,is_journal,journal_date,created_at,updated_at");
    for page in pages {
        println!(
            "{},{},{},{},{},{}",
            page.id,
            csv_escape(&page.title),
            page.is_journal,
            page.journal_date.map(|d| d.to_string()).unwrap_or_default(),
            page.created_at.to_rfc3339(),
            page.updated_at.to_rfc3339(),
        );
    }
}

pub fn print_search_csv(results: &[Block]) {
    println!("id,page_id,parent_id,position,content");
    for block in results {
        println!(
            "{},{},{},{},{}",
            block.id,
            block.page_id,
            block.parent_id.map(|p| p.to_string()).unwrap_or_default(),
            block.position,
            csv_escape(&block.content),
        );
    }
}

pub fn print_page_tree_csv(tree: &PageTree) {
    println!("id,parent_id,position,content");
    for block in &tree.blocks {
        println!(
            "{},{},{},{}",
            block.id,
            block.parent_id.map(|p| p.to_string()).unwrap_or_default(),
            block.position,
            csv_escape(&block.content),
        );
    }
}

pub fn print_blocks_list_csv(blocks: &[Block]) {
    println!("id,page_id,parent_id,position,content");
    for block in blocks {
        println!(
            "{},{},{},{},{}",
            block.id,
            block.page_id,
            block.parent_id.map(|p| p.to_string()).unwrap_or_default(),
            block.position,
            csv_escape(&block.content),
        );
    }
}

fn csv_escape(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

// ── OPML ──

pub fn print_page_tree_opml(tree: &PageTree) {
    println!(r#"<?xml version="1.0" encoding="UTF-8"?>"#);
    println!(r#"<opml version="2.0">"#);
    println!(r#"  <head><title>{}</title></head>"#, xml_escape(&tree.page.title));
    println!(r#"  <body>"#);
    print_blocks_opml(&tree.blocks, None, 2);
    println!(r#"  </body>"#);
    println!(r#"</opml>"#);
}

fn print_blocks_opml(blocks: &[Block], parent_id: Option<&uuid::Uuid>, depth: usize) {
    let children: Vec<&Block> = blocks
        .iter()
        .filter(|b| b.parent_id.as_ref() == parent_id)
        .collect();

    let indent = "  ".repeat(depth);
    for block in children {
        let text = xml_escape(block.content.trim());
        let has_children = blocks.iter().any(|b| b.parent_id.as_ref() == Some(&block.id));
        if has_children {
            println!(r#"{}<outline text="{}">"#, indent, text);
            print_blocks_opml(blocks, Some(&block.id), depth + 1);
            println!(r#"{}</outline>"#, indent);
        } else {
            println!(r#"{}<outline text="{}" />"#, indent, text);
        }
    }
}

pub fn print_page_list_opml(pages: &[Page]) {
    println!(r#"<?xml version="1.0" encoding="UTF-8"?>"#);
    println!(r#"<opml version="2.0">"#);
    println!(r#"  <head><title>MiNotes Pages</title></head>"#);
    println!(r#"  <body>"#);
    for page in pages {
        println!(r#"    <outline text="{}" />"#, xml_escape(&page.title));
    }
    println!(r#"  </body>"#);
    println!(r#"</opml>"#);
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
