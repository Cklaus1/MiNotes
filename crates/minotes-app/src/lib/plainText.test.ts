import { describe, expect, it } from "vitest";
import { blockPlainText } from "./plainText";
import { parseTaskLine, setTaskState } from "./tasks";

const ID = "0e1d2c3b-4a59-4687-a6b5-c4d3e2f1a0b9";

describe("blockPlainText (search results, Tasks view)", () => {
  it("keeps link titles and drops ids and macros", () => {
    expect(blockPlainText(`TODO book flights for [[Travel — Lisbon 2027|${ID}]] see ((${ID})) {{whiteboard:wb1}}`))
      .toEqual({ state: "TODO", text: "book flights for Travel — Lisbon 2027 see Whiteboard" });
    expect(blockPlainText(`{{todo:pending}} [[Project Alpha|${ID}]] send notes`).text).toBe("Project Alpha send notes");
    expect(blockPlainText("[[Reading::Book List]] and [[Inbox]]").text).toBe("Book List and Inbox");
    expect(blockPlainText("[[Page|shown label]]").text).toBe("shown label");
  });
  it("drops formatting marks, headings, list markers and html", () => {
    expect(blockPlainText("## **Big** _plan_ with `code`, ==hi== and ~~old~~").text).toBe("Big _plan_ with code, hi and old");
    expect(blockPlainText("- [ ] call bob\n- [x] paid").text).toBe("call bob paid");
    expect(blockPlainText("> quoted *it* <b>x</b>").text).toBe("quoted it x");
    expect(blockPlainText("see [docs](https://x.y) ![shot](attachment:abc)").text).toBe("see docs shot");
    expect(blockPlainText("DONE shipped it").state).toBe("DONE");
    expect(blockPlainText("snake_case_name stays").text).toBe("snake_case_name stays");
  });
});

describe("tasks: parse and change a task line", () => {
  it("parses markers, checkboxes and keywords", () => {
    expect(parseTaskLine("DOING write")).toEqual({ state: "doing", kind: "marker", text: "write" });
    expect(parseTaskLine("  - [x] paid")).toEqual({ state: "done", kind: "checkbox", text: "paid" });
    expect(parseTaskLine("Follow up: Ann")).toEqual({ state: "todo", kind: "keyword", text: "Ann" });
    expect(parseTaskLine(`{{todo:pending}} [[A|${ID}]] x`)).toBeNull();
    expect(parseTaskLine("plain")).toBeNull();
  });
  it("rewrites only the given line, keeping indentation", () => {
    expect(setTaskState("TODO buy milk", 0, "done")).toBe("DONE buy milk");
    expect(setTaskState("notes\n  DOING report", 1, "todo")).toBe("notes\n  TODO report");
    expect(setTaskState("- [ ] call bob", 0, "done")).toBe("- [x] call bob");
    expect(setTaskState("* [X] paid", 0, "todo")).toBe("* [ ] paid");
    expect(setTaskState("- [ ] call bob", 0, "doing")).toBe("DOING call bob");
    expect(setTaskState("Action: deploy", 0, "done")).toBe("DONE deploy");
    expect(setTaskState("TODO a", 0, "todo")).toBe("TODO a");
    expect(setTaskState("no task here", 0, "done")).toBeNull();
    expect(setTaskState("TODO a", 3, "done")).toBeNull();
  });
});
