/**
 * Backspace at the start of a block merges it into the previous one. The two
 * contents join on one line — the inverse of Enter's split — so split→merge
 * gives back the original block. A line break is kept only where markdown
 * block syntax can't share a line (a fence, a table, a divider, or a next block
 * that starts a list / heading / quote / fence / table).
 */

/** Lines that end a block construct: text appended to them would change it. */
const CLOSED_LAST_LINE = /^(\s*```.*|\s*~~~.*|\s*\|.*\|\s*|\s*(?:-{3,}|\*{3,}|_{3,})\s*)$/;
/** First lines that only mean what they mean at the start of a line. */
const BLOCK_FIRST_LINE = /^(\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|\|)|\s*(?:-{3,}|\*{3,}|_{3,})\s*$)/;

export function mergeMarkdown(prev: string, next: string, opts: { space?: boolean } = {}): string {
  if (!prev) return next;
  if (!next) return prev;
  const lastLine = prev.slice(prev.lastIndexOf("\n") + 1);
  const firstLine = next.split("\n", 1)[0];
  if (CLOSED_LAST_LINE.test(lastLine) || BLOCK_FIRST_LINE.test(firstLine)) return `${prev}\n${next}`;
  // Enter at a word boundary drops the space (stored markdown can't keep a
  // leading/trailing space); the split remembers it so the merge restores it.
  const space = opts.space && !/\s$/.test(prev) && !/^\s/.test(next) ? " " : "";
  return prev + space + next;
}
