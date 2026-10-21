/// <reference types="vite/client" />
/**
 * Lint: the app never calls the browser's `confirm()` / `alert()` (UX review C-1).
 * In the desktop app the dialog plugin turns them into async functions, so
 * `if (!confirm(…)) return` always went ahead. Use `confirmDialog` (lib/confirm.ts)
 * or a toast. (`prompt()` still works natively; replacing it is Wave 3.)
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

const BANNED = /(?<![\w$.])(?:window\.|globalThis\.|self\.)?(confirm|alert)\s*\(|\b(?:window|globalThis)\.(confirm|alert)\b/;

test("the source tree was found", () => {
  expect(Object.keys(sources).length).toBeGreaterThan(50);
  expect(Object.keys(sources).some((p) => p.endsWith("/src/lib/confirm.ts"))).toBe(true);
});

test("no window.confirm / confirm() / alert() in src (use confirmDialog)", () => {
  const hits: string[] = [];
  for (const [path, src] of Object.entries(sources)) {
    code(src).split("\n").forEach((line, i) => {
      if (BANNED.test(line)) hits.push(`${path}:${i + 1}: ${line.trim()}`);
    });
  }
  expect(hits).toEqual([]);
});

test("the lint catches what it should", () => {
  for (const bad of ["if (!confirm(`x`)) return;", "const ok = window.confirm(", "alert(msg)", "if (window.confirm) {}"]) {
    expect(BANNED.test(code(bad)), bad).toBe(true);
  }
  for (const ok of ["await confirmDialog({ message })", "api.confirmSync()", "onConfirm(x)", "// window.confirm() is broken"]) {
    expect(BANNED.test(code(ok)), ok).toBe(false);
  }
});
