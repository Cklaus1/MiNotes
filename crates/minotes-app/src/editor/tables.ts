/**
 * Tables: markdown round-trip, structure commands and cell navigation.
 *
 * A table block is stored as a GFM pipe table. tiptap-markdown's own table
 * serializer falls back to raw HTML for anything it considers "not markdown"
 * (a cell with two paragraphs after Enter, a header cell outside the first row),
 * which with `html: false` would not parse back — the table would turn into
 * literal tag soup on reload. It also drops column alignment and leaves `|` in
 * cell text unescaped (which splits the cell on reload). This serializer always
 * writes a pipe table: first row = header, alignment row from the header cells'
 * `align`, `|` escaped, multi-paragraph cells joined with a space.
 */
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TextSelection, type EditorState } from "@tiptap/pm/state";
import { TableMap, cellAround } from "@tiptap/pm/tables";

/** The markdown the `/table` slash command inserts: 3 columns, header + 2 rows. */
export function emptyTableMarkdown(cols = 3, bodyRows = 2): string {
  const row = "|" + "  |".repeat(cols);
  const delim = "|" + " --- |".repeat(cols);
  return [row, delim, ...Array.from({ length: bodyRows }, () => row)].join("\n");
}

/** Escape every `|` that isn't already escaped (an even run of backslashes before it). */
function escapePipes(s: string): string {
  return s.replace(/(\\*)\|/g, (_m, bs: string) => (bs.length % 2 === 0 ? bs + "\\|" : bs + "|"));
}

const alignAttr = {
  align: {
    default: null as string | null,
    parseHTML: (el: HTMLElement) => {
      const a = el.style?.textAlign || el.getAttribute("align");
      return a === "left" || a === "center" || a === "right" ? a : null;
    },
    renderHTML: (attrs: { align?: string | null }) =>
      attrs.align ? { style: `text-align: ${attrs.align}` } : {},
  },
};

export const AlignedTableCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), ...alignAttr };
  },
});

export const AlignedTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), ...alignAttr };
  },
});

export const MarkdownTable = Table.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          const rows: any[][] = [];
          node.forEach((row: any) => {
            const cells: any[] = [];
            row.forEach((cell: any) => cells.push(cell));
            rows.push(cells);
          });
          if (rows.length === 0) return;
          const width = Math.max(...rows.map((r) => r.length));

          // Render one cell's inline content to a single escaped line.
          const renderCell = (cell: any): string => {
            const parts: string[] = [];
            cell.forEach((child: any) => {
              const start = state.out.length;
              if (child.isTextblock) state.renderInline(child, false);
              else state.text(child.textContent);
              parts.push(state.out.slice(start));
              state.out = state.out.slice(0, start);
            });
            return escapePipes(parts.join(" ").replace(/\s*\n\s*/g, " ").trim());
          };

          state.inTable = true;
          rows.forEach((cells, i) => {
            state.write("| ");
            const texts: string[] = [];
            for (let j = 0; j < width; j++) texts.push(cells[j] ? renderCell(cells[j]) : "");
            state.out += texts.join(" | ") + " |";
            state.ensureNewLine();
            if (i === 0) {
              const delims: string[] = [];
              for (let j = 0; j < width; j++) {
                const a = cells[j]?.attrs?.align;
                delims.push(a === "left" ? ":---" : a === "center" ? ":---:" : a === "right" ? "---:" : "---");
              }
              state.write(`| ${delims.join(" | ")} |`);
              state.ensureNewLine();
            }
          });
          state.closeBlock(node);
          state.inTable = false;
        },
        parse: {
          // handled by markdown-it
        },
      },
    };
  },
});

/** True when the selection is inside a table. */
export function isInTable(state: EditorState): boolean {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === "table") return true;
  }
  return false;
}

/** Document position of the cell directly below the selection's cell, or null. */
function cellBelowPos(state: EditorState): number | null {
  const $cell = cellAround(state.selection.$from);
  if (!$cell) return null;
  const table = $cell.node(-1);
  const tableStart = $cell.start(-1);
  const map = TableMap.get(table);
  const rect = map.findCell($cell.pos - tableStart);
  if (rect.bottom >= map.height) return null;
  return tableStart + map.map[rect.bottom * map.width + rect.left];
}

/** Enter in a cell: move to the cell below, adding a row at the bottom of the table. */
export function moveToCellBelow(editor: any): boolean {
  let pos = cellBelowPos(editor.state);
  if (pos === null) {
    if (!editor.commands.addRowAfter()) return false;
    pos = cellBelowPos(editor.state);
    if (pos === null) return false;
  }
  const { state } = editor;
  editor.view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(pos + 1))).scrollIntoView());
  return true;
}

export type TableAction =
  | "addRowBefore" | "addRowAfter" | "addColumnBefore" | "addColumnAfter"
  | "deleteRow" | "deleteColumn" | "deleteTable";

export const TABLE_ACTIONS: { action: TableAction; label: string; short: string; danger?: boolean }[] = [
  { action: "addRowBefore", label: "Insert row above", short: "Row above" },
  { action: "addRowAfter", label: "Insert row below", short: "Row below" },
  { action: "addColumnBefore", label: "Insert column left", short: "Col left" },
  { action: "addColumnAfter", label: "Insert column right", short: "Col right" },
  { action: "deleteRow", label: "Delete row", short: "Del row", danger: true },
  { action: "deleteColumn", label: "Delete column", short: "Del col", danger: true },
  { action: "deleteTable", label: "Delete table", short: "Del table", danger: true },
];

/** Run a structure command on the table under the cursor. Returns false if it did nothing. */
export function runTableAction(editor: any, action: TableAction): boolean {
  if (!editor || editor.isDestroyed || !isInTable(editor.state)) return false;
  const chain = editor.chain().focus() as any;
  if (typeof chain[action] !== "function") return false;
  return chain[action]().run();
}
