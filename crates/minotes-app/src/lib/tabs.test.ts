import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as api from "./api";
import { goBack, goForward, navHistorySnapshot, noteLocation, setNavExecutor, type NavEntry } from "./navHistory";
import {
  activateTab, closeOtherTabs, closeTab, closeTabsToRight, cycleTab, duplicateTab, getTabsSnapshot, goToTab,
  loadNotebookTabs, MAX_CLOSED, MAX_SAVED_ENTRIES, moveActiveTab, moveTab, newTab, openInNewTab, parseTabs,
  reopenClosedTab, resetTabsForTests, serializeTabs, TABS_UI_KEY, togglePin, type TabsState,
} from "./tabs";
import { flushPendingEdits } from "./pendingEdits";

let nb = "";
const page = (id: string, notebook = nb): NavEntry => ({ notebook, kind: "page", pageId: id, title: id.toUpperCase() });
const tick = () => new Promise(r => setTimeout(r, 0));
/** Where App is (the executor "opens" what it is given). */
const shown: NavEntry[] = [];
const at = () => shown[shown.length - 1]?.pageId ?? shown[shown.length - 1]?.view;
/** App reports a location (a click in the current tab). */
const visit = (id: string) => { const e = page(id); shown.push(e); noteLocation(e); };
const snap = () => getTabsSnapshot();
const ids = () => snap().tabs.map(t => t.id);
const cur = (id: string) => { const t = snap().tabs.find(x => x.id === id)!; return t.entries[t.index]?.pageId; };
const activeIdx = () => ids().indexOf(snap().activeId);

describe("tabs", () => {
  beforeAll(async () => {
    nb = await api.getCurrentNotebook();
    setNavExecutor(e => { shown.push(e); noteLocation(e); });
  });
  beforeEach(async () => {
    resetTabsForTests();
    shown.length = 0;
    await loadNotebookTabs(nb);
    await api.setUiState(TABS_UI_KEY, "");
  });

  it("starts with one tab that is not visited yet; App's first location fills it", () => {
    expect(snap().tabs).toHaveLength(1);
    expect(snap().tabs[0].index).toBe(-1);
    visit("a");
    expect(cur(snap().activeId)).toBe("a");
  });

  it("opens in the current tab, in a new tab, and in a background tab", async () => {
    visit("a");
    visit("b"); // a click: the current tab
    expect(snap().tabs).toHaveLength(1);
    const first = snap().activeId;

    const bg = openInNewTab(page("c"), { activate: false });
    await tick();
    expect(snap().activeId).toBe(first);
    expect(ids()).toEqual([first, bg]);
    expect(at()).toBe("b");
    expect(cur(bg)).toBe("c");

    const fg = openInNewTab(page("d"), { activate: true });
    await tick();
    expect(ids()).toEqual([first, fg, bg]); // right after the active tab
    expect(snap().activeId).toBe(fg);
    expect(at()).toBe("d");

    const plus = newTab(page("journal"));
    await tick();
    expect(ids()).toEqual([first, fg, plus, bg]);
    expect(snap().activeId).toBe(plus);
    expect(at()).toBe("journal");
  });

  it("keeps back / forward per tab", async () => {
    visit("a1");
    visit("a2");
    const A = snap().activeId;
    const B = newTab(page("b1"));
    await tick();
    visit("b2");
    visit("b3");
    // A new tab from a link: Back goes no further than its first page.
    await goBack();
    expect(at()).toBe("b2");
    await goBack();
    expect(at()).toBe("b1");
    expect(await goBack()).toBe(false);
    expect(cur(A)).toBe("a2"); // A untouched

    activateTab(A);
    await tick();
    expect(at()).toBe("a2");
    await goBack();
    expect(at()).toBe("a1");
    expect(cur(B)).toBe("b1"); // B kept its place and its forward history
    activateTab(B);
    await tick();
    await goForward();
    expect(at()).toBe("b2");
    expect(snap().tabs.find(t => t.id === B)!.entries.map(e => e.pageId)).toEqual(["b1", "b2", "b3"]);
    expect(snap().tabs.find(t => t.id === A)!.entries.map(e => e.pageId)).toEqual(["a1", "a2"]);
    expect(navHistorySnapshot().entries.map(e => e.pageId)).toEqual(["b1", "b2", "b3"]);
  });

  it("never closes the last tab; closing the active tab activates its right neighbour, else the left", async () => {
    visit("a");
    const A = snap().activeId;
    closeTab(A);
    expect(ids()).toEqual([A]);

    const B = openInNewTab(page("b"), { activate: false });
    const C = openInNewTab(page("c"), { activate: false }); // after the active tab: A C B
    expect(ids()).toEqual([A, C, B]);
    closeTab(A);
    await tick();
    expect(snap().activeId).toBe(C);
    expect(at()).toBe("c");
    activateTab(B);
    await tick();
    closeTab(B); // the last one: the left neighbour
    await tick();
    expect(snap().activeId).toBe(C);
    expect(ids()).toEqual([C]);
    // Closing an inactive tab leaves the active one alone.
    const D = openInNewTab(page("d"), { activate: false });
    closeTab(D);
    expect(snap().activeId).toBe(C);
  });

  it("close others / to the right keep pinned tabs", async () => {
    visit("a");
    const A = snap().activeId;
    const B = openInNewTab(page("b"), { activate: false });
    const C = openInNewTab(page("c"), { activate: false });
    const D = openInNewTab(page("d"), { activate: false }); // A D C B
    togglePin(B); // B A D C
    expect(ids()).toEqual([B, A, D, C]);
    closeTabsToRight(A);
    expect(ids()).toEqual([B, A]);
    const E = openInNewTab(page("e"), { activate: false });
    activateTab(E);
    await tick();
    closeOtherTabs(A);
    await tick();
    expect(ids()).toEqual([B, A]);
    expect(snap().activeId).toBe(A);
    expect(at()).toBe("a");
    expect(C && D).toBeTruthy();
  });

  it("pinned tabs are a group at the left, in pin order", () => {
    visit("a");
    const A = snap().activeId;
    const B = openInNewTab(page("b"), { activate: false });
    const C = openInNewTab(page("c"), { activate: false });
    expect(ids()).toEqual([A, C, B]);
    togglePin(B);
    togglePin(C);
    expect(ids()).toEqual([B, C, A]);
    expect(snap().tabs.map(t => t.pinned)).toEqual([true, true, false]);
    togglePin(B); // unpinned: leads the unpinned tabs
    expect(ids()).toEqual([C, B, A]);
    // A new tab from a pinned active tab goes after the pinned group.
    activateTab(C);
    const N = openInNewTab(page("n"), { activate: false });
    expect(ids()).toEqual([C, N, B, A]);
  });

  it("moveTab: into the pinned group pins, out of it unpins; moveActiveTab stays in its group", async () => {
    visit("a");
    const A = snap().activeId;
    const B = openInNewTab(page("b"), { activate: false });
    const C = openInNewTab(page("c"), { activate: false }); // A C B
    togglePin(A); // A* C B
    moveTab(B, 0); // B* A* C
    expect(ids()).toEqual([B, A, C]);
    expect(snap().tabs.map(t => t.pinned)).toEqual([true, true, false]);
    moveTab(B, 2); // out: A* C B
    expect(ids()).toEqual([A, C, B]);
    expect(snap().tabs.find(t => t.id === B)!.pinned).toBe(false);
    moveTab(C, 1, true); // explicit drop zone at the edge: pinned
    expect(ids()).toEqual([A, C, B]);
    expect(snap().tabs.find(t => t.id === C)!.pinned).toBe(true);
    moveTab(C, 1, false);
    expect(snap().tabs.find(t => t.id === C)!.pinned).toBe(false);
    moveTab(B, 1); // reorder among unpinned: A* B C
    expect(ids()).toEqual([A, B, C]);

    activateTab(B);
    await tick();
    moveActiveTab(1);
    expect(ids()).toEqual([A, C, B]);
    moveActiveTab(1); // already last
    expect(ids()).toEqual([A, C, B]);
    moveActiveTab(-1);
    moveActiveTab(-1); // can't cross into the pinned group
    expect(ids()).toEqual([A, B, C]);
  });

  it("Ctrl+Tab cycles in row order with wrapping; Alt+n goes to the nth tab, Alt+9 to the last", async () => {
    visit("a");
    openInNewTab(page("d"), { activate: false });
    openInNewTab(page("c"), { activate: false });
    openInNewTab(page("b"), { activate: false }); // a b c d
    expect(activeIdx()).toBe(0);
    cycleTab(1);
    await tick();
    expect(activeIdx()).toBe(1);
    expect(at()).toBe("b");
    cycleTab(-1);
    cycleTab(-1); // wraps to the last
    await tick();
    expect(activeIdx()).toBe(3);
    expect(at()).toBe("d");
    cycleTab(1); // wraps to the first
    await tick();
    expect(activeIdx()).toBe(0);
    goToTab(3);
    await tick();
    expect(at()).toBe("c");
    goToTab(9);
    await tick();
    expect(activeIdx()).toBe(3);
    goToTab(8); // no 8th tab: nothing
    expect(activeIdx()).toBe(3);
  });

  it("duplicate copies the history", async () => {
    visit("a1");
    visit("a2");
    const A = snap().activeId;
    duplicateTab(A);
    await tick();
    const D = snap().activeId;
    expect(D).not.toBe(A);
    expect(ids()).toEqual([A, D]);
    expect(at()).toBe("a2");
    await goBack();
    expect(at()).toBe("a1");
    expect(cur(A)).toBe("a2");
    expect(snap().tabs.find(t => t.id === D)!.entries.map(e => e.pageId)).toEqual(["a1", "a2"]);
  });

  it("reopens closed tabs with their history, at most the last 10", async () => {
    visit("a");
    const A = snap().activeId;
    const B = openInNewTab(page("b1"), { activate: true });
    await tick();
    visit("b2");
    closeTab(B);
    await tick();
    expect(snap().closed).toBe(1);
    reopenClosedTab();
    await tick();
    const R = snap().activeId;
    expect(ids()).toEqual([A, R]);
    expect(at()).toBe("b2");
    await goBack();
    expect(at()).toBe("b1");
    expect(snap().closed).toBe(0);
    reopenClosedTab(); // nothing left: no-op
    expect(ids()).toHaveLength(2);

    for (let i = 0; i < 12; i++) closeTab(openInNewTab(page(`x${i}`), { activate: false }));
    expect(snap().closed).toBe(MAX_CLOSED);
    reopenClosedTab();
    await tick();
    expect(at()).toBe("x11");
  });

  it("serialize / parse round trip", () => {
    const state: TabsState = {
      notebook: nb,
      activeId: "t2",
      tabs: [
        { id: "t1", pinned: true, index: 0, entries: [page("p")] },
        { id: "t2", pinned: false, index: 1, entries: [page("a"), { notebook: nb, kind: "view", view: "tasks" }, { notebook: nb, kind: "journal-day", date: "2026-11-17" }] },
      ],
    };
    const back = parseTabs(serializeTabs(state), nb);
    expect(back).toEqual(state);
  });

  it("caps history at 50 entries per tab, keeping the current entry", () => {
    const entries = Array.from({ length: 120 }, (_, i) => page(`p${i}`));
    const json = serializeTabs({ notebook: nb, activeId: "t", tabs: [{ id: "t", pinned: false, index: 100, entries }] });
    const t = parseTabs(json, nb)!.tabs[0];
    expect(t.entries).toHaveLength(MAX_SAVED_ENTRIES);
    expect(t.entries[t.index].pageId).toBe("p100");
    // The same cap on a hand-written oversized save.
    const raw = JSON.stringify({ v: 1, notebook: nb, activeId: "t", tabs: [{ id: "t", pinned: false, index: 119, entries }] });
    const t2 = parseTabs(raw, nb)!.tabs[0];
    expect(t2.entries).toHaveLength(MAX_SAVED_ENTRIES);
    expect(t2.entries[t2.index].pageId).toBe("p119");
  });

  it("garbage → null; bad entries and empty tabs are dropped", () => {
    for (const g of ["", "nope", "null", "[]", "42", '{"v":2,"tabs":[]}', '{"v":1}', '{"v":1,"tabs":[]}', '{"v":1,"tabs":[null,{"entries":[{"kind":"zzz"}]}]}']) {
      expect(parseTabs(g, nb)).toBeNull();
    }
    const s = parseTabs(JSON.stringify({ v: 1, activeId: "missing", tabs: [
      { id: "x", entries: [{ kind: "page" }, { kind: "view", view: "bogus" }, { notebook: nb, kind: "page", pageId: "ok" }], index: 2 },
      { id: "x", pinned: true, entries: [{ notebook: nb, kind: "view", view: "trash" }], index: 0 },
    ] }), nb)!;
    expect(s.tabs).toHaveLength(2);
    expect(s.tabs[0].pinned).toBe(true); // pinned first
    expect(s.tabs[0].id).not.toBe(s.tabs[1].id); // duplicate ids made unique
    expect(s.tabs[1].entries).toEqual([{ notebook: nb, kind: "page", pageId: "ok" }]);
    expect(s.activeId).toBe(s.tabs[0].id);
  });

  it("stores another notebook's entries without titles; a restored tab never starts in another notebook", () => {
    const vault: NavEntry = { notebook: "vault", kind: "page", pageId: "v1", title: "Secret plans" };
    const byTitle: NavEntry = { notebook: "vault", kind: "page", title: "Only a title", create: true };
    const json = serializeTabs({ notebook: nb, activeId: "t", tabs: [{ id: "t", pinned: false, index: 3, entries: [page("a"), byTitle, vault, page("b")] }] });
    expect(json).not.toContain("Secret plans");
    expect(json).not.toContain("Only a title");
    expect(json).toContain("A"); // own titles are kept
    const t = parseTabs(json, nb)!.tabs[0];
    expect(t.entries.map(e => e.pageId)).toEqual(["a", "v1", "b"]);
    expect(t.entries[1]).toEqual({ notebook: "vault", kind: "page", pageId: "v1" });
    expect(t.entries[t.index].pageId).toBe("b");

    // Saved mid-way through a step into "vault": restored on this notebook's own entry.
    const mid = JSON.stringify({ v: 1, notebook: nb, activeId: "t", tabs: [{ id: "t", entries: [page("a"), { notebook: "vault", kind: "page", pageId: "v1" }, page("b")], index: 1 }] });
    const m = parseTabs(mid, nb)!.tabs[0];
    expect(m.entries[m.index].pageId).toBe("a");
    // Only other notebooks' entries: nothing to restore.
    expect(parseTabs(JSON.stringify({ v: 1, notebook: nb, tabs: [{ id: "t", entries: [{ notebook: "vault", kind: "page", pageId: "v1" }], index: 0 }] }), nb)).toBeNull();
  });

  it("a renamed notebook key: its own entries follow the new key", () => {
    const json = serializeTabs({ notebook: "old-key", activeId: "t", tabs: [{ id: "t", pinned: false, index: 0, entries: [page("a", "old-key")] }] });
    expect(parseTabs(json, nb)!.tabs[0].entries[0].notebook).toBe(nb);
  });

  it("saves to the notebook's ui_state (in the save barrier) and restores on reopen", async () => {
    visit("a1");
    visit("a2");
    const A = snap().activeId;
    const B = openInNewTab(page("b"), { activate: false });
    togglePin(B);
    await flushPendingEdits(); // the barrier writes at once
    const raw = await api.getUiState(TABS_UI_KEY);
    expect(raw).toBeTruthy();
    expect(localStorage.getItem(TABS_UI_KEY)).toBeNull();

    // A restart: a fresh store, App opens the journal, then the saved tabs come back.
    resetTabsForTests();
    shown.length = 0;
    visit("journal");
    await loadNotebookTabs(nb);
    await tick();
    expect(ids()).toEqual([B, A]);
    expect(snap().activeId).toBe(A);
    expect(snap().tabs[0].pinned).toBe(true);
    expect(at()).toBe("a2"); // App was sent to the active tab's page
    await goBack();
    expect(at()).toBe("a1");
  });

  it("a cross-notebook arrival lands in the notebook's active tab; Back returns to the source", async () => {
    visit("y1");
    visit("y2");
    // A link into "x": navHistory keeps the step pending while the notebook switches.
    const target: NavEntry = { notebook: "x", kind: "page", pageId: "xp", title: "XP" };
    const { setPendingNav } = await import("./navHistory");
    setPendingNav(target);
    await loadNotebookTabs("x"); // App reopened in notebook x
    noteLocation(target); // App took the pending step and arrived
    const s = snap();
    expect(s.tabs).toHaveLength(1);
    const e = s.tabs[0].entries;
    expect(e.map(x => x.pageId)).toEqual(["y2", "xp"]);
    expect(s.tabs[0].index).toBe(1);
    expect(navHistorySnapshot().pending).toBeNull();
  });
});
