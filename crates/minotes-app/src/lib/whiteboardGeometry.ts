/**
 * Whiteboard geometry (UX Wave 4): connectors that stay attached to shapes,
 * rubber-band selection and alignment guides. Pure functions over the board's
 * element lists (world coordinates), unit-tested in whiteboardGeometry.test.ts.
 */

export type ShapeType = "note" | "box" | "image" | "text";
export type ElementType = ShapeType | "arrow" | "line";
export interface ElementRef { type: ElementType; id: string }
export interface Rect { x: number; y: number; w: number; h: number }

interface Boxy { id: string; x: number; y: number; width: number; height: number }
interface TextLike { id: string; x: number; y: number; text: string; size: "S" | "M" | "L"; callout: boolean }
export interface ArrowLike {
  id: string; x1: number; y1: number; x2: number; y2: number;
  /** The shape the arrow starts / ends on; it follows that shape when it moves. */
  from?: { type: ShapeType; id: string } | null;
  to?: { type: ShapeType; id: string } | null;
}
interface LineLike { id?: string; points: { x: number; y: number }[] }

export interface BoardShapes {
  notes: Boxy[];
  boxes: Boxy[];
  images: Boxy[];
  texts: TextLike[];
  arrows?: ArrowLike[];
  lines?: LineLike[];
}

export const textFontSize = (size: "S" | "M" | "L") => (size === "S" ? 14 : size === "L" ? 24 : 18);

/** A text element's box — the same approximation the board uses for hit tests. */
export function textRect(t: TextLike): Rect {
  const pad = t.callout ? 10 : 4;
  const h = t.text.split("\n").length * textFontSize(t.size) * 1.3 + pad * 2;
  return { x: t.x - pad, y: t.y - pad, w: 200 + pad * 2, h };
}

export function shapeRect(board: BoardShapes, ref: { type: ElementType; id: string }): Rect | null {
  const box = (list: Boxy[]) => {
    const b = list.find((e) => e.id === ref.id);
    return b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null;
  };
  switch (ref.type) {
    case "note": return box(board.notes);
    case "box": return box(board.boxes);
    case "image": return box(board.images);
    case "text": {
      const t = board.texts.find((e) => e.id === ref.id);
      return t && t.text ? textRect(t) : null;
    }
    case "arrow": {
      const a = board.arrows?.find((e) => e.id === ref.id);
      return a ? { x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2), w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) } : null;
    }
    case "line": {
      const l = board.lines?.find((e, i) => (e.id ?? String(i)) === ref.id);
      if (!l || l.points.length === 0) return null;
      const xs = l.points.map((p) => p.x), ys = l.points.map((p) => p.y);
      const x = Math.min(...xs), y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
  }
}

/** The topmost shape (sticky, text, box, image — the board's layer order) at a point. */
export function shapeAt(board: BoardShapes, x: number, y: number, margin = 6): { type: ShapeType; id: string } | null {
  const inside = (r: Rect, m: number) => x >= r.x - m && x <= r.x + r.w + m && y >= r.y - m && y <= r.y + r.h + m;
  for (let i = board.notes.length - 1; i >= 0; i--) {
    const n = board.notes[i];
    if (inside({ x: n.x, y: n.y, w: n.width, h: n.height }, margin)) return { type: "note", id: n.id };
  }
  for (let i = board.texts.length - 1; i >= 0; i--) {
    const t = board.texts[i];
    if (t.text && inside(textRect(t), margin)) return { type: "text", id: t.id };
  }
  for (let i = board.boxes.length - 1; i >= 0; i--) {
    const b = board.boxes[i];
    if (inside({ x: b.x, y: b.y, w: b.width, h: b.height }, margin)) return { type: "box", id: b.id };
  }
  for (let i = board.images.length - 1; i >= 0; i--) {
    const b = board.images[i];
    if (inside({ x: b.x, y: b.y, w: b.width, h: b.height }, margin)) return { type: "image", id: b.id };
  }
  return null;
}

const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** Where the ray from the rect's centre towards (tx, ty) leaves the rect (plus `gap`). */
export function borderPoint(r: Rect, tx: number, ty: number, gap = 4): { x: number; y: number } {
  const c = centre(r);
  const dx = tx - c.x, dy = ty - c.y;
  if (dx === 0 && dy === 0) return c;
  const hw = r.w / 2 + gap, hh = r.h / 2 + gap;
  const s = Math.min(dx !== 0 ? hw / Math.abs(dx) : Infinity, dy !== 0 ? hh / Math.abs(dy) : Infinity);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

/**
 * An arrow's end points with its attachments applied: an attached end sits on
 * its shape's border, on the line towards the other end (the other shape's
 * centre when both are attached). A missing shape leaves that end where it was.
 */
export function connectorEnds(a: ArrowLike, board: BoardShapes): { x1: number; y1: number; x2: number; y2: number } {
  const fr = a.from ? shapeRect(board, a.from) : null;
  const tr = a.to ? shapeRect(board, a.to) : null;
  const aimFrom = tr ? centre(tr) : { x: a.x2, y: a.y2 };
  const aimTo = fr ? centre(fr) : { x: a.x1, y: a.y1 };
  const p1 = fr ? borderPoint(fr, aimFrom.x, aimFrom.y) : { x: a.x1, y: a.y1 };
  const p2 = tr ? borderPoint(tr, aimTo.x, aimTo.y) : { x: a.x2, y: a.y2 };
  return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
}

/** Arrows with attached ends moved onto their shapes; the same array when nothing moved. */
export function reattachArrows<A extends ArrowLike>(arrows: A[], board: BoardShapes): A[] {
  let changed = false;
  const out = arrows.map((a) => {
    if (!a.from && !a.to) return a;
    const e = connectorEnds(a, board);
    const same = Math.abs(e.x1 - a.x1) < 0.01 && Math.abs(e.y1 - a.y1) < 0.01 && Math.abs(e.x2 - a.x2) < 0.01 && Math.abs(e.y2 - a.y2) < 0.01;
    if (same) return a;
    changed = true;
    return { ...a, ...e };
  });
  return changed ? out : arrows;
}

/** Arrows whose attachment points at a shape that no longer exists lose it. */
export function dropDanglingAttachments<A extends ArrowLike>(arrows: A[], board: BoardShapes): A[] {
  let changed = false;
  const out = arrows.map((a) => {
    const f = a.from && !shapeRect(board, a.from) ? null : a.from;
    const t = a.to && !shapeRect(board, a.to) ? null : a.to;
    if (f === a.from && t === a.to) return a;
    changed = true;
    return { ...a, from: f, to: t };
  });
  return changed ? out : arrows;
}

const intersects = (a: Rect, b: Rect) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
const contains = (outer: Rect, r: Rect) => r.x >= outer.x && r.y >= outer.y && r.x + r.w <= outer.x + outer.w && r.y + r.h <= outer.y + outer.h;

/** Normalise a drag rectangle (any corner order). */
export function normRect(x1: number, y1: number, x2: number, y2: number): Rect {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

/**
 * Elements a rubber band selects: shapes it touches, and arrows / strokes it
 * contains entirely (touching a long stroke's corner shouldn't grab it).
 */
export function elementsInRect(board: BoardShapes, r: Rect): ElementRef[] {
  const out: ElementRef[] = [];
  for (const n of board.notes) if (intersects(r, { x: n.x, y: n.y, w: n.width, h: n.height })) out.push({ type: "note", id: n.id });
  for (const t of board.texts) if (t.text && intersects(r, textRect(t))) out.push({ type: "text", id: t.id });
  for (const b of board.boxes) if (intersects(r, { x: b.x, y: b.y, w: b.width, h: b.height })) out.push({ type: "box", id: b.id });
  for (const b of board.images) if (intersects(r, { x: b.x, y: b.y, w: b.width, h: b.height })) out.push({ type: "image", id: b.id });
  for (const a of board.arrows ?? []) {
    if (contains(r, normRect(a.x1, a.y1, a.x2, a.y2))) out.push({ type: "arrow", id: a.id });
  }
  (board.lines ?? []).forEach((l, i) => {
    const lr = shapeRect(board, { type: "line", id: l.id ?? String(i) });
    if (lr && contains(r, lr)) out.push({ type: "line", id: l.id ?? String(i) });
  });
  return out;
}

export interface Guides { x: number[]; y: number[] }

/**
 * Alignment guides while dragging: when the moving rect's left/centre/right
 * (top/middle/bottom) comes within `threshold` of another shape's, snap to it
 * and report the guide lines (world coordinates) to draw.
 */
export function snapToGuides(moving: Rect, others: Rect[], threshold: number): { dx: number; dy: number; guides: Guides } {
  const xs = (r: Rect) => [r.x, r.x + r.w / 2, r.x + r.w];
  const ys = (r: Rect) => [r.y, r.y + r.h / 2, r.y + r.h];
  let bestX: { d: number; at: number } | null = null;
  let bestY: { d: number; at: number } | null = null;
  for (const o of others) {
    for (const mx of xs(moving)) for (const ox of xs(o)) {
      const d = ox - mx;
      if (Math.abs(d) <= threshold && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, at: ox };
    }
    for (const my of ys(moving)) for (const oy of ys(o)) {
      const d = oy - my;
      if (Math.abs(d) <= threshold && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, at: oy };
    }
  }
  const dx = bestX?.d ?? 0, dy = bestY?.d ?? 0;
  // Every guide the snapped rect now sits on (several edges may line up at once).
  const snapped = { ...moving, x: moving.x + dx, y: moving.y + dy };
  const gx = new Set<number>(), gy = new Set<number>();
  if (bestX) for (const o of others) for (const ox of xs(o)) for (const mx of xs(snapped)) if (Math.abs(ox - mx) < 0.5) gx.add(ox);
  if (bestY) for (const o of others) for (const oy of ys(o)) for (const my of ys(snapped)) if (Math.abs(oy - my) < 0.5) gy.add(oy);
  return { dx, dy, guides: { x: [...gx], y: [...gy] } };
}

/** The bounding box of several rects (null for none). */
export function unionRect(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
}
