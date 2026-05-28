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

  // 1. #tag patterns — word chars, hyphens, underscores, slashes
  const tagRegex = /#([a-zA-Z0-9][a-zA-Z0-9_-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_-]*)*)/g;
  let match;
  while ((match = tagRegex.exec(content)) !== null) {
    const tag = match[1].toLowerCase();
    // Skip common non-tags: #TODO, #FIXME, #NOTE as standalone (but keep #project/subtag)
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

  // Filter: require at least 1 occurrence, exclude very short/noise tags
  const noise = new Set(["todo", "fixme", "note", "hack", "temp", "wip"]);
  const filtered = Array.from(allTags.entries())
    .filter(([tag, count]) => tag.length >= 2 && !noise.has(tag))
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