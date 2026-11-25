/**
 * Code blocks (UX Wave 4): a language dropdown that changes the fence language,
 * and a copy button — in the live editor and in the static rendering.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Editor } from "@tiptap/core";
import { createBlockExtensions } from "./blockExtensions";
import { filterCodeLanguages } from "./codeLanguage";
import { renderBlockStatic } from "./staticRender";

let ed: Editor;
const md = (): string => ((ed.storage as any).markdown.getMarkdown() as string).trim();

beforeEach(() => {
  const el = document.createElement("div");
  document.body.appendChild(el);
  ed = new Editor({
    element: el,
    extensions: createBlockExtensions({ onPageLinkClick() {}, onBlockRefClick() {}, onTagClick() {} }),
    content: "",
  });
});
afterEach(() => { ed.destroy(); document.body.replaceChildren(); });

describe("code block header", () => {
  test("the live block shows the language and a copy button", () => {
    ed.commands.setContent("```python\nprint(1)\n```");
    const pre = ed.view.dom.querySelector("pre")!;
    expect(pre.querySelector(".code-lang-btn")?.textContent).toBe("Python");
    expect(pre.querySelector(".code-copy-btn")).toBeTruthy();
    expect(pre.getAttribute("data-language-label")).toBe("Python");
    // The header is not part of the text.
    expect(md()).toBe("```python\nprint(1)\n```");
  });

  test("picking a language in the dropdown rewrites the fence", () => {
    ed.commands.setContent("```python\nprint(1)\n```");
    (ed.view.dom.querySelector(".code-lang-btn") as HTMLButtonElement).click();
    const picker = document.querySelector("[data-testid=code-lang-picker]")!;
    expect(picker).toBeTruthy();
    const input = picker.querySelector("input")!;
    input.value = "rust";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(document.querySelector("[data-testid=code-lang-picker]")).toBeNull();
    expect(md()).toBe("```rust\nprint(1)\n```");
    expect(ed.view.dom.querySelector(".code-lang-btn")?.textContent).toBe("Rust");
  });

  test("plain text removes the language", () => {
    ed.commands.setContent("```js\nx\n```");
    (ed.view.dom.querySelector(".code-lang-btn") as HTMLButtonElement).click();
    const opt = [...document.querySelectorAll<HTMLButtonElement>(".code-lang-option")].find(b => b.textContent === "Plain text")!;
    opt.click();
    expect(md()).toBe("```\nx\n```");
    expect(ed.view.dom.querySelector(".code-lang-btn")?.textContent).toBe("Plain text");
  });

  test("Escape closes the list and changes nothing", () => {
    ed.commands.setContent("```go\nx\n```");
    (ed.view.dom.querySelector(".code-lang-btn") as HTMLButtonElement).click();
    document.querySelector<HTMLInputElement>(".code-lang-filter")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(document.querySelector("[data-testid=code-lang-picker]")).toBeNull();
    expect(md()).toBe("```go\nx\n```");
  });

  test("the static rendering has the same header", () => {
    const frag = renderBlockStatic("```sql\nselect 1\n```");
    const div = document.createElement("div");
    div.appendChild(frag);
    expect(div.querySelector(".code-lang-btn")?.textContent).toBe("SQL");
    expect(div.querySelector(".code-copy-btn")).toBeTruthy();
    expect(div.querySelector("code")?.textContent).toBe("select 1");
  });
});

describe("filterCodeLanguages", () => {
  test("plain text first, prefix matches by id or name", () => {
    expect(filterCodeLanguages("")[0]).toEqual({ id: "", label: "Plain text" });
    expect(filterCodeLanguages("py")[0].id).toBe("python");
    expect(filterCodeLanguages("type")[0].id).toBe("typescript");
    expect(filterCodeLanguages("c#").some(l => l.id === "csharp")).toBe(true);
  });
  test("an id we don't list can be used as typed", () => {
    expect(filterCodeLanguages("elixir").map(l => l.id)).toEqual(["elixir"]);
  });
  test("the block's own unlisted language stays in the list", () => {
    expect(filterCodeLanguages("", "elixir")[1]).toEqual({ id: "elixir", label: "elixir" });
  });
});
