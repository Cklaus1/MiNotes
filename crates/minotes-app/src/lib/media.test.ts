/**
 * Image width syntax `![alt|300](src)` must survive the block editor's markdown
 * round trip (the editor keeps the alt verbatim), and the helpers that read it.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Editor } from "@tiptap/core";
import { createBlockExtensions } from "../editor/blockExtensions";
import { attachmentName, decorateMedia, formatSize, parseSizedAlt } from "./media";

let ed: Editor;
beforeEach(() => {
  ed = new Editor({
    element: document.createElement("div"),
    extensions: createBlockExtensions({ onPageLinkClick() {}, onBlockRefClick() {}, onTagClick() {} }),
    content: "",
  });
});
afterEach(() => ed.destroy());
const roundTrip = (markdown: string): string => {
  ed.commands.setContent(markdown);
  return ((ed.storage as any).markdown.getMarkdown() as string).trim();
};

const HASH = "a".repeat(64);

describe("image width syntax", () => {
  test("round-trips through the editor", () => {
    for (const md of [
      `![diagram|300](attachment:${HASH}/diagram.png)`,
      "![|480](data:image/png;base64,iVBORw0KGgo=)",
      `![photo of the bay|640x480](attachment:${HASH}/bay.jpg)`,
    ]) {
      expect(roundTrip(md)).toBe(md);
    }
  });
  test("parseSizedAlt", () => {
    expect(parseSizedAlt("diagram|300")).toEqual({ alt: "diagram", width: 300 });
    expect(parseSizedAlt("bay | 640x480")).toEqual({ alt: "bay", width: 640 });
    expect(parseSizedAlt("a|b")).toEqual({ alt: "a|b", width: null });
    expect(parseSizedAlt("plain")).toEqual({ alt: "plain", width: null });
  });
  test("a rendered image gets the width, the alt loses the suffix", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div class="block-static"><img alt="d|240" src="data:image/png;base64,x"></div>`;
    decorateMedia(root);
    const img = root.querySelector("img")!;
    expect(img.style.width).toBe("240px");
    expect(img.alt).toBe("d");
  });
});

describe("file chips", () => {
  test("names and sizes", () => {
    expect(attachmentName(`attachment:${HASH}/my%20report.pdf`, "")).toBe("my report.pdf");
    expect(attachmentName(`attachment:${HASH}/x.pdf`, "Report")).toBe("Report");
    expect(formatSize(900)).toBe("900 B");
    expect(formatSize(12_300)).toBe("12 KB");
    expect(formatSize(3_600_000)).toBe("3.4 MB");
  });
});
