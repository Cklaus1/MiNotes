import { describe, expect, test } from "vitest";
import { BUILTIN_TEMPLATES, fillTemplate, parseTemplate, templateBlockCount, templateFromBlocks, type TemplateBlock } from "./templates";

const shape = (bs: TemplateBlock[]): unknown => bs.map((b) => (b.children.length ? [b.content, shape(b.children)] : b.content));

describe("template text ↔ blocks", () => {
  test("indentation is nesting", () => {
    expect(shape(parseTemplate("A\n  B\n    C\n  D\nE"))).toEqual([["A", [["B", ["C"]], "D"]], "E"]);
  });

  test("a saved outline comes back the same (nesting, line breaks, code, empty blocks)", () => {
    const outline = [
      { content: "## Plan", depth: 3 },
      { content: "first\nsecond line", depth: 4 },
      { content: "```js\nlet x = 1;\n  indented();\n```", depth: 4 },
      { content: "", depth: 5 },
      { content: "TODO ship", depth: 3 },
    ];
    const text = templateFromBlocks(outline);
    expect(text).toBe("## Plan\n  first\n  \\ second line\n  ```js\n  let x = 1;\n    indented();\n  ```\n    {{blank}}\nTODO ship");
    const filled = fillTemplate(text);
    expect(shape(filled)).toEqual([
      ["## Plan", ["first\nsecond line", ["```js\nlet x = 1;\n  indented();\n```", [""]]]],
      "TODO ship",
    ]);
  });

  test("placeholders: date, time, title, yesterday/tomorrow, blank; cursor becomes the caret", () => {
    const now = new Date(2026, 9, 21, 9, 5);
    const [a, b] = fillTemplate("# {{title}} {{date}} {{time}}\n  Due {{tomorrow}}, was {{yesterday}}: {{cursor}}x\n  {{blank}}", { title: "Sprint", now });
    expect(a.content).toBe("# Sprint 2026-10-21 09:05");
    expect(a.cursor).toBeUndefined();
    expect(a.children[0].content).toBe("Due 2026-10-22, was 2026-10-20: x");
    expect(a.children[0].cursor).toBe("Due 2026-10-22, was 2026-10-20: ".length);
    expect(a.children[1].content).toBe("");
    expect(b).toBeUndefined();
  });

  test("only the first {{cursor}} counts", () => {
    const bs = fillTemplate("{{cursor}}a\n{{cursor}}b");
    expect(bs.map((b) => [b.content, b.cursor])).toEqual([["a", 0], ["b", undefined]]);
  });

  test("built-in templates are nested and each has a caret position", () => {
    for (const t of BUILTIN_TEMPLATES) {
      const bs = fillTemplate(t.content);
      const nested = bs.some((b) => b.children.length > 0);
      expect(nested, t.name).toBe(true);
      const hasCursor = (xs: TemplateBlock[]): boolean => xs.some((x) => x.cursor !== undefined || hasCursor(x.children));
      expect(hasCursor(bs), t.name).toBe(true);
      expect(templateBlockCount(t.content), t.name).toBeGreaterThan(3);
    }
  });
});
