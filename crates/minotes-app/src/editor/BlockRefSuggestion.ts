import { Extension } from "@tiptap/react";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionOptions, type SuggestionProps } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import { BlockRefMenu } from "./BlockRefMenu";
import { getBlocks, search } from "../lib/api";
import { primeBlockRef, refLabel } from "../lib/blockRefs";

/** Exported so the editor can tell whether this menu is open (e.g. Escape closes it). */
export const blockRefPluginKey = new PluginKey("blockRefSuggestion");

export const BlockRefSuggestion = Extension.create({
  name: "blockRefSuggestion",

  addOptions() {
    return {
      suggestion: {
        char: "((",
        allowSpaces: true,
        // A finished reference "((id))" (e.g. the caret placed at the end of a block
        // that ends with one) is not a query: don't pop the menu up over it.
        allow: ({ state, range }: { state: any; range: { from: number; to: number } }) =>
          !state.doc.textBetween(range.from, range.to, " ", " ").includes("))"),
        command: ({ editor, range, props }: { editor: any; range: any; props: any }) => {
          // The chip shows the block's text (lib/blockRefs); we already know it.
          if (props.pageTitle !== undefined) {
            primeBlockRef({ id: props.id, content: props.content ?? "", pageTitle: props.pageTitle, pageId: props.pageId ?? "" });
          }
          const contentPreview = refLabel(props.content ?? "");
          // The slash menu's "Embed block" opened this picker: insert an embed.
          const embed = !!(editor.storage as any).blockRefEmbed;
          (editor.storage as any).blockRefEmbed = false;

          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent({
              type: "blockRef",
              attrs: {
                blockId: props.id,
                content: contentPreview,
                embed,
              },
            })
            .run();
        },
        items: async ({ query }: { query: string }) => {
          if (!query || query.length < 1) return [];
          try {
            const blocks = await search(query, 10);
            // Which page each block is on (one call for all of them).
            const pages = new Map<string, { title: string; pageId: string }>();
            try {
              for (const b of await getBlocks(blocks.map((b: any) => b.id))) pages.set(b.id, { title: b.page_title, pageId: b.page_id });
            } catch {}
            return blocks.map((b: any) => ({
              id: b.id,
              content: b.content,
              pageTitle: pages.get(b.id)?.title,
              pageId: pages.get(b.id)?.pageId ?? b.page_id,
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

            onExit(props: SuggestionProps) {
              // Closed without picking: the next (( is a plain reference again.
              (props?.editor?.storage as any) && ((props.editor.storage as any).blockRefEmbed = false);
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
        pluginKey: blockRefPluginKey,
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});
