/// <reference types="vite/client" />
/**
 * Lint: the app never calls the browser's `confirm()` / `alert()` / `prompt()`
 * (UX review C-1, Wave 3). In the desktop app the dialog plugin turns confirm
 * into an async function, so `if (!confirm(…)) return` always went ahead, and
 * `prompt()` is a bare GTK dialog titled "JavaScript - tauri://localhost". Use
 * `confirmDialog` / `promptDialog` (lib/confirm.ts), a native picker, or a toast.
 */
import { expect, test } from "vitest";

const sources = import.meta.glob(["/src/**/*.ts", "/src/**/*.tsx", "!/src/**/*.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Source without comments and string/template contents (good enough for a lint). */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1")
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');
}

const BANNED = /(?<![\w$.])(?:window\.|globalThis\.|self\.)?(confirm|alert|prompt)\s*\(|\b(?:window|globalThis)\.(confirm|alert|prompt)\b/;

test("the source tree was found", () => {
  expect(Object.keys(sources).length).toBeGreaterThan(50);
  expect(Object.keys(sources).some((p) => p.endsWith("/src/lib/confirm.ts"))).toBe(true);
});

test("no window.confirm / confirm() / alert() / prompt() in src (use confirmDialog / promptDialog)", () => {
  const hits: string[] = [];
  for (const [path, src] of Object.entries(sources)) {
    code(src).split("\n").forEach((line, i) => {
      if (BANNED.test(line)) hits.push(`${path}:${i + 1}: ${line.trim()}`);
    });
  }
  expect(hits).toEqual([]);
});

test("the lint catches what it should", () => {
  for (const bad of ["if (!confirm(`x`)) return;", "const ok = window.confirm(", "alert(msg)", "if (window.confirm) {}",
    'const t = prompt("Page title:");', "window.prompt(`${title} (folder path)`)"]) {
    expect(BANNED.test(code(bad)), bad).toBe(true);
  }
  for (const ok of ["await confirmDialog({ message })", "api.confirmSync()", "onConfirm(x)", "// window.confirm() is broken",
    "await promptDialog({ label })", "askPassphrasePrompt()", "systemPrompt(x)"]) {
    expect(BANNED.test(code(ok)), ok).toBe(false);
  }
});
