/**
 * Split / merge (UX review 2026-10, Editor table): Backspace at the start of a
 * block merged it into the previous one with a "\n" between them and put the
 * caret at the end, so split→merge wasn't reversible.
 */
import { describe, expect, test } from "vitest";
import { mergeMarkdown } from "./mergeBlocks";
import { caretAfterMarkdown } from "./staticRender";

describe("mergeMarkdown", () => {
  test("a split in the middle of a word merges back to the original", () => {
    expect(mergeMarkdown("Secon", "d block")).toBe("Second block");
  });

  test("a split at a space keeps the space when the split said so", () => {
    expect(mergeMarkdown("Hello", "World", { space: true })).toBe("Hello World");
    expect(mergeMarkdown("Hello", "World")).toBe("HelloWorld");
  });

  test("inline formatting on both sides joins on one line", () => {
    expect(mergeMarkdown("**bold** and", " [[Page]] more")).toBe("**bold** and [[Page]] more");
    expect(mergeMarkdown("# Heading", " text")).toBe("# Heading text");
  });

  test("empty sides", () => {
    expect(mergeMarkdown("", "next")).toBe("next");
    expect(mergeMarkdown("prev", "")).toBe("prev");
  });

  test("block syntax that can't share a line keeps a line break", () => {
    expect(mergeMarkdown("intro", "- item")).toBe("intro\n- item");
    expect(mergeMarkdown("intro", "# Heading")).toBe("intro\n# Heading");
    expect(mergeMarkdown("intro", "```js\nx\n```")).toBe("intro\n```js\nx\n```");
    expect(mergeMarkdown("```\ncode\n```", "after")).toBe("```\ncode\n```\nafter");
    expect(mergeMarkdown("| a |\n| --- |\n| 1 |", "after")).toBe("| a |\n| --- |\n| 1 |\nafter");
    expect(mergeMarkdown("---", "after")).toBe("---\nafter");
  });
});

describe("caretAfterMarkdown: the join point in the merged block", () => {
  test("plain text: right after the last character", () => {
    expect(caretAfterMarkdown("Secon")).toBe(6); // doc pos 1 + 5 chars
  });
  test("a heading", () => {
    expect(caretAfterMarkdown("# Head")).toBe(5);
  });
  test("formatting and links count as their visible text", () => {
    expect(caretAfterMarkdown("**ab** c")).toBe(5);
    expect(caretAfterMarkdown("see [[Page]]")).toBe(6); // a wiki link is one atom
  });
});
