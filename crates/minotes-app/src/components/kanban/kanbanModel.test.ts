import { describe, expect, it } from "vitest";
import type { Block } from "../../lib/api";
import { buildStatusModel, statusOfColumn, withStatus, STATUS_COLUMNS } from "./kanbanModel";

const blk = (id: string, content: string, parent_id?: string): Block =>
  ({ id, page_id: "p", content, parent_id, position: 0, created_at: "", updated_at: "" } as unknown as Block);

describe("kanban: group by status", () => {
  it("every task on the page, at any depth, lands in its state's column", () => {
    const m = buildStatusModel([
      blk("h", "## Section"), blk("a", "TODO one", "h"), blk("b", "DOING two", "h"),
      blk("c", "- [x] three"), blk("d", "plain note"), blk("e", "DONE four\nmore text", "a"),
    ]);
    const ids = (col: string) => (m.cardsByColumn.get(col) ?? []).map((b) => b.id);
    expect(ids(STATUS_COLUMNS[0].id)).toEqual(["a"]);
    expect(ids(STATUS_COLUMNS[1].id)).toEqual(["b"]);
    expect(ids(STATUS_COLUMNS[2].id)).toEqual(["c", "e"]);
    expect(m.columnOfCard.has("d")).toBe(false);
  });
  it("moving a card rewrites only its marker", () => {
    expect(withStatus("TODO one\nbody", "doing")).toBe("DOING one\nbody");
    expect(withStatus("- [ ] call", "done")).toBe("- [x] call");
    expect(withStatus("plain", "todo")).toBe("TODO plain");
    expect(withStatus("DONE x", null)).toBe("x");
    expect(statusOfColumn(STATUS_COLUMNS[2].id)).toBe("done");
    expect(statusOfColumn("other")).toBeNull();
  });
});
