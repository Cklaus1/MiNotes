/** Enter on an empty nested block outdents it: what counts as "empty" (option B indent model). */
import { describe, expect, test } from "vitest";
import { Editor } from "@tiptap/core";
import { createBlockExtensions } from "./blockExtensions";
import { isBlankBlock, isBlankDoc } from "./blankBlock";

describe("isBlankBlock", () => {
  test("no text, whitespace or only line breaks", () => {
    for (const md of ["", "   ", "\n", " \n \n"]) expect(isBlankBlock(md)).toBe(true);
  });

  test("only a list / task marker or a TODO keyword", () => {
    for (const md of ["-", "- ", "*", "+ ", "1.", "2) ", "- [ ]", "- [ ] ", "- [x]", "[ ]", "TODO", "TODO ", "DOING", "DONE", "- \\[ \\]", "- \\[x\\]"]) {
      expect(isBlankBlock(md), JSON.stringify(md)).toBe(true);
    }
  });

  test("anything with real content is not blank", () => {
    for (const md of ["a", "- a", "- [ ] buy milk", "TODO call Ann", "todo", "TODOs", "---", "# Heading", "![x](y.png)", "[[Page]]", "1.5", "-x"]) {
      expect(isBlankBlock(md), JSON.stringify(md)).toBe(false);
    }
  });

  test("what the real editor serializes for an empty task item, bullet or TODO marker", () => {
    const ed = new Editor({
      element: document.createElement("div"),
      extensions: createBlockExtensions({ onPageLinkClick() {}, onBlockRefClick() {}, onTagClick() {} }),
      content: "",
    });
    const md = () => (ed.storage as any).markdown.getMarkdown() as string;
    try {
      for (const stored of ["", "- [ ]", "- ", "1. ", "TODO ", "DONE"]) {
        ed.commands.setContent(stored);
        expect(isBlankBlock(md()), `${JSON.stringify(stored)} -> ${JSON.stringify(md())}`).toBe(true);
      }
      ed.commands.setContent("");
      (ed.commands as any).toggleTaskList();
      expect(isBlankBlock(md()), md()).toBe(true);
      ed.commands.setContent("- [ ] a");
      expect(isBlankBlock(md())).toBe(false);
      // The key handler tests the document itself.
      for (const stored of ["", "- [ ]", "- ", "1. ", "TODO ", "DONE", "a\\\n"]) {
        ed.commands.setContent(stored);
        expect(isBlankDoc(ed.state.doc), JSON.stringify(stored)).toBe(stored !== "a\\\n");
      }
      ed.commands.setContent("");
      (ed.commands as any).toggleTaskList();
      expect(isBlankDoc(ed.state.doc)).toBe(true);
      // Atoms and code / quotes / tables are content even without text.
      for (const stored of ["[[Some Page]]", "![x](a.png)", "```\n```", "> ", "| a |\n|---|\n| b |", "- [ ] a"]) {
        ed.commands.setContent(stored);
        expect(isBlankDoc(ed.state.doc), JSON.stringify(stored)).toBe(false);
      }
    } finally {
      ed.destroy();
    }
  });
});
