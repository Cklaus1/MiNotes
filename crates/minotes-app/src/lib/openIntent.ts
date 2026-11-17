/**
 * "Open in a new tab" plumbing (PRD-tabs §3.2). Click sites ask `openModeFrom`
 * what the gesture means and, when it is not "current", hand the destination to
 * `openInTab`; App registers the handler. With no handler registered
 * `openInTab` returns false and the caller opens the destination as usual.
 */
import type { NavEntry } from "./navHistory";

export type OpenMode = "current" | "background" | "foreground";

type Handler = (entry: NavEntry, mode: Exclude<OpenMode, "current">) => void;

let handler: Handler | null = null;

/** Ctrl/⌘ (+Shift) click or middle button. Shift alone stays with the Shift+click handlers (right sidebar). */
export function openModeFrom(e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; button?: number }): OpenMode {
  if (e.button === 1) return "background";
  if (e.ctrlKey || e.metaKey) return e.shiftKey ? "foreground" : "background";
  return "current";
}

/** Register App's handler; returns the unregister function. */
export function setOpenInTabHandler(fn: Handler | null): () => void {
  handler = fn;
  return () => { if (handler === fn) handler = null; };
}

/** True when a tab was opened (callers then skip their normal open). */
export function openInTab(entry: NavEntry, mode: OpenMode): boolean {
  if (mode === "current" || !handler) return false;
  handler(entry, mode);
  return true;
}

/** A `[[wiki link]]` element (static render or live editor chip): opens its page by id when it has one, else by title. */
export function openWikiLinkInTab(el: Element, mode: OpenMode): boolean {
  const pageId = el.getAttribute("data-page-id") || undefined;
  const title = el.getAttribute("data-page-name") || el.textContent || undefined;
  if (!pageId && !title) return false;
  return openInTab({ notebook: "", kind: "page", pageId, title }, mode);
}

/** WebKitGTK pastes the X primary selection on a middle-click: stop it on mousedown / auxclick of link-like elements. */
export function preventMiddlePaste(e: { button: number; preventDefault(): void }): void {
  if (e.button === 1) e.preventDefault();
}
