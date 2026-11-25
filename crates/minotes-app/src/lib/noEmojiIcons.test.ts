/// <reference types="vite/client" />
/**
 * Lint: UI icons come from the app's icon set (lib/icons.ts, <Icon/>), not
 * emoji — emoji render differently per platform and as colour pictures next to
 * monochrome text (UX review Wave 3). Emoji the USER picks (page and project
 * icons) are content; the files that offer or show those are allowed below.
 */
import { expect, test } from "vitest";

const sources = import.meta.glob(["/src/**/*.tsx", "/src/**/*.ts", "!/src/**/*.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Files where emoji are user content or sample data, not UI icons. */
const ALLOWED = [
  "/src/components/FolderSettingsPanel.tsx", // the project icon picker (user content)
  "/src/lib/builtinTemplates.ts",            // template text
  "/src/lib/mockBackend.ts",                 // demo notes
  "/src/components/ObsidianPluginBrowser.tsx", // development-only stub
];

// Arrows and geometric shapes (▸ ▾ ↗ ↔) are typographic, not icons.
const EMOJI = /(?![\u2190-\u21FF\u25A0-\u25FF])\p{Extended_Pictographic}|\\u\{1F[0-9A-F]{3}\}|\\uD83[CDE]|&#1[0-9]{5};|&#x1F[0-9A-F]{3};/u;

/** Source without comments (an emoji in a comment is fine). */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");

test("no emoji used as UI icons (use <Icon name=…/>)", () => {
  const hits: string[] = [];
  for (const [path, src] of Object.entries(sources)) {
    if (ALLOWED.includes(path)) continue;
    code(src).split("\n").forEach((line, i) => {
      if (EMOJI.test(line)) hits.push(`${path}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  expect(hits).toEqual([]);
});

test("the lint catches what it should", () => {
  for (const bad of ["<span>📌 Pinned</span>", "&#128465; Trash", 'icon: "\\u{1F4C4}"', '"\\uD83D\\uDCC1"', "⚙"]) {
    expect(EMOJI.test(bad), bad).toBe(true);
  }
  for (const ok of ['<Icon name="pin" /> Pinned', "Move to… ▾", "← Notes", "✓ Saved"]) {
    expect(EMOJI.test(ok), ok).toBe(false);
  }
});
