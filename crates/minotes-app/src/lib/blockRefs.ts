/**
 * What a `((uuid))` block reference shows (C-12): the referenced block's text,
 * live. One cache of referenced blocks for the whole app, filled in batches
 * (one get_blocks call per tick), kept current by the app's own edits
 * (`noteBlockContent`) and refreshed when a page is (re)loaded.
 *
 * Chips are `.block-ref[data-block-id]` elements — in static blocks
 * (staticRender clones) and in live editors (BlockRefNode's node view). Every
 * chip in the document is relabelled when its block changes, so there is no
 * per-chip subscription to leak. Embed cards (`{{embed ((uuid))}}`) subscribe
 * through `subscribeBlockRefs`.
 */
import * as api from "./api";

export interface RefBlock {
  id: string;
  content: string;
  pageTitle: string;
  pageId: string;
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** id -> block, or null when it doesn't exist (deleted / never existed). */
const cache = new Map<string, RefBlock | null>();
const pending = new Set<string>();
let scheduled = false;
const listeners = new Set<() => void>();

/** Plain one-line text of a block's markdown, as a reference chip shows it. */
export function refLabel(markdown: string, max = 80): string {
  let s = markdown.split("\n").find(l => l.trim()) ?? "";
  s = s
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "")
    .replace(/^\s*>\s?/, "")
    .replace(/^(TODO|DOING|DONE)\s+/, "")
    .replace(/\{\{todo:(?:pending|doing|done)\}\}\s*/g, "")
    .replace(/\{\{embed \(\([^)]*\)\)\}\}/g, "…")
    .replace(/\(\([0-9a-fA-F-]{8,36}\)\)/g, "…")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, (_, t: string) => t.includes("::") ? t.split("::").pop()! : t)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|==)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\s](?:[^*_]*[^*_\s])?)[*_](?![\w*])/g, "$1$2")
    .replace(/`([^`]*)`/g, "$1")
    .trim();
  if (!s) return markdown.trim() ? "…" : "(empty block)";
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

const chipText = (id: string): string | null => {
  if (!cache.has(id)) return null;
  const b = cache.get(id);
  return b ? refLabel(b.content) : "(deleted block)";
};

/** Label every chip of `ids` (default: every cached id) in `root` (default: the document). */
function relabel(root: ParentNode = document, ids?: Set<string>) {
  for (const el of root.querySelectorAll<HTMLElement>(".block-ref[data-block-id]")) {
    if (el.classList.contains("block-embed-chip")) continue;
    const id = el.getAttribute("data-block-id")!;
    if (ids && !ids.has(id)) continue;
    const text = chipText(id);
    if (text === null) continue;
    if (el.textContent !== text) el.textContent = text;
    el.classList.toggle("block-ref-missing", cache.get(id) === null);
    const b = cache.get(id);
    el.title = b ? `${b.pageTitle} — click to open` : "This block no longer exists";
  }
}

function notify(ids: Set<string>) {
  if (typeof document !== "undefined") relabel(document, ids);
  for (const l of listeners) { try { l(); } catch {} }
}

async function flush() {
  scheduled = false;
  const ids = [...pending];
  pending.clear();
  if (ids.length === 0) return;
  const valid = ids.filter(id => UUID.test(id));
  const found = new Map<string, RefBlock>();
  try {
    if (valid.length) {
      for (const b of await api.getBlocks(valid)) {
        found.set(b.id, { id: b.id, content: b.content, pageTitle: b.page_title, pageId: b.page_id });
      }
    }
  } catch {
    return; // backend unavailable (locked, switching): keep what we had
  }
  for (const id of ids) cache.set(id, found.get(id) ?? null);
  notify(new Set(ids));
}

/** Fetch these blocks (batched; `force` refetches cached ones too). */
export function requestBlockRefs(ids: Iterable<string>, force = false) {
  for (const id of ids) if (force || !cache.has(id)) pending.add(id);
  if (pending.size && !scheduled) {
    scheduled = true;
    queueMicrotask(() => { void flush(); });
  }
}

/** Fill the chips under `root` from the cache and fetch the ones not known yet. */
export function hydrateBlockRefs(root: ParentNode) {
  const missing: string[] = [];
  for (const el of root.querySelectorAll<HTMLElement>(".block-ref[data-block-id]")) {
    const id = el.getAttribute("data-block-id");
    if (id && !cache.has(id)) missing.push(id);
  }
  relabel(root);
  if (missing.length) requestBlockRefs(missing);
}

/** A block's content changed in this app: chips and cards showing it follow. */
export function noteBlockContent(id: string, content: string) {
  const b = cache.get(id);
  if (b === undefined) return; // nobody references it (as far as we know)
  if (b && b.content === content) return;
  cache.set(id, b ? { ...b, content } : null);
  if (!b) requestBlockRefs([id], true);
  else notify(new Set([id]));
}

/** What we already know about a block (e.g. from the (( picker). */
export function primeBlockRef(block: RefBlock) {
  cache.set(block.id, block);
}

/** Re-read every referenced block currently shown (a page was loaded or refreshed). */
export function refreshShownBlockRefs() {
  if (typeof document === "undefined") return;
  const ids = new Set<string>();
  for (const el of document.querySelectorAll(".block-ref[data-block-id]")) ids.add(el.getAttribute("data-block-id")!);
  for (const el of document.querySelectorAll("[data-embed-id]")) ids.add(el.getAttribute("data-embed-id")!);
  if (ids.size) requestBlockRefs(ids, true);
}

export function getBlockRef(id: string): RefBlock | null | undefined {
  return cache.get(id);
}

export function subscribeBlockRefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test hook: forget everything. */
export function resetBlockRefs() {
  cache.clear();
  pending.clear();
}
