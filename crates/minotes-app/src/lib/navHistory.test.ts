import { beforeAll, describe, expect, it } from "vitest";
import * as api from "./api";
import {
  canGoBack, canGoForward, goBack, goForward, installNavHistory, navHistorySnapshot, navKeyDelta,
  noteLocation, sameEntry, setNavExecutor, setPendingNav, takePendingNav, type NavEntry,
} from "./navHistory";
import { LOCK_CHANGED } from "./encryption";

let nb = "";
const page = (id: string, notebook = nb): NavEntry => ({ notebook, kind: "page", pageId: id, title: id.toUpperCase() });
const view = (v: NavEntry["view"]): NavEntry => ({ notebook: nb, kind: "view", view: v });

describe("navHistory", () => {
  const ran: NavEntry[] = [];
  beforeAll(async () => {
    nb = await api.getCurrentNotebook();
    installNavHistory();
    setNavExecutor(e => { ran.push(e); noteLocation(e); });
  });

  it("records pages and views; back / forward walk them without new entries", async () => {
    noteLocation(page("a"));
    noteLocation(page("b"));
    noteLocation(view("tasks"));
    noteLocation(view("tasks")); // the same place again: no entry
    expect(navHistorySnapshot().entries.length).toBe(3);
    expect(canGoBack()).toBe(true);
    expect(canGoForward()).toBe(false);

    await goBack();
    expect(ran[ran.length - 1]).toMatchObject({ kind: "page", pageId: "b" });
    await goBack();
    expect(ran[ran.length - 1]).toMatchObject({ pageId: "a" });
    expect(canGoBack()).toBe(false);
    await goForward();
    expect(ran[ran.length - 1]).toMatchObject({ pageId: "b" });
    expect(navHistorySnapshot().entries.length).toBe(3);

    // A new place after going back drops what was ahead.
    noteLocation(page("c"));
    const s = navHistorySnapshot();
    expect(s.entries.map(e => e.pageId ?? e.view)).toEqual(["a", "b", "c"]);
    expect(canGoForward()).toBe(false);
  });

  it("ignores places passed on the way during a step", async () => {
    const before = navHistorySnapshot().entries.length;
    setNavExecutor(e => {
      ran.push(e);
      noteLocation(page("journal-on-the-way")); // e.g. a switch landing on the journal first
      noteLocation(e);
    });
    await goBack();
    expect(navHistorySnapshot().entries.length).toBe(before);
    expect(navHistorySnapshot().entries.some(e => e.pageId === "journal-on-the-way")).toBe(false);
    setNavExecutor(e => { ran.push(e); noteLocation(e); });
  });

  it("a renamed page is the same place (by id); a page by title matches its id later", () => {
    expect(sameEntry(page("x"), { ...page("x"), title: "Renamed" })).toBe(true);
    expect(sameEntry({ notebook: nb, kind: "page", title: "Roadmap" }, { notebook: nb, kind: "page", pageId: "1", title: "roadmap" })).toBe(true);
    expect(sameEntry(page("x", "nb1"), page("x", "nb2"))).toBe(false);
  });

  it("keeps a step for a locked notebook until it is unlocked", () => {
    const target: NavEntry = { notebook: "vault", kind: "page", title: "Secrets" };
    window.dispatchEvent(new CustomEvent(LOCK_CHANGED, { detail: { key: "vault", name: "Vault", locked: true } }));
    setPendingNav(target);
    expect(takePendingNav("vault")).toBeNull(); // locked: App isn't there to take it
    window.dispatchEvent(new CustomEvent(LOCK_CHANGED, { detail: { key: "vault", name: "Vault", locked: false } }));
    expect(takePendingNav("other")).toBeNull();
    expect(takePendingNav("vault")).toEqual(target);
    noteLocation({ notebook: "vault", kind: "page", pageId: "s1", title: "Secrets" }); // reached
    expect(navHistorySnapshot().pending).toBeNull();
  });

  it("Ctrl+[ / Ctrl+] are back / forward; other chords are not", () => {
    const k = (init: KeyboardEventInit) => navKeyDelta(new KeyboardEvent("keydown", init));
    expect(k({ key: "[", ctrlKey: true })).toBe(-1);
    expect(k({ key: "]", ctrlKey: true })).toBe(1);
    expect(k({ key: "[", ctrlKey: true, shiftKey: true })).toBe(0);
    expect(k({ key: "ArrowLeft", altKey: true })).toBe(0);
    expect(k({ key: "[" })).toBe(0);
  });
});
