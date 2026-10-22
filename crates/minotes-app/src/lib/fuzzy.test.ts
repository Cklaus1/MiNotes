import { describe, expect, it } from "vitest";
import { editDistance, fuzzyMatch, highlightParts, rankByFuzzy, snippetAround, TIER } from "./fuzzy";

const rank = (q: string, items: string[], boost?: (s: string) => number) =>
  rankByFuzzy(items, q, s => s, { boost }).map(r => r.item);

describe("fuzzyMatch tiers", () => {
  it("exact > prefix > word start > inside a word", () => {
    expect(fuzzyMatch("road", "road")!.tier).toBe(TIER.exact);
    expect(fuzzyMatch("road", "Roadmap")!.tier).toBe(TIER.prefix);
    expect(fuzzyMatch("map", "Product Map")!.tier).toBe(TIER.wordStart);
    expect(fuzzyMatch("map", "Roadmap")!.tier).toBe(TIER.substring);
  });

  it("finds words in any order", () => {
    const m = fuzzyMatch("lisbon travel", "Travel — Lisbon 2027")!;
    expect(m.tier).toBe(TIER.words);
    expect(m.ranges).toEqual([[0, 6], [9, 15]]);
  });

  it("matches letters in order (missing letters, acronyms)", () => {
    expect(fuzzyMatch("roadmp", "Roadmap")!.tier).toBe(TIER.letters);
    expect(fuzzyMatch("gtd", "Getting Things Done")!.tier).toBe(TIER.letters);
    expect(fuzzyMatch("gtd", "Getting Things Done")!.ranges).toEqual([[0, 1], [8, 9], [15, 16]]);
  });

  it("tolerates typos: swapped, wrong and extra letters", () => {
    expect(fuzzyMatch("raodmap", "Roadmap")!.tier).toBe(TIER.typo);
    expect(fuzzyMatch("roadmop", "Q4 Roadmap")!.tier).toBe(TIER.typo);
    expect(fuzzyMatch("roaddmap", "Roadmap")).not.toBeNull();
    expect(fuzzyMatch("meetnig notes", "Meeting Notes")).not.toBeNull();
    // A word still being typed, with a typo.
    expect(fuzzyMatch("raodm", "Roadmap 2027")).not.toBeNull();
  });

  it("rejects unrelated text", () => {
    expect(fuzzyMatch("roadmap", "Grocery list")).toBeNull();
    expect(fuzzyMatch("xyz", "Roadmap")).toBeNull();
    // Scattered letters across a long title are not a match.
    expect(fuzzyMatch("aeiou", "A long title with every vowel in it somewhere")).toBeNull();
    // Short words get no typo budget.
    expect(fuzzyMatch("cat", "car")).toBeNull();
  });

  it("is case-insensitive and keeps offsets of the original text", () => {
    const m = fuzzyMatch("MAP", "Product Map")!;
    expect(m.ranges).toEqual([[8, 11]]);
  });
});

describe("rankByFuzzy", () => {
  it("orders prefix > word start > inside a word > letters > typo", () => {
    const items = ["Myroadmap", "Raodmap draft", "Old Roadmap", "Roadmap", "Roadmap 2027", "R o a d m a p"];
    expect(rank("roadmap", items)).toEqual(["Roadmap", "Roadmap 2027", "Old Roadmap", "Myroadmap", "R o a d m a p", "Raodmap draft"]);
  });

  it("'roadmp' finds Roadmap first", () => {
    expect(rank("roadmp", ["Groceries", "Road trip", "Roadmap", "Meeting notes"])[0]).toBe("Roadmap");
  });

  it("a boost reorders inside a tier, never across tiers", () => {
    const items = ["AI Settings", "Settings", "Sync Settings"];
    // Recent "AI Settings" is boosted but "Settings" is an exact match.
    expect(rank("settings", items, s => (s === "AI Settings" ? 1 : 0))).toEqual(["Settings", "AI Settings", "Sync Settings"]);
    // Two word-start matches: the recent one first.
    expect(rank("set", ["Settings", "Set Theme"], s => (s === "Set Theme" ? 1 : 0))[0]).toBe("Set Theme");
    // Empty query: recent first, then the given order.
    expect(rank("", ["A", "B", "C"], s => (s === "C" ? 1 : 0))).toEqual(["C", "A", "B"]);
  });

  it("ties: shorter text first, then the given order", () => {
    expect(rank("new", ["New Page Template", "New Page", "New Notebook…"])).toEqual(["New Page", "New Notebook…", "New Page Template"]);
  });

  it("stays fast on 5,000 titles", () => {
    const words = ["Project", "Meeting", "Notes", "Roadmap", "Research", "Ideas", "Weekly", "Review", "Plan", "Draft", "Budget", "Travel"];
    const titles = Array.from({ length: 5000 }, (_, i) => `${words[i % 12]} ${words[(i * 7) % 12]} ${i}`);
    for (const q of ["r", "roadmp", "raodmap", "weekly review 42", "zzzz"]) rankByFuzzy(titles, q, s => s, { limit: 50 }); // warm up
    const t0 = performance.now();
    let n = 0;
    for (const q of ["r", "ro", "roa", "roadmp", "raodmap", "weekly review 42", "zzzz", "meetnig"]) n += rankByFuzzy(titles, q, s => s, { limit: 50 }).length;
    const per = (performance.now() - t0) / 8;
    expect(n).toBeGreaterThan(0);
    // ~5–15 ms per keystroke here; generous for slow CI runners.
    expect(per).toBeLessThan(120);
  });
});

describe("edit distance", () => {
  it("counts a swap as one edit and caps early", () => {
    expect(editDistance("raodmap", "roadmap")).toBe(1);
    expect(editDistance("roadmp", "roadmap")).toBe(1);
    expect(editDistance("abc", "xyz", 1)).toBe(2);
  });
});

describe("highlightParts / snippetAround", () => {
  it("splits text into hit and plain parts", () => {
    expect(highlightParts("Roadmap 2027", [[0, 4]])).toEqual([{ text: "Road", hit: true }, { text: "map 2027", hit: false }]);
    expect(highlightParts("abc", [])).toEqual([{ text: "abc", hit: false }]);
  });

  it("cuts a long block around the first hit, with shifted ranges", () => {
    const long = "word ".repeat(60) + "the needle is here " + "tail ".repeat(60);
    const s = snippetAround(long, "needle", 80);
    expect(s.text.startsWith("…")).toBe(true);
    expect(s.text.endsWith("…")).toBe(true);
    const [a, b] = s.ranges[0];
    expect(s.text.slice(a, b)).toBe("needle");
  });
});
