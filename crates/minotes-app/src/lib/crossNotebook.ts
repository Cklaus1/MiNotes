/**
 * Cross-notebook links: `[[Notebook::Page title]]` (core `cross_notebook.rs`).
 *
 * The chip is rendered by WikiLinkNode as `<span class="xnb-link"
 * data-notebook data-page-name>` showing "Notebook › Page"; `hydrateNotebookLinks`
 * then resolves it (batched, cached) to the target's CURRENT name and title —
 * by the ids link sync stored, so renames don't break it — or marks it "not
 * found". Clicking asks App (OPEN_IN_NOTEBOOK) to switch notebooks and open the
 * page. Such a link never creates a page, here or there.
 */
import * as api from "./api";
import { showToast } from "./toast";
import { NOTEBOOK_SWITCHED, NOTEBOOKS_CHANGED } from "./notebooks";

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
    case "page_missing": return `Not found: no page “${page}” in notebook ${t.notebook_name ?? notebook}`;
    case "notebook_missing": return `Not found: no notebook named “${notebook}”`;
    case "unavailable": return `Notebook ${t.notebook_name ?? notebook} is ${t.detail ?? "not available"} right now`;
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
      showToast(`Notebook ${t.notebook_name ?? notebook} has no page “${page}”. Links to another notebook never create pages — create it there first.`);
      return;
    case "notebook_missing":
      showToast(`There is no notebook named “${notebook}”. [[Notebook::Page]] links to a page in another notebook — check the name in the notebook menu.`);
      return;
    case "unavailable":
      showToast(`Notebook ${t.notebook_name ?? notebook} is ${t.detail ?? "not available"} right now.`);
      return;
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
