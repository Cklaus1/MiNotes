/**
 * Templates (UX Wave 4): the built-in ones and the user's own, stored by the
 * backend (`create_template` / `list_templates` / `delete_template`).
 *
 * Format (shared with core `apply_template`): one block per line; leading
 * indentation is nesting (two spaces per level when we write it); a line
 * starting with `\ ` continues the block above (a block with line breaks); a
 * ```` ``` ```` fence is one block up to its closing fence; blank lines are
 * skipped. Placeholders, filled in when the template is inserted:
 *
 *   {{date}} YYYY-MM-DD · {{time}} HH:MM · {{title}} the page's title
 *   {{yesterday}} / {{tomorrow}} YYYY-MM-DD · {{blank}} an empty block
 *   {{cursor}} where the caret goes (removed)
 */
import * as api from "./api";
import { localDateKey, localTimeKey, shiftDateKey } from "./dates";
import { BUILTIN_TEMPLATES } from "./builtinTemplates";

export { BUILTIN_TEMPLATES };

/** A block of an inserted template; `cursor`: caret offset in `content`. */
export interface TemplateBlock {
  content: string;
  children: TemplateBlock[];
  cursor?: number;
}

const indentOf = (l: string) => {
  let w = 0;
  for (const c of l) { if (c === " ") w += 1; else if (c === "\t") w += 4; else break; }
  return w;
};

/** Strip up to `n` columns of leading indentation. */
const dedent = (l: string, n: number) => {
  let i = 0, w = 0;
  while (i < l.length && w < n && (l[i] === " " || l[i] === "\t")) { w += l[i] === "\t" ? 4 : 1; i++; }
  return l.slice(i);
};

/** Parse a template's text into a block tree (placeholders untouched). */
export function parseTemplate(text: string): TemplateBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const roots: TemplateBlock[] = [];
  const stack: { indent: number; block: TemplateBlock }[] = [];
  let last: TemplateBlock | null = null;
  const add = (indent: number, content: string) => {
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const block: TemplateBlock = { content, children: [] };
    (stack.length ? stack[stack.length - 1].block.children : roots).push(block);
    stack.push({ indent, block });
    last = block;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = indentOf(line);
    const body = line.slice(line.length - line.trimStart().length);
    if ((body === "\\" || body.startsWith("\\ ")) && last) {
      (last as TemplateBlock).content += "\n" + body.slice(2);
      continue;
    }
    if (body.startsWith("```")) {
      const buf = [body.trimEnd()];
      while (++i < lines.length) {
        buf.push(dedent(lines[i], indent));
        if (lines[i].trimStart().startsWith("```")) break;
      }
      add(indent, buf.join("\n"));
      continue;
    }
    add(indent, body);
  }
  return roots;
}

/** One block of an outline, `depth` levels deep (any base depth). */
export interface OutlineBlock {
  content: string;
  depth: number;
}

/** Write an outline (outline order) as template text; `parseTemplate` reads it back. */
export function templateFromBlocks(blocks: OutlineBlock[]): string {
  if (!blocks.length) return "";
  const base = Math.min(...blocks.map((b) => b.depth));
  const out: string[] = [];
  for (const b of blocks) {
    const pad = "  ".repeat(Math.max(0, b.depth - base));
    const content = b.content.replace(/\r\n?/g, "\n");
    if (!content.trim()) { out.push(pad + "{{blank}}"); continue; }
    const [first, ...rest] = content.split("\n");
    out.push(pad + first);
    const fence = first.trimStart().startsWith("```");
    for (const l of rest) out.push(pad + (fence ? l : `\\ ${l}`));
  }
  return out.join("\n");
}

export interface TemplateContext {
  /** The page the template goes into ({{title}}). */
  title?: string;
  now?: Date;
}

/** Fill in the placeholders of one block's text ({{cursor}} stays: see fillTemplate). */
export function applyTemplateVars(text: string, ctx: TemplateContext = {}): string {
  const now = ctx.now ?? new Date();
  const today = localDateKey(now);
  return text
    .replace(/\{\{date\}\}/g, today)
    .replace(/\{\{today\}\}/g, today)
    .replace(/\{\{time\}\}/g, localTimeKey(now))
    .replace(/\{\{yesterday\}\}/g, shiftDateKey(today, -1))
    .replace(/\{\{tomorrow\}\}/g, shiftDateKey(today, 1))
    .replace(/\{\{title\}\}/g, ctx.title ?? "")
    .replace(/\{\{blank\}\}/g, "");
}

/**
 * A template ready to insert: placeholders filled (one timestamp for all), and
 * the first `{{cursor}}` turned into the block's caret offset (all removed).
 */
export function fillTemplate(text: string, ctx: TemplateContext = {}): TemplateBlock[] {
  const now = ctx.now ?? new Date();
  let cursorTaken = false;
  const fill = (b: TemplateBlock): TemplateBlock => {
    const filled = applyTemplateVars(b.content, { ...ctx, now });
    const at = filled.indexOf("{{cursor}}");
    const content = filled.replace(/\{\{cursor\}\}/g, "");
    const out: TemplateBlock = { content, children: b.children.map(fill) };
    if (at >= 0 && !cursorTaken) { cursorTaken = true; out.cursor = at; }
    return out;
  };
  return parseTemplate(text).map(fill);
}

/** How many blocks a template makes. */
export function templateBlockCount(text: string): number {
  const count = (bs: TemplateBlock[]): number => bs.reduce((n, b) => n + 1 + count(b.children), 0);
  return count(parseTemplate(text));
}

// ── The user's templates (backend), cached for the slash menu ──

let cache: api.Template[] = [];
let loadedAt = 0;
let inflight: Promise<api.Template[]> | null = null;
const listeners = new Set<() => void>();

/** The user's templates as last loaded (the slash menu reads this synchronously). */
export function userTemplates(): api.Template[] {
  return cache;
}

/** Reload the user's templates (at most every `maxAgeMs`). */
export function refreshUserTemplates(maxAgeMs = 0): Promise<api.Template[]> {
  if (Date.now() - loadedAt < maxAgeMs) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = api.listTemplates()
    .then((list) => { cache = list; loadedAt = Date.now(); listeners.forEach((l) => l()); return list; })
    .catch(() => cache)
    .finally(() => { inflight = null; });
  return inflight;
}

export function subscribeUserTemplates(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Is a template of this name already saved? (case-insensitive) */
export function templateNameTaken(name: string): api.Template | undefined {
  const n = name.trim().toLowerCase();
  return cache.find((t) => t.name.toLowerCase() === n);
}

/** Save (or replace) a user template. */
export async function saveUserTemplate(name: string, content: string, description?: string): Promise<void> {
  await refreshUserTemplates();
  const existing = templateNameTaken(name);
  if (existing) await api.deleteTemplate(existing.name);
  await api.createTemplate(name.trim(), content, description);
  await refreshUserTemplates();
}

/** Rename a user template (the backend has no rename: create the new, then delete the old). */
export async function renameUserTemplate(oldName: string, newName: string): Promise<void> {
  const t = cache.find((x) => x.name === oldName) ?? (await refreshUserTemplates()).find((x) => x.name === oldName);
  if (!t) throw new Error(`No template named “${oldName}”`);
  if (newName.trim() === oldName) return;
  if (templateNameTaken(newName) && newName.trim().toLowerCase() !== oldName.toLowerCase()) {
    throw new Error(`A template named “${newName.trim()}” already exists`);
  }
  if (newName.trim().toLowerCase() === oldName.toLowerCase()) {
    // Only the case changes: the old one has to go first (names are unique).
    await api.deleteTemplate(oldName);
    await api.createTemplate(newName.trim(), t.content, t.description ?? undefined);
  } else {
    // The copy first, so a failure never loses the template.
    await api.createTemplate(newName.trim(), t.content, t.description ?? undefined);
    await api.deleteTemplate(oldName);
  }
  await refreshUserTemplates();
}

export async function deleteUserTemplate(name: string): Promise<void> {
  await api.deleteTemplate(name);
  await refreshUserTemplates();
}
