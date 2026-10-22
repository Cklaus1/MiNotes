/** Human-readable names for code-fence language ids (```js → "JavaScript"). */
const LANGUAGE_NAMES: Record<string, string> = {
  js: "JavaScript", javascript: "JavaScript", jsx: "JavaScript (JSX)", mjs: "JavaScript", cjs: "JavaScript",
  ts: "TypeScript", typescript: "TypeScript", tsx: "TypeScript (TSX)",
  py: "Python", python: "Python",
  rs: "Rust", rust: "Rust",
  sh: "Shell", bash: "Shell", shell: "Shell", zsh: "Shell",
  go: "Go", golang: "Go", java: "Java", kotlin: "Kotlin", kt: "Kotlin", swift: "Swift",
  c: "C", cpp: "C++", "c++": "C++", cs: "C#", csharp: "C#",
  rb: "Ruby", ruby: "Ruby", php: "PHP", lua: "Lua", r: "R", perl: "Perl",
  html: "HTML", xml: "XML", css: "CSS", scss: "SCSS", less: "Less",
  json: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML", ini: "INI",
  sql: "SQL", graphql: "GraphQL", md: "Markdown", markdown: "Markdown",
  diff: "Diff", dockerfile: "Dockerfile", makefile: "Makefile",
  text: "Plain text", plaintext: "Plain text", txt: "Plain text",
};

/**
 * Label shown above a code block. Known ids get a clean name, unknown ids are
 * shown as written, and a block with no language gets no label (null).
 */
export function codeLanguageLabel(language: string | null | undefined): string | null {
  const id = (language ?? "").trim().replace(/^language-/, "");
  if (!id) return null;
  return LANGUAGE_NAMES[id.toLowerCase()] ?? id;
}

/**
 * The languages the code-block dropdown offers (fence ids lowlight's common set
 * highlights), "" = plain text. Any other fence id still works when typed.
 */
export const CODE_LANGUAGES: readonly string[] = [
  "", "bash", "c", "cpp", "csharp", "css", "diff", "go", "graphql", "html", "ini", "java",
  "javascript", "json", "kotlin", "lua", "makefile", "markdown", "php", "python", "r",
  "ruby", "rust", "scss", "sql", "swift", "typescript", "xml", "yaml",
];

/** Dropdown entries matching a filter (id or name), plain text first when it matches. */
export function filterCodeLanguages(filter: string, current?: string | null): { id: string; label: string }[] {
  const q = filter.trim().toLowerCase();
  const all = CODE_LANGUAGES.map((id) => ({ id, label: id ? codeLanguageLabel(id)! : "Plain text" }));
  const cur = (current ?? "").trim();
  if (cur && !CODE_LANGUAGES.includes(cur)) all.splice(1, 0, { id: cur, label: codeLanguageLabel(cur)! });
  if (!q) return all;
  const hits = all.filter((l) => l.id.startsWith(q) || l.label.toLowerCase().startsWith(q));
  const more = all.filter((l) => !hits.includes(l) && (l.id.includes(q) || l.label.toLowerCase().includes(q)));
  const out = [...hits, ...more];
  // A fence id we don't list (e.g. "elixir") can still be used as typed.
  if (/^[a-z0-9+#._-]+$/.test(q) && !out.some((l) => l.id === q)) out.push({ id: q, label: `Use “${q}”` });
  return out;
}
