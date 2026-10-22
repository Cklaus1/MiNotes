/**
 * Kanban cards / columns and mind-map nodes show a block as one line of text
 * (components/mindmap/blocksToFlow.ts extractLabel, through lib/plainText).
 * UX review: cards showed raw `[[x]]`, `[[Page|uuid]]`, `[text](url)` markup.
 */
import { describe, expect, test } from "vitest";
import { extractLabel, extractTaskLabel } from "../components/mindmap/blocksToFlow";

const UUID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

describe("card labels read as text", () => {
  test("links show their title", () => {
    expect(extractLabel("Call [[Ann]] about [[Project Alpha|" + UUID + "]]")).toBe("Call Ann about Project Alpha");
    expect(extractLabel("Read [the spec](https://example.com/spec)")).toBe("Read the spec");
    expect(extractLabel("See [[Work::Roadmap]]")).toBe("See Roadmap");
  });
  test("refs, macros and marks go", () => {
    expect(extractLabel(`**Ship** ==it== with ((${UUID}))`)).toBe("Ship it with");
    expect(extractLabel("{{todo:pending}} [[Review]] PR")).toBe("Review PR");
  });
  test("headings, first line with text, fences", () => {
    expect(extractLabel("## To Do")).toBe("To Do");
    expect(extractLabel("\nsecond line\nthird")).toBe("second line");
    expect(extractLabel("```js\nconst x = 1;\n```")).toBe("const x = 1;");
    expect(extractLabel("{{whiteboard:wb-1}}")).toBe("[Whiteboard]");
    expect(extractLabel("")).toBe("(empty)");
  });
  test("task keywords: kept by extractLabel, dropped by extractTaskLabel", () => {
    expect(extractLabel("TODO write [[Docs]]")).toBe("TODO write Docs");
    expect(extractTaskLabel("TODO write [[Docs]]")).toBe("write Docs");
  });
  test("long text is cut", () => {
    expect(extractLabel("x".repeat(100), 10)).toBe("xxxxxxxxx…");
  });
});
