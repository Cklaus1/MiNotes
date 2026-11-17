/**
 * Back / forward (UX Wave 4): one history across pages, journal days, the
 * main views (Tasks, All Pages, Trash, Archive, Graph) and notebooks — going
 * back after a cross-notebook jump reopens the source notebook.
 *
 * App reports where the user is (`noteLocation`, from its render state) and
 * performs a step (`setNavExecutor`). This module outlives App: while a
 * notebook is locked the lock gate unmounts App, but the history, the keys
 * (Ctrl+[ / Ctrl+], the mouse's back/forward buttons) and a step waiting for
 * the notebook to open (`takePendingNav`) stay here — going back into a locked
 * notebook shows its unlock screen and, once unlocked, the page.
 */
import { useSyncExternalStore } from "react";
import * as api from "./api";
import { switchNotebook } from "./notebooks";
import { LOCK_CHANGED } from "./encryption";
import { isConfirmOpen } from "./confirm";
import { isBusy } from "./busy";

export type NavView = "tasks" | "pages" | "trash" | "archive" | "graph";

export interface NavEntry {
  /** Notebook key ("" while unknown). */
  notebook: string;
  kind: "page" | "journal-day" | "view";
  pageId?: string;
  /** Page title (a page opened by name — a cross-notebook link — has no id yet). */
  title?: string;
  /** A journal day with nothing written yet. */
  date?: string;
  view?: NavView;
  /** Opening by title may create the page ("Create page in <Notebook>"). */
  create?: boolean;
}

const MAX_ENTRIES = 100;
/** A step whose target never shows up (a deleted page) stops waiting after this. */
const RESTORE_TIMEOUT_MS = 8000;

let entries: NavEntry[] = [];
let index = -1;
/** The entry a back/forward step is going to: other locations are not recorded meanwhile. */
let restoring: NavEntry | null = null;
let restoreTimer: ReturnType<typeof setTimeout> | null = null;
/** A step to take once its notebook is open (and unlocked). */
let pending: NavEntry | null = null;
let executor: ((e: NavEntry) => void) | null = null;
/** The open notebook is locked (the lock gate shows the unlock screen). */
let locked = false;
let version = 0;
const listeners = new Set<() => void>();

function changed() {
  version++;
  listeners.forEach(l => l());
}

export function sameEntry(a: NavEntry | null | undefined, b: NavEntry | null | undefined): boolean {
  if (!a || !b) return false;
  if (a.notebook && b.notebook && a.notebook !== b.notebook) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === "view") return a.view === b.view;
  if (a.kind === "journal-day") return a.date === b.date;
  if (a.pageId && b.pageId) return a.pageId === b.pageId;
  return !!a.title && !!b.title && a.title.trim().toLowerCase() === b.title.trim().toLowerCase();
}

function clearRestoring() {
  restoring = null;
  if (restoreTimer) clearTimeout(restoreTimer);
  restoreTimer = null;
}

/** Where the user is now (App calls this whenever it changes). */
export function noteLocation(loc: NavEntry | null): void {
  if (!loc || !loc.notebook) return;
  if (pending && sameEntry(pending, loc)) pending = null;
  if (restoring) {
    if (sameEntry(restoring, loc)) {
      // Arrived: keep the entry's details current (a page found by title now has its id).
      entries[index] = { ...restoring, ...loc };
      clearRestoring();
      changed();
    }
    return; // on the way there: nothing in between is a place the user chose
  }
  if (index >= 0 && sameEntry(entries[index], loc)) {
    const merged = { ...entries[index], ...loc };
    const differs = JSON.stringify(merged) !== JSON.stringify(entries[index]);
    entries[index] = merged;
    if (differs) changed(); // a renamed page: the tab row and the saved tabs follow
    return;
  }
  entries = entries.slice(0, index + 1);
  entries.push(loc);
  if (entries.length > MAX_ENTRIES) entries = entries.slice(entries.length - MAX_ENTRIES);
  index = entries.length - 1;
  changed();
}

export function canGoBack(): boolean {
  return index > 0;
}
export function canGoForward(): boolean {
  return index >= 0 && index < entries.length - 1;
}

/** Hand `e` to App, or keep it until App (re)mounts in that notebook. */
function deliver(e: NavEntry) {
  if (executor && !locked) {
    if (restoring) {
      if (restoreTimer) clearTimeout(restoreTimer);
      restoreTimer = setTimeout(clearRestoring, RESTORE_TIMEOUT_MS);
    }
    executor(e);
  } else {
    pending = e;
  }
}

/**
 * Go to `e`: switch notebooks first when it lives in another one (App then
 * takes it with `takePendingNav` — or, for a locked notebook, after unlocking).
 */
export async function navigateToEntry(e: NavEntry): Promise<void> {
  const current = await api.getCurrentNotebook().catch(() => null);
  if (e.notebook && current !== null && e.notebook !== current) {
    pending = e;
    try {
      await switchNotebook(e.notebook);
    } catch {
      // switchNotebook said why (toast); stay where we are.
      if (pending === e) pending = null;
      clearRestoring();
      changed();
    }
    return;
  }
  deliver(e);
}

async function step(delta: number): Promise<boolean> {
  const i = index + delta;
  if (i < 0 || i >= entries.length) return false;
  index = i;
  restoring = entries[i];
  changed();
  await navigateToEntry(entries[i]);
  return true;
}

export const goBack = () => step(-1);
export const goForward = () => step(1);

/** App: perform a step (open the page / view). Returns the remover. */
export function setNavExecutor(fn: (e: NavEntry) => void): () => void {
  executor = fn;
  return () => { if (executor === fn) executor = null; };
}

/** A step waiting for notebook `key` to be open (App runs it instead of the journal). */
export function takePendingNav(key: string): NavEntry | null {
  if (!pending || locked || (pending.notebook && pending.notebook !== key)) return null;
  const p = pending;
  // Kept until the location is reached (noteLocation), in case App unmounts first.
  if (restoring) {
    if (restoreTimer) clearTimeout(restoreTimer);
    restoreTimer = setTimeout(clearRestoring, RESTORE_TIMEOUT_MS);
  }
  return p;
}

/** Open `e` once its notebook is open — used by "Unlock and open" / "Create page in…". */
export function setPendingNav(e: NavEntry | null): void {
  pending = e;
}

/** The step couldn't be taken (the page is gone): stop waiting for it. */
export function cancelNavStep(): void {
  pending = null;
  clearRestoring();
  changed();
}

/** For the toolbar buttons: re-renders on every history change. */
export function useNavHistory(): { canBack: boolean; canForward: boolean } {
  useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => version,
  );
  return { canBack: canGoBack(), canForward: canGoForward() };
}

// ── Per-tab history (lib/tabs.ts): each tab owns an {entries, index}; the
// ACTIVE tab's is the one this module works on. ──

/** The live history (the active tab's), as plain data. */
export function exportHistory(): { entries: NavEntry[]; index: number } {
  return { entries: entries.map(e => ({ ...e })), index };
}

/**
 * Make `h` the live history (switching tabs). A step under way is forgotten,
 * unless `keepRestoring` (a notebook opened by a step: its arrival is still to come).
 */
export function importHistory(h: { entries: NavEntry[]; index: number }, opts: { keepRestoring?: boolean } = {}): void {
  if (!opts.keepRestoring) clearRestoring();
  entries = h.entries.map(e => ({ ...e }));
  index = entries.length === 0 ? -1 : Math.max(0, Math.min(h.index, entries.length - 1));
  changed();
}

/** Go to the live history's current entry (a tab switched to). False when it has none. */
export const goToCurrent = () => step(0);

/** Is a back / forward step on its way (its location not reached yet)? */
export function isRestoring(): boolean {
  return !!restoring;
}

/** The step waiting for its notebook to open, if any. */
export function pendingNav(): NavEntry | null {
  return pending;
}

/** Called after every history change (lib/tabs.ts). Returns the remover. */
export function subscribeNavHistory(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** Test hook (journeys): the history as plain data. */
export function navHistorySnapshot() {
  return { index, entries: entries.map(e => ({ ...e })), restoring: !!restoring, pending: pending ? { ...pending } : null };
}

/** Is this key event the back (-1) / forward (1) shortcut? Ctrl+[ / Ctrl+] (⌘ on macOS). */
export function navKeyDelta(e: KeyboardEvent): number {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return 0;
  if (e.key === "[" || e.code === "BracketLeft") return -1;
  if (e.key === "]" || e.code === "BracketRight") return 1;
  return 0;
}

let installed = false;

/** Keys and mouse buttons for back / forward, for the whole window (main.tsx). */
export function installNavHistory(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener(LOCK_CHANGED, (ev) => {
    const s = (ev as CustomEvent<api.NotebookSession | null>).detail;
    if (s) locked = !!s.locked;
    if (s && !s.locked && pending && executor && (!pending.notebook || pending.notebook === s.key)) {
      // Unlocked while App stayed mounted: nothing remounts to take the step.
      const p = pending;
      setTimeout(() => { if (pending === p && executor) deliver(p); }, 0);
    }
  });
  const blocked = () => isConfirmOpen() || isBusy();
  window.addEventListener("keydown", (e) => {
    const d = navKeyDelta(e);
    if (!d || e.defaultPrevented || blocked()) return;
    e.preventDefault();
    void step(d);
  });
  // Mouse buttons 4/5 (DOM buttons 3/4). The webview would otherwise try its
  // own history on some platforms.
  const isNavButton = (e: MouseEvent) => e.button === 3 || e.button === 4;
  window.addEventListener("mousedown", (e) => { if (isNavButton(e)) e.preventDefault(); }, true);
  window.addEventListener("mouseup", (e) => {
    if (!isNavButton(e)) return;
    e.preventDefault();
    if (blocked()) return;
    void step(e.button === 3 ? -1 : 1);
  }, true);
  window.addEventListener("auxclick", (e) => { if (isNavButton(e)) e.preventDefault(); }, true);
}
