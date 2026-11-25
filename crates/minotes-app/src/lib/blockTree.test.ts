/**
 * C-13: after a drop the outline must be in outline order (depth-first, siblings
 * by position) — positions are per parent, so sorting the whole page by
 * position scrambles it.
 */
import { describe, expect, test } from "vitest";
import type { Block } from "./api";
import { applyDrop, dropPlacement, effectiveDrop, indentPlacement, outdentPlacement, outlineOrder } from "./blockTree";

const blk = (id: string, position: number, parent_id?: string): Block => ({
  id, page_id: "p", parent_id, position, content: id, format: "markdown", collapsed: false,
  created_at: "", updated_at: "",
});

// A(a1, a2), B(b1), C — stored positions overlap across parents on purpose.
const page = (): Block[] => outlineOrder([
  blk("A", 1), blk("a1", 1, "A"), blk("a2", 2, "A"), blk("B", 2), blk("b1", 1, "B"), blk("C", 3),
]);
const show = (list: Block[]) => {
  const depth = new Map<string, number>();
  return list.map(b => { const d = b.parent_id ? depth.get(b.parent_id)! + 1 : 0; depth.set(b.id, d); return `${b.id}@${d}`; }).join(" ");
};

describe("outline order", () => {
  test("positions are per parent; the list is depth-first", () => {
    expect(show(page())).toBe("A@0 a1@1 a2@1 B@0 b1@1 C@0");
  });

  test("the old global position sort scrambles it (the C-13 bug)", () => {
    const sorted = page().slice().sort((x, y) => x.position - y.position);
    expect(show(outlineOrder(sorted))).toBe("A@0 a1@1 a2@1 B@0 b1@1 C@0");
    expect(sorted.map(b => b.id).join(" ")).not.toBe("A a1 a2 B b1 C");
  });
});

describe("applyDrop", () => {
  test("a parent dropped below a sibling moves with its subtree", () => {
    expect(show(applyDrop(page(), "A", "B", "below")!)).toBe("B@0 b1@1 A@0 a1@1 a2@1 C@0");
  });

  test("dropped above the first block", () => {
    expect(show(applyDrop(page(), "C", "A", "above")!)).toBe("C@0 A@0 a1@1 a2@1 B@0 b1@1");
  });

  test("dropped as a child becomes the first child", () => {
    expect(show(applyDrop(page(), "C", "B", "child")!)).toBe("A@0 a1@1 a2@1 B@0 C@1 b1@1");
  });

  test("a child dragged to the top level", () => {
    expect(show(applyDrop(page(), "a2", "B", "above")!)).toBe("A@0 a1@1 a2@0 B@0 b1@1 C@0");
  });

  test("into a leaf as a child", () => {
    expect(show(applyDrop(page(), "C", "b1", "child")!)).toBe("A@0 a1@1 a2@1 B@0 b1@1 C@2");
  });

  test("below an expanded parent means its first child; below a folded one, after its subtree", () => {
    expect(effectiveDrop(page(), "B", "below", new Set())).toBe("child");
    expect(effectiveDrop(page(), "B", "below", new Set(["B"]))).toBe("below");
    expect(effectiveDrop(page(), "C", "below", new Set())).toBe("below");
    expect(effectiveDrop(page(), "B", "above", new Set())).toBe("above");
  });

  test("never into its own subtree, never onto itself", () => {
    expect(applyDrop(page(), "A", "a1", "child")).toBeNull();
    expect(applyDrop(page(), "A", "a2", "below")).toBeNull();
    expect(applyDrop(page(), "A", "A", "below")).toBeNull();
  });

  test("exhausted precision renumbers the siblings", () => {
    const list = outlineOrder([blk("x", 1), blk("y", 1 + 1e-9), blk("z", 3)]);
    const plan = dropPlacement(list, "z", list[0], "below");
    expect(plan.renumber.get("x")).toBe(1);
    expect(plan.renumber.get("y")).toBe(3);
    expect(plan.position).toBe(2);
    expect(show(applyDrop(list, "z", "x", "below")!)).toBe("x@0 z@0 y@0");
  });
});

/** Tab / Shift+Tab (and Enter on an empty nested block, Backspace at its start): where the block goes. */
describe("indent / outdent placement", () => {
  const move = (list: Block[], id: string, plan: { parentId: string | undefined; position: number } | null) =>
    plan ? outlineOrder(list.map(b => (b.id === id ? { ...b, parent_id: plan.parentId, position: plan.position } : b))) : null;

  test("indent: last child of the previous sibling", () => {
    expect(show(move(page(), "B", indentPlacement(page(), "B"))!)).toBe("A@0 a1@1 a2@1 B@1 b1@2 C@0");
    expect(show(move(page(), "a2", indentPlacement(page(), "a2"))!)).toBe("A@0 a1@1 a2@2 B@0 b1@1 C@0");
  });

  test("indent: nothing above at the same level (first block, first child)", () => {
    expect(indentPlacement(page(), "A")).toBeNull();
    expect(indentPlacement(page(), "a1")).toBeNull();
    expect(indentPlacement(page(), "missing")).toBeNull();
  });

  test("outdent: right after the former parent, before the parent's next sibling", () => {
    const plan = outdentPlacement(page(), "a2")!;
    expect(plan.parentId).toBeUndefined();
    expect(plan.position).toBeGreaterThan(1);
    expect(plan.position).toBeLessThan(2);
    expect(show(move(page(), "a2", plan)!)).toBe("A@0 a1@1 a2@0 B@0 b1@1 C@0");
  });

  test("outdent: two levels deep steps out one level at a time", () => {
    const deep = outlineOrder([...page(), blk("x", 1, "a1")]);
    const once = move(deep, "x", outdentPlacement(deep, "x"))!;
    expect(show(once)).toBe("A@0 a1@1 x@1 a2@1 B@0 b1@1 C@0");
    const twice = move(once, "x", outdentPlacement(once, "x"))!;
    expect(show(twice)).toBe("A@0 a1@1 a2@1 x@0 B@0 b1@1 C@0");
    expect(outdentPlacement(twice, "x")).toBeNull();
  });

  test("outdent: a root block stays", () => {
    expect(outdentPlacement(page(), "B")).toBeNull();
  });

  test("outdent of the last parent's child appends after it", () => {
    const plan = outdentPlacement(page(), "b1")!;
    expect(show(move(page(), "b1", plan)!)).toBe("A@0 a1@1 a2@1 B@0 b1@0 C@0");
  });
});
