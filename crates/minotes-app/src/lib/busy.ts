/**
 * Progress for slow operations (UX Wave 3): opening another notebook, lock,
 * unlock, notebook .zip export/import, imports. The rule:
 *
 *   - a busy state shows at once (in the same task as the click: well within
 *     100 ms) — a pill with a spinner and what is happening;
 *   - while it runs the app takes no input (a transparent shield over the
 *     window and a key guard), so nothing can be typed into a view that is
 *     about to go away, and no second operation starts underneath;
 *   - it ends with a toast that says what happened (or what failed).
 *
 *     await withBusy("Opening “Work”…", () => switchNotebook(key), { done: "Opened “Work”" });
 *
 * Imperative DOM, like lib/toast.ts: it works outside React and above the
 * lock gate (unlock runs while the app is unmounted). Operations can nest (an
 * import that opens the new notebook); the innermost label shows.
 */
import { showToast } from "./toast";
import { errorMessage } from "./errors";

export interface BusyOptions<T> {
  /** Toast when it succeeds (or a function of the result; null/"" = no toast). */
  done?: string | ((result: T) => string | null | undefined);
  /** Toast when it fails (default: "<label without …> failed: <reason>"); null = rethrow only. */
  failed?: ((e: unknown) => string) | null;
}

const labels: string[] = [];
let root: HTMLDivElement | null = null;
let text: HTMLSpanElement | null = null;

function keyGuard(e: KeyboardEvent) {
  // Nothing reaches the app while it is busy (the confirm dialog is not
  // involved: busy operations never wait for one).
  e.preventDefault();
  e.stopImmediatePropagation();
}

let guarded = false;
/** Focus to give back when the operation ends (if that element still exists). */
let refocus: HTMLElement | null = null;

function guard(on: boolean) {
  if (on === guarded) return;
  guarded = on;
  if (on) {
    window.addEventListener("keydown", keyGuard, true);
    root?.classList.add("guarded");
    // Whatever had focus (an editor) must not take more input.
    const a = document.activeElement as HTMLElement | null;
    refocus = a && a !== document.body ? a : null;
    a?.blur?.();
  } else {
    window.removeEventListener("keydown", keyGuard, true);
    // A field that is still there (the unlock screen's passphrase after a
    // wrong one) gets its focus back; an editor that went away doesn't.
    const r = refocus;
    refocus = null;
    if (r && r.isConnected && !r.closest(".ProseMirror")) requestAnimationFrame(() => r.focus());
  }
}

function render() {
  if (labels.length === 0) {
    guard(false);
    root?.remove();
    root = null;
    text = null;
    document.body.removeAttribute("aria-busy");
    return;
  }
  if (!root) {
    root = document.createElement("div");
    root.className = "busy-shield";
    root.setAttribute("data-testid", "busy");
    const pill = document.createElement("div");
    pill.className = "busy-pill";
    pill.setAttribute("role", "status");
    pill.setAttribute("aria-live", "polite");
    const spin = document.createElement("span");
    spin.className = "busy-spinner";
    spin.setAttribute("aria-hidden", "true");
    text = document.createElement("span");
    text.className = "busy-label";
    text.setAttribute("data-testid", "busy-label");
    pill.append(spin, text);
    root.appendChild(pill);
    document.body.appendChild(root);
    document.body.setAttribute("aria-busy", "true");
  }
  text!.textContent = labels[labels.length - 1];
}

/** Is a busy operation running? */
export function isBusy(): boolean {
  return labels.length > 0;
}

/** Change the label of the innermost running operation (e.g. once a name is known). */
export function setBusyLabel(label: string): void {
  if (labels.length === 0) return;
  labels[labels.length - 1] = label;
  render();
}

/**
 * Run `fn` with the busy state showing; resolves/rejects like `fn`. On
 * failure a toast says so (unless `failed: null`) and the error is rethrown.
 */
export async function withBusy<T>(label: string, fn: () => Promise<T>, opts: BusyOptions<T> = {}): Promise<T> {
  labels.push(label);
  const mine = labels.length - 1;
  render(); // shows now, in the same task as the click
  try {
    // Keys already on their way still reach the page (an editor's last
    // characters); from then on the app takes no input until this is done.
    await settleInput();
    guard(true);
    const r = await fn();
    const msg = typeof opts.done === "function" ? opts.done(r) : opts.done;
    if (msg) showToast(msg);
    return r;
  } catch (e) {
    if (opts.failed !== null) {
      showToast(opts.failed ? opts.failed(e) : `${label.replace(/…$/, "")} failed: ${errorMessage(e)}`);
    }
    throw e;
  } finally {
    labels.splice(mine, 1);
    render();
  }
}

/**
 * Let input the window has already received (keys still being delivered) reach
 * the page before a save barrier reads the editors: one task, then one frame.
 */
export function settleInput(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
      else resolve();
    }, 0);
  });
}
