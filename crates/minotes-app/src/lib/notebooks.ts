/**
 * Notebook helpers shared by the sidebar switcher, the notebook dialogs, the
 * banners and App: switching (with per-notebook UI state), the folder picker
 * (native dialog, with a test hook), and the events that tie them together.
 */
import { useEffect, useState } from "react";
import * as api from "./api";
import { showToast } from "./toast";
import { errorMessage } from "./errors";
import { undoStack } from "./undoStack";

/** Fired after the open notebook changed (detail: { key }). App resets its views. */
export const NOTEBOOK_SWITCHED = "minotes-notebook-switched";
/** Fired when the notebook list or the open notebook's details changed. */
export const NOTEBOOKS_CHANGED = "minotes-notebooks-changed";

/** localStorage keys whose content belongs to one notebook (ids differ per notebook). */
const PER_NOTEBOOK_KEYS = ["minotes-recent-pages", "minotes-expanded-projects"];

const scoped = (key: string, notebook: string) => `${key}@notebook:${notebook}`;

/** Park the per-notebook localStorage entries of `from` and bring in those of `to`. */
function swapLocalState(from: string, to: string) {
  if (from === to) return;
  try {
    for (const k of PER_NOTEBOOK_KEYS) {
      const cur = localStorage.getItem(k);
      if (cur === null) localStorage.removeItem(scoped(k, from));
      else localStorage.setItem(scoped(k, from), cur);
      const next = localStorage.getItem(scoped(k, to));
      if (next === null) localStorage.removeItem(k);
      else localStorage.setItem(k, next);
    }
  } catch {
    /* storage unavailable: nothing to isolate */
  }
}

let switching = false;

/**
 * Open another notebook. Undo history belongs to a notebook, so it is cleared;
 * recent pages and sidebar state are swapped; App closes views and lands on the
 * new notebook's journal for today (it listens for NOTEBOOK_SWITCHED).
 */
export async function switchNotebook(key: string): Promise<void> {
  if (switching) return;
  switching = true;
  try {
    const from = await api.getCurrentNotebook();
    if (from === key) return;
    await api.switchNotebook(key);
    swapLocalState(from, key);
    undoStack.clear();
    window.dispatchEvent(new CustomEvent(NOTEBOOK_SWITCHED, { detail: { key, from } }));
    window.dispatchEvent(new Event(NOTEBOOKS_CHANGED));
  } finally {
    switching = false;
  }
}

/** Tell every notebook view to reload (after create / rename / delete / move). */
export function notebooksChanged() {
  window.dispatchEvent(new Event(NOTEBOOKS_CHANGED));
}

// ── Folder picker ──

let nextPicked: string | null | undefined;

/**
 * Test hook: the next pickFolder() returns `path` (null = cancelled) instead of
 * opening the native dialog, which automation can't drive.
 */
export function setNextPickedFolder(path: string | null) {
  nextPicked = path;
}

/** Ask the user for a folder. Native dialog in the app; a prompt in browser mode. */
export async function pickFolder(title: string, defaultPath?: string): Promise<string | null> {
  if (nextPicked !== undefined) {
    const p = nextPicked;
    nextPicked = undefined;
    return p;
  }
  if (api.isTauri) {
    const r = await api.pickFolderNative(title, defaultPath);
    return typeof r === "string" ? r : null;
  }
  const r = window.prompt(`${title} (folder path)`, defaultPath ?? "");
  return r?.trim() ? r.trim() : null;
}

/** "3 KB", "1.2 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "just now", "5 min ago", "2 h ago", else a date. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "never";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleString();
}

/** Shorten a path for display: the home dir becomes ~. */
export function prettyPath(p: string, home?: string): string {
  if (home && p.startsWith(home + "/")) return "~" + p.slice(home.length);
  return p.replace(/^\/home\/[^/]+(?=\/)/, "~").replace(/^\/root(?=\/)/, "~");
}

/** Keep the end of a long path (the part that tells folders apart): "…/MiNotes/Work". */
export function tailPath(p: string, max = 34): string {
  return p.length <= max ? p : "…" + p.slice(p.length - max + 1);
}

// ── Platform capabilities (from the backend; never UA sniffing) ──

/** Desktop defaults: what browser mode and the first render assume. */
export const DESKTOP_CAPABILITIES: api.PlatformCapabilities = {
  platform: "desktop", mobile: false, app_storage: false, choose_location: true, open_folder: true,
  reveal_folder: true, move_to_folder: true, outside_edits: true, mirror_always: true,
  import_from_files: true, keychain: true, notebook_zip: true,
};

let capsPromise: Promise<api.PlatformCapabilities> | null = null;
let capsValue: api.PlatformCapabilities = DESKTOP_CAPABILITIES;

/** The platform's capabilities (fetched once). */
export function platformCapabilities(): Promise<api.PlatformCapabilities> {
  if (!capsPromise) {
    capsPromise = api.getPlatformCapabilities()
      .then(c => { capsValue = c ? { ...DESKTOP_CAPABILITIES, ...c } : DESKTOP_CAPABILITIES; return capsValue; })
      .catch(() => DESKTOP_CAPABILITIES);
  }
  return capsPromise;
}

/** React hook: the capabilities (desktop defaults until the backend answered). */
export function useCapabilities(): api.PlatformCapabilities {
  const [caps, setCaps] = useState<api.PlatformCapabilities>(capsValue);
  useEffect(() => {
    let live = true;
    platformCapabilities().then(c => { if (live) setCaps(c); });
    return () => { live = false; };
  }, []);
  return caps;
}

// ── Notebook .zip export / import ──

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

let nextZipPick: string | null | undefined;
let nextExportDest: string | null | undefined;

/** Test hook: the next "Import notebook…" uses this file (null = cancelled). */
export function setNextZipPick(path: string | null) {
  nextZipPick = path;
}

/** Test hook: the next "Export notebook…" writes here instead of asking. */
export function setNextExportDest(path: string | null) {
  nextExportDest = path;
}

/** "Export notebook…": a .zip of the notebook (default: the open one), saved
 *  where the user picks. Shows a toast; returns what was written, or null. */
export async function exportNotebook(nb?: { key: string; name: string }): Promise<api.ZipExport | null> {
  const dest = nextExportDest;
  nextExportDest = undefined;
  try {
    const r = await api.exportNotebookZip(nb?.key ?? null, dest ?? null);
    if (r) showToast(`Exported “${r.name}”: ${count(r.pages, "page")}, ${count(r.attachments, "file")}, ${formatSize(r.bytes)}`);
    return r ?? null;
  } catch (e) {
    showToast(`Couldn't export the notebook: ${errorMessage(e)}`);
    return null;
  }
}

/** "Import notebook…": pick a notebook .zip, add it as a new notebook and open
 *  it. Never replaces an existing notebook. */
export async function importNotebookFromZip(): Promise<api.ZipImport | null> {
  let source: string | null;
  if (nextZipPick !== undefined) {
    source = nextZipPick;
    nextZipPick = undefined;
  } else if (api.isTauri) {
    const r = await api.pickZipNative("Import a MiNotes notebook (.zip)");
    source = typeof r === "string" ? r : null;
  } else {
    const r = window.prompt("Notebook .zip to import (path)");
    source = r?.trim() ? r.trim() : null;
  }
  if (!source) return null;
  try {
    const r = await api.importNotebookZip(source);
    await switchNotebook(r.notebook.key);
    notebooksChanged();
    const renamed = r.renamed_from ? ` as “${r.notebook.name}” (“${r.renamed_from}” already exists)` : ` “${r.notebook.name}”`;
    const skipped = r.skipped.length ? ` ${r.skipped.length} damaged file(s) were left out.` : "";
    showToast(`Imported notebook${renamed}: ${count(r.pages, "page")}, ${count(r.attachments, "file")}.${skipped}`);
    return r;
  } catch (e) {
    showToast(`Couldn't import that notebook: ${errorMessage(e)}`);
    return null;
  }
}
