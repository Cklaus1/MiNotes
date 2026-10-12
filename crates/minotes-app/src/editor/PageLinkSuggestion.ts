import { Extension } from "@tiptap/react";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionOptions, type SuggestionProps } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import { PageLinkMenu } from "./PageLinkMenu";
import { listPages, createPage, listNotebooks, getCurrentNotebook, listNotebookPages } from "../lib/api";
import { splitNotebookLink, NOTEBOOK_SEP } from "../lib/crossNotebook";

/** Exported so the editor can tell whether this menu is open (e.g. Escape closes it). */
export const pageLinkPluginKey = new PluginKey("pageLinkSuggestion");

export const PageLinkSuggestion = Extension.create({
  name: "pageLinkSuggestion",

  addOptions() {
    return {
      suggestion: {
        char: "[[",
        allowSpaces: true,
        // A finished "[[Page]]" is not a query: don't pop the menu up over it.
        allow: ({ state, range }: { state: any; range: { from: number; to: number } }) =>
          !state.doc.textBetween(range.from, range.to, " ", " ").includes("]]"),
        command: async ({ editor, range, props }: { editor: any; range: any; props: any }) => {
          // A notebook: type `[[Work::` and keep suggesting — its pages now.
          if (props.kind === "notebook") {
            editor.chain().focus().deleteRange(range).insertContent(`[[${props.title}${NOTEBOOK_SEP}`).run();
            return;
          }
          // A page in another notebook (picked, or typed `Work::Title` + Enter):
          // a cross-notebook link. Never creates a page, here or there.
          const xnb = props.kind === "xpage"
            ? { notebook: props.notebook, page: props.title }
            : (!props.id && props.title ? splitNotebookLink(props.title) : null);
          if (xnb) {
            editor.chain().focus().deleteRange(range)
              .insertContent({ type: "wikiLink", attrs: { pageName: xnb.page, notebook: xnb.notebook } })
              .run();
            return;
          }
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
          // `[[Work::…` — pages of notebook Work (read from it, read-only).
          const sep = query.indexOf(NOTEBOOK_SEP);
          if (sep >= 0) {
            const nb = query.slice(0, sep).trim();
            if (!nb) return [];
            try {
              const r = await listNotebookPages(nb, query.slice(sep + NOTEBOOK_SEP.length).trim(), 8);
              return r.pages.map((p) => ({ id: `${r.notebook_key}:${p.id}`, title: p.title, notebook: r.notebook_name, kind: "xpage" }));
            } catch {
              return [];
            }
          }
          try {
            const [pages, notebooks, current] = await Promise.all([
              listPages(100),
              listNotebooks().catch(() => []),
              getCurrentNotebook().catch(() => ""),
            ]);
            const q = query.toLowerCase();
            const local = pages
              .filter((p: any) => p.title.toLowerCase().includes(q))
              .slice(0, 8)
              .map((p: any) => ({ id: p.id, title: p.title }));
            // Other notebooks, offered as `Name::` (after the local pages, so
            // Enter still picks the best page).
            const nbs = notebooks
              .filter((n) => n.key !== current && n.available && n.name.toLowerCase().includes(q))
              .slice(0, 3)
              .map((n) => ({ id: `notebook:${n.key}`, title: n.name, kind: "notebook" }));
            return [...local, ...nbs];
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
        pluginKey: pageLinkPluginKey,
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});
