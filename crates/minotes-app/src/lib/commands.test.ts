import { describe, expect, it } from "vitest";
import { rankCommands, recencyBoost, registerCommands, listCommands } from "./commands";

const CMDS = [
  { id: "ai-settings", label: "AI Settings", keywords: "provider model key" },
  { id: "settings", label: "Settings", keywords: "preferences options" },
  { id: "delete-page", label: "Delete Page", keywords: "trash remove bin" },
  { id: "export-page", label: "Export Page as HTML…", keywords: "save download" },
  { id: "switch", label: "Switch Notebook…", keywords: "open notebook change" },
  { id: "sync", label: "Sync Now", keywords: "git push pull" },
  { id: "theme", label: "Toggle Theme", keywords: "dark light" },
];
const ids = (q: string, recent: string[] = []) => rankCommands(CMDS, q, recent).map(r => r.cmd.id);

describe("rankCommands", () => {
  it("an exact label beats a word start, even a recent one", () => {
    expect(ids("settings", ["ai-settings"])[0]).toBe("settings");
  });

  it("finds commands by keyword, below label hits", () => {
    expect(ids("trash")[0]).toBe("delete-page");
    expect(ids("dark")).toEqual(["theme"]);
    // A label hit beats a keyword hit of the same kind.
    expect(ids("sync")[0]).toBe("sync");
  });

  it("never matches scattered letters inside keywords", () => {
    // "sw": Switch (word start) and Sync Now (letters in the label), not Export (s…w in "save download").
    expect(ids("sw")).not.toContain("export-page");
    expect(ids("sw")[0]).toBe("switch");
  });

  it("tolerates typos in labels", () => {
    expect(ids("swtich")[0]).toBe("switch");
    expect(ids("tgogle theme")[0]).toBe("theme");
  });

  it("empty query: recent commands first, the rest in order", () => {
    expect(ids("", ["sync", "theme"]).slice(0, 3)).toEqual(["sync", "theme", "ai-settings"]);
  });

  it("recency decays with position", () => {
    expect(recencyBoost(["a", "b"], "a")).toBeGreaterThan(recencyBoost(["a", "b"], "b"));
    expect(recencyBoost(["a"], "z")).toBe(0);
  });

  it("marks the matched part of the label", () => {
    const [top] = rankCommands(CMDS, "sync", []);
    expect(top.cmd.id).toBe("sync");
    expect(top.ranges).toEqual([[0, 4]]);
  });
});

describe("the command registry", () => {
  it("resolves lazy labels and availability, and de-duplicates by id", () => {
    let shown = true;
    const off = registerCommands("t1", [
      { id: "x", label: () => (shown ? "Hide X" : "Show X"), run: () => {} },
      { id: "y", label: "Y", available: () => false, run: () => {} },
    ]);
    const off2 = registerCommands("t2", [{ id: "x", label: "Duplicate", run: () => {} }]);
    expect(listCommands().filter(c => c.id === "x").map(c => c.label)).toEqual(["Hide X"]);
    shown = false;
    expect(listCommands().find(c => c.id === "x")?.label).toBe("Show X");
    expect(listCommands().some(c => c.id === "y")).toBe(false);
    off(); off2();
    expect(listCommands().some(c => c.id === "x")).toBe(false);
  });
});
