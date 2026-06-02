/**
 * Extracts tags from markdown content using heuristics.
 * No external dependencies — pure TypeScript.
 */

export interface TagResult {
  tags: string[];
  confidence: number;
}

/**
 * Extract tags from a single block's content.
 * Recognizes: #tag, #nested/tags, frontmatter tags:, and semantic hints.
 */
export function extractTagsFromBlock(content: string): string[] {
  const tags = new Set<string>();

  // Bug #22: strip code regions before scanning for tags — fenced blocks and inline
  // code routinely contain `#include`, `#define`, CSS ids, etc. that are not tags.
  const withoutCode = content
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`[^`]*`/g, " "); // inline code spans

  // 1. #tag patterns. A real tag is preceded by start-of-string or whitespace (NOT
  //    by ':' or '/' as in `color:#fff` or a URL `...#section`), starts with a
  //    LETTER (so `#123` issue refs and `#2bug` are excluded), and allows
  //    word chars / hyphens / underscores / nested slashes.
  const tagRegex = /(^|\s)#([a-zA-Z][a-zA-Z0-9_-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_-]*)*)/g;
  // Looks like a CSS hex color? Exclude 6/8-digit pure-hex always (virtually never
  // a tag), and 3/4-digit only when it contains a digit (e.g. #f0f) — pure-letter
  // shorts like #fff/#cafe/#beef stay, since those are plausibly real tags.
  const isHexColor = (t: string) => {
    if (/^[0-9a-f]{6}$/i.test(t) || /^[0-9a-f]{8}$/i.test(t)) return true;
    if (/^[0-9a-f]{3,4}$/i.test(t) && /[0-9]/.test(t)) return true;
    return false;
  };
  let match;
  while ((match = tagRegex.exec(withoutCode)) !== null) {
    const tag = match[2].toLowerCase();
    if (isHexColor(tag)) continue; // skip hex colors
    tags.add(tag);
  }

  // 2. Frontmatter-style: tags: tag1, tag2, tag3
  const fmMatch = content.match(/^tags:\s*(.+)$/m);
  if (fmMatch) {
    fmMatch[1]
      .split(/[,;]/)
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0 && !t.startsWith("#"))
      .forEach((t) => tags.add(t));
  }

  return Array.from(tags);
}

/**
 * Extract tags from all blocks of a page.
 * Deduplicates and filters out noise.
 */
export function extractTags(blocks: { content: string }[]): TagResult {
  const allTags = new Map<string, number>();

  for (const block of blocks) {
    const tags = extractTagsFromBlock(block.content);
    for (const tag of tags) {
      allTags.set(tag, (allTags.get(tag) || 0) + 1);
    }
  }

  // Filter: require length ≥ 2. We deliberately do NOT drop common words
  // like "todo" or "note" — those are legitimate user tags and the previous
  // noise list silently swallowed them.
  const filtered = Array.from(allTags.entries())
    .filter(([tag]) => tag.length >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([tag]) => tag);

  // Confidence: higher when more tags are found consistently
  const confidence = filtered.length > 0 ? Math.min(0.95, 0.3 + filtered.length * 0.1) : 0;

  return { tags: filtered, confidence };
}

/**
 * Extract tags from a single string of content.
 */
export function extractTagsFromString(content: string): string[] {
  return extractTags([{ content }]).tags;
}