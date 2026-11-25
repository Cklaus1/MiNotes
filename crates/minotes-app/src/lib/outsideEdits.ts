/**
 * Edits made to the markdown copy in another program (PRD-notebooks Phase 4).
 * The backend imports them and emits "outside-edits"; this turns that report
 * into one undo step per imported file, quiet toasts, and notices for the
 * notebook banner (conflict copies, refused mass deletions, unreadable files).
 */
import * as api from "./api";
import { undoStack, type UndoAction } from "./undoStack";
import { executeUndo } from "./undoManager";
import { showToast, showUndoToast } from "./toast";

/** Window event (detail: OutsideReport) — NotebookBanner shows the notices. */
export const OUTSIDE_EDITS = "minotes-outside-edits";
/** Window event (detail: { ids }) — App reloads the open page if it is listed. */
export const OUTSIDE_PAGES_CHANGED = "minotes-outside-pages-changed";

const fileName = (p: string) => p.split("/").pop() ?? p;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Handle one "outside-edits" report from the backend. */
export function handleOutsideEdits(r: api.OutsideReport): void {
  const pushed: UndoAction[] = [];
  for (const i of r.imported) {
    if (!i.before.length && !i.after.length) continue; // moved / renamed only
    const action: UndoAction = {
      type: "outside-import",
      blockId: i.page_id,
      pageId: i.page_id,
      before: i.before,
      after: i.after,
      parkedPageId: i.removed_page_id,
      pageTitle: i.title,
      timestamp: Date.now(),
    };
    undoStack.push(action);
    pushed.push(action);
  }

  const afterUndo = () => {
    window.dispatchEvent(new CustomEvent(OUTSIDE_PAGES_CHANGED, { detail: { ids: r.imported.map(i => i.page_id) } }));
    window.dispatchEvent(new Event("minotes-sidebar-refresh"));
  };
  if (r.imported.length === 1) {
    const i = r.imported[0];
    const removed = i.blocks_removed ? ` — removed lines are in the Trash` : "";
    const msg = `Updated “${i.title}” from ${fileName(i.path)}, edited in another app${removed}`;
    const mine = pushed[0];
    if (mine) {
      showUndoToast(msg, () => {
        if (undoStack.peekUndo() !== mine) { showToast("That change can't be undone from here any more"); return; }
        executeUndo().then(afterUndo).catch(e => showToast(`Couldn't undo: ${e}`));
      }, 8000);
    } else {
      showToast(msg);
    }
  } else if (r.imported.length > 1) {
    showToast(`Updated ${plural(r.imported.length, "page")} from files edited in another app (Ctrl+Z undoes them one by one)`);
  }
  if (r.created.length === 1) showToast(`Added “${r.created[0].title}” from a new file in the markdown copy`);
  else if (r.created.length > 1) showToast(`Added ${plural(r.created.length, "page")} from new files in the markdown copy`);
  if (r.trashed.length === 1) {
    const t = r.trashed[0];
    showUndoToast(`Moved “${t.title}” to Trash — its file was deleted`, () => {
      api.restoreFromTrash(t.page_id, "page").then(afterUndo).catch(e => showToast(`Couldn't restore: ${e}`));
    }, 8000, "Restore");
  } else if (r.trashed.length > 1) {
    showToast(`Moved ${plural(r.trashed.length, "page")} to Trash — their files were deleted`);
  }
  for (const p of r.restored) showToast(`“${p.title}” was changed here, so its deleted file was written again`);

  const ids = new Set<string>();
  for (const x of [...r.imported, ...r.created, ...r.trashed]) ids.add(x.page_id);
  for (const c of r.conflicts) { ids.add(c.copy_id); if (c.page_id) ids.add(c.page_id); }
  window.dispatchEvent(new CustomEvent(OUTSIDE_EDITS, { detail: r }));
  window.dispatchEvent(new CustomEvent(OUTSIDE_PAGES_CHANGED, { detail: { ids: [...ids] } }));
  window.dispatchEvent(new Event("minotes-sidebar-refresh"));
}

/** Start listening for the backend's "outside-edits" event (desktop only). */
export function listenOutsideEdits(): () => void {
  if (!api.isTauri) return () => {};
  let unlisten: (() => void) | undefined;
  let gone = false;
  import("@tauri-apps/api/event").then(({ listen }) => {
    listen<api.OutsideReport>("outside-edits", e => handleOutsideEdits(e.payload)).then(fn => {
      if (gone) fn(); else unlisten = fn;
    });
  });
  return () => { gone = true; unlisten?.(); };
}
