/** The app-wide Esc rule: only the topmost layer closes (lib/layers.ts). */
import { afterEach, expect, test, vi } from "vitest";
import { coveredAbove, debugLayers, openLayer, topLayer } from "./layers";

const opened: Array<() => void> = [];
function open(kind: Parameters<typeof openLayer>[0], close: (() => void) | null) {
  const off = openLayer(kind, close);
  opened.push(off);
  return off;
}
afterEach(() => { while (opened.length) opened.pop()!(); });

async function esc(init: { target?: HTMLElement; handled?: boolean } = {}) {
  const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  if (init.handled) ev.preventDefault();
  (init.target ?? document.body).dispatchEvent(ev);
  await new Promise(r => setTimeout(r, 5));
}

test("Esc closes only the highest kind, whatever the order they opened in", async () => {
  const canvas = vi.fn(), panel = vi.fn(), dialog = vi.fn(), menu = vi.fn();
  open("menu", menu);
  open("canvas", canvas);
  open("dialog", dialog);
  open("panel", panel);
  expect(debugLayers()).toEqual(["canvas", "panel", "dialog", "menu"]);
  await esc();
  expect(menu).toHaveBeenCalledTimes(1);
  expect(dialog).not.toHaveBeenCalled();
  expect(panel).not.toHaveBeenCalled();
  expect(canvas).not.toHaveBeenCalled();
});

test("among layers of one kind, the most recent closes", async () => {
  const first = vi.fn(), second = vi.fn();
  open("panel", first);
  open("panel", second);
  await esc();
  expect(second).toHaveBeenCalledTimes(1);
  expect(first).not.toHaveBeenCalled();
});

test("an Escape something else used closes nothing", async () => {
  const dialog = vi.fn();
  open("dialog", dialog);
  await esc({ handled: true });
  expect(dialog).not.toHaveBeenCalled();
});

test("a field marked data-escape-local keeps its Escape", async () => {
  const dialog = vi.fn();
  open("dialog", dialog);
  const input = document.createElement("input");
  input.setAttribute("data-escape-local", "");
  document.body.appendChild(input);
  await esc({ target: input });
  expect(dialog).not.toHaveBeenCalled();
  input.remove();
});

test("a layer without close swallows Esc: nothing underneath closes", async () => {
  const panel = vi.fn();
  open("panel", panel);
  open("dialog", null);
  await esc();
  expect(panel).not.toHaveBeenCalled();
});

test("coveredAbove tells a canvas that Esc belongs to something above it", () => {
  expect(coveredAbove("canvas")).toBe(false);
  const off = open("panel", () => {});
  expect(coveredAbove("canvas")).toBe(true);
  expect(coveredAbove("panel")).toBe(false);
  off();
  expect(coveredAbove("canvas")).toBe(false);
  expect(topLayer()).toBeUndefined();
});
