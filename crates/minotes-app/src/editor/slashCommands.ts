import { Extension } from "@tiptap/react";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionOptions, type SuggestionProps } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import { SlashMenu, type SlashMenuItem } from "./SlashMenu";

/*
 * Slash commands use two strategies:
 * 1. Markdown-based (headings): save "# text" via onSlashCommand callback
 * 2. Editor-based (lists, hr): use TipTap API then save the resulting markdown
 *
 * For strategy 2, we use the editor directly then call onSlashSave
 * to persist whatever the editor now contains.
 */

let slashCommandCallback: ((markdown: string) => void) | null = null;
let slashSaveCallback: (() => void) | null = null;

export function setSlashCommandCallback(cb: (markdown: string) => void) {
  slashCommandCallback = cb;
}

export function setSlashSaveCallback(cb: () => void) {
  slashSaveCallback = cb;
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
    command: ({ editor, range }) => {
      const text = getTextBeforeSlash(editor, range);
      slashCommandCallback?.(`# ${text}`);
    },
  },
  {
    title: "Heading 2",
    description: "medium heading",
    command: ({ editor, range }) => {
      const text = getTextBeforeSlash(editor, range);
      slashCommandCallback?.(`## ${text}`);
    },
  },
  {
    title: "Heading 3",
    description: "small heading",
    command: ({ editor, range }) => {
      const text = getTextBeforeSlash(editor, range);
      slashCommandCallback?.(`### ${text}`);
    },
  },
  {
    title: "Bullet List",
    description: "list bullet unordered",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleBulletList().run();
      slashSaveCallback?.();
    },
  },
  {
    title: "Todo List",
    description: "task checkbox todo",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleTaskList().run();
      slashSaveCallback?.();
    },
  },
  {
    title: "Code Block",
    description: "code snippet",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run();
      slashSaveCallback?.();
    },
  },
  {
    title: "Quote",
    description: "blockquote",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleBlockquote().run();
      slashSaveCallback?.();
    },
  },
  {
    title: "Divider",
    description: "horizontal line separator",
    command: ({ editor, range }) => {
      slashCommandCallback?.("---");
    },
  },
];

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
        items: ({ query }: { query: string }) => {
          const q = query.toLowerCase();
          return COMMANDS.filter((item) =>
            item.title.toLowerCase().includes(q) ||
            item.description.toLowerCase().includes(q)
          );
        },
        render: () => {
          let reactRenderer: ReactRenderer;
          let popup: TippyInstance[];

          return {
            onStart: (props: SuggestionProps) => {
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
              reactRenderer?.updateProps(props);

              if (!props.clientRect) return;

              popup?.[0]?.setProps({
                getReferenceClientRect: props.clientRect as () => DOMRect,
              });
            },

            onKeyDown(props: { event: KeyboardEvent }) {
              if (props.event.key === "Escape") {
                popup?.[0]?.hide();
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
        pluginKey: new PluginKey("slashCommands"),
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});
