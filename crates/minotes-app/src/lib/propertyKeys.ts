/**
 * Property keys for the key autocomplete (components/PropertyEditor.tsx): the
 * keys in use in this notebook, most used first, cached for a few seconds.
 */
import * as api from "./api";

let cache: string[] = [];
let loadedAt = 0;
let inflight: Promise<string[]> | null = null;
const TTL_MS = 5000;

/** Keys in use (refreshed at most every few seconds). */
export function propertyKeys(): Promise<string[]> {
  if (Date.now() - loadedAt < TTL_MS) return Promise.resolve(cache);
  if (!inflight) {
    inflight = api.listPropertyKeys(undefined, 200)
      .then((keys) => { cache = keys; loadedAt = Date.now(); return keys; })
      .catch(() => cache)
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/** A key was just used: offer it next time without waiting for a reload. */
export function notePropertyKey(key: string) {
  if (!cache.includes(key)) cache = [key, ...cache];
}

/** Suggestions for what was typed: keys starting with it first, then containing it. */
export function suggestKeys(keys: readonly string[], typed: string, exclude: readonly string[] = [], max = 8): string[] {
  const q = typed.trim().toLowerCase();
  const skip = new Set(exclude.map((k) => k.toLowerCase()));
  const pool = keys.filter((k) => !skip.has(k.toLowerCase()) && k.toLowerCase() !== q);
  if (!q) return pool.slice(0, max);
  const starts = pool.filter((k) => k.toLowerCase().startsWith(q));
  const contains = pool.filter((k) => !k.toLowerCase().startsWith(q) && k.toLowerCase().includes(q));
  return [...starts, ...contains].slice(0, max);
}

/**
 * Bookkeeping the importer writes on every imported page (core `import`):
 * hashes and run ids that re-import and "undo import" match on. They stay in
 * the database but are never drawn or suggested; `import_source` ("evernote",
 * "obsidian"…) is the readable one and stays visible.
 */
const INTERNAL_KEYS = new Set(["import_hash", "import_src_hash", "import_ref", "import_run", "import_origin", "import_report"]);

export function isInternalProperty(key: string): boolean {
  return INTERNAL_KEYS.has(key);
}
