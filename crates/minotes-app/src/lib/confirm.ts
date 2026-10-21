/**
 * The app's own confirmation dialog. Use this, never `window.confirm`:
 *
 * In the desktop app the dialog plugin replaces `window.confirm` with an async
 * function that returns a Promise (and is rejected anyway: only `dialog:allow-open`
 * is granted). A Promise is truthy, so `if (!confirm(…)) return` went ahead every
 * time — deletes didn't ask and the encrypted-notebook export warning was skipped
 * (UX review C-1). `confirmDialog` resolves to a real boolean and is rendered by
 * <ConfirmHost/> (components/ConfirmHost.tsx, mounted once in main.tsx).
 *
 *     if (!(await confirmDialog({ message: "Delete it?", confirmLabel: "Delete", danger: true }))) return;
 *
 * Escape, a click outside and Cancel all answer false. While a dialog is open,
 * keys never reach the app underneath (shortcuts, editors, other dialogs).
 */

export interface ConfirmOptions {
  /** Bold first line. Optional. */
  title?: string;
  /** What will happen; may contain line breaks. */
  message: string;
  /** Label of the confirming button (default "OK"). Name the action: "Delete". */
  confirmLabel?: string;
  /** Label of the cancelling button (default "Cancel"). */
  cancelLabel?: string;
  /** A destructive action: the confirming button is red. */
  danger?: boolean;
}

export interface PendingConfirm extends ConfirmOptions {
  id: number;
}

type Listener = (current: PendingConfirm | null) => void;

const queue: { req: PendingConfirm; resolve: (ok: boolean) => void }[] = [];
const listeners = new Set<Listener>();
let nextId = 1;

function notify() {
  const current = queue[0]?.req ?? null;
  listeners.forEach((l) => l(current));
}

/** Ask the user; resolves true only when they press the confirming button. */
export function confirmDialog(opts: ConfirmOptions | string): Promise<boolean> {
  const o = typeof opts === "string" ? { message: opts } : opts;
  if (listeners.size === 0) {
    // No host mounted (should not happen in the app): never treat that as a yes.
    console.error("confirmDialog: no <ConfirmHost/> mounted; answering Cancel", o.message);
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    queue.push({ req: { ...o, id: nextId++ }, resolve });
    if (queue.length === 1) notify();
  });
}

/** Answer the dialog that is showing (the host's buttons call this). */
export function answerConfirm(id: number, ok: boolean): void {
  const head = queue[0];
  if (!head || head.req.id !== id) return;
  queue.shift();
  head.resolve(ok);
  notify();
}

/** True while a confirmation dialog is showing. */
export function isConfirmOpen(): boolean {
  return queue.length > 0;
}

/** For <ConfirmHost/>: called with the dialog to show (or null) now and on every change. */
export function subscribeConfirm(listener: Listener): () => void {
  listeners.add(listener);
  listener(queue[0]?.req ?? null);
  return () => { listeners.delete(listener); };
}

// Keys while a dialog is open. Registered when this module loads — before any
// component adds its own window listeners — so this capture listener runs first
// and stopImmediatePropagation keeps every key away from the app underneath
// (an Escape here must not also close the dialog or view below it).
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => {
    const head = queue[0];
    if (!head) return;
    e.stopImmediatePropagation();
    if (e.key === "Escape" || e.key === "Esc") {
      e.preventDefault();
      answerConfirm(head.req.id, false);
      return;
    }
    if (e.key === "Tab") {
      // Keep focus on the dialog's buttons.
      const buttons = [...document.querySelectorAll<HTMLButtonElement>("[data-confirm-dialog] button")];
      if (buttons.length === 0) return;
      e.preventDefault();
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.shiftKey ? (i <= 0 ? buttons.length - 1 : i - 1) : (i + 1) % buttons.length;
      buttons[next].focus();
    }
    // Enter / Space act on the focused button (the browser's default action).
  }, true);
}
