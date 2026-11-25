/**
 * "AI Suggested Links" heuristic: which existing pages are worth linking from
 * this page's text. A page is only suggested when there is real evidence it is
 * relevant — never merely because it exists:
 *
 *   1. its full title is mentioned in the text as a whole word/phrase, or
 *   2. at least half of its distinctive title keywords appear in the text.
 *
 * A keyword is distinctive when it is long enough, not a stop-word / generic
 * notes vocabulary ("page", "notes", ...), and not shared by many page titles
 * (a word that 30 titles have in common says nothing about any one of them).
 */

export interface LinkCandidate { id: string; title: string }
export interface LinkSuggestion { pageId: string; title: string; score: number; reason: string }

const STOPWORDS = new Set<string>([
  "this", "that", "these", "those", "there", "their", "them", "they", "then",
  "with", "from", "your", "yours", "have", "here", "what", "when", "which",
  "while", "about", "would", "could", "should", "into", "than", "been", "were",
  "will", "also", "some", "such", "only", "very", "just", "like", "more", "most",
  "over", "after", "before", "because", "between", "where", "other", "each",
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "was",
  "has", "had", "its", "our", "out", "new", "one", "two", "how", "why", "who",
  // Generic notes vocabulary — appears everywhere, identifies nothing.
  "page", "pages", "note", "notes", "untitled", "draft", "todo", "todos",
  "list", "item", "items", "test", "copy", "misc", "stuff", "thing", "things",
  "review", "meeting", "meetings", "project", "projects", "plan", "plans",
  "idea", "ideas", "document", "documents", "summary", "overview", "general",
  "daily", "weekly", "monthly", "report", "reports", "journal", "task", "tasks",
]);

/** A title keyword shared by more than this many page titles is not distinctive. */
const MAX_TITLE_FREQUENCY = 3;
const MAX_SUGGESTIONS = 3;

const tokenize = (text: string): string[] =>
  text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

const isKeyword = (w: string) => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w);

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when `title` occurs in `text` as a whole word/phrase (case-insensitive). */
function mentionsTitle(textLower: string, title: string): boolean {
  const t = title.trim().toLowerCase();
  if (t.length < 3 || STOPWORDS.has(t)) return false;
  // No lookbehind (older WebKitGTK lacks it): match a non-word char or the start instead.
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(t)}(?![\\p{L}\\p{N}])`, "u").test(textLower);
}

export function suggestLinks(
  pageText: string,
  currentPageId: string,
  allPages: LinkCandidate[],
  dismissed: ReadonlySet<string> = new Set(),
): LinkSuggestion[] {
  const textLower = pageText.toLowerCase();
  const contentWords = new Set(tokenize(pageText).filter(isKeyword));
  if (contentWords.size === 0) return [];

  // How many page titles each keyword appears in.
  const titleFrequency = new Map<string, number>();
  for (const p of allPages) {
    for (const w of new Set(tokenize(p.title).filter(isKeyword))) {
      titleFrequency.set(w, (titleFrequency.get(w) ?? 0) + 1);
    }
  }

  const out: LinkSuggestion[] = [];
  for (const p of allPages) {
    if (p.id === currentPageId || dismissed.has(p.title)) continue;
    if (pageText.includes(`[[${p.title}]]`) || pageText.includes(`[[${p.title}|`)) continue; // already linked
    if (mentionsTitle(textLower, p.title)) {
      out.push({ pageId: p.id, title: p.title, score: 100, reason: "mentioned on this page" });
      continue;
    }
    const keywords = [...new Set(tokenize(p.title).filter(isKeyword))]
      .filter((w) => (titleFrequency.get(w) ?? 0) <= MAX_TITLE_FREQUENCY);
    if (keywords.length === 0) continue;
    const shared = keywords.filter((w) => contentWords.has(w));
    const score = Math.round((shared.length / keywords.length) * 100);
    if (shared.length > 0 && score >= 50) {
      out.push({ pageId: p.id, title: p.title, score, reason: `shares “${shared.join("”, “")}”` });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, MAX_SUGGESTIONS);
}
