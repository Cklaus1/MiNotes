/**
 * Tabs (PRD-tabs): the tab store. Holds entries only — never a mounted page;
 * App shows the active tab's current entry.
 *
 * Each tab owns a back/forward history `{entries, index}`. The ACTIVE tab's
 * history lives in lib/navHistory (where App's `noteLocation` and the back /
 * forward keys work); the store's copy of it is stale and is refreshed with
 * `exportHistory()` whenever it is read, and swapped with `importHistory()`
 * when another tab is activated.
 *
 * Tabs are per notebook: `loadNotebookTabs(key)` (App, not on Android) loads the open notebook's tabs
 * from its `ui_state` ("tabs.v1" — encrypted with an encrypted notebook, never
 * localStorage) and saves them back debounced (≤ 1 write per second, and at
 * once in the save barrier, i.e. before a notebook switch or lock).
 *
 * Cross-notebook: a tab's history may hold another notebook's entries (Back
 * after a cross-notebook link). Arriving in a notebook by a link or a step, the
 * live history is spliced onto that notebook's active tab, so Back returns to
 * the source notebook (and Forward from there comes back).
 */
import { useSyncExternalStore } from "react";
import * as api from "./api";
import {
  exportHistory, goToCurrent, importHistory, isRestoring, pendingNav, sameEntry,
  subscribeNavHistory, type NavEntry, type NavView,
} from "./navHistory";
import { registerFlush } from "./pendingEdits";

/**
 * `draft`: a tab with nothing in it yet that shows the "new page" title field
 * (New tabs open → "A new page", or an empty tab switched to). Never saved.
 */
export interface Tab { id: string; entries: NavEntry[]; index: number; pinned: boolean; draft?: boolean }
/**
 * What the tab row draws: `entry` is the tab's current location (null = not
 * visited yet); `foreign` = that entry is another notebook's (its title must
 * not be shown — the tabs are loading, or a cross-notebook step is on its way).
 */
export interface TabView { id: string; pinned: boolean; entry: NavEntry | null; draft: boolean; foreign: boolean }
/** One notebook's tabs (what is saved in its ui_state). */
export interface TabsState { notebook: string; tabs: Tab[]; activeId: string }

interface ClosedTab { tab: Tab; position: number }

export const TABS_UI_KEY = "tabs.v1";
/** History entries kept per tab when saving. */
export const MAX_SAVED_ENTRIES = 50;
/** Closed tabs "Reopen closed tab" remembers (per notebook, in memory only). */
export const MAX_CLOSED = 10;
/** Open tabs at most (opening more says so and does nothing). */
export const MAX_TABS = 100;
const SAVE_DELAY_MS = 1000;
/**
 * After the save barrier (a notebook switch or lock is about to happen) no
 * debounced write starts for that notebook until its tabs are unloaded — or,
 * when nothing switched (the switch failed, a lock), until this long has passed.
 */
export const BARRIER_HOLD_MS = 8000;
/** A failed read of a notebook's tabs (not a lock) is retried once after this. */
const LOAD_RETRY_MS = 1500;

// ── State ──

let seq = 0;
function newId(): string {
  seq++;
  return `tab-${Date.now().toString(36)}-${seq.toString(36)}`;
}

/** The notebook the tabs belong to ("" until App reports one). */
let notebook = "";
let tabs: Tab[] = [{ id: newId(), entries: [], index: -1, pinned: false }];
let activeId = tabs[0].id;
let closed: ClosedTab[] = [];
/** Closed stacks of the other notebooks opened this session. */
const closedByNotebook = new Map<string, ClosedTab[]>();
/** The live history's index the last time no step was on its way. */
let settledIndex = -1;
/** A notebook's tabs are being loaded: nothing is saved meanwhile. */
let loading = false;
let loadToken = 0;
/** What was pending when the save barrier last ran (just before a notebook switch). */
let pendingAtFlush: NavEntry | null = null;
/** The save barrier ran for `notebook`: writes for it wait (see BARRIER_HOLD_MS). */
let hold: { notebook: string; timer: ReturnType<typeof setTimeout> } | null = null;
/**
 * Tabs opened by links from tab `anchor` one after another go after the last
 * of them (`last`), so they keep click order (as in browsers). Over once
 * another tab is activated or the anchor tab moves on from `at`.
 */
let bgRun: { anchor: string; last: string; at: NavEntry | null } | null = null;

function liveCurrent(): NavEntry | null {
  const h = exportHistory();
  return h.entries[h.index] ?? null;
}

let version = 0;
const listeners = new Set<() => void>();

function emit() {
  version++;
  listeners.forEach(l => l());
  scheduleSave();
}

subscribeNavHistory(() => {
  if (!isRestoring()) settledIndex = exportHistory().index;
  // The step the barrier saw was cancelled or failed (navHistory dropped it):
  // a later plain switch into that notebook must not count as its arrival.
  if (pendingAtFlush && !pendingNav()) pendingAtFlush = null;
  if (bgRun && !sameEntry(liveCurrent(), bgRun.at)) bgRun = null; // the tab went elsewhere
  emit();
});

const cloneTab = (t: Tab): Tab => ({ ...t, entries: t.entries.map(e => ({ ...e })) });
const pinnedCount = (list: Tab[] = tabs) => list.filter(t => t.pinned).length;
const findIndex = (id: string) => tabs.findIndex(t => t.id === id);
const currentEntry = (t: { entries: NavEntry[]; index: number }): NavEntry | null => t.entries[t.index] ?? null;

/** Copy the live history into the active tab. */
function syncActive() {
  const t = tabs.find(x => x.id === activeId);
  if (!t) return;
  const h = exportHistory();
  t.entries = h.entries;
  t.index = h.index;
}

/** Make `id` active without navigating (the history swap only). */
function swapTo(id: string) {
  syncActive();
  const t = tabs.find(x => x.id === id);
  if (!t) return;
  bgRun = null;
  // Switched to a tab with nothing in it: it shows the new-page field, never
  // the page that was open before.
  if (!currentEntry(t)) t.draft = true;
  activeId = id;
  importHistory({ entries: t.entries, index: t.index });
  settledIndex = exportHistory().index;
}

function pushClosed(t: Tab, position: number) {
  if (!currentEntry(t)) return; // an empty tab: nothing to reopen
  closed.push({ tab: cloneTab(t), position });
  if (closed.length > MAX_CLOSED) closed = closed.slice(closed.length - MAX_CLOSED);
}

/** Keep pinned tabs as a group at the left (stable order inside each group). */
function regroup() {
  tabs = [...tabs.filter(t => t.pinned), ...tabs.filter(t => !t.pinned)];
}

/**
 * Where a new tab goes: right after the active one (after the pinned group if
 * it is pinned). `fromLink`: after the tabs already opened from the active one
 * by links (click order, as browsers do).
 */
function insertionIndex(fromLink = false): number {
  const i = findIndex(activeId);
  if (i < 0) return tabs.length;
  if (fromLink && bgRun?.anchor === activeId) {
    const j = findIndex(bgRun.last);
    if (j >= 0 && !tabs[j].pinned) return j + 1;
  }
  return tabs[i].pinned ? pinnedCount() : i + 1;
}

let tooManyHandler: (() => void) | null = null;
/** App: what to do when a tab can't be opened because MAX_TABS are open (a toast). */
export function setTooManyTabsHandler(fn: (() => void) | null): void {
  tooManyHandler = fn;
}
/** At the cap: says so (App's toast) and returns true. */
function atCap(): boolean {
  if (tabs.length < MAX_TABS) return false;
  tooManyHandler?.();
  return true;
}

// ── Public API ──

/** Switch to tab `id`: its history becomes the live one and App opens its current entry. */
export function activateTab(id: string): void {
  if (id === activeId || findIndex(id) < 0) return;
  swapTo(id);
  emit();
  void goToCurrent();
}

/**
 * Open `entry` in a new tab next to the active one (after the ones already
 * opened from it); `activate` switches to it. Returns its id ("" at MAX_TABS).
 */
export function openInNewTab(entry: NavEntry, opts: { activate: boolean }): string {
  return addTab(entry, opts.activate, true);
}

function addTab(entry: NavEntry, activate: boolean, fromLink: boolean): string {
  if (atCap()) return "";
  const t: Tab = { id: newId(), entries: [{ ...entry }], index: 0, pinned: false };
  tabs.splice(insertionIndex(fromLink), 0, t);
  if (fromLink) bgRun = { anchor: activeId, last: t.id, at: liveCurrent() };
  if (activate) {
    swapTo(t.id);
    emit();
    void goToCurrent();
  } else {
    emit();
  }
  return t.id;
}

/** "+" / Ctrl+T: a new tab after the active one, switched to. */
export function newTab(entry: NavEntry): string {
  return addTab(entry, true, false);
}

/**
 * A new tab with nothing in it yet (New tabs open → "A new page": App shows a
 * title field there). Switched to; nothing is navigated. Not saved while empty.
 */
export function newEmptyTab(): string {
  if (atCap()) return "";
  const t: Tab = { id: newId(), entries: [], index: -1, pinned: false, draft: true };
  tabs.splice(insertionIndex(), 0, t);
  swapTo(t.id);
  emit();
  return t.id;
}

/** Remove the tabs in `ids` (pushed onto the closed stack); if the active one goes, activate `next`. */
function removeTabs(ids: Set<string>, nextActive: () => string | undefined) {
  if (ids.size === 0) return;
  syncActive();
  const activeGoes = ids.has(activeId);
  const next = activeGoes ? nextActive() : undefined;
  tabs.forEach((t, i) => { if (ids.has(t.id)) pushClosed(t, i); });
  if (activeGoes && next) {
    swapTo(next);
    tabs = tabs.filter(t => !ids.has(t.id));
    emit();
    void goToCurrent();
    return;
  }
  tabs = tabs.filter(t => !ids.has(t.id));
  emit();
}

/** Close a tab (never the last one). Closing the active tab activates the one to its right, else left. */
export function closeTab(id: string): void {
  const i = findIndex(id);
  if (i < 0 || tabs.length <= 1) return;
  removeTabs(new Set([id]), () => (tabs[i + 1] ?? tabs[i - 1])?.id);
}

/** Close every tab but `id` and the pinned ones. */
export function closeOtherTabs(id: string): void {
  if (findIndex(id) < 0) return;
  removeTabs(new Set(tabs.filter(t => t.id !== id && !t.pinned).map(t => t.id)), () => id);
}

/** Close the unpinned tabs to the right of `id`. */
export function closeTabsToRight(id: string): void {
  const i = findIndex(id);
  if (i < 0) return;
  removeTabs(new Set(tabs.slice(i + 1).filter(t => !t.pinned).map(t => t.id)), () => id);
}

/** Pin / unpin: pinned tabs stay a group at the left, in pin order; an unpinned tab leads the rest. */
export function togglePin(id: string): void {
  const i = findIndex(id);
  if (i < 0) return;
  const [t] = tabs.splice(i, 1);
  t.pinned = !t.pinned;
  tabs.splice(pinnedCount(), 0, t);
  emit();
}

/** A copy of tab `id` with its history, right after it, switched to. */
export function duplicateTab(id: string): void {
  syncActive();
  const i = findIndex(id);
  if (i < 0 || atCap()) return;
  const copy: Tab = { ...cloneTab(tabs[i]), id: newId(), pinned: false };
  tabs.splice(tabs[i].pinned ? pinnedCount() : i + 1, 0, copy);
  swapTo(copy.id);
  emit();
  void goToCurrent();
}

/** Bring back the last closed tab (with its history) where it was, and switch to it. */
export function reopenClosedTab(): void {
  if (closed.length === 0 || atCap()) return;
  const c = closed.pop()!;
  const t = cloneTab(c.tab);
  if (findIndex(t.id) >= 0) t.id = newId();
  const pc = pinnedCount();
  const pos = t.pinned ? Math.min(c.position, pc) : Math.max(pc, Math.min(c.position, tabs.length));
  tabs.splice(pos, 0, t);
  swapTo(t.id);
  emit();
  void goToCurrent();
}

/**
 * Drag reorder: `toIndex` is the tab's index in the resulting row. Dropping into
 * the pinned group pins it, out of it unpins it; `pinned` says so explicitly
 * (the drop zone at the group's edge is ambiguous by index alone).
 */
export function moveTab(id: string, toIndex: number, pinned?: boolean): void {
  const i = findIndex(id);
  if (i < 0) return;
  const [t] = tabs.splice(i, 1);
  const pc = pinnedCount();
  const pin = pinned ?? (toIndex < pc || (t.pinned && toIndex === pc));
  t.pinned = pin;
  const at = pin ? Math.max(0, Math.min(toIndex, pc)) : Math.max(pc, Math.min(toIndex, tabs.length));
  tabs.splice(at, 0, t);
  emit();
}

/** Ctrl+Shift+PgUp / PgDn: move the active tab one place, within its group. */
export function moveActiveTab(delta: -1 | 1): void {
  const i = findIndex(activeId);
  if (i < 0) return;
  const j = i + delta;
  if (j < 0 || j >= tabs.length || tabs[j].pinned !== tabs[i].pinned) return;
  [tabs[i], tabs[j]] = [tabs[j], tabs[i]];
  emit();
}

/** Ctrl+Tab / Ctrl+Shift+Tab: the next / previous tab in row order, wrapping. */
export function cycleTab(delta: -1 | 1): void {
  if (tabs.length < 2) return;
  const i = findIndex(activeId);
  activateTab(tabs[(i + delta + tabs.length) % tabs.length].id);
}

/** Alt+1..8: the nth tab (1-based); Alt+9: the last. */
export function goToTab(n: number): void {
  const t = n >= 9 ? tabs[tabs.length - 1] : tabs[n - 1];
  if (t) activateTab(t.id);
}

// ── Reading ──

function liveTabs(): Tab[] {
  syncActive();
  return tabs.map(cloneTab);
}

/** Tests / journeys: the store as plain data (`closed` = how many can be reopened). */
export function getTabsSnapshot(): { tabs: Tab[]; activeId: string; closed: number } {
  return { tabs: liveTabs(), activeId, closed: closed.length };
}

/** The notebook the tabs are for ("" before App reported one). */
export function tabsNotebook(): string {
  return notebook;
}

let viewCache: { version: number; value: { tabs: TabView[]; activeId: string; canReopen: boolean } } | null = null;
function viewSnapshot() {
  if (viewCache?.version === version) return viewCache.value;
  const value = {
    tabs: liveTabs().map(t => {
      const entry = currentEntry(t);
      return { id: t.id, pinned: t.pinned, entry, draft: !!t.draft, foreign: !!notebook && !!entry?.notebook && entry.notebook !== notebook };
    }),
    activeId,
    canReopen: closed.length > 0,
  };
  viewCache = { version, value };
  return value;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** The tab row: every tab's current location, the active tab, whether one can be reopened. */
export function useTabs(): { tabs: TabView[]; activeId: string; canReopen: boolean } {
  return useSyncExternalStore(subscribe, viewSnapshot);
}

// ── Saving ──

const VIEWS: NavView[] = ["tasks", "pages", "trash", "archive", "graph"];

/** The kept window of a long history (around its current entry). */
function capHistory(entries: NavEntry[], index: number): { entries: NavEntry[]; index: number } {
  if (entries.length <= MAX_SAVED_ENTRIES) return { entries, index };
  const start = Math.max(0, Math.min(index - (MAX_SAVED_ENTRIES - 10), entries.length - MAX_SAVED_ENTRIES));
  return { entries: entries.slice(start, start + MAX_SAVED_ENTRIES), index: index - start };
}

/**
 * The saved form of `state` (pure). History capped at 50 entries per tab;
 * another notebook's entries are kept without their title (an encrypted
 * notebook's page titles must not land in this notebook's ui_state) — and
 * dropped when the title was all they had.
 */
export function serializeTabs(state: TabsState): string {
  const own = (e: NavEntry) => !e.notebook || e.notebook === state.notebook;
  const out = state.tabs.map(t => {
    const kept: NavEntry[] = [];
    let index = -1;
    t.entries.forEach((e, i) => {
      const x: NavEntry = { ...e };
      if (!own(x)) {
        delete x.title;
        delete x.create;
      }
      if (x.kind !== "page" || x.pageId || x.title) kept.push(x);
      if (i <= t.index && kept.length) index = kept.length - 1;
    });
    if (index < 0 && kept.length && t.index >= 0) index = 0;
    if (kept.length === 0) index = -1;
    const capped = capHistory(kept, index);
    return { id: t.id, pinned: t.pinned, index: capped.index, entries: capped.entries };
  });
  return JSON.stringify({ v: 1, notebook: state.notebook, activeId: state.activeId, tabs: out });
}

function parseEntry(raw: unknown, storedKey: string, notebookKey: string): NavEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const nb = typeof r.notebook === "string" ? r.notebook : "";
  const e: NavEntry = { notebook: !nb || nb === storedKey ? notebookKey : nb, kind: "page" };
  if (r.kind === "page") {
    e.pageId = str(r.pageId);
    e.title = str(r.title);
    if (r.create === true) e.create = true;
    if (!e.pageId && !e.title) return null;
  } else if (r.kind === "journal-day") {
    e.kind = "journal-day";
    e.date = str(r.date);
    if (!e.date) return null;
  } else if (r.kind === "view") {
    e.kind = "view";
    if (!VIEWS.includes(r.view as NavView)) return null;
    e.view = r.view as NavView;
  } else {
    return null;
  }
  for (const k of Object.keys(e) as (keyof NavEntry)[]) if (e[k] === undefined) delete e[k];
  return e;
}

/**
 * A notebook's saved tabs (pure). Garbage → null. A tab's current entry is
 * moved onto one of this notebook's own entries (a tab saved mid-way through a
 * cross-notebook step must not switch notebooks when restored).
 */
export function parseTabs(json: string, notebookKey: string): TabsState | null {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return null; }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || !Array.isArray(r.tabs)) return null;
  const storedKey = typeof r.notebook === "string" ? r.notebook : "";
  const seen = new Set<string>();
  const out: Tab[] = [];
  for (const rt of r.tabs) {
    if (!rt || typeof rt !== "object") continue;
    const t = rt as Record<string, unknown>;
    const rawEntries = Array.isArray(t.entries) ? t.entries : [];
    const rawIndex = typeof t.index === "number" && Number.isFinite(t.index) ? Math.floor(t.index) : rawEntries.length - 1;
    const entries: NavEntry[] = [];
    let index = -1;
    rawEntries.forEach((re, i) => {
      const e = parseEntry(re, storedKey, notebookKey);
      if (e) entries.push(e);
      if (i <= rawIndex && entries.length) index = entries.length - 1;
    });
    const capped = capHistory(entries, index);
    const tab: Tab = {
      id: typeof t.id === "string" && t.id && !seen.has(t.id) ? t.id : newId(),
      entries: capped.entries,
      index: capped.index,
      pinned: t.pinned === true,
    };
    // Current entry in another notebook: the nearest own entry before it, else after it.
    const own = (i: number) => tab.entries[i]?.notebook === notebookKey;
    if (tab.index >= 0 && !own(tab.index)) {
      let j = tab.index;
      while (j >= 0 && !own(j)) j--;
      if (j < 0) { j = tab.index; while (j < tab.entries.length && !own(j)) j++; }
      if (j >= tab.entries.length) { tab.entries = []; j = -1; }
      tab.index = j;
    }
    if (tab.entries.length === 0) continue; // nothing to show
    seen.add(tab.id);
    out.push(tab);
  }
  if (out.length === 0) return null;
  const sorted = [...out.filter(t => t.pinned), ...out.filter(t => !t.pinned)];
  const active = typeof r.activeId === "string" && sorted.some(t => t.id === r.activeId) ? r.activeId : sorted[0].id;
  return { notebook: notebookKey, tabs: sorted, activeId: active };
}

/** The state to save: the active tab's live history (its last settled place while a step is on its way). */
function stateForSave(): TabsState {
  const list = liveTabs();
  const a = list.find(t => t.id === activeId);
  if (a && isRestoring() && currentEntry(a)?.notebook && currentEntry(a)!.notebook !== notebook
      && settledIndex >= 0 && settledIndex < a.entries.length) {
    a.index = settledIndex;
  }
  return { notebook, tabs: list, activeId };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;
/** The write under way (the barrier and a load wait for it). */
let writing: Promise<void> | null = null;

function scheduleSave() {
  if (!notebook || loading) return;
  dirty = true;
  if (!saveTimer) saveTimer = setTimeout(() => { void writeNow(); }, SAVE_DELAY_MS);
}

const heldFor = (key: string) => !!hold && hold.notebook === key;

function releaseHold() {
  if (!hold) return;
  clearTimeout(hold.timer);
  hold = null;
}

/** Wait for the write under way (and one started meanwhile). */
async function settleWrites(): Promise<void> {
  while (writing) await writing;
}

/**
 * Write unsaved tab changes into the open notebook's ui_state. `barrier`: the
 * save barrier's own write; otherwise nothing is written while the barrier
 * holds this notebook (a switch may be about to swap the database).
 */
async function writeNow(barrier = false): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  await settleWrites();
  if (!dirty || !notebook || loading) return;
  if (!barrier && heldFor(notebook)) return; // stays dirty: written after the hold
  dirty = false;
  const key = notebook;
  const json = serializeTabs(stateForSave());
  const p = (async () => {
    // Only into the notebook the tabs belong to. The check and the write are
    // not atomic: the barrier waits for this write before any switch runs,
    // and no write starts after the barrier (the hold), so nothing can switch
    // in between.
    const current = await api.getCurrentNotebook().catch(() => null);
    if (current !== key) return;
    await api.setUiState(TABS_UI_KEY, json).catch(() => { /* best effort: the next change retries */ });
  })();
  writing = p;
  try {
    await p;
  } finally {
    if (writing === p) writing = null;
  }
}

/** Write unsaved tab changes now, as the debounce timer would (not while the barrier holds). */
export function flushTabs(): Promise<void> {
  return writeNow();
}

/**
 * The save barrier (before a notebook switch or lock): what a step was waiting
 * for, the last write (after the one under way), then a hold — no further write
 * for this notebook until it is unloaded or BARRIER_HOLD_MS have passed.
 */
async function barrierFlush(): Promise<void> {
  pendingAtFlush = pendingNav();
  const key = notebook;
  if (key) {
    if (hold) clearTimeout(hold.timer);
    const timer = setTimeout(() => {
      // Nothing switched (a failed switch, a lock): saving resumes.
      if (hold?.timer !== timer) return;
      hold = null;
      pendingAtFlush = null;
      if (dirty) scheduleSave();
    }, BARRIER_HOLD_MS);
    hold = { notebook: key, timer };
  }
  await writeNow(true);
  await settleWrites();
}

registerFlush(barrierFlush);

// ── Notebooks ──

/**
 * Splice the live history `live` onto `dest` (the arrival notebook's active tab)
 * after a cross-notebook link or step into `key`: the destination keeps its own
 * past, then the way here — so Back returns to the source notebook.
 */
function arrive(dest: { entries: NavEntry[]; index: number } | null, live: { entries: NavEntry[]; index: number }, key: string): { entries: NavEntry[]; index: number } {
  const past = dest && dest.index >= 0 ? dest.entries.slice(0, dest.index + 1) : [];
  const c = live.index;
  const cur = live.entries[c];
  if (!cur) return { entries: past, index: past.length - 1 };
  if (cur.notebook !== key) {
    // Not arrived yet (a link): the source place, then the target is appended on arrival.
    const entries = [...past, cur];
    return { entries, index: entries.length - 1 };
  }
  if (past.length && sameEntry(past[past.length - 1], cur)) {
    // A step back to where this tab already was: keep its past, and what lies ahead.
    return { entries: [...past, ...live.entries.slice(c + 1)], index: past.length - 1 };
  }
  let s = c;
  while (s > 0 && live.entries[s - 1].notebook === key) s--;
  const from = Math.max(0, s - 1);
  const entries = [...past, ...live.entries.slice(from)];
  return { entries, index: past.length + (c - from) };
}

let loadPromise: Promise<void> = Promise.resolve();

/**
 * Load notebook `key`'s tabs (saving the previous notebook's first). See
 * App calls it on every notebook (re)open (one tab whose entry App's first
 * `noteLocation` fills when nothing was saved). Already loaded / loading: the load under way (so App can
 * await it before choosing the first page).
 */
export function loadNotebookTabs(key: string): Promise<void> {
  if (!key || key === notebook) return loadPromise;
  loadPromise = loadTabsOf(key);
  return loadPromise;
}

async function loadTabsOf(key: string, retry = true): Promise<void> {
  const token = ++loadToken;
  // The previous notebook: the save barrier wrote it before the switch; keep its closed stack.
  if (notebook) closedByNotebook.set(notebook, closed);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  dirty = false;
  releaseHold();
  bgRun = null;
  const p = pendingNav() ?? pendingAtFlush;
  pendingAtFlush = null;
  const before = exportHistory();
  const byNav = (!!p && (!p.notebook || p.notebook === key))
    || (isRestoring() && currentEntry(before)?.notebook === key);
  notebook = key;
  loading = true;
  closed = closedByNotebook.get(key) ?? [];
  // Meanwhile one tab: the live history (no other notebook's tabs in the row).
  tabs = [{ id: newId(), entries: before.entries, index: before.index, pinned: false }];
  activeId = tabs[0].id;
  emit();
  let saved: TabsState | null = null;
  try {
    // A write that started before the switch has landed (or not) before we read.
    await settleWrites();
    const json = await api.getUiState(TABS_UI_KEY);
    saved = json ? parseTabs(json, key) : null;
  } catch (err) {
    // Unreadable: not loaded — nothing is saved over its tabs. A notebook that
    // opened locked loads them on the next open (after unlocking); any other
    // failure is retried once a little later.
    if (token !== loadToken) return;
    loading = false;
    notebook = "";
    if (retry && !/NOTEBOOK_LOCKED/i.test(String((err as { message?: string })?.message ?? err))) {
      setTimeout(() => {
        if (token !== loadToken || notebook) return; // something else loaded meanwhile
        void api.getCurrentNotebook().then(cur => {
          if (cur === key && token === loadToken && !notebook) {
            loadPromise = loadTabsOf(key, false);
          }
        }).catch(() => {});
      }, LOAD_RETRY_MS);
    }
    return;
  }
  if (token !== loadToken) return;
  loading = false;
  const live = exportHistory();
  const restoredActive = saved?.tabs.find(t => t.id === saved!.activeId) ?? null;
  let history: { entries: NavEntry[]; index: number };
  // Where the user was in the previous notebook (a switch while the app runs —
  // the switcher, the palette): Back returns there, as it did before tabs.
  const cur = currentEntry(live);
  const from = cur && cur.notebook && cur.notebook !== key ? cur : null;
  if (byNav) {
    history = arrive(restoredActive, live, key);
  } else if (restoredActive) {
    const i = restoredActive.index;
    const es = restoredActive.entries;
    if (from && i >= 0) {
      // Back returns to `from`. Coming back and forth: the copy saved last
      // time is replaced by the latest place, never piled up.
      const keep = i > 0 && sameEntry(es[i - 1], from) ? i - 1 : i;
      const entries = [...es.slice(0, keep), from, ...es.slice(i)];
      history = { entries, index: keep + 1 };
    } else {
      history = { entries: es, index: restoredActive.index };
    }
  } else {
    // A fresh notebook: what App opened here (the trailing run of this notebook's
    // places), after the place the user came from in another notebook.
    let s = live.index;
    if (s >= 0 && live.entries[s]?.notebook === key) {
      while (s > 0 && live.entries[s - 1].notebook === key) s--;
      if (s > 0) s--; // the other notebook's place just before the run
      history = { entries: live.entries.slice(s, live.index + 1), index: live.index - s };
    } else if (from) {
      history = { entries: [from], index: 0 }; // App's first location here is appended
    } else {
      history = { entries: [], index: -1 };
    }
  }
  if (saved && restoredActive) {
    tabs = saved.tabs.map(t => (t.id === restoredActive.id ? { ...t, entries: history.entries, index: history.index } : t));
    activeId = restoredActive.id;
  } else {
    tabs = [{ id: newId(), entries: history.entries, index: history.index, pinned: false }];
    activeId = tabs[0].id;
  }
  importHistory(history, { keepRestoring: byNav });
  if (!isRestoring()) settledIndex = exportHistory().index;
  emit();
  // Restored tabs: App opens the active tab's place (unless it is already there).
  if (!byNav && restoredActive && !sameEntry(currentEntry(live), currentEntry(history))) void goToCurrent();
}

/** Tests: back to one empty tab, no notebook. */
export function resetTabsForTests(): void {
  loadToken++;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  dirty = false;
  loading = false;
  notebook = "";
  closed = [];
  closedByNotebook.clear();
  pendingAtFlush = null;
  releaseHold();
  bgRun = null;
  writing = null;
  tabs = [{ id: newId(), entries: [], index: -1, pinned: false }];
  activeId = tabs[0].id;
  importHistory({ entries: [], index: -1 });
  emit();
}
