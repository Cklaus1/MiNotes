import { Extension } from "@tiptap/react";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { exitSuggestion, type SuggestionOptions, type SuggestionProps } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import { SlashMenu, type SlashMenuItem } from "./SlashMenu";
import { generateWhiteboardId } from "../lib/whiteboardUtils";
import { BUILTIN_TEMPLATES, applyTemplateVars } from "../lib/builtinTemplates";
import { emptyTableMarkdown } from "./tables";

/** Exported so the editor can tell whether this menu is open (e.g. Escape closes it). */
export const slashPluginKey = new PluginKey("slashCommands");

/*
 * Slash commands use two strategies:
 * 1. Markdown-based (headings): save "# text" via onSlashCommand callback
 * 2. Editor-based (lists, hr): use TipTap API then save the resulting markdown
 *
 * Callbacks are stored on each editor instance ((editor.storage as any).slashCallbacks)
 * to avoid a shared module-level singleton race condition across multiple blocks.
 */

export function setSlashCallbacks(
  editor: any,
  command: (markdown: string) => void,
  save: () => void,
  template?: (lines: string[]) => void,
  flashcard?: () => void,
) {
  if (editor) {
    (editor.storage as any).slashCallbacks = { command, save, template, flashcard };
  }
}

function getTextBeforeSlash(editor: any, range: { from: number; to: number }): string {
  try {
    const doc = editor.state.doc;
    if (range.from > 1) {
      return doc.textBetween(1, range.from, "", "").trim();
    }
  } catch {}
  return "";
}

const COMMANDS: SlashMenuItem[] = [
  {
    title: "Heading 1",
    description: "large heading",
    aliases: ["h1", "title"],
    command: ({ editor, range }) => {
      const text = getTextBeforeSlash(editor, range);
      (editor.storage as any).slashCallbacks?.command(`# ${text}`);
    },
  },
  {
    title: "Heading 2",
    description: "medium heading",
    aliases: ["h2", "subtitle"],
    command: ({ editor, range }) => {
      const text = getTextBeforeSlash(editor, range);
      (editor.storage as any).slashCallbacks?.command(`## ${text}`);
    },
  },
  {
    title: "Heading 3",
    description: "small heading",
    aliases: ["h3"],
    command: ({ editor, range }) => {
      const text = getTextBeforeSlash(editor, range);
      (editor.storage as any).slashCallbacks?.command(`### ${text}`);
    },
  },
  {
    title: "Bullet List",
    description: "list bullet unordered",
    aliases: ["ul", "bullets", "unordered"],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleBulletList().run();
      (editor.storage as any).slashCallbacks?.save();
    },
  },
  {
    title: "Numbered List",
    description: "list numbered ordered 1. 2. 3.",
    aliases: ["ol", "ordered", "numbers", "1."],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleOrderedList().run();
      (editor.storage as any).slashCallbacks?.save();
    },
  },
  {
    title: "Todo List",
    description: "task checkbox todo",
    aliases: ["todo", "task", "checkbox", "checklist", "[]"],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleTaskList().run();
      (editor.storage as any).slashCallbacks?.save();
    },
  },
  {
    title: "Code Block",
    description: "code snippet",
    aliases: ["code", "codeblock", "```", "pre", "snippet"],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run();
      (editor.storage as any).slashCallbacks?.save();
    },
  },
  {
    title: "Quote",
    description: "blockquote",
    aliases: ["blockquote", ">"],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleBlockquote().run();
      (editor.storage as any).slashCallbacks?.save();
    },
  },
  {
    title: "Divider",
    description: "horizontal line separator",
    aliases: ["hr", "divider", "---", "line", "separator", "rule"],
    command: ({ editor, range }) => {
      (editor.storage as any).slashCallbacks?.command("---");
    },
  },
  {
    // Markdown approach (like headings): the block becomes a pipe table, which the
    // sync path renders as a TipTap table — so what's on screen is what's stored.
    title: "Table",
    description: "table grid rows columns 3x3",
    aliases: ["grid"],
    command: ({ editor, range }) => {
      const text = getTextBeforeSlash(editor, range);
      const table = emptyTableMarkdown(3, 2);
      (editor.storage as any).slashCallbacks?.command(text ? `${text}\n\n${table}` : table);
    },
  },
  {
    title: "Flashcard",
    description: "flashcard card srs review spaced repetition question answer",
    aliases: ["card", "srs"],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).run();
      const cb = (editor.storage as any).slashCallbacks;
      cb?.save();
      cb?.flashcard?.();
    },
  },
  {
    title: "Whiteboard",
    description: "drawing canvas sketch",
    aliases: ["draw", "canvas", "sketch"],
    command: ({ editor, range }) => {
      const wbId = generateWhiteboardId();
      (editor.storage as any).slashCallbacks?.command(`{{whiteboard:${wbId}}}`);
    },
  },
  // Templates — each gets a slash command entry
  ...BUILTIN_TEMPLATES.map((t) => ({
    title: `Template: ${t.name}`,
    description: `template ${t.description}`,
    command: ({ editor, range }: { editor: any; range: any }) => {
      // Substitute {{date}}/{{time}} once per insertion so every line in the
      // template shares a single timestamp.
      const now = new Date();
      const lines = t.blocks.map((b) => applyTemplateVars(b, now));
      // Set current block to first template line, pass remaining lines as multiline insert
      const [first, ...rest] = lines;
      (editor.storage as any).slashCallbacks?.command(first ?? "");
      // Insert remaining blocks via the onPasteMultiline mechanism
      if (rest.length > 0) {
        (editor.storage as any).slashCallbacks?.template?.(rest);
      }
    },
  })),
];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
/** True when the letters of `q` appear in `text` in order. */
const subsequence = (q: string, text: string) => {
  let i = 0;
  for (const ch of text) if (ch === q[i] && ++i === q.length) return true;
  return q.length === 0;
};

/**
 * The commands for a `/query`, best match first: an alias or the whole title
 * (exact), then a title / alias prefix, the start of a title word, a word of
 * the description, a substring, and last the letters in order (fuzzy).
 * Ties keep the menu's order.
 */
export function filterSlashCommands(query: string, items: SlashMenuItem[] = COMMANDS): SlashMenuItem[] {
  const q = norm(query);
  if (!q) return items;
  const ql = query.trim().toLowerCase();
  const score = (item: SlashMenuItem): number => {
    const title = norm(item.title);
    const aliases = (item.aliases ?? []).map(norm);
    const words = item.title.toLowerCase().split(/[\s:]+/).filter(Boolean);
    if (title === q || aliases.includes(q)) return 100;
    if (title.startsWith(q)) return 80;
    if (aliases.some(a => a.startsWith(q))) return 70;
    if (words.some(w => w.startsWith(ql))) return 60;
    if (item.description.toLowerCase().split(/\s+/).some(w => w.startsWith(ql))) return 40;
    if (title.includes(q) || norm(item.description).includes(q)) return 30;
    if (q.length >= 2 && subsequence(q, title)) return 10;
    return 0;
  };
  return items
    .map((item, i) => ({ item, i, s: score(item) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(x => x.item);
}

export const SlashCommands = Extension.create({
  name: "slashCommands",

  addOptions() {
    return {
      suggestion: {
        char: "/",
        startOfLine: false,
        command: ({ editor, range, props }: { editor: any; range: any; props: any }) => {
          props.command({ editor, range });
        },
        items: ({ query }: { query: string }) => filterSlashCommands(query),
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
