/**
 * Slash menu matching (UX review 2026-10): exact-substring matching found
 * nothing for `/h2` or `/codeblock`. Prefix / alias / fuzzy matching, best first.
 */
import { describe, expect, test } from "vitest";
import { filterSlashCommands } from "./slashCommands";

const top = (q: string) => filterSlashCommands(q)[0]?.title;
const titles = (q: string) => filterSlashCommands(q).map(c => c.title);

describe("filterSlashCommands", () => {
  test("aliases", () => {
    expect(top("h1")).toBe("Heading 1");
    expect(top("h2")).toBe("Heading 2");
    expect(top("h3")).toBe("Heading 3");
    expect(top("hr")).toBe("Divider");
    expect(top("divider")).toBe("Divider");
    expect(top("todo")).toBe("Todo List");
    expect(top("code")).toBe("Code Block");
    expect(top("codeblock")).toBe("Code Block");
    expect(top("ul")).toBe("Bullet List");
    expect(top("ol")).toBe("Numbered List");
  });

  test("numbered list exists", () => {
    expect(titles("")).toContain("Numbered List");
    expect(top("numbered")).toBe("Numbered List");
  });

  test("prefix of the title or a word in it", () => {
    expect(top("head")).toBe("Heading 1");
    expect(titles("head").slice(0, 3)).toEqual(["Heading 1", "Heading 2", "Heading 3"]);
    expect(top("quo")).toBe("Quote");
    expect(top("tab")).toBe("Table");
    expect(top("white")).toBe("Whiteboard");
  });

  test("case and spaces don't matter", () => {
    expect(top("Code Block")).toBe("Code Block");
    expect(top("CODE")).toBe("Code Block");
  });

  test("fuzzy (letters in order)", () => {
    expect(top("cdblk")).toBe("Code Block");
    expect(top("wbd")).toBe("Whiteboard");
  });

  test("description words still match, ranked after titles", () => {
    expect(titles("checkbox")).toContain("Todo List");
    expect(titles("meeting")[0]).toMatch(/^Template: Meeting/);
  });

  test("nothing matches nonsense", () => {
    expect(titles("zzqx")).toEqual([]);
  });

  test("empty query lists everything in the menu's order", () => {
    expect(titles("").slice(0, 3)).toEqual(["Heading 1", "Heading 2", "Heading 3"]);
  });
});
