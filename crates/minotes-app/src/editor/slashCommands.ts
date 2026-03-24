import { Extension } from "@tiptap/react";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionOptions, type SuggestionProps } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import { SlashMenu, type SlashMenuItem } from "./SlashMenu";

const COMMANDS: SlashMenuItem[] = [
  {
    title: "Heading 1",
    description: "Large heading",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).run();
      // Small delay to let the deletion settle, then apply heading
      setTimeout(() => {
        editor.chain().focus().setHeading({ level: 1 }).run();
      }, 10);
    },
  },
  {
    title: "Heading 2",
    description: "Medium heading",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).run();
      setTimeout(() => {
        editor.chain().focus().setHeading({ level: 2 }).run();
      }, 10);
    },
  },
  {
    title: "Heading 3",
    description: "Small heading",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).run();
      setTimeout(() => {
        editor.chain().focus().setHeading({ level: 3 }).run();
      }, 10);
    },
  },
  {
    title: "Bullet List",
    description: "Start a list",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).run();
      setTimeout(() => {
        editor.chain().focus().toggleBulletList().run();
      }, 10);
    },
  },
  {
    title: "Task List",
    description: "Checklist",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).run();
      setTimeout(() => {
        editor.chain().focus().toggleTaskList().run();
      }, 10);
    },
  },
  {
    title: "Code Block",
    description: "Code snippet",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).run();
      setTimeout(() => {
        editor.chain().focus().toggleCodeBlock().run();
      }, 10);
    },
  },
  {
    title: "Blockquote",
    description: "Quote",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).run();
      setTimeout(() => {
        editor.chain().focus().toggleBlockquote().run();
      }, 10);
    },
  },
  {
    title: "Divider",
    description: "Horizontal line",
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).run();
      setTimeout(() => {
        editor.chain().focus().setHorizontalRule().run();
      }, 10);
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
          return COMMANDS.filter((item) =>
            item.title.toLowerCase().includes(query.toLowerCase())
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
