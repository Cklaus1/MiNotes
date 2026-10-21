/**
 * The block editor's markdown round trip (UX review 2026-10 §4.1): every mark and
 * node must survive markdown → editor doc → markdown byte-for-byte, and what the
 * user creates with input rules / commands must serialize to the markdown that
 * parses back into the same thing. Uses the real extension set (blockExtensions).
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Editor } from "@tiptap/core";
import { createBlockExtensions } from "./blockExtensions";

let ed: Editor;

beforeEach(() => {
  ed = new Editor({
    element: document.createElement("div"),
    extensions: createBlockExtensions({ onPageLinkClick() {}, onBlockRefClick() {}, onTagClick() {} }),
    content: "",
  });
});
afterEach(() => ed.destroy());

const md = (): string => ((ed.storage as any).markdown.getMarkdown() as string).trim();
const load = (markdown: string) => ed.commands.setContent(markdown);
const roundTrip = (markdown: string): string => { load(markdown); return md(); };

/** Names of every node and mark in the doc, in document order (deduplicated). */
function kinds(): string[] {
  const out = new Set<string>();
  ed.state.doc.descendants((n) => {
    out.add(n.type.name);
    n.marks.forEach((m) => out.add(`mark:${m.type.name}`));
  });
  return [...out];
}

/** Every non-space character with its marks (whitespace may move out of a mark). */
function charMarks(): string[] {
  const out: string[] = [];
  ed.state.doc.descendants((n) => {
    if (!n.isText) return;
    const marks = n.marks.map((m) => m.type.name).sort().join("+");
    for (const ch of n.text ?? "") if (ch.trim()) out.push(`${ch}:${marks}`);
  });
  return out;
}

/** Type `text` the way a keyboard does: every character goes through handleTextInput
 *  (which runs the input rules), falling back to a plain insert. */
function typeText(text: string) {
  for (const ch of text) {
    const view = ed.view;
    const { from, to } = view.state.selection;
    const deflt = () => view.state.tr.insertText(ch, from, to);
    const handled = view.someProp("handleTextInput", (f: any) => f(view, from, to, ch, deflt));
    if (!handled) view.dispatch(deflt());
  }
}

const UUID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

describe("markdown → doc → markdown is identical", () => {
  const cases: [string, string, string[]][] = [
    ["bold", "a **bold** b", ["mark:bold"]],
    ["italic", "a *italic* b", ["mark:italic"]],
    ["inline code", "a `code` b", ["mark:code"]],
    ["strike", "a ~~strike~~ b", ["mark:strike"]],
    ["highlight", "a ==highlight== b", ["mark:highlight"]],
    ["bold inside highlight", "==there **hi**==", ["mark:highlight", "mark:bold"]],
    ["all marks together", "**b** *i* `c` ~~s~~ ==h==", ["mark:bold", "mark:italic", "mark:code", "mark:strike", "mark:highlight"]],
    ["link", "see [the site](https://example.com) now", ["mark:link"]],
    ["attachment link", "[report.pdf](attachment:" + "a".repeat(64) + "/report.pdf)", ["mark:link"]],
    ["wiki link", "go to [[Project Alpha]] now", ["wikiLink"]],
    ["wiki link with id", "[[Project Alpha|1234abcd]]", ["wikiLink"]],
    ["cross-notebook link", "see [[Work::Roadmap]]", ["wikiLink"]],
    ["tag", "x #urgent done", ["tag"]],
    ["tag at start", "#urgent fix it", ["tag"]],
    ["nested tag", "filed under #area/home", ["tag"]],
    ["block ref", `as said in ((${UUID}))`, ["blockRef"]],
    ["heading 1", "# Title", ["heading"]],
    ["heading 2", "## Section", ["heading"]],
    ["heading 3", "### Sub", ["heading"]],
    ["heading 4", "#### Deep", ["heading"]],
    ["code block with language", "```python\nprint('hi')\n```", ["codeBlock"]],
    ["code block without language", "```\nplain\n```", ["codeBlock"]],
    ["quote", "> wise words", ["blockquote"]],
    ["table", "| a | b |\n| --- | --- |\n| 1 | 2 |", ["table", "tableRow", "tableHeader", "tableCell"]],
    ["task list", "- [ ] open\n- [x] done", ["taskList", "taskItem"]],
    ["TODO marker", "TODO write tests", []],
    ["DONE marker", "DONE ship it", []],
    ["todo macro", "{{todo:pending}} call Bob", []],
    ["divider", "---", ["horizontalRule"]],
    ["attachment image", "![screenshot.png](attachment:" + "b".repeat(64) + "/screenshot.png)", ["image"]],
    ["bullet list", "- one\n- two", ["bulletList", "listItem"]],
    ["ordered list", "1. one\n2. two", ["orderedList", "listItem"]],
    ["multi-line block", "line one\nline two", ["hardBreak"]],
    ["snake_case word", "call do_the_thing now", []],
    ["hex colour is not a tag", "colour #f0f0f0 here", []],
    ["anchor in a word is not a tag", "page.html#section and a#b", []],
  ];
  for (const [name, markdown, expectKinds] of cases) {
    test(name, () => {
      expect(roundTrip(markdown)).toBe(markdown);
      const k = kinds();
      for (const want of expectKinds) expect(k, `${name}: doc has ${want}`).toContain(want);
      if (name.endsWith("is not a tag")) expect(k).not.toContain("tag");
    });
  }

  // Two marks that START at the same character are written in schema order
  // (prosemirror-markdown), so `==**hi** there==` comes back as `**==hi==** ==there==`
  // — the same formatting, different text (and a space between them loses the
  // outer mark: expelEnclosingWhitespace). Same for `*__b__ c*` (bold/italic).
  // Logged in docs/UX-review-2026-10.md; here we hold it to "same doc, stable".
  for (const markdown of ["==**hi** there==", "**==hi== there**", "*__b__ c*"]) {
    test(`overlapping marks keep their formatting: ${markdown}`, () => {
      load(markdown);
      const before = charMarks();
      const once = md();
      load(once);
      expect(charMarks()).toEqual(before);
      expect(roundTrip(once)).toBe(once);
    });
  }

  test("round trip is stable (a second pass changes nothing)", () => {
    const all = cases.map(([, m]) => m);
    for (const m of all) {
      const once = roundTrip(m);
      expect(roundTrip(once)).toBe(once);
    }
  });
});

describe("what the user types serializes correctly", () => {
  test("typing '#urgent ' makes a tag that saves as #urgent (C-3)", () => {
    typeText("x #urgent done");
    expect(md()).toBe("x #urgent done");
    expect(kinds()).toContain("tag");
    // …and it parses back to the same tag.
    expect(roundTrip(md())).toBe("x #urgent done");
  });

  test("typing '#tag ' at the start of a block", () => {
    typeText("#idea later");
    expect(md()).toBe("#idea later");
  });

  test("'# ' at the start of a block is still a heading, not a tag", () => {
    typeText("# Heading");
    expect(md()).toBe("# Heading");
    expect(kinds()).not.toContain("tag");
  });

  test("typing '==hi==' makes a highlight that saves as ==hi== (C-4)", () => {
    typeText("say ==hi== ");
    expect(kinds()).toContain("mark:highlight");
    expect(md()).toBe("say ==hi==");
  });

  test("the highlight command saves as ==…== (C-4)", () => {
    load("make this bright");
    // select "this"
    ed.commands.setTextSelection({ from: 6, to: 10 });
    ed.commands.toggleHighlight();
    expect(md()).toBe("make ==this== bright");
  });

  test("typing [[Page]] makes a wiki link", () => {
    typeText("see [[Page]]");
    expect(kinds()).toContain("wikiLink");
    expect(md()).toBe("see [[Page]]");
  });

  test("typing ((uuid)) makes a block ref", () => {
    typeText(`ref ((${UUID}))`);
    expect(kinds()).toContain("blockRef");
    expect(md()).toBe(`ref ((${UUID}))`);
  });
});
