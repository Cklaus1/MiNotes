import { describe, expect, it } from "vitest";
import {
  borderPoint, connectorEnds, dropDanglingAttachments, elementsInRect, normRect, reattachArrows, shapeAt, snapToGuides,
  type BoardShapes,
} from "./whiteboardGeometry";

const board = (): BoardShapes => ({
  notes: [{ id: "n1", x: 0, y: 0, width: 100, height: 100 }],
  boxes: [{ id: "b1", x: 300, y: 0, width: 100, height: 100 }],
  images: [],
  texts: [{ id: "t1", x: 0, y: 300, text: "hi", size: "M", callout: false }],
  arrows: [{ id: "a1", x1: 100, y1: 50, x2: 300, y2: 50, from: { type: "note", id: "n1" }, to: { type: "box", id: "b1" } }],
  lines: [{ id: "l1", points: [{ x: 500, y: 500 }, { x: 520, y: 530 }] }],
});

describe("whiteboard connectors", () => {
  it("an attached end sits on its shape's border, facing the other shape", () => {
    expect(borderPoint({ x: 0, y: 0, w: 100, h: 100 }, 1000, 50, 0)).toEqual({ x: 100, y: 50 });
    const e = connectorEnds(board().arrows![0], board());
    expect(e).toEqual({ x1: 104, y1: 50, x2: 296, y2: 50 });
  });
  it("arrows follow a moved shape and stay attached", () => {
    const b = board();
    const a0 = reattachArrows(b.arrows!, b);
    b.boxes[0] = { ...b.boxes[0], x: 300, y: 300 }; // move the box down-right
    const a1 = reattachArrows(a0, b);
    expect(a1).not.toBe(a0);
    // Centre to centre, cut at both borders (4 px gap): a diagonal now.
    expect([a1[0].x1, a1[0].y1, a1[0].x2, a1[0].y2]).toEqual([104, 104, 296, 296]);
    expect(a1[0].from).toEqual({ type: "note", id: "n1" });
    expect(reattachArrows(a1, b)).toBe(a1); // nothing moved: same array (no undo entry)
  });
  it("a deleted shape releases the arrow end", () => {
    const b = board();
    b.boxes = [];
    expect(dropDanglingAttachments(b.arrows!, b)[0].to).toBeNull();
    expect(connectorEnds({ id: "x", x1: 0, y1: 0, x2: 9, y2: 9, to: { type: "box", id: "gone" } }, b)).toEqual({ x1: 0, y1: 0, x2: 9, y2: 9 });
  });
  it("shapeAt finds the topmost shape under a point", () => {
    expect(shapeAt(board(), 50, 50)).toEqual({ type: "note", id: "n1" });
    expect(shapeAt(board(), 350, 50)).toEqual({ type: "box", id: "b1" });
    expect(shapeAt(board(), 10, 305)).toEqual({ type: "text", id: "t1" });
    expect(shapeAt(board(), 200, 200)).toBeNull();
  });
});

describe("rubber band and guides", () => {
  it("selects the shapes it touches and the strokes it contains", () => {
    const ids = (r: ReturnType<typeof normRect>) => elementsInRect(board(), r).map((e) => `${e.type}:${e.id}`);
    expect(ids(normRect(-10, -10, 120, 120))).toEqual(["note:n1"]);
    expect(ids(normRect(450, 450, 600, 600))).toEqual(["line:l1"]);
    expect(ids(normRect(510, 510, 600, 600))).toEqual([]); // a stroke must be inside entirely
    expect(ids(normRect(-10, -10, 600, 600)).sort()).toEqual(["arrow:a1", "box:b1", "line:l1", "note:n1", "text:t1"]);
  });
  it("snaps to the nearest edge or centre within the threshold", () => {
    const s = snapToGuides({ x: 103, y: 210, w: 50, h: 50 }, [{ x: 0, y: 0, w: 100, h: 100 }], 5);
    expect(s.dx).toBe(-3);
    expect(s.dy).toBe(0);
    expect(s.guides.x).toEqual([100]);
    const c = snapToGuides({ x: 24, y: 400, w: 50, h: 20 }, [{ x: 0, y: 0, w: 100, h: 100 }], 2);
    expect(c.dx).toBe(1); // centres 50 / 49 → 50
    expect(snapToGuides({ x: 500, y: 500, w: 10, h: 10 }, [{ x: 0, y: 0, w: 100, h: 100 }], 4)).toEqual({ dx: 0, dy: 0, guides: { x: [], y: [] } });
  });
});
