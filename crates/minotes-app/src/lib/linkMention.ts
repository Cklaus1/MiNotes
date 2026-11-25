/**
 * "Link" on an unlinked mention (backlinks panel, UX Wave 4): wrap the first
 * plain-text mention of a page title in `[[ ]]`, keeping the text as written
 * (links resolve case-insensitively). Mentions inside links, refs, macros, code
 * and web addresses are left alone, and only whole words count.
 */

/** Ranges of `content` that must not be rewritten. */
function protectedRanges(content: string): [number, number][] {
  const out: [number, number][] = [];
  const res = [
    /```[\s\S]*?(```|$)/g, // fenced code
    /`[^`\n]*`/g, // inline code
    /\[\[[^\]\n]*\]\]/g, // wiki links
    /\(\([^)\n]*\)\)/g, // block refs
    /\{\{[^}\n]*\}\}/g, // macros, embeds
    /!?\[[^\]\n]*\]\([^)\n]*\)/g, // markdown links / images
    /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, // web addresses
    /(^|\s)#[^\s#]+/g, // tags
  ];
  for (const re of res) for (const m of content.matchAll(re)) out.push([m.index!, m.index! + m[0].length]);
  return out;
}

const WORD = /[\p{L}\p{N}_]/u;

/** Where the first linkable mention of `title` is in `content` (or null). */
export function findUnlinkedMention(content: string, title: string): { from: number; to: number } | null {
  const t = title.trim();
  if (!t) return null;
  const hay = content.toLowerCase();
  const need = t.toLowerCase();
  const guard = protectedRanges(content);
  for (let i = hay.indexOf(need); i >= 0; i = hay.indexOf(need, i + 1)) {
    const end = i + need.length;
    if (i > 0 && WORD.test(content[i - 1]) && WORD.test(t[0])) continue;
    if (end < content.length && WORD.test(content[end]) && WORD.test(t[t.length - 1])) continue;
    if (guard.some(([a, b]) => i < b && end > a)) continue;
    return { from: i, to: end };
  }
  return null;
}

/** `content` with its first linkable mention of `title` wrapped in [[ ]], or null. */
export function linkFirstMention(content: string, title: string): string | null {
  const at = findUnlinkedMention(content, title);
  if (!at) return null;
  return `${content.slice(0, at.from)}[[${content.slice(at.from, at.to)}]]${content.slice(at.to)}`;
}
