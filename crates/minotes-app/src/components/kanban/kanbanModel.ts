import type { Block } from "../../lib/api";
import { isTitleHeading } from "../mindmap/blocksToFlow";

/** Id of the virtual leading column holding top-level blocks that are not sections. */
export const UNSORTED_ID = "__unsorted__";
export const UNSORTED_TITLE = "No section";

export interface KanbanModel {
  /** Real section blocks, in page order. */
  columns: Block[];
  /** Top-level blocks that are not sections — cards of the "No section" column. */
  unsorted: Block[];
  /** Cards per column id (includes UNSORTED_ID when `unsorted` is non-empty). */
  cardsByColumn: Map<string, Block[]>;
  /** Column id of every card. */
  columnOfCard: Map<string, string>;
}

const HEADING_RE = /^#{1,6}\s+\S/;
const isDivider = (b: Block) => b.content.trim() === "---";

export function isHeading(content: string): boolean {
  return HEADING_RE.test(content.trim());
}

/** Split "## Title\nrest" into the heading prefix, the first line's text and the rest. */
export function splitHeading(content: string): { prefix: string; title: string; rest: string } {
  const nl = content.indexOf("\n");
  const first = nl === -1 ? content : content.slice(0, nl);
  const rest = nl === -1 ? "" : content.slice(nl);
  const m = first.match(/^(\s*#{1,6}\s+)(.*)$/);
  return m ? { prefix: m[1], title: m[2], rest } : { prefix: "", title: first, rest };
}

/**
 * Map a page's blocks onto a board.
 *
 * A column is a top-level block that acts as a section heading: a markdown
 * heading, or any block with children. `stickyIds` are blocks the board has
 * already shown as columns — they stay columns even if their last card is moved
 * out, so a plain-text column never collapses into a card mid-session.
 * Every other top-level block (plain paragraph, leaf TODO) is a card in the
 * leading "No section" column, which only exists when it has cards.
 * A leading H1 that just repeats the page title is skipped unless it has cards.
 */
export function buildKanbanModel(blocks: Block[], pageTitle: string, stickyIds: ReadonlySet<string>): KanbanModel {
  const byPosition = (a: Block, b: Block) => a.position - b.position;
  const childrenOf = new Map<string, Block[]>();
  for (const b of blocks) {
    if (!b.parent_id || isDivider(b)) continue;
    const list = childrenOf.get(b.parent_id);
    if (list) list.push(b); else childrenOf.set(b.parent_id, [b]);
  }

  const top = blocks.filter((b) => !b.parent_id && !isDivider(b)).sort(byPosition);
  const columns: Block[] = [];
  const unsorted: Block[] = [];
  top.forEach((b, i) => {
    const hasChildren = childrenOf.has(b.id);
    if (i === 0 && !hasChildren && isTitleHeading(b.content, pageTitle)) return;
    if (hasChildren || isHeading(b.content) || stickyIds.has(b.id)) columns.push(b);
    else if (b.content.trim() !== "") unsorted.push(b);
  });

  const cardsByColumn = new Map<string, Block[]>();
  const columnOfCard = new Map<string, string>();
  if (unsorted.length > 0) cardsByColumn.set(UNSORTED_ID, unsorted);
  for (const col of columns) cardsByColumn.set(col.id, (childrenOf.get(col.id) ?? []).sort(byPosition));
  for (const [colId, cards] of cardsByColumn) for (const c of cards) columnOfCard.set(c.id, colId);

  return { columns, unsorted, cardsByColumn, columnOfCard };
}
