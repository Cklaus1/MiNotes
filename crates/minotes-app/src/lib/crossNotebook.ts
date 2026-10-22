/**
 * Cross-notebook links: `[[Notebook::Page title]]` (core `cross_notebook.rs`).
 *
 * The chip is rendered by WikiLinkNode as `<span class="xnb-link"
 * data-notebook data-page-name>` showing "Notebook › Page"; `hydrateNotebookLinks`
 * then resolves it (batched, cached) to the target's CURRENT name and title —
 * by the ids link sync stored, so renames don't break it — or marks it "not
 * found". Clicking asks App (OPEN_IN_NOTEBOOK) to switch notebooks and open the
 * page. Following a link never creates a page silently: a "not found" chip in
 * an existing notebook asks first ("Create page in <Notebook>"), and a chip
 * into a locked notebook offers "Unlock and open" (the passphrase in-app).
 */
import * as api from "./api";
import { showToast } from "./toast";
import { NOTEBOOK_SWITCHED, NOTEBOOKS_CHANGED, switchNotebook } from "./notebooks";
import { askPassphrase, unlock } from "./encryption";
import { confirmDialog } from "./confirm";
import { errorMessage } from "./errors";
import { setPendingNav } from "./navHistory";

export const NOTEBOOK_SEP = "::";

/** `Notebook::Page` → its parts (both non-empty after trimming), else null. */
export function splitNotebookLink(target: string): { notebook: string; page: string } | null {
  const i = target.indexOf(NOTEBOOK_SEP);
  if (i < 0) return null;
  const notebook = target.slice(0, i).trim();
  const page = target.slice(i + NOTEBOOK_SEP.length).trim();
  if (!notebook || !page || /[[\]]/.test(notebook)) return null;
  return { notebook, page };
}

/** The chip's text before (or without) resolution. */
export function notebookLinkLabel(notebook: string, page: string): string {
  return `${notebook} › ${page}`;
}

// ── Opening a page in another notebook ──

/** App listens: switch to `key` (if not open), open `pageId`, reveal `blockId`. */
export const OPEN_IN_NOTEBOOK = "minotes-open-in-notebook";
export interface OpenInNotebook {
  /** Notebook key; empty = the open notebook. */
  key: string;
  pageId: string;
  blockId?: string;
  /** Open (or create) by title instead of id. */
  title?: string;
}
export function openInNotebook(detail: OpenInNotebook) {
  window.dispatchEvent(new CustomEvent<OpenInNotebook>(OPEN_IN_NOTEBOOK, { detail }));
}

// ── Resolution: batched into one IPC call per tick, cached briefly ──

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; p: Promise<api.LinkTarget> }>();
let queue: Array<{ ref: api.LinkRef; resolve: (t: api.LinkTarget) => void; reject: (e: unknown) => void }> = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const refKey = (r: api.LinkRef) =>
  `${r.block_id ?? ""}\u0000${r.notebook.trim().toLowerCase()}\u0000${r.page.trim().toLowerCase()}`;

function flush() {
  flushTimer = null;
  const batch = queue;
  queue = [];
  if (batch.length === 0) return;
  api.resolveNotebookLinks(batch.map(b => b.ref)).then(
    (targets) => batch.forEach((b, i) => targets[i] ? b.resolve(targets[i]) : b.reject(new Error("no result"))),
    (e) => batch.forEach(b => b.reject(e)),
  );
}

export function resolveNotebookLink(ref: api.LinkRef, fresh = false): Promise<api.LinkTarget> {
  const k = refKey(ref);
  const hit = cache.get(k);
  if (hit && !fresh && Date.now() - hit.at < TTL_MS) return hit.p;
  const p = new Promise<api.LinkTarget>((resolve, reject) => {
    queue.push({ ref, resolve, reject });
    if (!flushTimer) flushTimer = setTimeout(flush, 0);
  });
  cache.set(k, { at: Date.now(), p });
  p.catch(() => cache.delete(k));
  return p;
}

export function clearNotebookLinkCache() {
  cache.clear();
}

if (typeof window !== "undefined") {
  window.addEventListener(NOTEBOOK_SWITCHED, clearNotebookLinkCache);
  window.addEventListener(NOTEBOOKS_CHANGED, clearNotebookLinkCache);
}

const OK_STATUSES = new Set<api.LinkStatus>(["ok", "local"]);

function tooltip(t: api.LinkTarget, notebook: string, page: string): string {
  switch (t.status) {
    case "ok": return t.current
      ? `Open “${t.page_title}”`
      : `Open “${t.page_title}” in notebook ${t.notebook_name}`;
    case "local": return `Open “${t.page_title}”`;
    case "page_missing": return `Not found: no page “${page}” in notebook ${t.notebook_name ?? notebook} — click to create it there`;
    case "notebook_missing": return `Not found: no notebook named “${notebook}”`;
    case "unavailable": return isLocked(t)
      ? `Notebook ${t.notebook_name ?? notebook} is locked — click to unlock it and open “${page}”`
      : `Notebook ${t.notebook_name ?? notebook} is ${t.detail ?? "not available"} right now`;
  }
}

function apply(el: HTMLElement, t: api.LinkTarget, notebook: string, page: string) {
  el.dataset.xnbStatus = t.status;
  const label = t.status === "ok"
    ? notebookLinkLabel(t.notebook_name ?? notebook, t.page_title ?? page)
    : t.status === "local" ? (t.page_title ?? page)
    : notebookLinkLabel(t.notebook_name ?? notebook, page);
  if (el.textContent !== label) el.textContent = label;
  el.classList.toggle("xnb-missing", !OK_STATUSES.has(t.status));
  // Not a dead end: a locked notebook can be unlocked, a missing page created.
  el.classList.toggle("xnb-actionable", isLocked(t) || (t.status === "page_missing" && !!t.notebook_key));
  el.dataset.xnbAction = isLocked(t) ? "unlock" : t.status === "page_missing" && t.notebook_key ? "create" : "";
  el.title = tooltip(t, notebook, page);
}

/** Resolve every `.xnb-link` chip under `root` and show what it points at. */
export function hydrateNotebookLinks(root: ParentNode | null | undefined) {
  if (!root) return;
  root.querySelectorAll<HTMLElement>(".xnb-link").forEach((el) => {
    const notebook = el.dataset.notebook;
    const page = el.dataset.pageName;
    if (!notebook || !page) return;
    const blockId = el.closest<HTMLElement>("[data-block-id]")?.dataset.blockId ?? null;
    const req = refKey({ block_id: blockId, notebook, page });
    el.dataset.xnbReq = req;
    resolveNotebookLink({ block_id: blockId, notebook, page })
      .then((t) => { if (el.dataset.xnbReq === req) apply(el, t, notebook, page); })
      .catch(() => { /* leave the plain chip */ });
  });
}

/** Follow a link: open the page (switching notebooks), or explain why not. */
export async function followNotebookLink(notebook: string, page: string, blockId?: string | null) {
  let t: api.LinkTarget;
  try {
    t = await resolveNotebookLink({ block_id: blockId ?? null, notebook, page }, true);
  } catch (e) {
    showToast(`Couldn't open ${notebookLinkLabel(notebook, page)}: ${String((e as any)?.message ?? e)}`);
    return;
  }
  switch (t.status) {
    case "ok":
      openInNotebook({ key: t.current ? "" : t.notebook_key!, pageId: t.page_id! });
      return;
    case "local":
      openInNotebook({ key: "", pageId: t.page_id! });
      return;
    case "page_missing":
      if (t.notebook_key) {
        await createPageInNotebook(t.notebook_key, t.notebook_name ?? notebook, page, !!t.current);
        return;
      }
      showToast(`Notebook ${t.notebook_name ?? notebook} has no page “${page}”.`);
      return;
    case "notebook_missing":
      showToast(`There is no notebook named “${notebook}”. [[Notebook::Page]] links to a page in another notebook — check the name in the notebook menu.`);
      return;
    case "unavailable":
      if (isLocked(t) && t.notebook_key) {
        await unlockAndOpen(t.notebook_key, t.notebook_name ?? notebook, page);
        return;
      }
      showToast(`Notebook ${t.notebook_name ?? notebook} is ${t.detail ?? "not available"} right now.`);
      return;
  }
}

function isLocked(t: api.LinkTarget): boolean {
  return t.status === "unavailable" && /locked/i.test(t.detail ?? "");
}

/**
 * A link into a locked notebook: "Unlock and open" — the passphrase in the
 * app's own prompt, then that notebook opens, unlocked, at the page. A wrong
 * passphrase asks again; Cancel leaves its unlock screen showing (Back returns).
 */
export async function unlockAndOpen(key: string, name: string, page: string): Promise<boolean> {
  let secret = await askPassphrase("Unlock and open", `“${name}” is encrypted and locked. Enter its passphrase to open “${page}”.`);
  if (!secret) return false;
  // App takes this step once the notebook is open and unlocked (lib/navHistory).
  setPendingNav({ notebook: key, kind: "page", title: page });
  try {
    await switchNotebook(key);
  } catch {
    setPendingNav(null);
    return false; // switchNotebook said why
  }
  for (;;) {
    try {
      await unlock(secret);
      return true;
    } catch (e) {
      const msg = errorMessage(e);
      if (!/WRONG_PASSPHRASE/i.test(msg)) {
        showToast(`Couldn't unlock “${name}”: ${msg.replace(/^[A-Z_]+:\s*/, "")}`);
        return false;
      }
      const again = await askPassphrase("Unlock and open", `Wrong passphrase for “${name}” — try again.`);
      if (!again) return false;
      secret = again;
    }
  }
}

/** A link to a page an existing notebook doesn't have: offer to create it there. */
export async function createPageInNotebook(key: string, name: string, page: string, current: boolean): Promise<boolean> {
  const ok = await confirmDialog({
    title: `No page “${page}” in ${name}`,
    message: current
      ? `Create the page “${page}” in this notebook and open it?`
      : `Create the page “${page}” in the notebook ${name}? MiNotes then opens ${name} at the new page.`,
    confirmLabel: `Create page in ${name}`,
  });
  if (!ok) return false;
  // Opening a page by title creates it (App.openPage); the link resolves to it from then on.
  clearNotebookLinkCache();
  if (current) {
    openInNotebook({ key: "", pageId: "", title: page });
    return true;
  }
  setPendingNav({ notebook: key, kind: "page", title: page, create: true });
  try {
    await switchNotebook(key);
    return true;
  } catch {
    setPendingNav(null);
    return false;
  }
}

/** Click on a chip element (static render or live editor). */
export function followNotebookLinkElement(el: HTMLElement) {
  const notebook = el.dataset.notebook;
  const page = el.dataset.pageName;
  if (!notebook || !page) return;
  const blockId = el.closest<HTMLElement>("[data-block-id]")?.dataset.blockId ?? null;
  void followNotebookLink(notebook, page, blockId);
}
