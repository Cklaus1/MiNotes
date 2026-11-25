/**
 * Structure-aware paste (C-6). Pasted markdown becomes a block tree the way an
 * outliner reads it: headings are blocks (kept as headings), list items are
 * blocks nested by indentation (bullet / number markers dropped, task
 * checkboxes kept), an indented plain line is a child of the line above it
 * (markdown would make it code), a fenced code block is one block, consecutive
 * quote lines / table rows stay one block. Plain lines without any structure
 * return null: the existing line-per-block paste handles them.
 */
import type { Editor } from "@tiptap/core";

export interface PastedBlock {
  content: string;
  children: PastedBlock[];
  /** Put the caret here afterwards (offset in `content`; templates' {{cursor}}). */
  cursor?: number;
}

const FENCE = /^(\s*)(```+|~~~+)(.*)$/;
const HEADING = /^#{1,6}\s+\S/;
const LIST = /^([-*+]|\d+[.)])\s+(.*)$/;
const TASK = /^\[[ xX]\]\s/;
const QUOTE = /^>/;
const TABLE = /^\|.*\|\s*$/;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})$/;

/** Leading whitespace as columns (a tab is 4). */
function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n += 1;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

/** Strip up to `cols` columns of leading whitespace. */
function dedent(line: string, cols: number): string {
  let i = 0, n = 0;
  while (i < line.length && n < cols && (line[i] === " " || line[i] === "\t")) {
    n += line[i] === "\t" ? 4 : 1;
    i++;
  }
  return line.slice(i);
}

export function parsePastedMarkdown(text: string): PastedBlock[] | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const items: { indent: number; content: string; heading: boolean }[] = [];
  let structured = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = indentOf(line);
    const body = line.trim();
    const fence = FENCE.exec(line);
    if (fence) {
      // Up to the closing fence (same marker, at least as long), or the end.
      const marker = fence[2];
      const out = [dedent(line, indent)];
      let j = i + 1;
      for (; j < lines.length; j++) {
        out.push(dedent(lines[j], indent));
        const t = lines[j].trim();
        if (t.startsWith(marker[0].repeat(marker.length)) && /^(```+|~~~+)\s*$/.test(t)) break;
      }
      if (j >= lines.length) out.push(marker); // unclosed: close it
      items.push({ indent, content: out.join("\n"), heading: false });
      structured = true;
      i = j;
      continue;
    }
    if (QUOTE.test(body) || TABLE.test(body)) {
      // Consecutive quote lines / table rows at this indent stay one block.
      const kind = QUOTE.test(body) ? QUOTE : TABLE;
      const out = [body];
      while (i + 1 < lines.length && lines[i + 1].trim() && kind.test(lines[i + 1].trim())) out.push(lines[++i].trim());
      items.push({ indent, content: out.join("\n"), heading: false });
      structured = true;
      continue;
    }
    if (HEADING.test(body) && indent < 4) {
      items.push({ indent: 0, content: body, heading: true });
      structured = true;
      continue;
    }
    const list = LIST.exec(body);
    if (list && !RULE.test(body)) {
      const rest = list[2];
      const bullet = /^[-*+]$/.test(list[1]);
      items.push({ indent, content: bullet && TASK.test(rest) ? `- ${rest}` : rest, heading: false });
      structured = true;
      continue;
    }
    if (indent > 0) structured = true;
    items.push({ indent, content: body, heading: false });
  }
  if (!structured || items.length === 0) return null;

  // Nest by indentation: a deeper item is a child of the nearest shallower one
  // above it; a heading always starts again at the top level.
  const roots: PastedBlock[] = [];
  const stack: { indent: number; node: PastedBlock }[] = [];
  for (const it of items) {
    const node: PastedBlock = { content: it.content, children: [] };
    if (it.heading) stack.length = 0;
    while (stack.length && stack[stack.length - 1].indent >= it.indent) stack.pop();
    (stack.length ? stack[stack.length - 1].node.children : roots).push(node);
    stack.push({ indent: it.indent, node });
  }
  return roots;
}

/**
 * Enter on a line that is just ```lang (typed): turn it into a code block in
 * that language instead of splitting the block (the text used to be saved as
 * escaped backticks). True when it did.
 */
export function fenceToCodeBlock(editor: Editor): boolean {
  const { state } = editor;
  const { $from, empty } = state.selection;
  if (!empty || !editor.schema.nodes.codeBlock) return false;
  const parent = $from.parent;
  if (parent.type.name !== "paragraph" || $from.parentOffset !== parent.content.size) return false;
  const m = /^(?:```|~~~)([\w+#.-]*)$/.exec(parent.textContent.trim());
  if (!m) return false;
  const start = $from.start();
  return editor.chain()
    .deleteRange({ from: start, to: start + parent.content.size })
    .setNode("codeBlock", { language: m[1] || null })
    .run();
}
