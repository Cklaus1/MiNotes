import { Extension } from "@tiptap/react";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionOptions, type SuggestionProps } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import { BlockRefMenu } from "./BlockRefMenu";
import { search } from "../lib/api";

export const BlockRefSuggestion = Extension.create({
  name: "blockRefSuggestion",

  addOptions() {
    return {
      suggestion: {
        char: "((",
        allowSpaces: true,
        command: ({ editor, range, props }: { editor: any; range: any; props: any }) => {
          const contentPreview = props.content
            ? props.content.length > 40
              ? props.content.slice(0, 40) + "..."
              : props.content
            : props.id.slice(0, 8) + "...";

          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent({
              type: "blockRef",
              attrs: {
                blockId: props.id,
                content: contentPreview,
              },
            })
            .run();
        },
        items: async ({ query }: { query: string }) => {
          if (!query || query.length < 1) return [];
          try {
            const blocks = await search(query, 10);
            return blocks.map((b: any) => ({
              id: b.id,
              content: b.content,
              pageTitle: b.page_id ? undefined : undefined,
            }));
          } catch {
            return [];
          }
        },
        render: () => {
          let reactRenderer: ReactRenderer;
          let popup: TippyInstance[];

          return {
            onStart: (props: SuggestionProps) => {
              reactRenderer = new ReactRenderer(BlockRefMenu, {
                props: { ...props, query: props.query },
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
              reactRenderer?.updateProps({ ...props, query: props.query });

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
        pluginKey: new PluginKey("blockRefSuggestion"),
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});
