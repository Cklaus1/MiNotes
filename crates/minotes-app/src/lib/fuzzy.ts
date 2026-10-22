/**
 * Fuzzy matching and ranking for the search palette, the command palette and
 * pickers (UX Wave 4).
 *
 * Tiers, best first (each tier is worth more than any bonus inside a lower one):
 *   exact title > prefix > a word starts with the query > the query inside a word
 *   > every word of the query found (any order) > the letters in order
 *   ("roadmp", "gtd") > one or two typos per word ("raodmap", "roadmpa").
 * Inside a tier: shorter text first, then an optional caller boost (recent
 * commands), then the original order.
 *
 * Every match says which parts of the text matched (`ranges`, [start, end) in
 * UTF-16 units of the original text) so the UI can highlight them.
 */

export type Range = [number, number];

export interface FuzzyMatch {
  score: number;
  /** 0 exact … 6 typo — see TIER. */
  tier: number;
  ranges: Range[];
}

export const TIER = {
  exact: 0,
  prefix: 1,
  wordStart: 2,
  substring: 3,
  words: 4,
  letters: 5,
  typo: 6,
} as const;

const TIER_BASE = 1000;

/** Lower-case per UTF-16 unit, keeping offsets aligned with the original text. */
export function foldCase(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const l = c.toLowerCase();
    out += l.length === 1 ? l : c;
  }
  return out;
}

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);
/** A word starts at `i` (start of text, or after a non-letter, or a lower→Upper step). */
function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1];
  const cur = text[i];
  if (!isWordChar(prev)) return true;
  return prev === prev.toLowerCase() && cur !== cur.toLowerCase() && cur === cur.toUpperCase();
}

/** The words of a text with their offsets. */
function wordsOf(lower: string): Array<{ start: number; word: string }> {
  const out: Array<{ start: number; word: string }> = [];
  const re = /[\p{L}\p{N}]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower))) out.push({ start: m.index, word: m[0] });
  return out;
}

/** Optimal-string-alignment distance (insert, delete, substitute, swap two neighbours), capped. */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2 = new Array(b.length + 1).fill(0);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1);
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev2[j] = prev[j];
    prev = cur;
  }
  return prev[b.length];
}

/** How many typos a query word of this length may have. */
function typoBudget(len: number): number {
  return len >= 8 ? 2 : len >= 4 ? 1 : 0;
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** The letters of `q` in order inside `t`, preferring word starts and runs. */
function lettersInOrder(q: string, t: string, original: string): { ranges: Range[]; quality: number } | null {
  // Greedy left-to-right, but jump to a word start when one comes before the
  // next plain hit would end a run (keeps "gtd" on "Getting Things Done").
  const ranges: Range[] = [];
  let ti = 0;
  let quality = 0;
  let prevHit = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    if (c === " ") continue;
    let hit = t.indexOf(c, ti);
    if (hit < 0) return null;
    if (hit !== prevHit + 1) {
      // Not continuing a run: is there a word start with this letter before giving up the run?
      for (let k = hit; k < t.length; k++) {
        if (t[k] === c && isWordStart(original, k)) { if (k - hit < 12) hit = k; break; }
      }
    }
    if (hit === prevHit + 1) quality += 3;
    else if (isWordStart(original, hit)) quality += 2;
    else quality -= 1;
    ranges.push([hit, hit + 1]);
    prevHit = hit;
    ti = hit + 1;
  }
  // Too scattered to be what was meant ("ae" inside any long title).
  const letters = q.replace(/ /g, "").length;
  if (quality < letters - 1) return null;
  return { ranges: mergeRanges(ranges), quality };
}

/**
 * Match `query` against `text`. Null when it doesn't match at all.
 * Case-insensitive; spaces in the query separate words (any order).
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = foldCase(query.trim().replace(/\s+/g, " "));
  if (!q) return { score: 0, tier: TIER.exact, ranges: [] };
  const t = foldCase(text);
  const lenPenalty = Math.min(text.length, 200) / 1000; // shorter text wins a tie
  const mk = (tier: number, bonus: number, ranges: Range[]): FuzzyMatch =>
    ({ score: (7 - tier) * TIER_BASE + Math.max(-300, Math.min(300, bonus)) - lenPenalty, tier, ranges });

  if (t === q) return mk(TIER.exact, 0, [[0, text.length]]);
  if (t.startsWith(q)) return mk(TIER.prefix, 0, [[0, q.length]]);
  // The whole query at a word start, else anywhere.
  let firstAt = -1;
  for (let at = t.indexOf(q); at >= 0; at = t.indexOf(q, at + 1)) {
    if (isWordStart(text, at)) return mk(TIER.wordStart, -at, [[at, at + q.length]]);
    if (firstAt < 0) firstAt = at;
  }
  if (firstAt >= 0) return mk(TIER.substring, -firstAt, [[firstAt, firstAt + q.length]]);

  const tokens = q.split(" ").filter(Boolean);
  const words = wordsOf(t);

  // Every query word found as typed (any order); word starts count more.
  if (tokens.length > 1) {
    const ranges: Range[] = [];
    let bonus = 0;
    let ok = true;
    for (const tok of tokens) {
      let best = -1;
      for (let at = t.indexOf(tok); at >= 0; at = t.indexOf(tok, at + 1)) {
        if (isWordStart(text, at)) { best = at; bonus += 10; break; }
        if (best < 0) best = at;
      }
      if (best < 0) { ok = false; break; }
      ranges.push([best, best + tok.length]);
    }
    if (ok) return mk(TIER.words, bonus, mergeRanges(ranges));
  }

  // The letters in order ("roadmp" → Roadmap, "gtd" → Getting Things Done).
  const letters = lettersInOrder(q, t, text);
  if (letters) return mk(TIER.letters, letters.quality * 5, letters.ranges);

  // Typos: every query word is within its budget of some word of the text
  // (or of that word's beginning, for a word still being typed).
  const ranges: Range[] = [];
  let cost = 0;
  for (const tok of tokens) {
    const budget = typoBudget(tok.length);
    if (budget === 0) {
      const at = t.indexOf(tok);
      if (at < 0) return null;
      ranges.push([at, at + tok.length]);
      continue;
    }
    let best: { d: number; r: Range } | null = null;
    for (const w of words) {
      const whole = editDistance(tok, w.word, budget);
      const prefixLen = Math.min(w.word.length, tok.length);
      const part = w.word.length > tok.length ? editDistance(tok, w.word.slice(0, prefixLen), budget) : budget + 1;
      const d = Math.min(whole, part);
      if (d <= budget && (!best || d < best.d)) {
        best = { d, r: [w.start, w.start + (whole <= part ? w.word.length : prefixLen)] };
        if (d === 0) break;
      }
    }
    if (!best) return null;
    cost += best.d;
    ranges.push(best.r);
  }
  return mk(TIER.typo, -cost * 50, mergeRanges(ranges));
}

export interface Ranked<T> {
  item: T;
  match: FuzzyMatch;
}

/**
 * Rank `items` for `query` by their text (best first). `boost` (0…1) lifts an
 * item inside its tier only — e.g. recently used commands — never above a
 * better kind of match. Empty query: every item, boosted ones first, else in
 * the given order.
 */
export function rankByFuzzy<T>(
  items: readonly T[],
  query: string,
  text: (item: T) => string,
  opts: { boost?: (item: T) => number; limit?: number } = {},
): Ranked<T>[] {
  const out: Array<Ranked<T> & { order: number; boost: number }> = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const match = fuzzyMatch(query, text(item));
    if (!match) continue;
    out.push({ item, match, order: i, boost: opts.boost?.(item) ?? 0 });
  }
  out.sort((a, b) =>
    (b.match.score + b.boost * 200) - (a.match.score + a.boost * 200) ||
    a.order - b.order);
  const limited = opts.limit !== undefined ? out.slice(0, opts.limit) : out;
  return limited.map(({ item, match }) => ({ item, match }));
}

/** Split text into plain / highlighted parts for rendering. */
export function highlightParts(text: string, ranges: readonly Range[]): Array<{ text: string; hit: boolean }> {
  const parts: Array<{ text: string; hit: boolean }> = [];
  let at = 0;
  for (const [s, e] of mergeRanges(ranges.filter(([s, e]) => e > s && s < text.length))) {
    if (s > at) parts.push({ text: text.slice(at, s), hit: false });
    parts.push({ text: text.slice(Math.max(s, at), Math.min(e, text.length)), hit: true });
    at = Math.min(e, text.length);
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts;
}

/**
 * A snippet of a (long) block text around the first place the query's words
 * appear, with those places as ranges (relative to the snippet).
 */
export function snippetAround(text: string, query: string, width = 140): { text: string; ranges: Range[] } {
  const lower = foldCase(text);
  const tokens = foldCase(query.trim()).split(/\s+/).filter(t => t.length > 0);
  const hits: Range[] = [];
  for (const tok of tokens) {
    for (let at = lower.indexOf(tok); at >= 0; at = lower.indexOf(tok, at + tok.length)) hits.push([at, at + tok.length]);
  }
  const merged = mergeRanges(hits);
  if (text.length <= width) return { text, ranges: merged };
  const first = merged[0]?.[0] ?? 0;
  let start = Math.max(0, first - Math.floor(width / 3));
  // Start at a word boundary.
  if (start > 0) { const sp = text.indexOf(" ", start); if (sp >= 0 && sp < first) start = sp + 1; }
  const end = Math.min(text.length, start + width);
  const pre = start > 0 ? "…" : "";
  const post = end < text.length ? "…" : "";
  const shift = pre.length - start;
  const ranges = merged
    .filter(([s, e]) => e > start && s < end)
    .map(([s, e]) => [Math.max(s, start) + shift, Math.min(e, end) + shift] as Range);
  return { text: pre + text.slice(start, end) + post, ranges };
}
