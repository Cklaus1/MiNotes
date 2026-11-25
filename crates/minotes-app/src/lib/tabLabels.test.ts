import { describe, expect, it } from "vitest";
import { journalDateOfTitle, tabLabel } from "./tabLabels";

const today = "2026-11-17";

describe("tabLabel", () => {
  it("names views and gives them their icon", () => {
    expect(tabLabel({ notebook: "n", kind: "view", view: "tasks" }, { today })).toMatchObject({ icon: "square-check", title: "Tasks" });
    expect(tabLabel({ notebook: "n", kind: "view", view: "pages" }, { today }).title).toBe("All Pages");
    expect(tabLabel({ notebook: "n", kind: "view", view: "graph" }, { today }).icon).toBe("graph");
  });

  it("shows today's journal as Today and other days short", () => {
    const t = tabLabel({ notebook: "n", kind: "page", pageId: "j", title: "Journal/2026-11-17" }, { today });
    expect(t.icon).toBe("journal");
    expect(t.title.startsWith("Today · ")).toBe(true);
    const other = tabLabel({ notebook: "n", kind: "journal-day", date: "2026-11-12" }, { today });
    expect(other.title.startsWith("Today")).toBe(false);
    expect(other.icon).toBe("journal");
  });

  it("uses the live title of a renamed page", () => {
    const titles = new Map([["p1", "New name"]]);
    expect(tabLabel({ notebook: "n", kind: "page", pageId: "p1", title: "Old name" }, { titles, today }).title).toBe("New name");
    expect(tabLabel({ notebook: "n", kind: "page", pageId: "p2", title: "Kept" }, { titles, today }).title).toBe("Kept");
  });

  it("an empty tab", () => {
    expect(tabLabel(null, { today }).title).toBe("New tab");
  });

  it("journal titles", () => {
    expect(journalDateOfTitle("Journal/2026-01-02")).toBe("2026-01-02");
    expect(journalDateOfTitle("Journal notes")).toBeNull();
  });
});
