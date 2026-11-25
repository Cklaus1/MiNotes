/**
 * Slash menu matching (UX review 2026-10): exact-substring matching found
 * nothing for `/h2` or `/codeblock`. Prefix / alias / fuzzy matching, best first.
 */
import { describe, expect, test } from "vitest";
import { filterSlashCommands, markdownLink, normalizeUrl, slashMenuItems } from "./slashCommands";

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

describe("the menu (UX Wave 4)", () => {
  const all = filterSlashCommands("");

  test("every command has an icon, a group and a one-line description (not a keyword list)", () => {
    for (const c of all) {
      expect(c.icon, c.title).toBeTruthy();
      expect(c.group, c.title).toBeTruthy();
      expect(c.description, c.title).toMatch(/^[A-Z0-9]/);
      expect(c.description.length, c.title).toBeLessThan(70);
    }
  });

  test("groups are contiguous, in order", () => {
    const seen: string[] = [];
    for (const c of all) if (seen[seen.length - 1] !== c.group) seen.push(c.group!);
    expect(seen).toEqual(["Basic", "Lists", "Media", "Links & dates", "Advanced", "Templates"]);
  });

  test("the new commands", () => {
    expect(top("callout")).toBe("Callout");
    expect(top("warning")).toBe("Warning callout");
    expect(top("tip")).toBe("Tip callout");
    expect(top("image")).toBe("Image");
    expect(top("img")).toBe("Image");
    expect(top("file")).toBe("File");
    expect(top("link")).toBe("Link");
    expect(top("date")).toBe("Date");
    expect(top("embed")).toBe("Embed block");
    expect(top("ref")).toBe("Block reference");
  });
});

describe("dates in the menu", () => {
  const NOW = new Date(2026, 9, 21, 12, 0); // a Wednesday
  test("/date next friday → that day first, nothing else", () => {
    expect(slashMenuItems("date next friday", NOW).map(i => i.title)).toEqual(["Date: 2026-10-23"]);
  });
  test("/date nonsense → no results", () => {
    expect(slashMenuItems("date banana", NOW)).toEqual([]);
  });
  test("/tomorrow and /fri put the day first", () => {
    expect(slashMenuItems("tomorrow", NOW)[0].title).toBe("Date: 2026-10-22");
    expect(slashMenuItems("fri", NOW)[0].title).toBe("Date: 2026-10-23");
  });
  test("/today is the Date command itself (no duplicate)", () => {
    const items = slashMenuItems("today", NOW);
    expect(items[0].title).toBe("Date");
    expect(items.filter(i => i.title.startsWith("Date:"))).toEqual([]);
  });
  test("ordinary queries get no date item", () => {
    expect(slashMenuItems("table", NOW)[0].title).toBe("Table");
    expect(slashMenuItems("code", NOW)[0].title).toBe("Code Block");
  });
});

describe("links", () => {
  test("normalizeUrl", () => {
    expect(normalizeUrl("example.com/a")).toBe("https://example.com/a");
    expect(normalizeUrl("http://x.org")).toBe("http://x.org");
    expect(normalizeUrl("not a url")).toBeNull();
    expect(normalizeUrl("word")).toBeNull();
  });
  test("markdownLink escapes", () => {
    expect(markdownLink("a [b]", "https://x.org/a b(c)")).toBe("[a \\[b\\]](https://x.org/a%20b%28c%29)");
  });
});
