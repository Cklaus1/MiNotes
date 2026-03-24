import { Extension } from "@tiptap/react";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionOptions, type SuggestionProps } from "@tiptap/suggestion";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import { PageLinkMenu } from "./PageLinkMenu";
import { listPages, createPage } from "../lib/api";

export const PageLinkSuggestion = Extension.create({
  name: "pageLinkSuggestion",

  addOptions() {
    return {
      suggestion: {
        char: "[[",
        allowSpaces: true,
        command: async ({ editor, range, props }: { editor: any; range: any; props: any }) => {
          let title = props.title;
          // If the item has no id, it means "create new page"
          if (!props.id && props.title) {
            try {
              const page = await createPage(props.title);
              title = page.title;
            } catch {
              // Fall back to using the typed title even if creation fails
              title = props.title;
            }
          }
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent({
              type: "wikiLink",
              attrs: { pageName: title },
            })
            .run();
        },
        items: async ({ query }: { query: string }) => {
          try {
            const pages = await listPages(100);
            return pages
              .filter((p: any) => p.title.toLowerCase().includes(query.toLowerCase()))
              .slice(0, 8)
              .map((p: any) => ({ id: p.id, title: p.title }));
          } catch {
            return [];
          }
        },
        render: () => {
          let reactRenderer: ReactRenderer;
          let popup: TippyInstance[];

          return {
            onStart: (props: SuggestionProps) => {
              reactRenderer = new ReactRenderer(PageLinkMenu, {
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
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});
