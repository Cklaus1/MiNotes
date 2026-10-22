import { describe, expect, test } from "vitest";
import { estimateHeight, indexAt, prefixHeights, windowPlan, windowRange } from "./blockWindow";

const ids = Array.from({ length: 1000 }, (_, i) => `b${i}`);

describe("block window", () => {
  test("prefix sums use measured heights, the average otherwise", () => {
    const h = new Map([["b0", 50], ["b1", 10]]);
    const est = estimateHeight(h);
    expect(est).toBe(30);
    const p = prefixHeights(ids.slice(0, 4), h, est);
    expect([...p]).toEqual([0, 50, 60, 90, 120]);
  });

  test("indexAt finds the block under a y", () => {
    const p = prefixHeights(ids, new Map(), 30);
    expect(indexAt(p, 0)).toBe(0);
    expect(indexAt(p, 29.9)).toBe(0);
    expect(indexAt(p, 30)).toBe(1);
    expect(indexAt(p, 30 * 999 + 5)).toBe(999);
    expect(indexAt(p, 1e9)).toBe(999);
  });

  test("the window covers the viewport plus overscan, snapped", () => {
    const p = prefixHeights(ids, new Map(), 30);
    expect(windowRange(p, 0, 600, 300, 20)).toEqual([0, 40]);
    const [s, e] = windowRange(p, 15000, 15600, 300, 20); // blocks 500..520 visible
    expect(s).toBeLessThanOrEqual(490);
    expect(e).toBeGreaterThanOrEqual(530);
    expect(s % 20).toBe(0);
    expect(windowRange(p, 1e9, 1e9 + 600, 300, 20)[1]).toBe(1000);
  });

  test("the plan: gaps around the window and the pinned blocks, in order", () => {
    expect(windowPlan(100, 20, 30, [5, 95, 25])).toEqual([
      { kind: "gap", from: 0, to: 5 },
      { kind: "block", index: 5 },
      { kind: "gap", from: 6, to: 20 },
      ...Array.from({ length: 10 }, (_, k) => ({ kind: "block", index: 20 + k })),
      { kind: "gap", from: 30, to: 95 },
      { kind: "block", index: 95 },
      { kind: "gap", from: 96, to: 100 },
    ]);
    expect(windowPlan(3, 0, 3)).toEqual([0, 1, 2].map(index => ({ kind: "block", index })));
  });
});
