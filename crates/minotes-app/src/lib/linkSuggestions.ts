/**
 * Suggests related pages for wikilinking based on content similarity.
 * No external dependencies — pure TypeScript.
 */

import type { Page, Block } from "./api";

export interface LinkSuggestion {
  pageId: string;
  title: string;
  score: number;
  reason: string;
}

/**
 * Tokenize content into meaningful words.
 */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/\[\[([^\]]+)\]\]/g, "$1") // unwrap wikilinks
      .replace(/[#*`_~>|\-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );
}

/**
 * Extract headings from content.
 */
function extractHeadings(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").trim().toLowerCase())
    .filter((h) => h.length > 0);
}

/**
 * Suggest related pages for a given page.
 * Uses keyword overlap, heading similarity, and wikilink co-occurrence.
 */
export function suggestLinks(
  currentBlocks: Block[],
  allPages: Page[],
  currentPageId: string,
  existingLinks: Set<string>,
): LinkSuggestion[] {
  // Combine all block content for the current page
  const fullContent = currentBlocks.map((b) => b.content).join(" ");
  const currentTokens = tokenize(fullContent);
  const currentHeadings = extractHeadings(fullContent);

  const suggestions: LinkSuggestion[] = [];

  for (const page of allPages) {
    if (page.id === currentPageId) continue;
    if (existingLinks.has(page.title)) continue;

    // Get blocks for this candidate page (caller should pre-fetch)
    // We'll score based on title + available content
    const titleTokens = tokenize(page.title);

    // Score components
    let score = 0;
    let reasons: string[] = [];

    // 1. Title overlap with content tokens
    const titleOverlap = [...titleTokens].filter((t) => currentTokens.has(t));
    if (titleOverlap.length > 0) {
      score += titleOverlap.length * 15;
      reasons.push(`title match: ${titleOverlap.join(", ")}`);
    }

    // 2. Heading overlap
    // (We'd need the candidate page's blocks for this — caller passes them)
    // For now, skip heading scoring without block data

    // 3. Wikilink co-occurrence: if both pages link to the same pages
    // (Requires link data — caller should pre-compute)

    // 4. Common words in content (requires candidate blocks)
    // Skipped without block data

    if (score > 0) {
      suggestions.push({
        pageId: page.id,
        title: page.title,
        score: Math.min(100, score),
        reason: reasons.join(" + "),
      });
    }
  }

  return suggestions
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

/**
 * Full version with candidate page blocks.
 */
export function suggestLinksWithBlocks(
  currentBlocks: Block[],
  candidates: { page: Page; blocks: Block[] }[],
  existingLinks: Set<string>,
): LinkSuggestion[] {
  const fullContent = currentBlocks.map((b) => b.content).join(" ");
  const currentTokens = tokenize(fullContent);
  const currentHeadings = extractHeadings(fullContent);

  const suggestions: LinkSuggestion[] = [];

  for (const { page, blocks } of candidates) {
    if (existingLinks.has(page.title)) continue;

    const candidateContent = blocks.map((b) => b.content).join(" ");
    const candidateTokens = tokenize(candidateContent);
    const candidateHeadings = extractHeadings(candidateContent);

    let score = 0;
    let reasons: string[] = [];

    // Keyword overlap
    const overlap = [...currentTokens].filter((t) => candidateTokens.has(t));
    const overlapRatio = overlap.length / Math.max(currentTokens.size, candidateTokens.size);
    if (overlapRatio > 0.1) {
      score += overlapRatio * 40;
      reasons.push(`${overlap.length} shared keywords`);
    }

    // Heading overlap
    const headingOverlap = currentHeadings.filter((h) =>
      candidateHeadings.some((ch) => ch.includes(h) || h.includes(ch)),
    );
    if (headingOverlap.length > 0) {
      score += headingOverlap.length * 20;
      reasons.push(`shared headings: ${headingOverlap.join(", ")}`);
    }

    // Title match
    const titleTokens = tokenize(page.title);
    const titleHits = [...titleTokens].filter((t) => currentTokens.has(t));
    if (titleHits.length > 0) {
      score += titleHits.length * 15;
      reasons.push(`title match: ${titleHits.join(", ")}`);
    }

    if (score > 10) {
      suggestions.push({
        pageId: page.id,
        title: page.title,
        score: Math.min(100, Math.round(score)),
        reason: reasons.join(" + "),
      });
    }
  }

  return suggestions
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}