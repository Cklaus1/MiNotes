/**
 * Image width (`![alt|300](src)`) and the resize handle (editor/imageView.ts):
 * the width round-trips, a drag writes it, a double-click on the handle removes it.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Editor } from "@tiptap/core";
import { createBlockExtensions } from "./blockExtensions";
import { parseImageAlt, withImageWidth } from "./imageView";

const SRC = "attachment:" + "c".repeat(64) + "/photo.png";
let ed: Editor;
const md = (): string => ((ed.storage as any).markdown.getMarkdown() as string).trim();

beforeEach(() => {
  const el = document.createElement("div");
  document.body.appendChild(el);
  ed = new Editor({ element: el, extensions: createBlockExtensions({ onPageLinkClick() {}, onBlockRefClick() {}, onTagClick() {} }), content: "" });
});
afterEach(() => { ed.destroy(); document.body.replaceChildren(); });

describe("image width", () => {
  test("alt helpers", () => {
    expect(parseImageAlt("photo|300")).toEqual({ text: "photo", width: 300 });
    expect(parseImageAlt("a|b")).toEqual({ text: "a|b", width: null });
    expect(withImageWidth("photo|300", 420)).toBe("photo|420");
    expect(withImageWidth("photo|300", null)).toBe("photo");
  });

  test("![alt|300](src) round-trips and renders 300 px wide with a handle", () => {
    ed.commands.setContent(`![photo|300](${SRC})`);
    expect(md()).toBe(`![photo|300](${SRC})`);
    const img = ed.view.dom.querySelector(".img-resizable img") as HTMLImageElement;
    expect(img.style.width).toBe("300px");
    expect(img.alt).toBe("photo");
    expect(ed.view.dom.querySelector(".img-resize-handle")).toBeTruthy();
  });

  test("dragging the handle writes the width; double-click removes it", () => {
    ed.commands.setContent(`![photo](${SRC})`);
    const img = ed.view.dom.querySelector(".img-resizable img") as HTMLImageElement;
    img.getBoundingClientRect = () => ({ width: 200, height: 100, left: 0, top: 0, right: 200, bottom: 100, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const h = ed.view.dom.querySelector(".img-resize-handle") as HTMLElement;
    const ev = (type: string, x: number) => { const e = new MouseEvent(type, { bubbles: true, clientX: x }) as any; e.pointerId = 1; return e; };
    h.dispatchEvent(Object.assign(ev("pointerdown", 100), {}));
    h.dispatchEvent(ev("pointermove", 220));
    h.dispatchEvent(ev("pointerup", 220));
    expect(md()).toBe(`![photo|320](${SRC})`);
    (ed.view.dom.querySelector(".img-resize-handle") as HTMLElement).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(md()).toBe(`![photo](${SRC})`);
  });

  test("web images keep their placeholder (no handle)", () => {
    ed.commands.setContent("![x|200](https://example.com/a.png)");
    expect(ed.view.dom.querySelector(".remote-img")).toBeTruthy();
    expect(ed.view.dom.querySelector(".img-resize-handle")).toBeNull();
    expect(md()).toBe("![x|200](https://example.com/a.png)");
  });
});
