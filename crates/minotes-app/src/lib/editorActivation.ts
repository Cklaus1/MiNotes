/**
 * Which block has a live TipTap editor.
 *
 * Blocks render as static HTML (editor/staticRender.ts) and mount an editor only
 * while being edited. The block that claims the editor last is the owner; the
 * previous owners are asked to release theirs a little later (after their blur
 * save has run). A block that still holds focus (or has its context menu open)
 * refuses and is asked again on the next sweep, so at most a couple of editors
 * exist at any time — whatever the page size.
 */

export interface EditorOwner {
  /** Go back to static rendering. Return false to keep the editor for now. */
  release: () => boolean;
}

/** Longer than useBlockEditor's 50 ms blur-save delay. */
const RELEASE_DELAY_MS = 150;

let current: EditorOwner | null = null;
const waiting = new Set<EditorOwner>();
let timer: ReturnType<typeof setTimeout> | null = null;

function sweep() {
  timer = null;
  for (const o of [...waiting]) {
    if (o === current) { waiting.delete(o); continue; }
    if (o.release()) waiting.delete(o);
  }
}

function schedule() {
  if (!timer && waiting.size > 0) timer = setTimeout(sweep, RELEASE_DELAY_MS);
}

/** `owner` mounts an editor: earlier owners release theirs soon. */
export function claimEditor(owner: EditorOwner) {
  if (current === owner) return;
  if (current) waiting.add(current);
  waiting.delete(owner);
  current = owner;
  schedule();
}

/** Something changed for an editor that refused to release (it blurred, a menu closed). */
export function requestEditorSweep() {
  schedule();
}

/** The owner unmounted. */
export function forgetEditor(owner: EditorOwner) {
  waiting.delete(owner);
  if (current === owner) current = null;
}
