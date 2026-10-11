/**
 * Mock backend for testing MiNotes in a regular browser (outside Tauri).
 *
 * An in-memory model of the Rust core (crates/minotes-core) that browser-mode
 * journeys talk to. It mirrors the core's observable contract — validation,
 * error cases, the links model (backlinks, unlinked references, graph, aliases,
 * rename rewriting), trash/archive (nested folders, title parking), search
 * semantics — so a journey that passes here means the same thing in the app.
 * `.claude/skills/desktop-check/parity.sh` diffs this file against the real
 * backend; keep it at zero unexplained divergences.
 *
 * Commands that cannot work in a browser throw "... not supported in browser
 * mode"; a command name the real app doesn't have throws like Tauri does.
 */

import { localDateKey } from "./dates";
import { countPendingTodos, parseTodoLine } from "./todoExtractor";
import type {
  Page, Block, PageTree, Link, GraphStats, Property,
  FolderTreeRoot, QueryResult, GraphData, RestoreBlock, Card, BlockWithPage,
  Template, CssSnippet,
} from "./api";

// ── In-memory store ──

const now = new Date().toISOString();
const today = localDateKey();
const ts = () => new Date().toISOString();

// Real ids are UUIDs (the backend rejects anything else), so the mock's are too.
function genId(): string {
  const c: any = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const h = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  h[12] = "4"; h[16] = "89ab"[Math.floor(Math.random() * 4)];
  const x = h.join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

const UUID_RE = /^(urn:uuid:)?\{?[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}\}?$/;
const isUuid = (s: unknown) => typeof s === "string" && UUID_RE.test(s);

function fail(msg: string): never {
  throw new Error(msg);
}

interface MockFolder {
  id: string;
  name: string;
  parent_id?: string;
  icon?: string;
  color?: string;
  position: number;
  collapsed: boolean;
  created_at: string;
  updated_at: string;
}

const pages: Map<string, Page> = new Map();
const blocks: Map<string, Block> = new Map();
const properties: Map<string, Property[]> = new Map();
/** Journals shown but not written yet: date -> virtual page (same id every time). */
const pendingJournals: Map<string, Page> = new Map();
const folders: Map<string, MockFolder> = new Map();
const favorites: Map<string, number> = new Map(); // pageId -> position
/** pageId -> when trashed, and its real title if it was parked (see parkTrashedTitle). */
const trash: Map<string, { at: string; original?: string }> = new Map();
const trashedFolders: Map<string, string> = new Map(); // folderId -> deleted_at
const archived: Map<string, string> = new Map(); // pageId -> archived_at
const archivedFolders: Map<string, string> = new Map();
const cards: Map<string, Card> = new Map(); // SRS flashcards by card id
const aliases: Map<string, { pageId: string; created_at: string }> = new Map(); // alias -> page
const templates: Map<string, Template> = new Map(); // by name
const cssSnippets: Map<string, CssSnippet> = new Map(); // by name
/** Undo log (core `undo_last` basics): newest last. */
const undoLog: Array<() => void> = [];
let undoSeq = 0;

// ── Seed test data ──

function seedData() {
  // Journal page
  const journalId = genId();
  pages.set(journalId, {
    id: journalId,
    title: `Journal/${today}`,
    position: 1,
    is_journal: true,
    journal_date: today,
    created_at: now,
    updated_at: now,
  });

  const jb1 = genId();
  blocks.set(jb1, {
    id: jb1, page_id: journalId, position: 1,
    content: "Welcome to today's journal. Start typing here.",
    format: "markdown", collapsed: false, created_at: now, updated_at: now,
  });

  // Getting Started page
  const gsId = genId();
  pages.set(gsId, {
    id: gsId, title: "Getting Started", position: 2,
    is_journal: false, created_at: now, updated_at: now,
  });

  const tutorialBlocks = [
    "This is a block. Press **Enter** to create a new one below.",
    "Type **[[** to link to another page. Try [[Project Alpha]]",
    "Press **/** for slash commands — headings, lists, code blocks.",
    "Press **Ctrl+Enter** to cycle: TODO → DOING → DONE",
    "Use **Ctrl+K** to search, or type **>** for commands.",
    "Press **Ctrl+J** to jump to today's journal.",
    "Press **Ctrl+,** for Settings. You're ready to go!",
  ];

  tutorialBlocks.forEach((content, i) => {
    const bid = genId();
    blocks.set(bid, {
      id: bid, page_id: gsId, position: i + 1,
      content, format: "markdown", collapsed: false,
      created_at: now, updated_at: now,
    });
  });

  // Project Alpha page
  const paId = genId();
  pages.set(paId, {
    id: paId, title: "Project Alpha", position: 3,
    is_journal: false, created_at: now, updated_at: now,
  });

  const projectBlocks = [
    "# Project Alpha",
    "This is a sample project page with nested blocks.",
    "## Tasks",
    "TODO Review the PRD document",
    "DOING Build the frontend components",
    "DONE Set up the development environment",
    "## Notes",
    "The architecture uses Rust + TypeScript with Tauri 2.",
    "Key insight: blocks are the fundamental unit of content.",
  ];

  let parentId: string | undefined;
  projectBlocks.forEach((content, i) => {
    const bid = genId();
    // Nest "TODO/DOING/DONE" blocks under "Tasks"
    const isTask = content.startsWith("TODO") || content.startsWith("DOING") || content.startsWith("DONE");
    const isNote = i >= 7;
    blocks.set(bid, {
      id: bid, page_id: paId, position: i + 1,
      parent_id: isTask ? parentId : isNote && i > 7 ? parentId : undefined,
      content, format: "markdown", collapsed: false,
      created_at: now, updated_at: now,
    });
    if (content === "## Tasks" || content === "## Notes") parentId = bid;
  });

  // Research Notes page
  const rnId = genId();
  pages.set(rnId, {
    id: rnId, title: "Research Notes", position: 4,
    is_journal: false, created_at: now, updated_at: now,
  });

  ["Exploring local-first architectures for note-taking apps.",
   "Key reference: [[Project Alpha]] for implementation details.",
   "CRDT sync is the future of collaborative editing.",
   "- [ ] Read the Automerge paper",
   "- [x] Review Logseq's outliner model",
  ].forEach((content, i) => {
    const bid = genId();
    blocks.set(bid, {
      id: bid, page_id: rnId, position: i + 1,
      content, format: "markdown", collapsed: false,
      created_at: now, updated_at: now,
    });
  });
  // Test Results page
  const trId = genId();
  pages.set(trId, {
    id: trId, title: "Test Results — 2026-03-24", position: 5,
    is_journal: false, created_at: now, updated_at: now,
  });

  [
    "# MiNotes Test Results & UX Review",
    "Generated by automated testing with agent-browser v0.22.1",
    "## Test Suite Summary",
    "- **Smoke Test**: 6/6 passed (app loads, journal, navigation, search, settings)",
    "- **E2E Suite**: 42/42 passed (all features exist and respond)",
    "- **Slash Commands**: 11/12 passed (headings, lists, quotes, divider)",
    "- **Funnel Tests**: 31/32 passed (complete user journeys)",
    "- **Rust Unit Tests**: 55/55 passed (backend logic)",
    "- **Total: 145 passed, 2 failed**",
    "## Funnel Test Details",
    "### Create Page & Write Content — 5/5 PASS",
    "- [x] Navigate to page",
    "- [x] Blocks visible",
    "- [x] Read block content",
    "- [x] Modify block",
    "- [x] Editor shows update",
    "### Todo List — 4/5 PASS",
    "- [x] Checkbox renders as real taskList node",
    "- [x] Task text visible in accessibility tree",
    "- [x] Multiple task items render",
    "- [ ] Mixed checked/unchecked detection (test pattern issue)",
    "### Headings — 3/3 PASS",
    "- [x] H1 renders as heading element",
    "- [x] H2 renders as heading element",
    "- [x] H1 visible in accessibility tree",
    "### All Other Funnels — PASS",
    "- [x] Bullet list renders correctly",
    "- [x] Blockquote renders correctly",
    "- [x] Code block renders correctly",
    "- [x] Divider renders correctly",
    "- [x] Wiki links are clickable",
    "- [x] Search shows all pages",
    "- [x] Settings has all sections",
    "- [x] Journal date navigation works",
    "- [x] Page navigation works end-to-end",
  ].forEach((content, i) => {
    const bid = genId();
    blocks.set(bid, {
      id: bid, page_id: trId, position: i + 1,
      content, format: "markdown", collapsed: false,
      created_at: now, updated_at: now,
    });
  });

  // UX Design Review page
  const uxId = genId();
  pages.set(uxId, {
    id: uxId, title: "UX Design Review — 2026-03-24", position: 6,
    is_journal: false, created_at: now, updated_at: now,
  });

  [
    "# UX Design Review",
    "Automated screenshot analysis of MiNotes UI via agent-browser",
    "## What Works Well",
    "- [x] Clean dark theme with good contrast (Catppuccin Mocha)",
    "- [x] Sidebar layout is organized and readable",
    "- [x] Settings panel is compact with 2-column keyboard shortcuts",
    "- [x] Wiki links render as clickable blue text",
    "- [x] Bold/inline formatting renders correctly",
    "- [x] Headings are visually distinct and properly sized",
    "- [x] Page header shows title + metadata",
    "## High Priority Issues",
    "TODO Nested blocks dont show visual indentation — data-depth not rendering in mock data",
    "TODO Task states (TODO/DOING/DONE) need colored badges: yellow, blue, green+strikethrough",
    "## Medium Priority Issues",
    "TODO Hide + alias by default — takes space, rarely used",
    "TODO Hide Unlinked References when empty — reduces noise",
    "TODO H1 block redundant with page title header",
    "TODO Format journal date as human-readable (Monday, March 24, 2026)",
    "## Recommended Quick Wins",
    "- [ ] Hide empty Unlinked References (5 min)",
    "- [ ] Hide + alias by default (5 min)",
    "- [ ] Color TODO/DOING/DONE badges (15 min)",
    "- [ ] Format journal date nicely (10 min)",
    "## Bugs Found & Fixed",
    "DONE Enter inside task lists now creates new list item (was creating new block)",
    "DONE Test API methods no longer overwrite each other (mutable singleton)",
    "DONE ProseMirror input — created window.__MINOTES__ test API as workaround",
    "DOING Slash command focus — cursor doesnt land inside task list item after creation",
  ].forEach((content, i) => {
    const bid = genId();
    blocks.set(bid, {
      id: bid, page_id: uxId, position: i + 1,
      content, format: "markdown", collapsed: false,
      created_at: now, updated_at: now,
    });
  });
}

seedData();

// ── Helper functions ──

// Outline order (depth-first, siblings by position) — same contract as core's
// get_page_blocks. Positions only order siblings, so a flat sort would put a
// first child (position 1) above its parent.
function getPageBlocks(pageId: string): Block[] {
  const all = Array.from(blocks.values())
    .filter(b => b.page_id === pageId)
    .sort((a, b) => a.position - b.position);
  const ids = new Set(all.map(b => b.id));
  const kids = new Map<string, Block[]>();
  for (const b of all) {
    const key = b.parent_id && ids.has(b.parent_id) ? b.parent_id : "";
    (kids.get(key) ?? kids.set(key, []).get(key)!).push(b);
  }
  const out: Block[] = [];
  const seen = new Set<string>();
  const walk = (key: string) => {
    for (const b of kids.get(key) ?? []) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      out.push(b);
      walk(b.id);
    }
  };
  walk("");
  for (const b of all) if (!seen.has(b.id)) out.push(b); // parent cycles: keep, at the end
  return out;
}

const asciiLower = (s: string) => s.replace(/[A-Z]/g, c => c.toLowerCase());

/** core `get_page_by_title`: exact title, then exact alias. */
function pageByTitle(title: string): Page | undefined {
  for (const p of pages.values()) if (p.title === title) return p;
  const a = aliases.get(title);
  return a ? pages.get(a.pageId) : undefined;
}

/** core `get_page_tree` lookup: a UUID-shaped arg is an id, anything else a title. */
function findPage(titleOrId: string): Page | undefined {
  return isUuid(titleOrId) ? pages.get(titleOrId) : pageByTitle(titleOrId);
}

const byAge = <T extends { created_at: string; id?: string }>(a: T, b: T) =>
  a.created_at.localeCompare(b.created_at) || String(a.id ?? "").localeCompare(String(b.id ?? ""));

/** core `find_page_for_link`: exact title, exact alias, then ASCII-case-insensitive
 *  title, then alias (oldest wins). */
function resolveLink(title: string): Page | undefined {
  const exact = pageByTitle(title);
  if (exact) return exact;
  const t = asciiLower(title);
  const ci = Array.from(pages.values()).filter(p => asciiLower(p.title) === t).sort(byAge)[0];
  if (ci) return ci;
  const al = Array.from(aliases.entries())
    .filter(([a]) => asciiLower(a) === t)
    .map(([, v]) => v)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  return al ? pages.get(al.pageId) : undefined;
}

/** core `links::extract_links`, page links only: `[[Title]]` / `[[Title|alias]]`;
 *  `((...))` spans are skipped as a unit. */
function pageLinkTitles(content: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < content.length - 1) {
    if (content[i] === "[" && content[i + 1] === "[") {
      const end = content.indexOf("]]", i + 2);
      if (end >= 0) {
        const t = content.slice(i + 2, end).split("|")[0].trim();
        if (t) out.push(t);
        i = end + 2;
        continue;
      }
    }
    if (content[i] === "(" && content[i + 1] === "(") {
      const end = content.indexOf("))", i + 2);
      if (end >= 0) { i = end + 2; continue; }
    }
    i++;
  }
  return out;
}

/** Page ids a block links to, one entry per link occurrence (like link rows). */
function linkTargets(b: Block): string[] {
  const out: string[] = [];
  for (const t of pageLinkTitles(b.content)) {
    const p = resolveLink(t);
    if (p) out.push(p.id);
  }
  return out;
}

/** core `links::rewrite_page_links`: point `[[old]]`/`[[old|x]]` at `new`, skipping
 *  inline code and fenced blocks. Returns null if nothing changed. */
function rewritePageLinks(content: string, oldT: string, newT: string): string | null {
  let out = "", i = 0, copied = 0, changed = false;
  const len = content.length;
  while (i < len) {
    if (content.startsWith("```", i)) {
      const p = content.indexOf("```", i + 3);
      i = p >= 0 ? p + 3 : len;
      continue;
    }
    if (content[i] === "`") {
      const p = content.indexOf("`", i + 1);
      if (p >= 0) { i = p + 1; continue; }
    }
    if (content[i] === "[" && content[i + 1] === "[") {
      const end = content.indexOf("]]", i + 2);
      if (end >= 0) {
        const inner = content.slice(i + 2, end);
        if (asciiLower(inner.split("|")[0].trim()) === asciiLower(oldT)) {
          out += content.slice(copied, i) + "[[" + newT;
          const pipe = inner.indexOf("|");
          if (pipe >= 0) out += inner.slice(pipe);
          out += "]]";
          changed = true;
          i = end + 2;
          copied = i;
          continue;
        }
        i = end + 2;
        continue;
      }
    }
    i++;
  }
  return changed ? out + content.slice(copied) : null;
}

/** Ids of `folderId` and all its descendant folders. */
function folderSubtree(folderId: string): Set<string> {
  const out = new Set<string>([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders.values()) {
      if (f.parent_id && out.has(f.parent_id) && !out.has(f.id)) { out.add(f.id); grew = true; }
    }
  }
  return out;
}

function folderHiddenBy(fid: string | undefined | null, set: Map<string, string>): boolean {
  const seen = new Set<string>();
  while (fid && !seen.has(fid)) {
    seen.add(fid);
    if (set.has(fid)) return true;
    fid = folders.get(fid)?.parent_id;
  }
  return false;
}

/** core `hidden_pages`: trashed/archived, directly or via an ancestor folder. */
function pageHidden(pageId: string): boolean {
  if (trash.has(pageId) || archived.has(pageId)) return true;
  const fid = pages.get(pageId)?.folder_id;
  return folderHiddenBy(fid, trashedFolders) || folderHiddenBy(fid, archivedFolders);
}

/** One backlink per source block on a visible page, newest first (core get_backlinks). */
function backlinkBlocks(pageId: string): Block[] {
  return Array.from(blocks.values())
    .filter(b => !pageHidden(b.page_id) && linkTargets(b).includes(pageId))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

function withPage(b: Block): BlockWithPage {
  return { ...b, page_title: pages.get(b.page_id)?.title ?? "" };
}

/** core `contains_word`: case-insensitive whole-word containment. */
function containsWord(hay: string, needle: string): boolean {
  if (!needle) return false;
  const h = hay.toLowerCase(), n = needle.toLowerCase();
  const isWord = (c: string | undefined) => !!c && /[\p{Alphabetic}\p{N}_]/u.test(c);
  let start = 0;
  for (;;) {
    const at = h.indexOf(n, start);
    if (at < 0) return false;
    const before = Array.from(h.slice(0, at)).pop();
    const after = Array.from(h.slice(at + n.length))[0];
    if (!isWord(before) && !isWord(after)) return true;
    start = at + 1;
  }
}

// ── Journals ──

/** core `journal_date_of`: canonical `Journal/YYYY-MM-DD` only. */
function journalDateOf(title: string): string | undefined {
  const m = /^Journal\/(\d{4}-\d{2}-\d{2})$/.exec(title);
  return m && parseDate(m[1]) === m[1] ? m[1] : undefined;
}

/** chrono `%Y-%m-%d` (1-2 digit month/day accepted), normalised; throws like the
 *  Tauri command. */
function parseDate(s: string): string {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!m) fail(s === "" ? "Invalid date: premature end of input" : "Invalid date: input contains invalid characters");
  const [y, mo, d] = [Number(m![1]), Number(m![2]), Number(m![3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    fail("Invalid date: input is out of range");
  }
  return `${m![1]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The live (not trashed) journal for a date. */
function findJournal(d: string): Page | undefined {
  const p = pageByTitle(`Journal/${d}`);
  return p && !trash.has(p.id) ? p : undefined;
}

/** core `get_or_create_journal`, adopting the virtual id shown for that date. */
function getOrCreateJournal(d: string): Page {
  const existing = findJournal(d);
  if (existing) return existing;
  return createPage(`Journal/${d}`);
}

// ── Pages ──

/** core `normalize_name`: line breaks (and whitespace around them) become one
 *  space, ends trimmed; null when nothing visible is left. */
function normalizeName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const out = name.split(/[\n\r\u2028\u2029]/).map(l => l.trim()).filter(Boolean).join(" ").trim();
  return out || null;
}

/** core `normalize_title`: the stored form of a page title; blank is rejected. */
function validateTitle(title: string): string {
  return normalizeName(title) ?? fail("Invalid input: Page title cannot be empty");
}

const normalizeFolderName = (name: string): string =>
  normalizeName(name) ?? fail("Invalid input: Folder name cannot be empty");

// core properties.rs validation (set_property).
const PROPERTY_VALUE_TYPES = ["text", "string", "number", "date", "boolean", "checkbox", "url", "email", "select", "tag", "page"];

function validatePropertyKey(key: unknown): string {
  const k = typeof key === "string" ? key.trim() : "";
  if (!k) fail("Invalid input: Property key cannot be empty");
  if (Array.from(k).length > 128) fail("Invalid input: Property key is too long (max 128 characters)");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(k)) fail("Invalid input: Property key cannot contain line breaks or control characters");
  if (k.includes("::")) fail(`Invalid input: Property key '${k}' cannot contain '::'`);
  return k;
}

function checkPropertyEntity(entityId: string, entityType: string) {
  if (entityType !== "page" && entityType !== "block") fail(`Invalid input: Unknown entity type '${entityType}' (expected page or block)`);
  const [mine, other, label, otherLabel] = entityType === "page"
    ? [pages.has(entityId), blocks.has(entityId), "Page", "block"]
    : [blocks.has(entityId), pages.has(entityId), "Block", "page"];
  if (mine) return;
  if (other) fail(`Invalid input: ${entityId} is a ${otherLabel}, not a ${entityType}`);
  fail(`Not found: ${label} ${entityId}`);
}

function checkPropertyValue(key: string, value: string, valueType: string) {
  if (!PROPERTY_VALUE_TYPES.includes(valueType)) {
    fail(`Invalid input: Unknown property value type '${valueType}' (expected one of: ${PROPERTY_VALUE_TYPES.join(", ")})`);
  }
  const v = String(value ?? "").trim();
  let ok = true, hint = "";
  if (valueType === "number") ok = v !== "" && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v) && Number.isFinite(Number(v));
  else if (valueType === "date") {
    hint = " (expected YYYY-MM-DD)";
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      ok = d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
    } else ok = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v) && !isNaN(Date.parse(v));
  } else if (valueType === "boolean" || valueType === "checkbox") { hint = " (expected true or false)"; ok = v === "true" || v === "false"; }
  if (!ok) fail(`Invalid input: '${value}' is not a valid ${valueType} for '${key}'${hint}`);
}

const titleTaken = (t: string) => Array.from(pages.values()).some(p => p.title === t);

/** core `free_title_from_trash`: a trashed page holding `title` is renamed to a
 *  unique placeholder; its real title is remembered for the trash list / restore. */
function parkTrashedTitle(title: string) {
  const holder = Array.from(pages.values()).find(p => p.title === title && trash.has(p.id));
  if (!holder) return;
  const short = holder.id.replace(/[^0-9a-fA-F]/g, "").slice(-12);
  let parked = `${title} (deleted ${short})`;
  for (let n = 2; titleTaken(parked); n++) parked = `${title} (deleted ${short} ${n})`;
  const t = trash.get(holder.id)!;
  if (t.original === undefined) t.original = title;
  holder.title = parked;
}

/** core `unpark_title`: back to the real title, or "<t> (restored)" if it's taken. */
function unparkTitle(pageId: string) {
  const original = trash.get(pageId)?.original;
  const page = pages.get(pageId);
  if (original === undefined || !page) return;
  let title = original;
  for (let n = 1; titleTaken(title); n++) title = n === 1 ? `${original} (restored)` : `${original} (restored ${n})`;
  page.title = title;
  page.updated_at = ts();
}

function createPage(rawTitle: string): Page {
  const title = validateTitle(rawTitle);
  parkTrashedTitle(title);
  if (pageByTitle(title)) fail(`A page titled '${title}' already exists`);
  const jd = journalDateOf(title);
  // A journal shown as virtual keeps the id the UI already holds.
  const pending = jd ? pendingJournals.get(jd) : undefined;
  if (jd) pendingJournals.delete(jd);
  const rootMax = Math.max(0, ...Array.from(pages.values()).filter(p => !p.folder_id).map(p => p.position));
  const t = ts();
  const page: Page = {
    id: pending?.id ?? genId(), title, position: rootMax + 1,
    is_journal: !!jd, ...(jd ? { journal_date: jd } : {}),
    created_at: t, updated_at: t,
  };
  pages.set(page.id, page);
  undoLog.push(() => purgePage(page.id));
  return page;
}

function purgePage(pageId: string) {
  for (const [bid, b] of blocks) if (b.page_id === pageId) { blocks.delete(bid); properties.delete(bid); }
  for (const [cid, c] of cards) if (!blocks.has(c.block_id)) cards.delete(cid);
  for (const [a, v] of aliases) if (v.pageId === pageId) aliases.delete(a);
  properties.delete(pageId);
  favorites.delete(pageId);
  trash.delete(pageId);
  archived.delete(pageId);
  pages.delete(pageId);
}

/** Delete folders (subtree) like the FK cascade: their pages fall back to root. */
function dropFolders(ids: Set<string>) {
  for (const p of pages.values()) if (p.folder_id && ids.has(p.folder_id)) p.folder_id = undefined;
  for (const id of ids) { folders.delete(id); trashedFolders.delete(id); archivedFolders.delete(id); }
}

// ── Blocks ──

function requireBlock(id: string): Block {
  return blocks.get(id) ?? fail(`Not found: Block ${id}`);
}

/** core `check_new_parent`. */
function checkNewParent(block: Block, parentId: string) {
  if (parentId === block.id) fail("Invalid input: A block cannot be its own parent");
  const parent = blocks.get(parentId) ?? fail(`Not found: Block ${parentId}`);
  if (parent.page_id !== block.page_id) fail("Invalid input: Cannot move a block under a parent on a different page");
  const seen = new Set<string>();
  for (let cur: Block | undefined = parent; cur && !seen.has(cur.id); cur = cur.parent_id ? blocks.get(cur.parent_id) : undefined) {
    seen.add(cur.id);
    if (cur.id === block.id) fail("Invalid input: Cannot move a block under one of its own descendants");
  }
}

/** core `set_block_parent` (move / reorder / reparent). */
function setBlockParent(id: string, parentId: string | undefined | null, position: number | undefined) {
  const block = requireBlock(id);
  if (parentId) checkNewParent(block, parentId);
  block.parent_id = parentId ?? undefined;
  if (position !== undefined) block.position = position;
  block.updated_at = ts();
  return block;
}

function createBlock(pageId: string, content: string, parentId?: string | null): Block {
  if (!pages.has(pageId)) {
    // First write to a virtual journal materialises it under the same id.
    const pending = Array.from(pendingJournals.values()).find(p => p.id === pageId);
    if (!pending) fail(`Not found: Page ${pageId}`);
    pageId = getOrCreateJournal(pending!.journal_date!).id;
  }
  if (parentId) {
    const parent = blocks.get(parentId) ?? fail(`Not found: Parent block ${parentId}`);
    if (parent.page_id !== pageId) fail(`Invalid input: Parent block ${parentId} is on a different page`);
  }
  const siblings = Array.from(blocks.values()).filter(b => b.page_id === pageId && (b.parent_id ?? null) === (parentId ?? null));
  const maxPos = siblings.length > 0 ? Math.max(...siblings.map(b => b.position)) : 0;
  const t = ts();
  const block: Block = {
    id: genId(), page_id: pageId, ...(parentId ? { parent_id: parentId } : {}),
    position: maxPos + 1, content,
    format: "markdown", collapsed: false, created_at: t, updated_at: t,
  };
  blocks.set(block.id, block);
  undoLog.push(() => deleteSubtree(block.id));
  return block;
}

/** Remove a block, its subtree and their properties/cards. Returns the removed blocks. */
function deleteSubtree(id: string): Block[] {
  if (!blocks.has(id)) return [];
  const doomed = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of blocks.values()) {
      if (b.parent_id && doomed.has(b.parent_id) && !doomed.has(b.id)) { doomed.add(b.id); grew = true; }
    }
  }
  const removed: Block[] = [];
  for (const bid of doomed) { removed.push(blocks.get(bid)!); blocks.delete(bid); properties.delete(bid); }
  // cards.block_id is ON DELETE CASCADE in the real schema.
  for (const [cid, c] of cards) if (doomed.has(c.block_id)) cards.delete(cid);
  return removed;
}

// ── Search (mirrors core search.rs) ──

/** Index tokens like FTS5 unicode61 with remove_diacritics: letter/digit runs,
 *  lower-cased, accents folded. */
function tokens(s: string): string[] {
  return (s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

type Term = { kind: "prefix" | "phrase"; words: string[] };

/** core `parse_query`: "quoted" = exact phrase, other words = prefixes, AND. */
function parseQuery(q: string): Term[] {
  const terms: Term[] = [];
  const words = (text: string) => {
    for (const w of text.split(/\s+/)) {
      const t = tokens(w);
      if (t.length) terms.push({ kind: "prefix", words: t });
    }
  };
  let rest = q;
  for (;;) {
    const open = rest.indexOf('"');
    if (open < 0) break;
    const close = rest.indexOf('"', open + 1);
    words(rest.slice(0, open));
    if (close < 0) { rest = rest.slice(open + 1); break; }
    const t = tokens(rest.slice(open + 1, close));
    if (t.length) terms.push({ kind: "phrase", words: t });
    rest = rest.slice(close + 1);
  }
  words(rest);
  return terms;
}

const CJK_RE = /[ᄀ-ᇿ⺀-⿟぀-ヿ㄀-㆏ㆠ-ㇿ㐀-䶿一-鿿ꥠ-꥿가-퟿豈-﫿ｦ-ﾟ]|[\uD840-\uD8BF][\uDC00-\uDFFF]/;

function termMatches(content: string[], term: Term): boolean {
  const n = term.words.length;
  for (let i = 0; i + n <= content.length; i++) {
    let ok = true;
    for (let j = 0; j < n && ok; j++) {
      const last = j === n - 1;
      ok = last && term.kind === "prefix" ? content[i + j].startsWith(term.words[j]) : content[i + j] === term.words[j];
    }
    if (ok) return true;
  }
  return false;
}

function searchBlocks(query: string, limit: number): Block[] {
  const terms = parseQuery(query);
  if (terms.length === 0) return [];
  const visible = Array.from(blocks.values()).filter(b => pages.has(b.page_id) && !pageHidden(b.page_id));
  if (CJK_RE.test(query)) {
    // Substring match of every whitespace-separated piece (SQL LIKE: ASCII case-insensitive).
    const needles = query.replace(/"/g, " ").split(/\s+/).filter(Boolean).map(asciiLower);
    return visible
      .filter(b => needles.every(n => asciiLower(b.content).includes(n)))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, limit);
  }
  return visible.filter(b => {
    const t = tokens(b.content);
    return terms.every(term => termMatches(t, term));
  }).slice(0, limit);
}

// ── Templates ──

/** core `apply_template`: one block per line, indentation = nesting, fenced code
 *  kept as one block, blank lines skipped. All-or-nothing. */
function applyTemplate(pageId: string, name: string): Block[] {
  if (!pages.has(pageId)) fail(`Not found: Page ${pageId}`);
  const tpl = templates.get(name) ?? fail(`Not found: Template '${name}'`);
  const indentOf = (l: string) => { let w = 0; for (const c of l) { if (c === " ") w += 1; else if (c === "\t") w += 4; else break; } return w; };
  const lines = tpl.content.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const made: Block[] = [];
  const stack: Array<[number, string]> = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (line.trim() !== "") {
      const ind = indentOf(line);
      while (stack.length && stack[stack.length - 1][0] >= ind) stack.pop();
    }
    const parent = stack.length ? stack[stack.length - 1][1] : undefined;
    if (trimmed.startsWith("```")) {
      let buf = trimmed;
      i++;
      while (i < lines.length) {
        buf += "\n" + lines[i];
        const closes = lines[i].trimStart().startsWith("```");
        i++;
        if (closes) break;
      }
      const b = createBlock(pageId, buf, parent);
      stack.push([indentOf(line), b.id]);
      made.push(b);
      continue;
    }
    if (line.trim() === "") { i++; continue; }
    const b = createBlock(pageId, trimmed.trimEnd(), parent);
    stack.push([indentOf(line), b.id]);
    made.push(b);
    i++;
  }
  return made;
}

const notInBrowser = (cmd: string) => () => fail(`${cmd} is not supported in browser mode`);

// ── Mock API handlers ──

const handlers: Record<string, (args: any) => any> = {
  list_pages: ({ limit }: { limit?: number }) => {
    return Array.from(pages.values())
      .filter(p => !trash.has(p.id) && !archived.has(p.id))
      .sort((a, b) => a.position - b.position || b.updated_at.localeCompare(a.updated_at))
      .slice(0, limit ?? 100);
  },

  get_page_tree: ({ titleOrId }: { titleOrId: string }) => {
    const page = findPage(titleOrId);
    if (page) return { page, blocks: getPageBlocks(page.id) };
    // A journal shown but not written yet is still openable by its id.
    const pending = Array.from(pendingJournals.values()).find(p => p.id === titleOrId);
    if (pending) {
      const real = findJournal(pending.journal_date!);
      return real ? { page: real, blocks: getPageBlocks(real.id) } : { page: pending, blocks: [] };
    }
    fail(`Page not found: ${titleOrId}`);
  },

  create_page: ({ title }: { title: string }) => createPage(title),

  // Soft delete, like the app: the page goes to the trash.
  delete_page: ({ id }: { id: string }) => {
    handlers.trash_page({ id });
    return true;
  },

  rename_page: ({ id, newTitle: rawTitle }: { id: string; newTitle: string }) => {
    const newTitle = validateTitle(rawTitle);
    const holder = pageByTitle(newTitle);
    if (holder && holder.id !== id) parkTrashedTitle(newTitle);
    const conflict = pageByTitle(newTitle);
    if (conflict && conflict.id !== id) fail(`A page titled '${newTitle}' already exists`);
    const page = pages.get(id) ?? fail(`Not found: Page ${id}`);
    const old = page.title;
    // Blocks that link here (resolved BEFORE the title changes), rewritten after.
    const referencing = Array.from(blocks.values()).filter(b => linkTargets(b).includes(id));
    page.title = newTitle;
    page.updated_at = ts();
    if (old !== newTitle) {
      for (const b of referencing) {
        const next = rewritePageLinks(b.content, old, newTitle);
        if (next !== null) { b.content = next; b.updated_at = ts(); }
      }
    }
    return page;
  },

  create_block: ({ pageId, content, parentId }: { pageId: string; content: string; parentId?: string }) =>
    createBlock(pageId, content, parentId),

  update_block: ({ id, content }: { id: string; content: string }) => {
    const block = requireBlock(id);
    const prev = block.content;
    block.content = content;
    block.updated_at = ts();
    undoLog.push(() => { const b = blocks.get(id); if (b) b.content = prev; });
    return block;
  },

  // Mirrors core `delete_block`: removes the block, its whole subtree and the
  // subtree's properties.
  delete_block: ({ id }: { id: string }) => {
    if (!blocks.has(id)) return false;
    const removed = deleteSubtree(id);
    undoLog.push(() => { for (const b of removed) if (pages.has(b.page_id) && !blocks.has(b.id)) blocks.set(b.id, b); });
    return true;
  },

  // Mirrors core `restore_blocks`: all-or-nothing recreation of deleted blocks
  // with their original ids/parents/positions/content, then their properties.
  // Any order: parents inside the batch are placed first.
  restore_blocks: ({ blocks: input }: { blocks: RestoreBlock[] }) => {
    const batch = new Map<string, RestoreBlock>();
    for (const rb of input) {
      if (batch.has(rb.id)) fail(`Invalid input: Block ${rb.id} appears twice`);
      batch.set(rb.id, rb);
    }
    for (const rb of input) {
      if (!Number.isFinite(rb.position)) fail(`Invalid input: Block ${rb.id}: position must be finite`);
      if (blocks.has(rb.id)) fail(`Invalid input: Block ${rb.id} already exists`);
      if (!pages.has(rb.page_id)) fail(`Invalid input: Page ${rb.page_id} does not exist`);
      if (rb.parent_id) {
        const parentPage = batch.get(rb.parent_id)?.page_id ?? blocks.get(rb.parent_id)?.page_id;
        if (!parentPage) fail(`Invalid input: Parent block ${rb.parent_id} of ${rb.id} does not exist`);
        if (parentPage !== rb.page_id) fail(`Invalid input: Parent block ${rb.parent_id} of ${rb.id} is on a different page`);
      }
    }
    const placed = new Set<string>();
    let remaining = [...input];
    while (remaining.length) {
      const before = remaining.length;
      remaining = remaining.filter(rb => {
        const ready = !rb.parent_id || !batch.has(rb.parent_id) || placed.has(rb.parent_id);
        if (ready) placed.add(rb.id);
        return !ready;
      });
      if (remaining.length === before) fail("Invalid input: Blocks to restore form a parent cycle");
    }
    const t = ts();
    return input.map(rb => {
      const block: Block = {
        id: rb.id, page_id: rb.page_id, ...(rb.parent_id ? { parent_id: rb.parent_id } : {}),
        position: rb.position, content: rb.content,
        format: "markdown", collapsed: false, created_at: t, updated_at: t,
      };
      blocks.set(rb.id, block);
      properties.set(rb.id, (rb.properties ?? []).map(([key, value]) => ({
        id: genId(), entity_id: rb.id, entity_type: "block",
        key, value, value_type: "text", created_at: t, updated_at: t,
      })).sort((a, b) => a.key.localeCompare(b.key)));
      return block;
    });
  },

  move_block: ({ id, newParent, position }: { id: string; newParent: string; position: number }) =>
    setBlockParent(id, newParent, position),

  reparent_block: ({ id, parentId }: { id: string; parentId?: string }) =>
    setBlockParent(id, parentId, undefined),

  reorder_block: ({ id, parentId, position }: { id: string; parentId?: string; position: number }) =>
    setBlockParent(id, parentId, position),

  search_blocks: ({ query, limit }: { query: string; limit?: number }) => searchBlocks(query, limit ?? 20),

  get_backlinks: ({ pageId }: { pageId: string }) =>
    backlinkBlocks(pageId).map(b => ({
      id: b.id, from_block: b.id, to_page: pageId, link_type: "reference",
      created_at: b.updated_at, block: withPage(b),
    }) as Link),

  get_unlinked_references: ({ pageId }: { pageId: string }) => {
    const page = pages.get(pageId) ?? fail(`Not found: Page ${pageId}`);
    const title = page.title;
    const linked = new Set(backlinkBlocks(pageId).map(b => b.id));
    return Array.from(blocks.values())
      .filter(b => b.page_id !== pageId && !pageHidden(b.page_id) && asciiLower(b.content).includes(asciiLower(title)))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 50)
      .filter(b => !linked.has(b.id) && !b.content.includes(`[[${title}]]`) && containsWord(b.content, title));
  },

  get_graph_stats: () => {
    let links = 0;
    const linked = new Set<string>();
    for (const b of blocks.values()) {
      const t = linkTargets(b);
      links += t.length;
      t.forEach(x => linked.add(x));
    }
    const all = Array.from(pages.values());
    return {
      pages: all.length,
      blocks: blocks.size,
      links,
      properties: Array.from(properties.values()).reduce((n, l) => n + l.length, 0),
      events: undoLog.length,
      orphan_pages: all.filter(p => !linked.has(p.id) && !Array.from(blocks.values()).some(b => b.page_id === p.id)).length,
      journal_pages: all.filter(p => p.is_journal).length,
    } as GraphStats;
  },

  // Trashed/archived pages are not part of the visible graph.
  get_graph_data: () => {
    const visible = Array.from(pages.values()).filter(p => !pageHidden(p.id));
    const incoming = new Map<string, number>();
    const edges = new Map<string, number>();
    for (const b of blocks.values()) {
      if (!pages.has(b.page_id) || pageHidden(b.page_id)) continue;
      for (const to of linkTargets(b)) {
        incoming.set(to, (incoming.get(to) ?? 0) + 1);
        if (!pageHidden(to)) edges.set(`${b.page_id}\n${to}`, (edges.get(`${b.page_id}\n${to}`) ?? 0) + 1);
      }
    }
    return {
      nodes: visible
        .sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0))
        .map(p => ({
          id: p.id, title: p.title,
          block_count: Array.from(blocks.values()).filter(b => b.page_id === p.id).length,
          link_count: incoming.get(p.id) ?? 0,
        })),
      edges: Array.from(edges.entries()).sort().map(([k, weight]) => {
        const [source, target] = k.split("\n");
        return { source, target, weight };
      }),
    } as GraphData;
  },

  run_query: notInBrowser("run_query (SQL)") as (a: any) => QueryResult,

  // Today's journal is created on read; other dates return a virtual page (same
  // id for the same date) that the first create_block / create_page materialises.
  get_journal: ({ date }: { date?: string }) => {
    const d = date == null ? today : parseDate(date);
    const existing = findJournal(d);
    if (existing) return { page: existing, blocks: getPageBlocks(existing.id) } as PageTree;
    if (d === today) {
      const p = getOrCreateJournal(d);
      return { page: p, blocks: getPageBlocks(p.id) } as PageTree;
    }
    let v = pendingJournals.get(d);
    if (!v) {
      const t = ts();
      v = { id: genId(), title: `Journal/${d}`, position: 0, is_journal: true, journal_date: d, created_at: t, updated_at: t };
      pendingJournals.set(d, v);
    }
    return { page: v, blocks: [] } as PageTree;
  },

  get_folder_tree: () => {
    const visiblePage = (p: Page) => !trash.has(p.id) && !archived.has(p.id);
    const rootPages = Array.from(pages.values())
      .filter(p => !p.folder_id && visiblePage(p))
      .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
    const buildTree = (parentId?: string): any[] => {
      return Array.from(folders.values())
        .filter(f => (f.parent_id ?? undefined) === parentId && !trashedFolders.has(f.id) && !archivedFolders.has(f.id))
        .sort((a, b) => a.position - b.position)
        .map(f => ({
          ...f,
          children: buildTree(f.id),
          pages: Array.from(pages.values())
            .filter(p => p.folder_id === f.id && visiblePage(p))
            .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title)),
        }));
    };
    return { folders: buildTree(undefined), root_pages: rootPages } as FolderTreeRoot;
  },

  create_folder: ({ name: rawName, parentId }: { name: string; parentId?: string }) => {
    const name = normalizeFolderName(rawName);
    if (parentId && !folders.has(parentId)) fail("Database error: FOREIGN KEY constraint failed");
    const siblings = Array.from(folders.values()).filter(f => (f.parent_id ?? null) === (parentId ?? null));
    const t = ts();
    const folder: MockFolder = {
      id: genId(), name, ...(parentId ? { parent_id: parentId } : {}),
      position: Math.max(0, ...siblings.map(f => f.position)) + 1, collapsed: false, created_at: t, updated_at: t,
    };
    folders.set(folder.id, folder);
    return folder;
  },

  move_page_to_folder: ({ pageId, folderId }: { pageId: string; folderId?: string }) => {
    const page = pages.get(pageId) ?? fail(`Not found: Page ${pageId}`);
    if (folderId && !folders.has(folderId)) fail("Database error: FOREIGN KEY constraint failed");
    page.folder_id = folderId ?? undefined;
    page.updated_at = ts();
    return page;
  },

  reorder_page: ({ id, newPosition }: { id: string; newPosition: number }) => {
    const page = pages.get(id) ?? fail(`Not found: Page ${id}`);
    page.position = newPosition;
    page.updated_at = ts();
    return page;
  },

  // core delete_folder: pages in it (and, via the FK cascade, in its subfolders)
  // move to the root; the folder and its subfolders are deleted.
  delete_folder: ({ id }: { id: string }) => {
    if (!folders.has(id)) return false;
    dropFolders(folderSubtree(id));
    return true;
  },
  rename_folder: ({ id, newName }: { id: string; newName: string }) => {
    const name = normalizeFolderName(newName);
    const f = folders.get(id) ?? fail(`Not found: Folder ${id}`);
    f.name = name;
    f.updated_at = ts();
    return f;
  },
  update_folder_appearance: ({ id, icon, color }: { id: string; icon?: string | null; color?: string | null }) => {
    const f = folders.get(id) ?? fail(`Not found: Folder ${id}`);
    if (icon != null) f.icon = icon;
    if (color != null) f.color = color;
    f.updated_at = ts();
    return { ...f };
  },

  set_property: ({ entityId, entityType, key: rawKey, value, valueType: rawType }: any) => {
    const key = validatePropertyKey(rawKey);
    checkPropertyEntity(entityId, entityType);
    const valueType = rawType ?? "text";
    checkPropertyValue(key, value, valueType);
    const t = ts();
    const existing = properties.get(entityId) ?? [];
    const idx = existing.findIndex(p => p.key === key);
    const prop: Property = {
      id: idx >= 0 ? existing[idx].id : genId(), entity_id: entityId, entity_type: entityType,
      key, value, value_type: valueType ?? "text",
      created_at: idx >= 0 ? existing[idx].created_at : t, updated_at: t,
    };
    if (idx >= 0) existing[idx] = prop; else existing.push(prop);
    existing.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    properties.set(entityId, existing);
    return prop;
  },

  get_properties: ({ entityId }: { entityId: string }) => properties.get(entityId) ?? [],

  // core: walk up the parent chain; a child's key overrides its ancestors'.
  get_inherited_properties: ({ blockId }: { blockId: string }) => {
    const all = new Map<string, Property>();
    let cur: string | undefined = blockId;
    for (let depth = 0; cur && depth <= 20; depth++) {
      for (const p of properties.get(cur) ?? []) if (!all.has(p.key)) all.set(p.key, p);
      cur = blocks.get(cur)?.parent_id;
    }
    return Array.from(all.values()).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  },

  delete_property: ({ entityId, key }: { entityId: string; key: string }) => {
    const existing = properties.get(entityId) ?? [];
    const left = existing.filter(p => p.key !== key);
    properties.set(entityId, left);
    return left.length !== existing.length;
  },

  // Favourites survive trash/archive (hidden while the page is), like core.
  add_favorite: ({ pageId }: { pageId: string }) => {
    if (!pages.has(pageId)) fail("Database error: FOREIGN KEY constraint failed");
    if (!favorites.has(pageId)) {
      const maxPos = favorites.size > 0 ? Math.max(...favorites.values()) : 0;
      favorites.set(pageId, maxPos + 1);
    }
  },
  remove_favorite: ({ pageId }: { pageId: string }) => favorites.delete(pageId),
  list_favorites: () => {
    return Array.from(favorites.entries())
      .sort((a, b) => a[1] - b[1])
      .map(([id, pos]) => {
        const page = pages.get(id);
        if (!page || pageHidden(id)) return null;
        return { ...page, position: pos }; // Use favorites position, not page position
      })
      .filter(Boolean) as Page[];
  },
  reorder_favorite: ({ pageId, newPosition }: { pageId: string; newPosition: number }) => {
    if (favorites.has(pageId)) favorites.set(pageId, newPosition);
  },

  add_alias: ({ pageId, alias }: { pageId: string; alias: string }) => {
    if (!pages.has(pageId)) fail(`Not found: Page ${pageId}`);
    if (aliases.has(alias)) fail(`The alias '${alias}' is already in use`);
    aliases.set(alias, { pageId, created_at: ts() });
  },
  remove_alias: ({ alias }: { alias: string }) => aliases.delete(alias),
  get_aliases: ({ pageId }: { pageId: string }) =>
    Array.from(aliases.entries()).filter(([, v]) => v.pageId === pageId).map(([a]) => a).sort(),

  create_template: ({ name, description, content }: { name: string; description?: string; content: string }) => {
    if (templates.has(name)) fail(`A template named '${name}' already exists`);
    const t = ts();
    const tpl: Template = { id: genId(), name, ...(description != null ? { description } : {}), content, created_at: t, updated_at: t };
    templates.set(name, tpl);
    return tpl;
  },
  list_templates: () => Array.from(templates.values()).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  apply_template: ({ pageId, templateName }: { pageId: string; templateName: string }) => {
    // All-or-nothing, like the core transaction.
    const before = new Set(blocks.keys());
    const undoLen = undoLog.length;
    try {
      return applyTemplate(pageId, templateName);
    } catch (e) {
      for (const id of Array.from(blocks.keys())) if (!before.has(id)) blocks.delete(id);
      undoLog.length = undoLen;
      throw e;
    }
  },
  delete_template: ({ name }: { name: string }) => templates.delete(name),

  export_opml: notInBrowser("export_opml"),
  export_json: () => ({
    version: "1.0",
    exported_at: ts(),
    pages: (handlers.list_pages({ limit: 10000 }) as Page[]).map(page => ({
      page, blocks: getPageBlocks(page.id), properties: properties.get(page.id) ?? [],
    })),
    whiteboards: [],
  }),
  publish_site: notInBrowser("publish_site"),
  list_plugins: () => [],
  register_plugin: notInBrowser("register_plugin"),
  enable_plugin: notInBrowser("enable_plugin"),
  disable_plugin: notInBrowser("disable_plugin"),
  uninstall_plugin: notInBrowser("uninstall_plugin"),
  // SRS cards — mirrors core cards.rs: one card per block (create is idempotent),
  // a new card is due immediately, a review pushes `due` forward ("again" keeps
  // it due soon), cards vanish with their block.
  create_card: ({ blockId, cardType }: { blockId: string; cardType: string }) => {
    if (!blocks.has(blockId)) fail(`Not found: Block ${blockId}`);
    for (const c of cards.values()) if (c.block_id === blockId) return c;
    const t = ts();
    const card: Card = { id: genId(), block_id: blockId, card_type: cardType || "basic", due: t, stability: 0, difficulty: 0, reps: 0, lapses: 0, state: "new", created_at: t, updated_at: t };
    cards.set(card.id, card);
    return card;
  },
  list_cards: () => [...cards.values()].filter(c => blocks.has(c.block_id)),
  get_due_cards: ({ limit }: { limit?: number }) => {
    const t = ts();
    return [...cards.values()]
      .filter(c => blocks.has(c.block_id) && c.due <= t)
      .sort((a, b) => a.due.localeCompare(b.due))
      .slice(0, limit ?? 50);
  },
  review_card: ({ cardId, rating }: { cardId: string; rating: string }) => {
    const card = cards.get(cardId) ?? fail(`Not found: Card ${cardId}`);
    const days: Record<string, number> = { again: 0, hard: 1, good: 3, easy: 7 };
    if (!(rating in days)) fail(`Invalid rating: ${rating}`);
    const t = new Date();
    const due = rating === "again" ? new Date(t.getTime() + 60_000) : new Date(t.getTime() + days[rating] * 86_400_000);
    const next: Card = {
      ...card, due: due.toISOString(), reps: card.reps + 1,
      lapses: card.lapses + (rating === "again" ? 1 : 0),
      state: rating === "again" ? "learning" : "review",
      last_review: t.toISOString(), updated_at: t.toISOString(),
    };
    cards.set(cardId, next);
    return next;
  },
  get_srs_stats: () => {
    const t = ts();
    const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
    const live = [...cards.values()].filter(c => blocks.has(c.block_id));
    return {
      due_count: live.filter(c => c.due <= t).length,
      reviewed_today: live.filter(c => c.last_review && c.last_review >= dayStart.toISOString()).length,
      total_cards: live.length,
    };
  },
  delete_card: ({ cardId }: { cardId: string }) => cards.delete(cardId),
  // ── Notebooks (mirrors minotes-core notebook.rs + the app's switch) ──
  list_graphs: () => mockNotebooks.filter(n => n.kind === "legacy").map(n => ({
    name: n.key, path: n.db_path, size_bytes: 4096, modified_at: n.modified_at,
  })),
  switch_graph: ({ name }: { name: string }) => {
    validateGraphKey(name);
    const nb = mockNotebooks.find(n => n.key === name);
    if (!nb) fail(`Graph '${name}' does not exist`);
    if (!nb.available) fail(`Notebook \u201c${nb.name}\u201d is unavailable: its folder was not found`);
    if (name !== currentNotebook) {
      notebookStores.set(currentNotebook, snapshotStore());
      restoreStore(notebookStores.get(name) ?? emptyStore());
      notebookStores.delete(name);
      currentNotebook = name;
    }
    nb.last_opened = ts();
    return true;
  },
  create_graph_cmd: ({ name }: { name: string }) => {
    if (!name || /[/\\.\0]/.test(name)) fail(`Invalid input: Invalid graph name: '${name}'. Must be non-empty and contain no path separators or dots.`);
    if (mockNotebooks.some(n => n.key === name)) fail(`A graph named '${name}' already exists`);
    const nb = legacyNotebook(name);
    mockNotebooks.push(nb);
    return { name, path: nb.db_path, size_bytes: 4096, modified_at: nb.modified_at };
  },
  delete_graph_cmd: ({ name }: { name: string }) => {
    validateGraphKey(name);
    if (name === currentNotebook) fail("Cannot delete the currently active graph. Switch to another graph first.");
    const i = mockNotebooks.findIndex(n => n.key === name && n.kind === "legacy");
    if (i < 0) return false;
    mockNotebooks.splice(i, 1);
    notebookStores.delete(name);
    return true;
  },
  get_current_graph: () => currentNotebook,
  list_notebooks: () => [...mockNotebooks].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.key.localeCompare(b.key)),
  get_notebook_session: () => {
    const nb = mockNotebooks.find(n => n.key === currentNotebook)!;
    return {
      key: nb.key, name: nb.name, kind: nb.kind, path: nb.path, db_path: nb.db_path, mirror_dir: nb.mirror_dir,
      read_only: false, held_by: null, notice: null, cloud: nb.cloud, conflicted_copies: [],
    };
  },
  dismiss_notebook_notice: () => {},
  default_notebook_location: ({ name }: { name: string }) => `${MOCK_HOME}/MiNotes/${(name ?? "").trim()}`,
  create_notebook: ({ name, location }: { name: string; location?: string | null }) => {
    const n = (name ?? "").trim();
    validateNotebookName(n);
    if (mockNotebooks.some(x => x.name === n)) fail(`A notebook named '${n}' already exists`);
    const path = (location && location.trim()) || `${MOCK_HOME}/MiNotes/${n}`;
    if (!path.startsWith("/")) fail("The notebook folder must be an absolute path");
    if (mockNotebooks.some(x => x.path === path) || mockFolders.has(path)) fail(`${path} already exists and is not empty — choose a new folder`);
    const nb = folderNotebook(genId(), n, path);
    mockNotebooks.push(nb);
    return nb;
  },
  open_notebook_folder: ({ path }: { path: string }) => {
    const known = mockNotebooks.find(n => n.path === path);
    if (known) return known;
    const stored = mockFolders.get(path);
    if (!stored) fail(`${path} is not a MiNotes notebook (no notebook.minotes inside)`);
    mockFolders.delete(path);
    mockNotebooks.push(stored);
    return stored;
  },
  locate_notebook: ({ key, path }: { key: string; path: string }) => {
    const nb = mockNotebooks.find(n => n.key === key);
    if (!nb) fail(`Not found: Unknown notebook ${key}`);
    Object.assign(nb, folderNotebook(nb.key, nb.name, path), { available: true });
    return nb;
  },
  rename_notebook: ({ key, name }: { key: string; name: string }) => {
    const n = (name ?? "").trim();
    validateNotebookName(n);
    const nb = mockNotebooks.find(x => x.key === key);
    if (!nb) fail(`Not found: Unknown notebook ${key}`);
    if (mockNotebooks.some(x => x.name === n && x.key !== key)) fail(`A notebook named '${n}' already exists`);
    nb.name = n;
    return nb;
  },
  delete_notebook: ({ key }: { key: string }) => {
    if (key === currentNotebook) fail("Invalid input: Cannot delete the open notebook. Switch to another notebook first.");
    const i = mockNotebooks.findIndex(n => n.key === key);
    if (i < 0) fail(`Not found: Unknown notebook ${key}`);
    mockNotebooks.splice(i, 1);
    notebookStores.delete(key);
  },
  forget_notebook: ({ key }: { key: string }) => {
    if (key === currentNotebook) fail("Cannot remove the open notebook from the list");
    const i = mockNotebooks.findIndex(n => n.key === key && n.kind === "folder");
    if (i >= 0) {
      const [nb] = mockNotebooks.splice(i, 1);
      mockFolders.set(nb.path, nb); // still on "disk": Open notebook… finds it again
    }
  },
  take_over_notebook: () => handlers.get_notebook_session({}),
  move_notebook_to_folder: ({ path }: { path: string }) => {
    const nb = mockNotebooks.find(n => n.key === currentNotebook)!;
    if (nb.kind === "folder") fail("Invalid input: This notebook is already in a folder of its own");
    if (mockNotebooks.some(x => x.path === path)) fail(`${path} already exists and is not empty — choose a new folder`);
    Object.assign(nb, folderNotebook(genId(), nb.name, path));
    currentNotebook = nb.key;
    return handlers.get_notebook_session({});
  },
  mirror_status: () => mockMirrorStatus(),
  mirror_rebuild: () => { mirrorWrittenAt = ts(); return mockMirrorStatus(); },
  mirror_open_folder: notInBrowser("mirror_open_folder"),
  save_export_file: notInBrowser("save_export_file"),
  git_sync_resolve_deletions: () => 0,
  outside_edit_set_blocks: () => null,
  // core clip_content: a page, url/tag properties, one block per paragraph.
  clip_content: ({ title, content, url, tags }: { title: string; content: string; url?: string; tags?: string[] }) => {
    const page = createPage(title);
    if (url != null) handlers.set_property({ entityId: page.id, entityType: "page", key: "url", value: url, valueType: "url" });
    for (const tag of tags ?? []) handlers.set_property({ entityId: page.id, entityType: "page", key: `tag:${tag}`, value: tag, valueType: "tag" });
    const paras = content.split("\n\n").map(s => s.trim()).filter(Boolean);
    for (const p of paras) createBlock(page.id, p);
    if (paras.length === 0 && content.trim()) createBlock(page.id, content.trim());
    return page;
  },
  create_highlight: notInBrowser("create_highlight"),
  get_highlights: () => [],
  update_highlight_note: notInBrowser("update_highlight_note"),
  delete_highlight: () => false,
  search_highlights: () => [],
  // core undo_last basics: block create/update/delete and page create.
  undo: () => {
    const op = undoLog.pop();
    if (!op) return null;
    op();
    return ++undoSeq;
  },
  get_sync_status: () => ({ total_pages: 0, synced_pages: 0, pending_changes: 0 }),
  sync_page: notInBrowser("sync_page"),
  get_version_history: () => [],
  restore_version: notInBrowser("restore_version"),
  plugin_storage_get: () => null,
  plugin_storage_set: () => {},
  add_css_snippet: ({ name, css, source }: { name: string; css: string; source: string }) => {
    if (cssSnippets.has(name)) fail("Database error: UNIQUE constraint failed: css_snippets.name");
    const s: CssSnippet = { id: genId(), name, css, enabled: true, source, created_at: ts() };
    cssSnippets.set(name, s);
    return s;
  },
  list_css_snippets: () => Array.from(cssSnippets.values()).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  toggle_css_snippet: ({ name }: { name: string }) => {
    const s = cssSnippets.get(name) ?? fail(`Not found: CSS snippet '${name}'`);
    s.enabled = !s.enabled;
    return s;
  },
  delete_css_snippet: ({ name }: { name: string }) => cssSnippets.delete(name),
  get_enabled_css_snippets: () => handlers.list_css_snippets({}).filter((s: CssSnippet) => s.enabled),
  update_css_snippet: ({ name, css }: { name: string; css: string }) => {
    const s = cssSnippets.get(name) ?? fail(`Not found: CSS snippet '${name}'`);
    s.css = css;
    return s;
  },
  save_png_to_downloads: ({ filename }: { filename: string }) => `Downloads/${filename}`,
  paste_image_wsl: notInBrowser("paste_image_wsl"),
  read_pdf_file: notInBrowser("read_pdf_file"),
  read_file_base64: notInBrowser("read_file_base64"),

  // Feature 8: Link Preview — mock OG metadata
  fetch_og_metadata: ({ url }: { url: string }) => ({
    title: new URL(url).hostname + " — Page Title",
    description: "A brief description of the linked page content.",
    image: "",
  }),

  // A block with its page title (block refs navigate with it), or null.
  get_block: ({ id }: { id: string }) => {
    const b = blocks.get(id);
    return b ? withPage(b) : null;
  },
  // Several blocks in one call, input order, unknown ids skipped.
  get_blocks: ({ ids }: { ids: string[] }) => {
    for (const id of ids) if (!isUuid(id)) fail(uuidError(id));
    const seen = new Set<string>();
    return ids.filter(id => blocks.has(id) && !seen.has(id) && seen.add(id)).map(id => withPage(blocks.get(id)!));
  },

  // Properties of many entities in one call; only entities with properties appear.
  get_properties_batch: ({ entityIds }: { entityIds: string[] }) => {
    const out: Record<string, unknown[]> = {};
    for (const id of entityIds) {
      const p = properties.get(id);
      if (p && p.length) out[id] = p;
    }
    return out;
  },

  // Archive (whole folder subtrees, like core)
  archive_page: ({ id }: { id: string }) => {
    if (!pages.has(id)) fail("Database error: FOREIGN KEY constraint failed");
    if (!archived.has(id)) archived.set(id, ts());
  },
  unarchive_page: ({ id }: { id: string }) => { archived.delete(id); },
  archive_folder: ({ id }: { id: string }) => {
    if (!folders.has(id)) fail("Database error: FOREIGN KEY constraint failed");
    const sub = folderSubtree(id);
    const t = ts();
    let count = 0;
    for (const p of pages.values()) {
      if (p.folder_id && sub.has(p.folder_id) && !archived.has(p.id)) { archived.set(p.id, t); count++; }
    }
    if (!archivedFolders.has(id)) archivedFolders.set(id, t);
    return count;
  },
  unarchive_folder: ({ id }: { id: string }) => {
    const sub = folderSubtree(id);
    for (const f of sub) archivedFolders.delete(f);
    for (const p of pages.values()) if (p.folder_id && sub.has(p.folder_id)) archived.delete(p.id);
  },
  list_archived: () => {
    const items: Array<{ id: string; title: string; item_type: string; page_count: number; archived_at: string }> = [];
    for (const [fid, at] of archivedFolders) {
      const f = folders.get(fid);
      if (!f) continue;
      const sub = folderSubtree(fid);
      const pageCount = Array.from(archived.keys()).filter(pid => { const p = pages.get(pid); return p?.folder_id && sub.has(p.folder_id); }).length;
      items.push({ id: fid, title: f.name, item_type: "folder", page_count: pageCount, archived_at: at });
    }
    for (const [pid, at] of archived) {
      const p = pages.get(pid);
      if (p && !folderHiddenBy(p.folder_id, archivedFolders)) {
        items.push({ id: p.id, title: p.title, item_type: "page", page_count: 0, archived_at: at });
      }
    }
    return items.sort((a, b) => b.archived_at.localeCompare(a.archived_at));
  },
  archived_count: () => archivedFolders.size + Array.from(archived.keys()).filter(pid => {
    const p = pages.get(pid);
    return p && !folderHiddenBy(p.folder_id, archivedFolders);
  }).length,

  // Trash (whole folder subtrees; a trashed page's title is free for new pages)
  trash_page: ({ id }: { id: string }) => {
    if (!pages.has(id)) fail("Database error: FOREIGN KEY constraint failed");
    if (!trash.has(id)) trash.set(id, { at: ts() });
  },
  trash_folder: ({ id }: { id: string }) => {
    if (!folders.has(id)) fail("Database error: FOREIGN KEY constraint failed");
    const sub = folderSubtree(id);
    const t = ts();
    let count = 0;
    for (const p of pages.values()) {
      if (p.folder_id && sub.has(p.folder_id) && !trash.has(p.id)) { trash.set(p.id, { at: t }); count++; }
    }
    if (!trashedFolders.has(id)) trashedFolders.set(id, t);
    return count;
  },
  restore_from_trash: ({ id, itemType }: { id: string; itemType: string }) => {
    if (itemType === "folder") {
      const f = folders.get(id) ?? fail("Not found: Folder not found");
      const clash = Array.from(folders.values()).some(o => o.name === f.name && o.id !== id && !trashedFolders.has(o.id));
      if (clash) f.name = `${f.name} (restored)`;
      const sub = folderSubtree(id);
      const inside = Array.from(pages.values()).filter(p => p.folder_id && sub.has(p.folder_id));
      for (const p of inside) unparkTitle(p.id);
      for (const fid of sub) trashedFolders.delete(fid);
      for (const p of inside) trash.delete(p.id);
    } else {
      if (!trash.has(id)) fail("Not found: Page not in trash");
      unparkTitle(id);
      trash.delete(id);
    }
  },
  // "Delete forever" only applies to things in the trash (core delete_from_trash).
  permanently_delete: ({ id, itemType }: { id: string; itemType: string }) => {
    if (itemType === "folder") {
      if (!trashedFolders.has(id)) fail("Invalid input: This folder is not in the trash; move it to the trash before deleting it permanently");
      const sub = folderSubtree(id);
      for (const p of Array.from(pages.values())) if (p.folder_id && sub.has(p.folder_id)) purgePage(p.id);
      dropFolders(sub);
    } else {
      if (!trash.has(id)) fail("Invalid input: This page is not in the trash; move it to the trash before deleting it permanently");
      purgePage(id);
    }
  },
  list_trash: () => {
    const items: Array<{ id: string; title: string; item_type: string; page_count: number; deleted_at: string }> = [];
    for (const [fid, at] of trashedFolders) {
      const f = folders.get(fid);
      if (!f) continue;
      const sub = folderSubtree(fid);
      const pageCount = Array.from(trash.keys()).filter(pid => { const p = pages.get(pid); return p?.folder_id && sub.has(p.folder_id); }).length;
      items.push({ id: fid, title: f.name, item_type: "folder", page_count: pageCount, deleted_at: at });
    }
    for (const [pid, t] of trash) {
      const p = pages.get(pid);
      if (p && !folderHiddenBy(p.folder_id, trashedFolders)) {
        items.push({ id: p.id, title: t.original ?? p.title, item_type: "page", page_count: 0, deleted_at: t.at });
      }
    }
    return items.sort((a, b) => b.deleted_at.localeCompare(a.deleted_at));
  },
  empty_trash: () => {
    const items = handlers.list_trash({}) as Array<{ id: string; item_type: string }>;
    let count = 0;
    for (const it of items) if (it.item_type === "folder" && folders.has(it.id)) { handlers.permanently_delete({ id: it.id, itemType: "folder" }); count++; }
    for (const it of items) if (it.item_type === "page" && pages.has(it.id)) { handlers.permanently_delete({ id: it.id, itemType: "page" }); count++; }
    return count;
  },

  // Git Sync
  git_available: () => true,
  git_sync_enable: () => ({
    enabled: true,
    remote_url: null,
    branch: "main",
    last_sync: ts(),
  }),
  git_sync_disable: () => {},
  git_sync: () => ({
    success: true,
    pages_exported: 0,
    pages_imported: 0,
    conflicts_resolved: 0,
    error: null,
  }),
  git_sync_status: () => ({
    enabled: false,
    remote_url: null,
    branch: null,
    last_sync: null,
  }),

  // AI: TODOs. Uses the shared line rules in todoExtractor.ts, which mirror the
  // Rust parse_pending_todo. Hidden (trashed/archived, also via folders) pages don't count.
  get_pending_todo_count: () => countPendingTodos(
    Array.from(blocks.values()).filter(b => pages.has(b.page_id) && !pageHidden(b.page_id)).map(b => b.content),
  ),
  list_pending_todos: () => pendingTodos().map(({ page_title, text }) => ({ page_title, text })),
  list_pending_todos_with_page_ids: () => pendingTodos(),

  // ── Whiteboards (mirrors minotes-core repo/whiteboards.rs) ──
  get_whiteboard: ({ id }: { id: string }) => mockWhiteboards.get(id) ?? null,
  save_whiteboard: ({ id, data }: { id: string; data: string }) => {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) fail(`Invalid input: invalid whiteboard id: ${JSON.stringify(id)}`);
    JSON.parse(data); // must be valid JSON, like the Rust side
    mockWhiteboards.set(id, data);
  },
  // Boards no {{whiteboard:<id>}} block references any more.
  gc_whiteboards: () => {
    const used = new Set<string>();
    for (const b of blocks.values()) for (const m of b.content.matchAll(/\{\{whiteboard:([A-Za-z0-9_-]+)\}\}/g)) used.add(m[1]);
    const gone = Array.from(mockWhiteboards.keys()).filter(id => !used.has(id));
    gone.forEach(id => mockWhiteboards.delete(id));
    return gone;
  },
  // ── End whiteboards ──
};

function pendingTodos(): Array<{ page_id: string; page_title: string; text: string }> {
  const out: Array<{ page_id: string; page_title: string; text: string }> = [];
  for (const b of blocks.values()) {
    const p = pages.get(b.page_id);
    if (!p || pageHidden(p.id)) continue;
    for (const line of b.content.split("\n")) {
      const t = parseTodoLine(line);
      if (t && !t.done) out.push({ page_id: p.id, page_title: p.title, text: t.text });
    }
  }
  return out;
}

// Whiteboard storage for the mock backend (whiteboard id -> JSON data).
const mockWhiteboards: Map<string, string> = new Map();

// ── Notebooks: each notebook is its own store; switching swaps the live maps ──

const MOCK_HOME = "/home/user";

interface MockNotebook {
  key: string; name: string; kind: "legacy" | "folder"; path: string; db_path: string; mirror_dir: string;
  available: boolean; last_opened: string | null; size_bytes: number; modified_at: string; cloud: string | null;
}

function legacyNotebook(name: string): MockNotebook {
  return {
    key: name, name, kind: "legacy", path: `${MOCK_HOME}/.minotes/${name}.db`, db_path: `${MOCK_HOME}/.minotes/${name}.db`,
    mirror_dir: name === "default" ? `${MOCK_HOME}/MiNotes_Sync` : `${MOCK_HOME}/MiNotes_Sync-${name}`,
    available: true, last_opened: null, size_bytes: 4096, modified_at: ts(), cloud: null,
  };
}

function folderNotebook(key: string, name: string, path: string): MockNotebook {
  const cloud = /(^|\/)(Dropbox|OneDrive|Google Drive|iCloud Drive)(\/|$)/.exec(path)?.[2] ?? null;
  return {
    key, name, kind: "folder", path, db_path: `${path}/notebook.minotes`, mirror_dir: `${path}/notes`,
    available: true, last_opened: null, size_bytes: 4096, modified_at: ts(), cloud,
  };
}

const mockNotebooks: MockNotebook[] = [legacyNotebook("default")];
/** Folder notebooks forgotten from the list but still "on disk". */
const mockFolders: Map<string, MockNotebook> = new Map();
let currentNotebook = "default";
let mirrorWrittenAt: string | null = null;

function validateGraphKey(name: string) {
  if (!name || /[/\\.\0]/.test(name) || /[\u0000-\u001f]/.test(name)) {
    fail(`Invalid graph name: '${name}'. Must be non-empty and contain no path separators or dots.`);
  }
}

function validateNotebookName(name: string) {
  if (!name.trim() || name.trim() !== name || name.length > 100 || /[/\\.\0]/.test(name) || /[\u0000-\u001f]/.test(name)) {
    fail(`Invalid input: Invalid notebook name: '${name}'. Use letters, numbers, spaces, - or _ (no dots or slashes).`);
  }
}

function mockMirrorStatus() {
  const nb = mockNotebooks.find(n => n.key === currentNotebook)!;
  mirrorWrittenAt = mirrorWrittenAt ?? ts();
  return {
    dir: nb.mirror_dir, enabled: true, last_written_at: mirrorWrittenAt, last_pass_at: ts(), last_full_at: mirrorWrittenAt,
    error: null, pages: Array.from(pages.keys()).filter(id => !trash.has(id) && !archived.has(id)).length,
    pending: false, behind: false, read_only: false,
  };
}

interface MockStore {
  maps: Map<string, unknown>[];
  undo: Array<() => void>;
}

/** Every per-notebook map, in a fixed order. */
const storeMaps = (): Map<string, any>[] => [
  pages, blocks, properties, pendingJournals, folders, favorites, trash, trashedFolders, archived,
  archivedFolders, cards, aliases, templates, cssSnippets, mockWhiteboards,
];

function snapshotStore(): MockStore {
  return { maps: storeMaps().map(m => new Map(m)), undo: [...undoLog] };
}

function restoreStore(st: MockStore) {
  storeMaps().forEach((m, i) => {
    m.clear();
    st.maps[i].forEach((v, k) => m.set(k, v));
  });
  undoLog.length = 0;
  undoLog.push(...st.undo);
}

function emptyStore(): MockStore {
  return { maps: storeMaps().map(() => new Map()), undo: [] };
}

/** Saved stores of the notebooks that are not open. */
const notebookStores: Map<string, MockStore> = new Map();

// ── Argument validation, as Tauri does before the Rust command runs ──
// Generated from the #[tauri::command] signatures in src-tauri/src/lib.rs:
// non-Option params are required; params the command parses as a UUID must be one.
const REQUIRED_ARGS: Record<string, string[]> = {"get_page_tree":["titleOrId"],"create_page":["title"],"delete_page":["id"],"rename_page":["id","newTitle"],"create_block":["pageId","content"],"update_block":["id","content"],"delete_block":["id"],"search_blocks":["query"],"get_backlinks":["pageId"],"get_unlinked_references":["pageId"],"run_query":["sql"],"create_folder":["name"],"move_page_to_folder":["pageId"],"reorder_page":["id","newPosition"],"set_property":["entityId","entityType","key","value"],"get_properties":["entityId"],"get_inherited_properties":["blockId"],"delete_property":["entityId","key"],"delete_folder":["id"],"update_folder_appearance":["id"],"rename_folder":["id","newName"],"create_card":["blockId","cardType"],"review_card":["cardId","rating"],"delete_card":["cardId"],"add_favorite":["pageId"],"remove_favorite":["pageId"],"reorder_favorite":["pageId","newPosition"],"add_alias":["pageId","alias"],"remove_alias":["alias"],"get_aliases":["pageId"],"create_template":["name","content"],"apply_template":["pageId","templateName"],"delete_template":["name"],"publish_site":["outputDir"],"move_block":["id","newParent","position"],"reorder_block":["id","position"],"reparent_block":["id"],"register_plugin":["name","version"],"enable_plugin":["name"],"disable_plugin":["name"],"uninstall_plugin":["name"],"switch_graph":["name"],"create_graph_cmd":["name"],"delete_graph_cmd":["name"],"create_highlight":["pdfPath","pageNum","x","y","width","height","color"],"get_highlights":["pdfPath"],"update_highlight_note":["id","note"],"delete_highlight":["id"],"search_highlights":["query"],"sync_page":["pageId"],"get_version_history":["pageId"],"restore_version":["pageId","versionHash"],"plugin_storage_get":["pluginName","key"],"plugin_storage_set":["pluginName","key","value"],"add_css_snippet":["name","css","source"],"toggle_css_snippet":["name"],"delete_css_snippet":["name"],"update_css_snippet":["name","css"],"clip_content":["title","content"],"save_png_to_downloads":["filename","data"],"read_pdf_file":["path"],"read_file_base64":["path"],"fetch_og_metadata":["url"],"get_block":["id"],"get_blocks":["ids"],"get_properties_batch":["entityIds"],"archive_page":["id"],"unarchive_page":["id"],"archive_folder":["id"],"unarchive_folder":["id"],"trash_page":["id"],"trash_folder":["id"],"restore_from_trash":["id","itemType"],"permanently_delete":["id","itemType"],"get_whiteboard":["id"],"save_whiteboard":["id","data"],"restore_blocks":["blocks"],"default_notebook_location":["name"],"create_notebook":["name"],"open_notebook_folder":["path"],"locate_notebook":["key","path"],"rename_notebook":["key","name"],"delete_notebook":["key"],"forget_notebook":["key"],"move_notebook_to_folder":["path"],"git_sync_resolve_deletions":["action"]};
const UUID_ARGS: Record<string, string[]> = {"delete_page":["id"],"rename_page":["id"],"create_block":["pageId","parentId?"],"update_block":["id"],"delete_block":["id"],"get_backlinks":["pageId"],"get_unlinked_references":["pageId"],"create_folder":["parentId?"],"move_page_to_folder":["pageId","folderId?"],"reorder_page":["id"],"set_property":["entityId"],"get_properties":["entityId"],"get_inherited_properties":["blockId"],"delete_property":["entityId"],"delete_folder":["id"],"update_folder_appearance":["id"],"rename_folder":["id"],"create_card":["blockId"],"review_card":["cardId"],"delete_card":["cardId"],"add_favorite":["pageId"],"remove_favorite":["pageId"],"reorder_favorite":["pageId"],"add_alias":["pageId"],"get_aliases":["pageId"],"apply_template":["pageId"],"move_block":["id","newParent"],"reorder_block":["id","parentId?"],"reparent_block":["id","parentId?"],"update_highlight_note":["id"],"delete_highlight":["id"],"sync_page":["pageId"],"get_version_history":["pageId"],"restore_version":["pageId"],"get_block":["id"],"archive_page":["id"],"unarchive_page":["id"],"archive_folder":["id"],"unarchive_folder":["id"],"trash_page":["id"],"trash_folder":["id"],"restore_from_trash":["id"],"permanently_delete":["id"]};

/** The uuid crate's message for a malformed id (what the Tauri command returns). */
function uuidError(v: string): string {
  const i = Array.from(v).findIndex(c => !/[0-9a-fA-F-]/.test(c));
  return i >= 0
    ? `invalid character: expected an optional prefix of \`urn:uuid:\` followed by [0-9a-fA-F-], found \`${Array.from(v)[i]}\` at ${i + 1}`
    : `invalid length: expected length 32 for simple format, found ${v.replace(/-/g, "").length}`;
}

function validated(cmd: string, fn: (args: any) => any) {
  return (args: any) => {
    const a = args ?? {};
    for (const k of REQUIRED_ARGS[cmd] ?? []) {
      if (a[k] === undefined || a[k] === null) {
        fail(`invalid args \`${k}\` for command \`${cmd}\`: command ${cmd} missing required key ${k}`);
      }
    }
    for (const spec of UUID_ARGS[cmd] ?? []) {
      const k = spec.replace("?", "");
      if (a[k] == null) continue;
      if (!isUuid(a[k])) fail(uuidError(String(a[k])));
    }
    return fn(a);
  };
}

const validatedHandlers: Record<string, (args: any) => any> = Object.fromEntries(
  Object.entries(handlers).map(([cmd, fn]) => [cmd, validated(cmd, fn)]),
);

/** A command the real app doesn't have fails like Tauri's ("Command x not found")
 *  instead of silently resolving to undefined. */
export const mockHandlers: Record<string, (args: any) => any> = new Proxy(validatedHandlers, {
  get(target, key) {
    if (typeof key !== "string" || key in target || key === "then" || !/^[a-z][a-z0-9_]*$/.test(key)) {
      return (target as any)[key];
    }
    return () => fail(`Command ${key} not found`);
  },
});

// ── AI platform ──
// Browser-mode mock of the AI commands (settings, fake catalogue, scripted
// cited answers streamed as events) — see lib/aiMock.ts.
import { createAiMockHandlers } from "./aiMock";
Object.assign(mockHandlers, createAiMockHandlers(mockHandlers));
// ── End AI platform ──

// ── Import / attachments ──
// Browser-mode mock of import + attachment commands — see lib/importMock.ts.
import { createImportMockHandlers } from "./importMock";
Object.assign(mockHandlers, createImportMockHandlers(mockHandlers));
// ── End import ──
