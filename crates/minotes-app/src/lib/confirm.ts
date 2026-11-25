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
  /** A text field: the dialog is a prompt (promptDialog) and answers its value. */
  input?: { label: string; value: string; placeholder?: string; hint?: (value: string) => string };
}

/** promptDialog: the app's own text prompt (never `window.prompt`). */
export interface PromptOptions {
  title?: string;
  /** Optional explanation above the field. */
  message?: string;
  /** The field's label (also its accessible name). */
  label: string;
  defaultValue?: string;
  placeholder?: string;
  /** Label of the confirming button (default "OK"). */
  confirmLabel?: string;
  cancelLabel?: string;
  /** A live line under the field describing what was typed (e.g. the day a phrase means). */
  hint?: (value: string) => string;
}

type Listener = (current: PendingConfirm | null) => void;

const queue: { req: PendingConfirm; resolve: (answer: boolean | string | null) => void }[] = [];
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
    queue.push({ req: { ...o, id: nextId++ }, resolve: (a) => resolve(a === true) });
    if (queue.length === 1) notify();
  });
}

/**
 * Ask for a line of text in the app's own dialog; resolves to the trimmed text,
 * or null when cancelled (Escape, a click outside, Cancel) or left empty.
 */
export function promptDialog(opts: PromptOptions): Promise<string | null> {
  if (listeners.size === 0) {
    console.error("promptDialog: no <ConfirmHost/> mounted; answering Cancel", opts.label);
    return Promise.resolve(null);
  }
  return new Promise<string | null>((resolve) => {
    const req: PendingConfirm = {
      title: opts.title, message: opts.message ?? "", confirmLabel: opts.confirmLabel, cancelLabel: opts.cancelLabel,
      input: { label: opts.label, value: opts.defaultValue ?? "", placeholder: opts.placeholder, hint: opts.hint }, id: nextId++,
    };
    queue.push({ req, resolve: (a) => resolve(typeof a === "string" && a.trim() ? a.trim() : null) });
    if (queue.length === 1) notify();
  });
}

/** Answer the prompt that is showing with its text (null = cancelled). */
export function answerPrompt(id: number, value: string | null): void {
  const head = queue[0];
  if (!head || head.req.id !== id) return;
  queue.shift();
  head.resolve(value);
  notify();
}

/** Answer the dialog that is showing (the host's buttons call this). */
export function answerConfirm(id: number, ok: boolean): void {
  const head = queue[0];
  if (!head || head.req.id !== id) return;
  queue.shift();
  head.resolve(head.req.input ? (ok ? currentInputValue() : null) : ok);
  notify();
}

function currentInputValue(): string {
  const el = document.querySelector<HTMLInputElement>("[data-confirm-dialog] input[data-confirm-input]");
  return el?.value ?? "";
}

/** "1 page" / "3 pages": counts in confirmation messages. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
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
    if (e.key === "Enter" && head.req.input && (e.target as HTMLElement | null)?.matches?.("input[data-confirm-input]")) {
      // Enter in a prompt's field answers it (an empty field does nothing).
      e.preventDefault();
      const v = currentInputValue();
      if (v.trim()) answerConfirm(head.req.id, true);
      return;
    }
    if (e.key === "Tab") {
      // Keep focus inside the dialog (its field and buttons).
      const buttons = [...document.querySelectorAll<HTMLElement>("[data-confirm-dialog] input, [data-confirm-dialog] button:not(:disabled)")];
      if (buttons.length === 0) return;
      e.preventDefault();
      const i = buttons.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (i <= 0 ? buttons.length - 1 : i - 1) : (i + 1) % buttons.length;
      buttons[next].focus();
    }
    // Enter / Space act on the focused button (the browser's default action).
  }, true);
}
