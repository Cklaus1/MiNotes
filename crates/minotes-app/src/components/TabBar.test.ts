import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import TabBar from "./TabBar";
import type { TabBarItem } from "../lib/tabBarTypes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tab = (id: string, o: Partial<TabBarItem> = {}): TabBarItem =>
  ({ id, pinned: false, icon: "page", title: id.toUpperCase(), fullTitle: `Page ${id}`, ...o });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function mount(tabs: TabBarItem[], extra: Record<string, unknown> = {}) {
  const fns = {
    onBack: vi.fn(), onForward: vi.fn(), onActivate: vi.fn(), onClose: vi.fn(), onNewTab: vi.fn(),
    onCloseOthers: vi.fn(), onCloseRight: vi.fn(), onTogglePin: vi.fn(), onDuplicate: vi.fn(),
    onReopenClosed: vi.fn(), onMove: vi.fn(),
  };
  act(() => {
    root.render(createElement(TabBar, {
      tabs, activeId: tabs[0].id, canBack: false, canForward: true, canReopen: false, ...fns, ...extra,
    }));
  });
  return fns;
}
const tabs = () => Array.from(host.querySelectorAll<HTMLElement>('[role="tab"]'));
const xs = () => host.querySelectorAll(".tab-x");
function rightClick(el: Element) {
  act(() => { el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
}
const menuItem = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>(".tab-menu-item")).find((b) => b.textContent?.includes(label))!;

test("one tab: no close button anywhere", () => {
  mount([tab("a")]);
  expect(tabs()).toHaveLength(1);
  expect(xs()).toHaveLength(0);
});

test("several tabs: every unpinned tab has a close button; title tooltip is the full title", () => {
  mount([tab("a"), tab("b"), tab("c")]);
  expect(tabs()).toHaveLength(3);
  expect(xs()).toHaveLength(3);
  expect(tabs()[1].getAttribute("title")).toBe("Page b");
  expect(tabs()[0].getAttribute("aria-selected")).toBe("true");
});

test("a pinned tab shows no title text and no close button", () => {
  mount([tab("a", { pinned: true }), tab("b")]);
  const pinned = tabs()[0];
  expect(pinned.querySelector(".tab-title")).toBeNull();
  expect(pinned.querySelector(".tab-x")).toBeNull();
  expect(pinned.getAttribute("aria-label")).toBe("Page a");
  expect(xs()).toHaveLength(1);
});

test("click activates; the close button closes without activating; middle-click closes", () => {
  const f = mount([tab("a"), tab("b")]);
  act(() => { tabs()[1].click(); });
  expect(f.onActivate).toHaveBeenCalledWith("b");
  act(() => { (xs()[1] as HTMLElement).click(); });
  expect(f.onClose).toHaveBeenCalledWith("b");
  expect(f.onActivate).toHaveBeenCalledTimes(1);

  const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 1 });
  act(() => { tabs()[0].dispatchEvent(down); });
  expect(down.defaultPrevented).toBe(true);
  act(() => { tabs()[0].dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 })); });
  expect(f.onClose).toHaveBeenCalledWith("a");
});

test("keyboard: Enter activates, ArrowRight focuses the next tab", () => {
  const f = mount([tab("a"), tab("b")]);
  act(() => { tabs()[0].focus(); });
  act(() => { tabs()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })); });
  expect(document.activeElement).toBe(tabs()[1]);
  act(() => { tabs()[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  expect(f.onActivate).toHaveBeenCalledWith("b");
});

test("context menu: items enabled and disabled by what there is to close", () => {
  // pinned P, then A, B: right-click B (last) → nothing to the right, others = A
  const f = mount([tab("p", { pinned: true }), tab("a"), tab("b")]);
  rightClick(tabs()[2]);
  expect(menuItem("Close other tabs").disabled).toBe(false);
  expect(menuItem("Close tabs to the right").disabled).toBe(true);
  expect(menuItem("Reopen closed tab").disabled).toBe(true);
  expect(menuItem("Pin tab")).toBeTruthy();
  act(() => { menuItem("Duplicate tab").click(); });
  expect(f.onDuplicate).toHaveBeenCalledWith("b");
  expect(document.querySelector(".tab-menu")).toBeNull();
});

test("context menu: pinned tab offers Unpin; right of a pinned-only remainder is disabled; Reopen follows canReopen", () => {
  mount([tab("p", { pinned: true }), tab("a")], { canReopen: true });
  rightClick(tabs()[0]);
  expect(menuItem("Unpin tab")).toBeTruthy();
  expect(menuItem("Close tabs to the right").disabled).toBe(false);
  expect(menuItem("Reopen closed tab").disabled).toBe(false);
});

test("context menu: Close is disabled with one tab", () => {
  mount([tab("a")]);
  rightClick(tabs()[0]);
  expect(menuItem("Close").disabled).toBe(true);
  expect(menuItem("Close other tabs").disabled).toBe(true);
});

test("compact: only the active tab, and the overflow button is always there", () => {
  mount([tab("a"), tab("b")], { compact: true, activeId: "b" });
  expect(tabs()).toHaveLength(1);
  expect(tabs()[0].getAttribute("data-tab-id")).toBe("b");
  expect(host.querySelector('[data-testid="tab-more"]')).not.toBeNull();
});

test("overflow list filters and Enter activates", () => {
  const f = mount([tab("a", { fullTitle: "Roadmap" }), tab("b", { fullTitle: "Journal" }), tab("c", { fullTitle: "Tasks" })], { compact: true });
  act(() => { (host.querySelector('[data-testid="tab-more"]') as HTMLElement).click(); });
  const rows = () => Array.from(document.querySelectorAll('[data-testid="tab-list-row"]'));
  expect(rows()).toHaveLength(3);
  const input = document.querySelector<HTMLInputElement>(".tab-list-search")!;
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input, "jour");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(rows()).toHaveLength(1);
  expect(rows()[0].textContent).toContain("Journal");
  act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  expect(f.onActivate).toHaveBeenCalledWith("b");
  expect(document.querySelector(".tab-list")).toBeNull();
});
