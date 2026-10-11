import type { Block } from "../../lib/api";

/**
 * Collapsed branches, shared with the outline view.
 *
 * The outline (PageView) keeps a page's collapsed block ids in localStorage under
 * `minotes-collapsed-<pageId>` (the backend has no command that writes
 * `blocks.collapsed`), and the desktop journeys check that it survives a
 * restart. The mind map reads and writes the same entry, so collapsing a branch
 * in either view collapses it in both and it persists across reopen/restart.
 * Blocks whose stored `collapsed` flag is set (CLI, sync) count as collapsed too.
 */

const storageKey = (pageId: string) => "minotes-collapsed-" + pageId;

/** Stored collapsed ids for the page, or null when nothing has been stored yet. */
export function loadCollapsed(pageId: string, blocks: Block[]): Set<string> | null {
  let stored: string[] | null = null;
  try {
    const raw = localStorage.getItem(storageKey(pageId));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) stored = parsed.filter((x): x is string => typeof x === "string");
    }
  } catch { /* unavailable storage: fall back to the block flags */ }
  const fromBlocks = blocks.filter((b) => b.collapsed).map((b) => b.id);
  if (stored === null && fromBlocks.length === 0) return null;
  return new Set([...(stored ?? []), ...fromBlocks]);
}

/** Persist the page's collapsed ids (only ids of blocks still on the page). */
export function saveCollapsed(pageId: string, ids: Set<string>, blocks: Block[]): void {
  const onPage = new Set(blocks.map((b) => b.id));
  const keep = [...ids].filter((id) => onPage.has(id));
  try {
    localStorage.setItem(storageKey(pageId), JSON.stringify(keep));
  } catch { /* storage full or blocked: collapse still works for this session */ }
  // The outline (PageView) keeps its own copy of this state; tell it to re-read.
  window.dispatchEvent(new CustomEvent("minotes-collapse-changed", { detail: { pageId } }));
}
