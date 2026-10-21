/**
 * Pure helpers for a page's block list. Blocks carry `parent_id` + `position`;
 * positions are per parent, so the rendered list must always be rebuilt in
 * outline order (depth-first, siblings by position) after a structural change —
 * never sorted by position alone (C-13).
 */
import type { Block } from "./api";

/** Depth-first outline order (siblings by position) — the order the list renders in. */
export function outlineOrder(list: Block[]): Block[] {
  const ids = new Set(list.map(b => b.id));
  const kids = new Map<string, Block[]>();
  for (const b of list) {
    const key = b.parent_id && ids.has(b.parent_id) ? b.parent_id : "__root__";
    const arr = kids.get(key) ?? [];
    arr.push(b);
    kids.set(key, arr);
  }
  const out: Block[] = [];
  const seen = new Set<string>();
  const walk = (key: string) => {
    for (const b of (kids.get(key) ?? []).slice().sort((x, y) => x.position - y.position)) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      out.push(b);
      walk(b.id);
    }
  };
  walk("__root__");
  // Anything unreachable (cycles) keeps its place at the end rather than vanishing.
  for (const b of list) if (!seen.has(b.id)) out.push(b);
  return out;
}

export type DropWhere = "above" | "below" | "child";

/** True when `id` is `ancestorId` or lies below it. */
export function isInSubtree(list: Block[], id: string, ancestorId: string): boolean {
  const byId = new Map(list.map(b => [b.id, b]));
  for (let p: string | undefined = id, guard = 0; p && guard < 100000; p = byId.get(p)?.parent_id, guard++) {
    if (p === ancestorId) return true;
  }
  return false;
}

/**
 * Where a dropped block goes: its new parent and position among that parent's
 * children. "child" makes it the target's first child. When the gap between the
 * neighbours is too small for a midpoint, those siblings are renumbered 1..n
 * (`renumber`, the dragged block not included).
 */
export function dropPlacement(
  list: Block[], draggedId: string, target: Block, where: DropWhere,
): { parentId: string | undefined; position: number; renumber: Map<string, number> } {
  const parentId = where === "child" ? target.id : target.parent_id ?? undefined;
  const siblings = list
    .filter(b => (b.parent_id ?? undefined) === parentId && b.id !== draggedId)
    .sort((a, b) => a.position - b.position);
  const ti = siblings.findIndex(b => b.id === target.id);
  const at = where === "child" ? 0 : where === "above" ? ti : ti + 1;
  const before = siblings[at - 1]?.position;
  const after = siblings[at]?.position;
  let position: number;
  if (before === undefined && after === undefined) position = 1;
  else if (before === undefined) position = after! > 0 ? after! / 2 : after! - 1;
  else if (after === undefined) position = before + 1;
  else position = (before + after) / 2;
  const renumber = new Map<string, number>();
  const tooTight = (before !== undefined && after !== undefined && after - before < 1e-6) ||
    (before === undefined && after !== undefined && after > 0 && after < 1e-6);
  if (tooTight) {
    siblings.forEach((b, i) => renumber.set(b.id, i < at ? i + 1 : i + 2));
    position = at + 1;
  }
  return { parentId, position, renumber };
}

/** The list after moving `draggedId` (with its subtree) to the drop place, in outline order. */
export function applyDrop(list: Block[], draggedId: string, targetId: string, where: DropWhere): Block[] | null {
  const target = list.find(b => b.id === targetId);
  if (!target || draggedId === targetId || isInSubtree(list, targetId, draggedId)) return null;
  const plan = dropPlacement(list, draggedId, target, where);
  return outlineOrder(list.map(b => {
    if (b.id === draggedId) return { ...b, parent_id: plan.parentId, position: plan.position };
    const r = plan.renumber.get(b.id);
    return r !== undefined ? { ...b, position: r } : b;
  }));
}
