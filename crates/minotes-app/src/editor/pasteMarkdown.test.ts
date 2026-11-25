/**
 * C-6: pasted markdown becomes the right block tree — headings as blocks,
 * nested lists as child blocks, indented lines as children (not code), fenced
 * code as one code block — and a typed ```lang + Enter makes a code block.
 */
import { afterEach, describe, expect, test } from "vitest";
import { Editor } from "@tiptap/core";
import { createBlockExtensions } from "./blockExtensions";
import { fenceToCodeBlock, parsePastedMarkdown, type PastedBlock } from "./pasteMarkdown";

/** The tree as "content" lines, two spaces per level. */
const show = (items: PastedBlock[] | null, depth = 0): string =>
  items === null ? "null" : items.map(i => "  ".repeat(depth) + i.content + (i.children.length ? "\n" + show(i.children, depth + 1) : "")).join("\n");

describe("parsePastedMarkdown", () => {
  test("plain lines are not structure (the line-per-block paste handles them)", () => {
    expect(parsePastedMarkdown("first line\nsecond line\nthird")).toBeNull();
    expect(parsePastedMarkdown("just one line")).toBeNull();
  });

  test("headings are blocks, kept as headings", () => {
    expect(show(parsePastedMarkdown("# Title\nintro text\n## Part\nmore"))).toBe("# Title\nintro text\n## Part\nmore");
  });

  test("nested - / * / 1. lists become child blocks (markers dropped)", () => {
    const md = "- one\n  - one.a\n    - one.a.i\n  - one.b\n- two\n* three\n1. four\n   1. four.1\n2. five";
    expect(show(parsePastedMarkdown(md))).toBe(
      "one\n  one.a\n    one.a.i\n  one.b\ntwo\nthree\nfour\n  four.1\nfive");
  });

  test("4-space and tab indents nest too", () => {
    expect(show(parsePastedMarkdown("- a\n    - b\n\t\t- c\n- d"))).toBe("a\n  b\n    c\nd");
  });

  test("indented plain lines are children of the line above, not code", () => {
    expect(show(parsePastedMarkdown("Parent\n    child line\n    another child\nNext"))).toBe(
      "Parent\n  child line\n  another child\nNext");
  });

  test("task items keep their checkbox", () => {
    expect(show(parsePastedMarkdown("- [ ] open\n- [x] done\n  - [ ] sub"))).toBe(
      "- [ ] open\n- [x] done\n  - [ ] sub");
  });

  test("a fenced code block is ONE block, its lines and indentation intact", () => {
    const md = "Intro:\n```python\ndef f():\n    return 1\n\n# not a heading\n```\nAfter";
    expect(show(parsePastedMarkdown(md))).toBe(
      "Intro:\n```python\ndef f():\n    return 1\n\n# not a heading\n```\nAfter");
  });

  test("a fence inside a list item is that item's child", () => {
    // (the fence is dedented to its own indentation; show() indents only its first line)
    expect(show(parsePastedMarkdown("- code:\n  ```js\n  let x = 1;\n  ```\n- next"))).toBe(
      "code:\n  ```js\nlet x = 1;\n```\nnext");
  });

  test("blank lines separate, quotes and tables stay whole", () => {
    expect(show(parsePastedMarkdown("> a quote\n> continues\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- item"))).toBe(
      "> a quote\n> continues\n| a | b |\n| --- | --- |\n| 1 | 2 |\nitem");
  });

  test("Windows line endings", () => {
    expect(show(parsePastedMarkdown("# H\r\n- a\r\n  - b\r\n"))).toBe("# H\na\n  b");
  });

  test("a heading ends the list nesting above it", () => {
    expect(show(parsePastedMarkdown("- a\n  - b\n# H\n- c"))).toBe("a\n  b\n# H\nc");
  });
});

describe("typed ```lang + Enter", () => {
  let ed: Editor | null = null;
  afterEach(() => { ed?.destroy(); ed = null; });
  const mount = (content: string) => {
    ed = new Editor({
      element: document.createElement("div"),
      extensions: createBlockExtensions({ onPageLinkClick() {}, onBlockRefClick() {}, onTagClick() {} }),
      content,
    });
    ed.commands.focus("end");
    return ed;
  };
  const md = () => ((ed!.storage as any).markdown.getMarkdown() as string).trim();

  test("```python becomes a python code block (not escaped backticks)", () => {
    mount("```python");
    // setContent parses "```python" as an (empty) code fence already in markdown;
    // type it as text the way a user does instead:
    ed!.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "```python" }] }] });
    ed!.commands.focus("end");
    expect(fenceToCodeBlock(ed!)).toBe(true);
    const node = ed!.state.doc.firstChild!;
    expect(node.type.name).toBe("codeBlock");
    expect(node.attrs.language).toBe("python");
    ed!.commands.insertContent("print(1)");
    expect(md()).toBe("```python\nprint(1)\n```");
  });

  test("plain ``` works too; other text is left alone", () => {
    mount("");
    ed!.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "```" }] }] });
    ed!.commands.focus("end");
    expect(fenceToCodeBlock(ed!)).toBe(true);
    expect(ed!.state.doc.firstChild!.type.name).toBe("codeBlock");
    ed!.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "say ```x" }] }] });
    ed!.commands.focus("end");
    expect(fenceToCodeBlock(ed!)).toBe(false);
  });
});
