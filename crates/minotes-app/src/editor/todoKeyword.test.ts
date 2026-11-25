/** TODO/DOING/DONE keyword decoration: spacing after the badge, DONE text struck. */
import { afterEach, expect, test } from "vitest";
import { Editor } from "@tiptap/core";
import { createBlockExtensions } from "./blockExtensions";

let ed: Editor | null = null;
afterEach(() => { ed?.destroy(); ed = null; });
const mount = (content: string) => {
  ed = new Editor({
    element: document.createElement("div"),
    extensions: createBlockExtensions({ onPageLinkClick() {}, onBlockRefClick() {}, onTagClick() {} }),
    content,
  });
  return ed.view.dom as HTMLElement;
};
const md = () => ((ed!.storage as any).markdown.getMarkdown() as string).trim();

test("the keyword is wrapped (room after the badge); the markdown is unchanged", () => {
  for (const kw of ["TODO", "DOING", "DONE"]) {
    const dom = mount(`${kw} write tests`);
    expect(dom.querySelector(".todo-kw")?.textContent).toBe(kw);
    expect(md()).toBe(`${kw} write tests`);
    ed!.destroy(); ed = null;
  }
});

test("DONE strikes the task text, not the keyword", () => {
  const dom = mount("DONE ship **it**");
  const struck = [...dom.querySelectorAll(".todo-done-text")].map(e => e.textContent).join("");
  expect(struck).toBe("ship it");
  expect(dom.querySelector(".todo-kw")?.closest(".todo-done-text")).toBeNull();
});

test("TODO is not struck; a word that merely starts with TODO is not a keyword", () => {
  expect(mount("TODO later").querySelector(".todo-done-text")).toBeNull();
  ed!.destroy(); ed = null;
  expect(mount("TODOS are fun").querySelector(".todo-kw")).toBeNull();
});
