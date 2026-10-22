/**
 * Windowing for big pages (UX Wave 4). Above WINDOW_THRESHOLD visible blocks,
 * PageView renders only the blocks near the viewport (plus "pinned" ones: the
 * block being edited, the one being dragged); the rest are empty spacers sized
 * by each block's measured height (or the average, before it was ever shown).
 * The list stays one flat column of `.block` elements in outline order, so
 * selection, drag and collapse work as before; jumping to a block outside the
 * window (search, a ((ref)), arrows, a backlink) moves the window first.
 */

/** Visible blocks above which the list is windowed (smaller pages render whole). */
export const WINDOW_THRESHOLD = 300;
/** Extra pixels rendered above and below the viewport. */
export const OVERSCAN_PX = 1200;
/** Height of a block that has never been rendered, before any was measured. */
export const DEFAULT_BLOCK_HEIGHT = 30;
/** Window bounds snap to multiples of this (fewer re-renders while scrolling). */
export const WINDOW_STEP = 20;

/** The threshold, unless a developer override is set (localStorage `minotes-window-threshold`). */
export function windowThreshold(): number {
  try {
    const v = Number(localStorage.getItem("minotes-window-threshold"));
    if (Number.isFinite(v) && v > 0) return v;
  } catch { /* storage unavailable */ }
  return WINDOW_THRESHOLD;
}

/** Average of the measured heights (the estimate for blocks never rendered). */
export function estimateHeight(heights: Map<string, number>): number {
  if (heights.size === 0) return DEFAULT_BLOCK_HEIGHT;
  let sum = 0;
  for (const h of heights.values()) sum += h;
  return sum / heights.size;
}

/** prefix[i] = top of block i (from the top of the list); prefix[n] = total height. */
export function prefixHeights(ids: readonly string[], heights: Map<string, number>, estimate: number): Float64Array {
  const prefix = new Float64Array(ids.length + 1);
  for (let i = 0; i < ids.length; i++) prefix[i + 1] = prefix[i] + (heights.get(ids[i]) ?? estimate);
  return prefix;
}

/** First index whose bottom is below `y` (binary search over the prefix sums). */
export function indexAt(prefix: Float64Array, y: number): number {
  const n = prefix.length - 1;
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (prefix[mid + 1] <= y) lo = mid + 1; else hi = mid;
  }
  return Math.min(lo, Math.max(0, n - 1));
}

/** The [start, end) block range to render for a viewport [y0, y1) (list coordinates). */
export function windowRange(prefix: Float64Array, y0: number, y1: number, overscan = OVERSCAN_PX, step = WINDOW_STEP): [number, number] {
  const n = prefix.length - 1;
  if (n <= 0) return [0, 0];
  const a = indexAt(prefix, Math.max(0, y0 - overscan));
  const b = indexAt(prefix, Math.max(0, y1 + overscan)) + 1;
  const start = Math.max(0, Math.floor(a / step) * step);
  const end = Math.min(n, Math.ceil(b / step) * step);
  return [start, Math.max(end, Math.min(n, start + 1))];
}

export type WindowPart = { kind: "block"; index: number } | { kind: "gap"; from: number; to: number };

/** Blocks in [start, end) plus `pinned`, in order, with the gaps between them. */
export function windowPlan(count: number, start: number, end: number, pinned: Iterable<number> = []): WindowPart[] {
  const set = new Set<number>();
  for (let i = Math.max(0, start); i < Math.min(count, end); i++) set.add(i);
  for (const p of pinned) if (p >= 0 && p < count) set.add(p);
  const idx = [...set].sort((x, y) => x - y);
  const out: WindowPart[] = [];
  let next = 0;
  for (const i of idx) {
    if (i > next) out.push({ kind: "gap", from: next, to: i });
    out.push({ kind: "block", index: i });
    next = i + 1;
  }
  if (next < count) out.push({ kind: "gap", from: next, to: count });
  return out;
}
