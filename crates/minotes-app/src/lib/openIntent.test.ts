import { describe, it, expect, vi, afterEach } from "vitest";
import { openModeFrom, openInTab, setOpenInTabHandler, preventMiddlePaste } from "./openIntent";
import type { NavEntry } from "./navHistory";

const ev = (o: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; button: number }> = {}) =>
  ({ ctrlKey: false, metaKey: false, shiftKey: false, ...o });
const entry: NavEntry = { notebook: "", kind: "page", pageId: "p1", title: "A" };

afterEach(() => { setOpenInTabHandler(null); });

describe("openModeFrom", () => {
  it.each([
    ["plain", ev(), "current"],
    ["ctrl", ev({ ctrlKey: true }), "background"],
    ["meta", ev({ metaKey: true }), "background"],
    ["ctrl+shift", ev({ ctrlKey: true, shiftKey: true }), "foreground"],
    ["meta+shift", ev({ metaKey: true, shiftKey: true }), "foreground"],
    ["shift only", ev({ shiftKey: true }), "current"],
    ["middle", ev({ button: 1 }), "background"],
    ["left", ev({ button: 0 }), "current"],
  ] as const)("%s", (_n, e, mode) => { expect(openModeFrom(e)).toBe(mode); });
});

describe("openInTab", () => {
  it("is false without a handler", () => { expect(openInTab(entry, "background")).toBe(false); });
  it("is false for current", () => {
    const fn = vi.fn(); setOpenInTabHandler(fn);
    expect(openInTab(entry, "current")).toBe(false); expect(fn).not.toHaveBeenCalled();
  });
  it("calls the handler", () => {
    const fn = vi.fn(); setOpenInTabHandler(fn);
    expect(openInTab(entry, "foreground")).toBe(true); expect(fn).toHaveBeenCalledWith(entry, "foreground");
  });
  it("unregisters", () => {
    const off = setOpenInTabHandler(vi.fn()); off();
    expect(openInTab(entry, "background")).toBe(false);
  });
});

describe("preventMiddlePaste", () => {
  it("only for the middle button", () => {
    const pd = vi.fn();
    preventMiddlePaste({ button: 0, preventDefault: pd }); expect(pd).not.toHaveBeenCalled();
    preventMiddlePaste({ button: 1, preventDefault: pd }); expect(pd).toHaveBeenCalledTimes(1);
  });
});
