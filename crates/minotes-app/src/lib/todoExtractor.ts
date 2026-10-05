/**
 * Extracts TODO items from markdown content.
 * No external dependencies — pure TypeScript.
 *
 * The line rules here are THE frontend definition of a TODO and mirror
 * `parse_pending_todo` in crates/minotes-core/src/repo/ai_suggestions.rs exactly.
 * Applied per line:
 *   1. Strip one leading BOM (U+FEFF), then leading whitespace.
 *   2. `TODO x` / `DOING x` (uppercase + space; the Ctrl+Enter format): pending if
 *      the rest is non-empty.
 *   3. `DONE x` or `{{todo:...}}`: never pending. `{{todo:*}}` lines are the
 *      "All TODOs" page's own mirror entries, so they are not TODOs at all
 *      (counting them would double-count every TODO).
 *   4. Checkbox `-`/`*`/`+`, 1+ spaces, `[ ]`, 1+ spaces, non-empty text: pending.
 *      `[x]`/`[X]`: done.
 *   5. Keyword (any case) `todo:`, `action:`, `follow up:`, `follow-up:`, `next:`
 *      followed by non-empty text: pending.
 *   6. Empty text never counts; lowercase `todo foo` and `TODOS ...` don't match.
 */

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  sourcePageId: string;
  sourceBlockId: string;
  sourceBlockIndex: number;
}

export interface ParsedTodo {
  text: string;
  done: boolean;
  kind: "checkbox" | "keyword";
}

const CHECKBOX_RE = /^[-*+]\s+\[([ xX])\]\s+(.*)$/;
const ACTION_RE = /^(todo|action|follow up|follow-up|next):(.*)$/i;

/** Parse one line. Returns null when the line is not a TODO (pending or done). */
export function parseTodoLine(line: string): ParsedTodo | null {
  const trimmed = line.replace(/^\uFEFF/, "").trimStart();

  for (const kw of ["TODO ", "DOING "]) {
    if (trimmed.startsWith(kw)) {
      const text = trimmed.slice(kw.length).trim();
      return text ? { text, done: false, kind: "keyword" } : null;
    }
  }
  if (trimmed.startsWith("DONE ")) {
    const text = trimmed.slice(5).trim();
    return text ? { text, done: true, kind: "keyword" } : null;
  }
  if (trimmed.startsWith("{{todo:")) return null;

  const cb = trimmed.match(CHECKBOX_RE);
  if (cb) {
    const text = cb[2].trim();
    return text ? { text, done: cb[1] !== " ", kind: "checkbox" } : null;
  }

  const action = trimmed.match(ACTION_RE);
  if (action) {
    const text = action[2].trim();
    return text ? { text, done: false, kind: "keyword" } : null;
  }

  return null;
}

/** Number of pending (not done) TODO lines across the given block contents. */
export function countPendingTodos(contents: Iterable<string>): number {
  let count = 0;
  for (const content of contents) {
    for (const line of content.split("\n")) {
      const t = parseTodoLine(line);
      if (t && !t.done) count++;
    }
  }
  return count;
}

/**
 * Extract TODOs (pending and done) from a single block.
 */
export function extractTodosFromBlock(
  content: string,
  blockId: string,
  pageId: string,
  index: number,
): TodoItem[] {
  const todos: TodoItem[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const t = parseTodoLine(lines[i]);
    if (!t) continue;
    todos.push({
      id: t.kind === "checkbox" ? `${blockId}-${i}` : `${blockId}-action-${i}`,
      text: t.text,
      done: t.done,
      sourcePageId: pageId,
      sourceBlockId: blockId,
      sourceBlockIndex: index,
    });
  }

  return todos;
}

/**
 * Extract TODOs from all blocks of a page.
 */
export function extractTodos(
  blocks: { id: string; content: string }[],
  pageId: string,
): TodoItem[] {
  const allTodos: TodoItem[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const todos = extractTodosFromBlock(block.content, block.id, pageId, i);
    allTodos.push(...todos);
  }

  return allTodos;
}

/**
 * Extract TODOs from a single string of content.
 */
export function extractTodosFromString(
  content: string,
  blockId: string,
  pageId: string,
): TodoItem[] {
  return extractTodosFromBlock(content, blockId, pageId, 0);
}
