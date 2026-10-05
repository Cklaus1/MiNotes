// Whiteboard utility functions — separated from Whiteboard.tsx component
// to avoid breaking Vite React Fast Refresh (components-only exports rule)
//
// Storage: whiteboard data lives in the graph's SQLite DB (`whiteboards`
// table, via get_whiteboard / save_whiteboard). Older versions kept it only in
// webview localStorage under `minotes-whiteboard-<id>`; on first load of a
// whiteboard with no DB row, that legacy copy is imported into the DB. The
// localStorage copy is intentionally left in place as a backup.

import { getWhiteboard, saveWhiteboard } from "./api";

const LEGACY_STORAGE_PREFIX = "minotes-whiteboard-";

/** Parsed whiteboard JSON (shape owned by Whiteboard.tsx). */
export type StoredWhiteboard = Record<string, any>;

/** Whiteboard content marker pattern */
export const WHITEBOARD_REGEX = /^\{\{whiteboard:([a-zA-Z0-9-]+)\}\}$/;

// In-memory cache of parsed whiteboard data (only for boards that exist).
const cache = new Map<string, StoredWhiteboard>();
const inflight = new Map<string, Promise<StoredWhiteboard | null>>();

function readLegacy(id: string): string | null {
  try {
    return localStorage.getItem(LEGACY_STORAGE_PREFIX + id);
  } catch {
    return null;
  }
}

function hasContent(d: StoredWhiteboard | undefined | null): boolean {
  if (!d) return false;
  return ["notes", "lines", "images", "texts", "arrows", "boxes"].some(
    (k) => Array.isArray(d[k]) && d[k].length > 0,
  );
}

async function fetchWhiteboard(id: string): Promise<StoredWhiteboard | null> {
  const raw = await getWhiteboard(id);
  if (raw != null) {
    const parsed = JSON.parse(raw) as StoredWhiteboard;
    cache.set(id, parsed);
    return parsed;
  }
  // One-time migration from legacy localStorage storage.
  const legacy = readLegacy(id);
  if (legacy == null) {
    cache.delete(id);
    return null;
  }
  let parsed: StoredWhiteboard;
  try {
    parsed = JSON.parse(legacy);
  } catch {
    return null;
  }
  try {
    await saveWhiteboard(id, legacy);
  } catch (e) {
    console.warn("Whiteboard: failed to import legacy localStorage data into DB", e);
  }
  cache.set(id, parsed);
  return parsed;
}

/**
 * Load a whiteboard's data. `fresh` bypasses the in-memory cache (used when
 * opening the editor); thumbnails use the cache. Missing boards are never
 * cached, so a later legacy-localStorage import is still picked up.
 */
export function loadWhiteboard(id: string, opts: { fresh?: boolean } = {}): Promise<StoredWhiteboard | null> {
  if (!opts.fresh && cache.has(id)) return Promise.resolve(cache.get(id)!);
  const existing = inflight.get(id);
  if (existing) return existing;
  const p = fetchWhiteboard(id).finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

/** Synchronous cache read (undefined if not loaded yet). */
export function getCachedWhiteboard(id: string): StoredWhiteboard | undefined {
  return cache.get(id);
}

/**
 * Persist whiteboard data to the DB. Rejects on failure (callers must surface
 * the error). On success updates the cache and fires `whiteboard-saved`.
 */
export async function persistWhiteboard(id: string, data: StoredWhiteboard): Promise<void> {
  await saveWhiteboard(id, JSON.stringify(data));
  cache.set(id, data);
  window.dispatchEvent(new CustomEvent("whiteboard-saved", { detail: id }));
}

/** Check if a whiteboard has saved (non-empty) data, as far as is known synchronously. */
export function hasWhiteboardData(whiteboardId: string): boolean {
  const cached = cache.get(whiteboardId);
  if (cached) return hasContent(cached);
  return readLegacy(whiteboardId) !== null;
}

/** Generate a new whiteboard ID */
export function generateWhiteboardId(): string {
  return "wb-" + crypto.randomUUID().slice(0, 8);
}
