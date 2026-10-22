/**
 * Sync conflict copies (UX Wave 4): a page "<title> (conflict from <device>)"
 * holds the other device's version of <title> after both devices changed the
 * same block. The banner on such a page opens the compare view
 * (components/ConflictCompare.tsx); resolving goes through the backend in one
 * transaction (core repo/conflicts.rs) and is one undo step here.
 */
import * as api from "./api";
import { undoStack } from "./undoStack";
import { executeUndo } from "./undoManager";
import { showToast, showUndoToast } from "./toast";
import { errorMessage } from "./errors";

/** "Plan (conflict from laptop)" (or "… (2)") → { base: "Plan", device: "laptop" }. */
export function parseConflictTitle(title: string): { base: string; device: string } | null {
  const m = /^(.+) \(conflict from (.+?)\)(?: \(\d+\))?$/.exec(title.trimEnd());
  return m ? { base: m[1], device: m[2] } : null;
}

/** Ask the views to show the page again after a resolve / undo / redo. */
export const CONFLICT_RESOLVED = "minotes-conflict-resolved";

/**
 * Apply the choices; push one undo entry (Ctrl+Z, or Undo in the toast,
 * restores the page and brings the copy back from the Trash).
 */
export async function resolveConflict(copyId: string, choices: api.ConflictChoice[], pageTitle: string): Promise<api.ConflictResolution> {
  const r = await api.resolveConflict(copyId, choices);
  const entry = {
    type: "conflict-resolve" as const,
    blockId: "",
    pageId: r.page_id,
    copyId: r.copy_id,
    before: r.before,
    after: r.after,
    timestamp: Date.now(),
  };
  undoStack.push(entry);
  window.dispatchEvent(new CustomEvent(CONFLICT_RESOLVED, { detail: { pageId: r.page_id, copyId: r.copy_id } }));
  const what = [
    r.took_theirs ? `${r.took_theirs} from the other version` : "",
    r.kept_both ? `${r.kept_both} kept both ways` : "",
  ].filter(Boolean).join(", ");
  showUndoToast(`Resolved “${pageTitle}”${what ? ` (${what})` : ""} — the conflict copy is in the Trash`, () => {
    if (undoStack.peekUndo() !== entry) { showToast("That can't be undone from here any more — use Ctrl+Z"); return; }
    executeUndo()
      .then(() => window.dispatchEvent(new CustomEvent(CONFLICT_RESOLVED, { detail: { pageId: r.page_id, copyId: r.copy_id, undone: true } })))
      .catch(e => showToast(`Couldn't undo: ${errorMessage(e)}`));
  }, 10000);
  return r;
}
