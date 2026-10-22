/**
 * Remembered views per page (PRD-kanban "open as board", PRD-mindmap §5 #6).
 *
 * Page properties, so they sync and survive a device change, and written only
 * on an explicit choice (never by just looking at a board), so browsing never
 * churns sync:
 *   view:: kanban | mindmap   — the page opens as a board / mind map
 *   kanban-group:: status     — the board groups cards by TODO/DOING/DONE
 *   mindmap-layout:: LR | TB | radial
 */
import { useEffect, useRef } from "react";
import * as api from "./api";

export type PageViewMode = "kanban" | "mindmap";
export const VIEW_KEY = "view";
export const KANBAN_GROUP_KEY = "kanban-group";
export const MINDMAP_LAYOUT_KEY = "mindmap-layout";

const cache = new Map<string, Map<string, string>>();

/** The page's view properties (cached per page; refreshed on every write). */
export async function pageViewProps(pageId: string, fresh = false): Promise<Map<string, string>> {
  const hit = cache.get(pageId);
  if (hit && !fresh) return hit;
  const props = await api.getProperties(pageId).catch(() => [] as api.Property[]);
  const m = new Map<string, string>();
  for (const p of props) {
    if (p.key === VIEW_KEY || p.key === KANBAN_GROUP_KEY || p.key === MINDMAP_LAYOUT_KEY) m.set(p.key, (p.value ?? "").trim());
  }
  cache.set(pageId, m);
  return m;
}

/** Set (or with null, remove) one view property on a page. */
export async function setPageViewProp(pageId: string, key: string, value: string | null): Promise<void> {
  if (value === null) await api.deleteProperty(pageId, key);
  else await api.setProperty(pageId, "page", key, value);
  const m = cache.get(pageId) ?? new Map<string, string>();
  if (value === null) m.delete(key); else m.set(key, value);
  cache.set(pageId, m);
  window.dispatchEvent(new CustomEvent("minotes-page-view-changed", { detail: { pageId, key, value } }));
}

/**
 * App: when a page is opened (its id changes), open it in its remembered view.
 * A refresh of the same page doesn't re-open a board the user just closed.
 */
export function useRememberedPageView(pageId: string | null | undefined, open: (mode: PageViewMode) => void): void {
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (!pageId) return;
    let cancelled = false;
    openingView(pageId).then((v) => { if (v && !cancelled) openRef.current(v); }).catch(() => {});
    return () => { cancelled = true; };
  }, [pageId]);
}

/** The view a page opens in, if one was chosen. */
export async function openingView(pageId: string): Promise<PageViewMode | null> {
  const v = (await pageViewProps(pageId, true)).get(VIEW_KEY)?.toLowerCase();
  return v === "kanban" || v === "mindmap" ? v : null;
}
