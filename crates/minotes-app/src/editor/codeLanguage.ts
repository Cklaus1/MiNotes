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
