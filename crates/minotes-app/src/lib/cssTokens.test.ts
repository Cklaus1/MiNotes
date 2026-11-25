/**
 * Lint: no CSS custom property refers to itself, directly or through other
 * properties. `--text-muted: var(--text-muted)` (the Obsidian-compat block)
 * made the variable "guaranteed-invalid" app-wide: muted text fell back to the
 * inherited colour and every border/background drawn with it vanished
 * (UX review, Wave 3 item 1).
 */
import { expect, test } from "vitest";

// @ts-expect-error -- provided by vitest.config.ts (vitest empties even `?raw` CSS)
import stylesheets from "virtual:stylesheets";

const sheets = stylesheets as Record<string, string>;

/** name → every custom property its definitions (in any rule) refer to. */
function references(css: string, into = new Map<string, Set<string>>()) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of clean.matchAll(/(--[\w-]+)\s*:\s*([^;{}]*)/g)) {
    const [, name, value] = m;
    const refs = into.get(name) ?? new Set<string>();
    for (const r of value.matchAll(/var\(\s*(--[\w-]+)/g)) refs.add(r[1]);
    into.set(name, refs);
  }
  return into;
}

function cycles(graph: Map<string, Set<string>>): string[] {
  const found: string[] = [];
  const state = new Map<string, 1 | 2>();
  const visit = (n: string, path: string[]) => {
    if (state.get(n) === 2) return;
    if (state.get(n) === 1) {
      found.push([...path.slice(path.indexOf(n)), n].join(" → "));
      return;
    }
    state.set(n, 1);
    for (const r of graph.get(n) ?? []) visit(r, [...path, n]);
    state.set(n, 2);
  };
  for (const n of graph.keys()) visit(n, []);
  return found;
}

test("the stylesheets were found", () => {
  expect(Object.keys(sheets).some((p) => p.endsWith("/src/styles.css"))).toBe(true);
  expect(sheets["/src/styles.css"].length).toBeGreaterThan(10000);
});

test("no CSS custom property refers to itself (directly or in a cycle)", () => {
  const graph = new Map<string, Set<string>>();
  for (const css of Object.values(sheets)) references(css, graph);
  expect(cycles(graph)).toEqual([]);
});

test("the core colour tokens are defined with real values", () => {
  const all = Object.values(sheets).join("\n");
  for (const token of ["--text-muted", "--text-secondary", "--border", "--bg-surface"]) {
    expect(new RegExp(`${token}\\s*:\\s*#`).test(all), token).toBe(true);
  }
});

test("the cycle check catches what it should", () => {
  expect(cycles(references(":root{--a: var(--a);}"))).toHaveLength(1);
  expect(cycles(references(":root{--a: var(--b); --b: 1px solid var(--a);}"))).toHaveLength(1);
  expect(cycles(references(":root{--a: #fff; --b: var(--a, red);}"))).toEqual([]);
});
