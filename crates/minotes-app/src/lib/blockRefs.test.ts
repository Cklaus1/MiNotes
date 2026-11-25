/**
 * C-12: a ((uuid)) chip shows the referenced block's text (not the uuid), and
 * follows edits of that block.
 */
import { beforeEach, describe, expect, test } from "vitest";
import { hydrateBlockRefs, noteBlockContent, primeBlockRef, refLabel, resetBlockRefs } from "./blockRefs";
import { renderBlockStatic } from "../editor/staticRender";

const ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

describe("refLabel", () => {
  test("plain text of the first line, without markdown", () => {
    expect(refLabel("Source text with **bold** and *it*")).toBe("Source text with bold and it");
    expect(refLabel("## Heading")).toBe("Heading");
    expect(refLabel("TODO call [[Bob|1234abcd]] about `x`")).toBe("call Bob about x");
    expect(refLabel("see [site](https://x.y) ==hi==")).toBe("see site hi");
    expect(refLabel("first\nsecond")).toBe("first");
    expect(refLabel("a snake_case_name")).toBe("a snake_case_name");
  });
  test("long text is cut", () => {
    expect(refLabel("x".repeat(200)).length).toBe(80);
  });
});

describe("chips", () => {
  beforeEach(() => resetBlockRefs());

  test("a static chip never shows the uuid, and shows the text once known", () => {
    const root = document.createElement("div");
    root.appendChild(renderBlockStatic(`see ((${ID})) here`));
    document.body.appendChild(root);
    const chip = root.querySelector(".block-ref")!;
    expect(chip.getAttribute("data-block-id")).toBe(ID);
    expect(chip.textContent).not.toContain(ID);
    primeBlockRef({ id: ID, content: "The **source**", pageTitle: "Other", pageId: "p" });
    hydrateBlockRefs(root);
    expect(chip.textContent).toBe("The source");
    root.remove();
  });

  test("an edit of the referenced block relabels every chip", () => {
    const root = document.createElement("div");
    root.appendChild(renderBlockStatic(`a ((${ID})) b ((${ID}))`));
    document.body.appendChild(root);
    primeBlockRef({ id: ID, content: "old", pageTitle: "Other", pageId: "p" });
    hydrateBlockRefs(root);
    noteBlockContent(ID, "new text");
    expect([...root.querySelectorAll(".block-ref")].map(c => c.textContent)).toEqual(["new text", "new text"]);
    root.remove();
  });

  test("an embed renders as an embed chip, not the referenced text", () => {
    const root = document.createElement("div");
    root.appendChild(renderBlockStatic(`{{embed ((${ID}))}}`));
    const chip = root.querySelector(".block-ref")!;
    expect(chip.classList.contains("block-embed-chip")).toBe(true);
    expect(chip.hasAttribute("data-embed")).toBe(true);
  });
});
