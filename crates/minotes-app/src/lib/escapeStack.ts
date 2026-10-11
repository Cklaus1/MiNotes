/**
 * Escape-to-close for views that have no Escape handling of their own (kanban,
 * All Pages, project settings, calendar, outline, …).
 *
 * Views register a close callback while they are open; Escape closes only the
 * most recently opened one (topmost first). The decision is made after every
 * other keydown listener has run: if anything else already handled this Escape
 * (called preventDefault — a menu, a dialog, the editor, a panel's own handler),
 * nothing here closes, so one key press never closes two things.
 */
import { useEffect, useRef } from "react";

type Entry = { id: number; close: () => void };
const stack: Entry[] = [];
let nextId = 1;
let installed = false;

function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.isComposing) return;
    // Let every other listener (React handlers, window listeners registered
    // later, ProseMirror keymaps) see the event first.
    setTimeout(() => {
      if (e.defaultPrevented) return;
      const top = stack[stack.length - 1];
      if (top) top.close();
    }, 0);
  });
}

/** Register `close` while `active`; Escape calls it when it is the topmost entry. */
export function useEscapeToClose(active: boolean, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!active) return;
    install();
    const entry: Entry = { id: nextId++, close: () => closeRef.current() };
    stack.push(entry);
    return () => {
      const i = stack.findIndex(x => x.id === entry.id);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active]);
}

/** Mark an Escape as handled so views underneath don't close too. */
export function consumeEscape(e: { key: string; preventDefault: () => void }): void {
  if (e.key === "Escape") e.preventDefault();
}
