import { describe, expect, it } from "vitest";
import { cardBadges, inlineSegments, parseWikiLink, segmentsText } from "./richText";

const ID = "0e1d2c3b-4a59-4687-a6b5-c4d3e2f1a0b9";

describe("inline segments (kanban cards, mind map nodes)", () => {
  it("links become chips with the page title, never raw markdown", () => {
    const s = inlineSegments(`TODO book flights for [[Travel Lisbon|${ID}]] with **Ana**`);
    expect(s).toEqual([
      { kind: "text", text: "book flights for " },
      { kind: "link", target: "Travel Lisbon", label: "Travel Lisbon" },
      { kind: "text", text: " with Ana" },
    ]);
    expect(segmentsText(s)).toBe("book flights for Travel Lisbon with Ana");
  });
  it("a link never swallows an earlier lone [[", () => {
    const s = inlineSegments("Type **[[** to link. Try [[My First Page]]");
    expect(s.filter((x) => x.kind === "link")).toEqual([{ kind: "link", target: "My First Page", label: "My First Page" }]);
  });
  it("aliases and cross-notebook links", () => {
    expect(parseWikiLink("Page|shown")).toEqual({ target: "Page", label: "shown" });
    expect(parseWikiLink("Work::Plan")).toEqual({ target: "Plan", label: "Plan", notebook: "Work" });
  });
  it("tags are pieces of their own, or dropped for badges", () => {
    expect(inlineSegments("Ship it #work today")).toEqual([
      { kind: "text", text: "Ship it " }, { kind: "tag", tag: "work" }, { kind: "text", text: " today" },
    ]);
    expect(segmentsText(inlineSegments("Ship it #work", { withTags: false }))).toBe("Ship it");
  });
  it("headings, markers and property lines are not shown as text", () => {
    expect(segmentsText(inlineSegments("## Big plan"))).toBe("Big plan");
    expect(segmentsText(inlineSegments("due:: 2026-11-02\nDONE Write report"))).toBe("Write report");
    expect(segmentsText(inlineSegments("x".repeat(50), { maxLen: 10 }))).toBe("xxxxxxxxx…");
  });
});

describe("card badges", () => {
  const today = "2026-10-21";
  it("dates first (overdue / today / later), then tags, then properties", () => {
    const b = cardBadges("TODO Pay rent #home #money\ndue:: 2026-10-20", [{ key: "owner", value: "Robin" }], today);
    expect(b.map((x) => x.label)).toEqual(["Due 2026-10-20", "#home", "#money", "owner: Robin"]);
    expect(b[0].when).toBe("overdue");
    expect(cardBadges("SCHEDULED: <2026-10-21 Wed>", [], today)[0]).toMatchObject({ label: "Scheduled 2026-10-21", when: "today" });
    expect(cardBadges("x", [{ key: "deadline", value: "2027-01-01" }], today)[0].when).toBe("later");
  });
  it("hides internal properties and caps the count", () => {
    expect(cardBadges("x", [{ key: "kanban-color", value: "#fff" }, { key: "collapsed", value: "true" }], today)).toEqual([]);
    expect(cardBadges("#a #b #c #d #e", [], today, 3).length).toBe(3);
    expect(cardBadges("x", [{ key: "tags", value: "alpha, beta" }], today).map((x) => x.label)).toEqual(["#alpha", "#beta"]);
  });
});
