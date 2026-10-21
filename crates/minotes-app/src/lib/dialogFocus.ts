/**
 * Keyboard focus for dialogs (UX Wave 3): when a dialog opens, focus moves
 * into it (its `autofocus`/`[data-autofocus]` element, else the first control);
 * Tab and Shift+Tab stay inside it; when it closes, focus goes back to what had
 * it before (the button that opened it), if that is still on the page.
 *
 * Every modal uses it through <Modal/>; dialogs with their own frame (import,
 * search palette, SQL query, flashcards, snippets, page versions) call the
 * hook on their dialog element. Side panels (Settings, AI, Ask) only restore
 * focus (`trap: false`): the page beside them stays reachable.
 */
import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = [
  "a[href]", "button:not([disabled])", "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])", "textarea:not([disabled])", "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='true']",
].join(",");

export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.getClientRects().length > 0 && !el.closest("[inert], [aria-hidden='true']"),
  );
}

export function useDialogFocus(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  opts: { trap?: boolean; initialFocus?: boolean } = {},
): void {
  const trap = opts.trap ?? true;
  const initialFocus = opts.initialFocus ?? true;
  // Who had focus when the dialog opened — read while rendering, before an
  // `autoFocus` field inside the dialog takes it during the commit.
  const opener = useRef<HTMLElement | null>(null);
  const wasActive = useRef(false);
  if (active && !wasActive.current && typeof document !== "undefined") {
    opener.current = document.activeElement as HTMLElement | null;
  }
  wasActive.current = active;
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    const previous = opener.current;
    // Focus inside, unless something inside already has it (autoFocus ran).
    if (initialFocus && !root.contains(document.activeElement)) {
      const first = root.querySelector<HTMLElement>("[autofocus], [data-autofocus]") ?? focusables(root)[0];
      (first ?? root).focus({ preventScroll: true });
    }
    const onKey = (e: KeyboardEvent) => {
      if (!trap || e.key !== "Tab" || e.defaultPrevented) return;
      const list = focusables(root);
      if (list.length === 0) { e.preventDefault(); return; }
      const i = list.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : (i === -1 || i === list.length - 1 ? 0 : i + 1);
      e.preventDefault();
      list[next].focus();
    };
    root.addEventListener("keydown", onKey);
    return () => {
      root.removeEventListener("keydown", onKey);
      // Back to where the user was (after this render commits).
      const target = previous;
      if (target && target !== document.body && typeof target.focus === "function") {
        requestAnimationFrame(() => {
          if (target.isConnected && (!document.activeElement || document.activeElement === document.body || !document.contains(document.activeElement))) {
            target.focus({ preventScroll: true });
          }
        });
      }
    };
  }, [active, ref, trap, initialFocus]);
}
