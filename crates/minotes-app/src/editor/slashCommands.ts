import { Extension } from "@tiptap/react";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { exitSuggestion, findSuggestionMatch, type SuggestionOptions, type SuggestionProps } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import { SlashMenu, type SlashMenuItem } from "./SlashMenu";
import { generateWhiteboardId } from "../lib/whiteboardUtils";
import { BUILTIN_TEMPLATES, refreshUserTemplates, templateBlockCount, userTemplates } from "../lib/templates";
import { emptyTableMarkdown } from "./tables";
import { describeDate, journalLink, parseNaturalDate } from "../lib/naturalDate";
import { localDateKey } from "../lib/dates";
import { promptDialog } from "../lib/confirm";
import { attachmentMarkdown, storeFile } from "../lib/attachments";
import { showToast } from "../lib/toast";
import { errorMessage } from "../lib/errors";
import { openLanguagePickerAtCaret } from "./codeBlockView";

/** Exported so the editor can tell whether this menu is open (e.g. Escape closes it). */
export const slashPluginKey = new PluginKey("slashCommands");

/*
 * Slash commands use two strategies:
 * 1. Markdown-based (headings, callouts, tables): save "# text" via onSlashCommand callback
 * 2. Editor-based (lists, links, dates, files): use the TipTap API then save the resulting markdown
 *
 * Callbacks are stored on each editor instance ((editor.storage as any).slashCallbacks)
 * to avoid a shared module-level singleton race condition across multiple blocks.
 */

export function setSlashCallbacks(
  editor: any,
  command: (markdown: string) => void,
  save: () => void,
  /** Insert a template's text (lib/templates.ts); `intoEmpty`: it replaces this empty block. */
  template?: (text: string, intoEmpty: boolean) => void,
  flashcard?: () => void,
) {
  if (editor) {
    (editor.storage as any).slashCallbacks = { command, save, template, flashcard };
  }
}

const callbacks = (editor: any) => (editor.storage as any).slashCallbacks;

function getTextBeforeSlash(editor: any, range: { from: number; to: number }): string {
  try {
    const doc = editor.state.doc;
    if (range.from > 1) {
      return doc.textBetween(1, range.from, "", "").trim();
    }
  } catch {}
  return "";
}

/** Insert markdown at the caret (tiptap-markdown parses it) and save the block. */
function insertMarkdown(editor: any, markdown: string) {
  if (!editor || editor.isDestroyed) return;
  editor.chain().focus().insertContent(markdown).run();
  callbacks(editor)?.save();
}

/** Remove the `/query` text now, then run `fn` (which may wait for a dialog / picker). */
function afterRemovingQuery(editor: any, range: { from: number; to: number }, fn: () => void | Promise<void>) {
  editor.chain().focus().deleteRange(range).run();
  void Promise.resolve(fn()).catch((e) => showToast(`Couldn't insert: ${errorMessage(e)}`));
}

/** A native file picker (the GTK one in the desktop app). Resolves with the chosen files. */
function pickFiles(accept: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = true;
    input.style.display = "none";
    input.addEventListener("change", () => {
      resolve([...(input.files ?? [])]);
      input.remove();
    }, { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

/** Store the picked files as attachments (in the notebook) and reference them here. */
async function attachFiles(editor: any, accept: string) {
  const files = await pickFiles(accept);
  if (!files.length || !editor || editor.isDestroyed) return;
  const parts: string[] = [];
  for (const file of files) {
    try {
      parts.push(attachmentMarkdown(await storeFile(file)));
    } catch (e) {
      showToast(`Couldn't attach ${file.name || "the file"}: ${errorMessage(e)}`);
    }
  }
  if (parts.length) insertMarkdown(editor, parts.join(" "));
}

/** A web address as typed: `example.com/x` gets https://; anything without a dot is refused. */
export function normalizeUrl(input: string): string | null {
  const s = input.trim();
  if (!s || /\s/.test(s)) return null;
  if (/^(https?|mailto|attachment):/i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s)) return `https://${s}`;
  return null;
}

/** `[text](url)` with the characters that would end the text or the url escaped. */
export function markdownLink(text: string, url: string): string {
  const t = text.replace(/([[\]\\])/g, "\\$1");
  const u = url.replace(/[()\s]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
  return `[${t}](${u})`;
}

async function insertLink(editor: any) {
  const value = await promptDialog({
    title: "Insert link",
    label: "Web address",
    placeholder: "https://example.com",
    confirmLabel: "Insert",
  });
  if (value === null) { editor?.commands?.focus?.(); return; }
  const url = normalizeUrl(value);
  if (!url) { showToast(`“${value}” isn't a web address`); editor?.commands?.focus?.(); return; }
  insertMarkdown(editor, markdownLink(url.replace(/^https?:\/\//i, "").replace(/\/$/, ""), url) + " ");
}

async function insertPickedDate(editor: any) {
  const value = await promptDialog({
    title: "Insert a date",
    label: "Day",
    message: "Type a day the way you'd say it: today, next friday, in 3 days, mar 30, 2026-12-01.",
    placeholder: "next friday",
    confirmLabel: "Insert",
    hint: (v: string) => {
      if (!v.trim()) return "";
      const d = parseNaturalDate(v);
      return d ? `→ ${describeDate(d)}` : "Not a date I know";
    },
  });
  if (value === null) { editor?.commands?.focus?.(); return; }
  const d = parseNaturalDate(value);
  if (!d) { showToast(`“${value}” isn't a date I know`); editor?.commands?.focus?.(); return; }
  insertMarkdown(editor, journalLink(d) + " ");
}

/** `((` opens the block picker; `embed` makes the picked block an embed card. */
function openBlockPicker(editor: any, range: { from: number; to: number }, embed: boolean) {
  (editor.storage as any).blockRefEmbed = embed;
  editor.chain().focus().deleteRange(range).insertContent("((").run();
}

/**
 * Insert a template where the `/` was: into this block when it is otherwise empty
 * (the first template block replaces it), else as blocks after it. PageView fills
 * the placeholders and puts the caret at {{cursor}}.
 */
function insertTemplate(editor: any, range: { from: number; to: number }, text: string) {
  const doc = editor.state.doc;
  const rest = doc.textBetween(0, range.from, "\n", "\u0001") + doc.textBetween(range.to, doc.content.size, "\n", "\u0001");
  const intoEmpty = !rest.trim();
  const cb = callbacks(editor);
  editor.chain().focus().deleteRange(range).run();
  if (!intoEmpty) cb?.save();
  cb?.template?.(text, intoEmpty);
}

function templateItem(name: string, description: string, content: string): SlashMenuItem {
  return {
    title: `Template: ${name}`,
    description,
    keywords: ["template"],
    icon: "template",
    group: "Templates",
    command: ({ editor, range }) => insertTemplate(editor, range, content),
  };
}

/** The user's saved templates as menu items (after the built-in ones). */
function userTemplateItems(): SlashMenuItem[] {
  return userTemplates().map((t) => {
    const n = templateBlockCount(t.content);
    return templateItem(t.name, t.description?.trim() || `Your template · ${n} block${n === 1 ? "" : "s"}`, t.content);
  });
}

const dateItem = (date: Date, title: string): SlashMenuItem => ({
  title,
  description: `${describeDate(date)} · links to that day's journal`,
  icon: "calendar",
  group: "Links & dates",
  command: ({ editor, range }) => {
    editor.chain().focus().deleteRange(range).run();
    insertMarkdown(editor, journalLink(date) + " ");
  },
});

const COMMANDS: SlashMenuItem[] = [
  // ── Basic ──
  {
    title: "Heading 1",
    description: "Big section heading",
    aliases: ["h1", "title"],
    icon: "heading-1",
    group: "Basic",
    command: ({ editor, range }) => {
      const text = getTextBeforeSlash(editor, range);
      callbacks(editor)?.command(`# ${text}`);
    },
  },
  {
    title: "Heading 2",
    description: "Medium section heading",
    aliases: ["h2", "subtitle"],
    icon: "heading-2",
    group: "Basic",
    command: ({ editor, range }) => {
      const text = getTextBeforeSlash(editor, range);
      callbacks(editor)?.command(`## ${text}`);
    },
  },
  {
    title: "Heading 3",
    description: "Small section heading",
    aliases: ["h3"],
    icon: "heading-3",
    group: "Basic",
    command: ({ editor, range }) => {
      const text = getTextBeforeSlash(editor, range);
      callbacks(editor)?.command(`### ${text}`);
    },
  },
  {
    title: "Quote",
    description: "Set a quotation apart from the text",
    aliases: ["blockquote", ">"],
    icon: "quote",
    group: "Basic",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleBlockquote().run();
      callbacks(editor)?.save();
    },
  },
  // Callouts: `> [!type] text` (CalloutNode) — markdown approach, like headings.
  ...([
    ["Callout", "note", "A highlighted box for a note", "info", ["note", "info", "callout"]],
    ["Warning callout", "warning", "A box that warns about a risk", "warning", ["warning", "caution", "danger"]],
    ["Tip callout", "tip", "A box with a helpful hint", "lightbulb", ["tip", "hint"]],
  ] as const).map(([title, type, description, icon, aliases]): SlashMenuItem => ({
    title,
    description,
    aliases: [...aliases],
    keywords: ["callout", "admonition", "box"],
    icon,
    group: "Basic",
    command: ({ editor, range }) => {
      const text = getTextBeforeSlash(editor, range);
      callbacks(editor)?.command(`> [!${type}] ${text}`.trimEnd());
    },
  })),
  {
    title: "Divider",
    description: "A line between sections",
    aliases: ["hr", "divider", "---", "line", "separator", "rule"],
    icon: "minus",
    group: "Basic",
    command: ({ editor }) => {
      callbacks(editor)?.command("---");
    },
  },
  // ── Lists ──
  {
    title: "Bullet List",
    description: "A simple bulleted list",
    aliases: ["ul", "bullets", "unordered"],
    keywords: ["list"],
    icon: "list",
    group: "Lists",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleBulletList().run();
      callbacks(editor)?.save();
    },
  },
  {
    title: "Numbered List",
    description: "A list numbered 1, 2, 3",
    aliases: ["ol", "ordered", "numbers", "1."],
    keywords: ["list"],
    icon: "list-ordered",
    group: "Lists",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleOrderedList().run();
      callbacks(editor)?.save();
    },
  },
  {
    title: "Todo List",
    description: "Checkboxes to tick off",
    aliases: ["todo", "task", "checkbox", "checklist", "[]"],
    keywords: ["list"],
    icon: "square-check",
    group: "Lists",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleTaskList().run();
      callbacks(editor)?.save();
    },
  },
  // ── Media ──
  {
    title: "Image",
    description: "Add a picture from your computer",
    aliases: ["img", "picture", "photo"],
    keywords: ["upload", "screenshot"],
    icon: "image",
    group: "Media",
    command: ({ editor, range }) => afterRemovingQuery(editor, range, () => attachFiles(editor, "image/*")),
  },
  {
    title: "File",
    description: "Attach a file from your computer",
    aliases: ["attachment", "attach", "upload"],
    keywords: ["pdf", "document"],
    icon: "paperclip",
    group: "Media",
    command: ({ editor, range }) => afterRemovingQuery(editor, range, () => attachFiles(editor, "")),
  },
  {
    title: "Whiteboard",
    description: "A canvas to sketch and draw on",
    aliases: ["draw", "canvas", "sketch"],
    icon: "draw",
    group: "Media",
    command: ({ editor }) => {
      const wbId = generateWhiteboardId();
      callbacks(editor)?.command(`{{whiteboard:${wbId}}}`);
    },
  },
  // ── Links & dates ──
  {
    title: "Link",
    description: "A web link — asks for the address",
    aliases: ["url", "href", "web"],
    keywords: ["hyperlink"],
    icon: "link",
    group: "Links & dates",
    command: ({ editor, range }) => afterRemovingQuery(editor, range, () => insertLink(editor)),
  },
  {
    title: "Date",
    description: "Today, linked to its journal page (or /date next friday)",
    aliases: ["today", "now"],
    keywords: ["day", "journal", "calendar"],
    icon: "calendar",
    group: "Links & dates",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).run();
      insertMarkdown(editor, journalLink(new Date()) + " ");
    },
  },
  {
    title: "Pick a date…",
    description: "Type any day: next friday, in 3 days, mar 30",
    aliases: ["day", "datepicker"],
    keywords: ["date", "when", "deadline", "due"],
    icon: "calendar",
    group: "Links & dates",
    command: ({ editor, range }) => afterRemovingQuery(editor, range, () => insertPickedDate(editor)),
  },
  {
    title: "Block reference",
    description: "Link to another block; its text stays in sync",
    aliases: ["ref", "blockref", "(("],
    keywords: ["reference", "link", "block"],
    icon: "block-ref",
    group: "Links & dates",
    command: ({ editor, range }) => openBlockPicker(editor, range, false),
  },
  {
    title: "Embed block",
    description: "Show another block here as a live card",
    aliases: ["embed", "transclude", "transclusion"],
    keywords: ["block", "card"],
    icon: "embed",
    group: "Links & dates",
    command: ({ editor, range }) => openBlockPicker(editor, range, true),
  },
  // ── Advanced ──
  {
    title: "Code Block",
    description: "Code with syntax highlighting; pick the language",
    aliases: ["code", "codeblock", "```", "pre", "snippet"],
    icon: "code",
    group: "Advanced",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run();
      callbacks(editor)?.save();
      // Ask for the language (Esc keeps plain text; the label changes it later).
      setTimeout(() => openLanguagePickerAtCaret(editor), 80);
    },
  },
  {
    // Markdown approach (like headings): the block becomes a pipe table, which the
    // sync path renders as a TipTap table — so what's on screen is what's stored.
    title: "Table",
    description: "A small table; Tab adds rows",
    aliases: ["grid"],
    keywords: ["rows", "columns"],
    icon: "table",
    group: "Advanced",
    command: ({ editor, range }) => {
      const text = getTextBeforeSlash(editor, range);
      const table = emptyTableMarkdown(3, 2);
      callbacks(editor)?.command(text ? `${text}\n\n${table}` : table);
    },
  },
  {
    title: "Flashcard",
    description: "Make this block a card to review later",
    aliases: ["card", "srs"],
    keywords: ["review", "spaced", "repetition", "question", "answer"],
    icon: "layers",
    group: "Advanced",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).run();
      const cb = callbacks(editor);
      cb?.save();
      cb?.flashcard?.();
    },
  },
  // ── Templates — the built-in ones; the user's own are added per query ──
  ...BUILTIN_TEMPLATES.map((t) => templateItem(t.name, t.description, t.content)),
];

/** Every built-in slash command, in menu order (tests, the shortcut list). */
export const SLASH_COMMANDS: readonly SlashMenuItem[] = COMMANDS;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
/** True when the letters of `q` appear in `text` in order. */
const subsequence = (q: string, text: string) => {
  let i = 0;
  for (const ch of text) if (ch === q[i] && ++i === q.length) return true;
  return q.length === 0;
};

/**
 * The commands for a `/query`, best match first: an alias or the whole title
 * (exact), then a title / alias prefix, the start of a title word, a keyword or
 * a word of the description, a substring, and last the letters in order (fuzzy).
 * Ties keep the menu's order.
 */
export function filterSlashCommands(query: string, items: readonly SlashMenuItem[] = COMMANDS): SlashMenuItem[] {
  const q = norm(query);
  if (!q) return [...items];
  const ql = query.trim().toLowerCase();
  const score = (item: SlashMenuItem): number => {
    const title = norm(item.title);
    const aliases = (item.aliases ?? []).map(norm);
    const words = item.title.toLowerCase().split(/[\s:]+/).filter(Boolean);
    if (title === q || aliases.includes(q)) return 100;
    if (title.startsWith(q)) return 80;
    if (aliases.some(a => a.startsWith(q))) return 70;
    if (words.some(w => w.startsWith(ql))) return 60;
    if ((item.keywords ?? []).some(k => k.startsWith(ql))) return 45;
    if (item.description.toLowerCase().split(/[\s,;·()]+/).some(w => w.startsWith(ql))) return 40;
    if (title.includes(q)) return 30;
    if (q.length >= 2 && subsequence(q, title)) return 10;
    return 0;
  };
  return items
    .map((item, i) => ({ item, i, s: score(item) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(x => x.item);
}

/**
 * The menu for a query: `/date next friday` (or a bare day such as `/tomorrow`,
 * `/fri`, `/+3d`) puts the day it means first, then the matching commands.
 */
export function slashMenuItems(query: string, now: Date = new Date(), items: readonly SlashMenuItem[] = COMMANDS): SlashMenuItem[] {
  const dated = /^date\s+(.+)$/i.exec(query.trim());
  if (dated) {
    const d = parseNaturalDate(dated[1], now);
    return d ? [dateItem(d, `Date: ${localDateKey(d)}`)] : [];
  }
  const out = filterSlashCommands(query, items);
  const q = query.trim();
  const top = out[0];
  const exact = !!top && (norm(top.title) === norm(q) || (top.aliases ?? []).some(a => norm(a) === norm(q)));
  if (q.length >= 3 && !exact) {
    const d = parseNaturalDate(q, now);
    if (d) out.unshift(dateItem(d, `Date: ${localDateKey(d)}`));
  }
  return out;
}

export const SlashCommands = Extension.create({
  name: "slashCommands",

  addOptions() {
    return {
      suggestion: {
        char: "/",
        startOfLine: false,
        // Spaces end the query, except after `/date ` (a day can be several words).
        findSuggestionMatch: (config: Parameters<typeof findSuggestionMatch>[0]) => {
          const wide = findSuggestionMatch({ ...config, allowSpaces: true });
          if (wide && /^date\s/i.test(wide.query)) return wide;
          return findSuggestionMatch({ ...config, allowSpaces: false });
        },
        command: ({ editor, range, props }: { editor: any; range: any; props: any }) => {
          props.command({ editor, range });
        },
        items: async ({ query }: { query: string }) => {
          // The user's templates: from the cache, refreshed at most every few seconds.
          await refreshUserTemplates(5000);
          return slashMenuItems(query, new Date(), [...COMMANDS, ...userTemplateItems()]);
        },
        render: () => {
          let reactRenderer: ReactRenderer;
          let popup: TippyInstance[];
          let items: unknown[] = [];

          return {
            onStart: (props: SuggestionProps) => {
              items = props.items;
              reactRenderer = new ReactRenderer(SlashMenu, {
                props,
                editor: props.editor,
              });

              if (!props.clientRect) return;

              popup = tippy("body", {
                getReferenceClientRect: props.clientRect as () => DOMRect,
                appendTo: () => document.body,
                content: reactRenderer.element,
                showOnCreate: true,
                interactive: true,
                trigger: "manual",
                placement: "bottom-start",
              });
            },

            onUpdate(props: SuggestionProps) {
              items = props.items;
              reactRenderer?.updateProps(props);

              if (!props.clientRect) return;

              popup?.[0]?.setProps({
                getReferenceClientRect: props.clientRect as () => DOMRect,
              });
            },

            onKeyDown(props: { event: KeyboardEvent; view: any }) {
              if (props.event.key === "Escape") {
                popup?.[0]?.hide();
                return true;
              }
              // "No results": Enter just closes the menu; the typed text stays.
              if (props.event.key === "Enter" && items.length === 0) {
                exitSuggestion(props.view, slashPluginKey);
                return true;
              }
              return (reactRenderer?.ref as any)?.onKeyDown?.(props) ?? false;
            },

            onExit() {
              popup?.[0]?.destroy();
              reactRenderer?.destroy();
            },
          };
        },
      } as Partial<SuggestionOptions>,
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        pluginKey: slashPluginKey,
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});
