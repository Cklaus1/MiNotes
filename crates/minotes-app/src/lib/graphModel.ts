/**
 * The Graph view's model, without the canvas: which pages are shown (local
 * graph, project / tag / orphan filters), how they are coloured, and which node
 * an arrow key moves to. Pure functions, unit-tested in graphModel.test.ts.
 */
import type { GraphData, GraphNode } from "./api";

export type ColorBy = "none" | "project" | "tag";

export interface GraphFilters {
  /** Local graph: only pages within `depth` links of `centerId` (both directions). */
  local: { centerId: string; depth: number } | null;
  /** A project (folder) id, "__none__" for pages outside any project, or null for all. */
  project: string | null;
  /** A tag (lower-case, no `#`), or null for all. */
  tag: string | null;
  /** Only pages with no link in either direction. */
  orphansOnly: boolean;
  /** Hide pages with no link in either direction (ignored with orphansOnly). */
  hideUnlinked: boolean;
}

export const NO_PROJECT = "__none__";

/** Undirected adjacency of the whole graph (self-links and dangling edges dropped). */
export function adjacency(data: GraphData): Map<string, Set<string>> {
  const known = new Set(data.nodes.map((n) => n.id));
  const adj = new Map<string, Set<string>>();
  for (const id of known) adj.set(id, new Set());
  for (const e of data.edges) {
    if (e.source === e.target || !known.has(e.source) || !known.has(e.target)) continue;
    adj.get(e.source)!.add(e.target);
    adj.get(e.target)!.add(e.source);
  }
  return adj;
}

/** Pages within `depth` hops of `center` (center included), with their distance. */
export function neighbourhood(adj: Map<string, Set<string>>, center: string, depth: number): Map<string, number> {
  const dist = new Map<string, number>();
  if (!adj.has(center)) return dist;
  dist.set(center, 0);
  let frontier = [center];
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const n of adj.get(id) ?? []) {
        if (dist.has(n)) continue;
        dist.set(n, d);
        next.push(n);
      }
    }
    frontier = next;
  }
  return dist;
}

/** The pages the graph shows for these filters. */
export function visibleNodes(data: GraphData, adj: Map<string, Set<string>>, f: GraphFilters): GraphNode[] {
  const local = f.local ? neighbourhood(adj, f.local.centerId, f.local.depth) : null;
  return data.nodes.filter((n) => {
    const linked = (adj.get(n.id)?.size ?? 0) > 0;
    if (local && !local.has(n.id)) return false;
    if (f.orphansOnly) { if (linked) return false; }
    else if (f.hideUnlinked && !linked && !(local && n.id === f.local!.centerId)) return false;
    if (f.project !== null) {
      const p = n.folder_id ?? NO_PROJECT;
      if (p !== f.project) return false;
    }
    if (f.tag !== null && !(n.tags ?? []).includes(f.tag)) return false;
    return true;
  });
}

/** Does `title` match the search text? (case-insensitive, every word somewhere in it) */
export function titleMatches(title: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  const t = title.toLowerCase();
  return q.split(/\s+/).every((w) => t.includes(w));
}

export interface Category { key: string; label: string; count: number }

/** Max distinct colours in the legend; the rest share "Other". */
export const MAX_CATEGORIES = 7;
export const OTHER = "__other__";

/**
 * The colour categories for `nodes`: projects or (first) tags, most common
 * first, at most MAX_CATEGORIES (+ "Other"); `categoryOf` maps each node id.
 */
export function categories(
  nodes: GraphNode[],
  by: ColorBy,
  projectName: (id: string) => string,
): { list: Category[]; categoryOf: Map<string, string> } {
  const categoryOf = new Map<string, string>();
  if (by === "none") return { list: [], categoryOf };
  const raw = new Map<string, string>(); // node → raw key
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const key = by === "project" ? (n.folder_id ?? NO_PROJECT) : (n.tags?.[0] ?? NO_PROJECT);
    raw.set(n.id, key);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const ranked = [...counts.entries()]
    .filter(([k]) => k !== NO_PROJECT)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const kept = new Set(ranked.slice(0, MAX_CATEGORIES).map(([k]) => k));
  let other = 0;
  for (const [id, key] of raw) {
    const c = key === NO_PROJECT ? NO_PROJECT : kept.has(key) ? key : OTHER;
    categoryOf.set(id, c);
    if (c === OTHER) other++;
  }
  const list: Category[] = ranked.slice(0, MAX_CATEGORIES).map(([k, count]) => ({
    key: k, count, label: by === "project" ? projectName(k) : `#${k}`,
  }));
  if (other > 0) list.push({ key: OTHER, label: "Other", count: other });
  const none = counts.get(NO_PROJECT) ?? 0;
  if (none > 0) list.push({ key: NO_PROJECT, label: by === "project" ? "No project" : "No tag", count: none });
  return { list, categoryOf };
}

export type ArrowKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

const DIRS: Record<ArrowKey, { x: number; y: number }> = {
  ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 }, ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 },
};

interface Pt { id: string; x: number; y: number }

/**
 * The node an arrow key moves to from `from`: the neighbour (linked page)
 * best in that direction — within 75° of it, nearest along it and least off to
 * the side. With no neighbour that way, the nearest node of all in that
 * direction, so the keyboard can reach unlinked pages too. Null: nothing there.
 */
export function stepTo(from: Pt, key: ArrowKey, neighbours: Pt[], all: Pt[]): string | null {
  const d = DIRS[key];
  const best = (cands: Pt[]) => {
    let pick: Pt | null = null;
    let score = Infinity;
    for (const c of cands) {
      if (c.id === from.id) continue;
      const dx = c.x - from.x, dy = c.y - from.y;
      const along = dx * d.x + dy * d.y;
      if (along <= 0) continue;
      const side = Math.abs(dx * d.y - dy * d.x);
      if (side > along * Math.tan((75 * Math.PI) / 180)) continue;
      const s = along + side * 2;
      if (s < score) { score = s; pick = c; }
    }
    return pick;
  };
  return (best(neighbours) ?? best(all))?.id ?? null;
}
