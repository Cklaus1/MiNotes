import { Node, mergeAttributes, InputRule } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import markdownItWikiLink from "./markdownItWikiLink";
import {
  splitNotebookLink, notebookLinkLabel, hydrateNotebookLinks, followNotebookLinkElement, NOTEBOOK_SEP,
} from "../lib/crossNotebook";

export interface WikiLinkOptions {
  onPageLinkClick: (pageName: string, shiftKey?: boolean) => void;
}

export const WikiLinkNode = Node.create<WikiLinkOptions>({
  name: "wikiLink",
  group: "inline",
  inline: true,
  atom: true,

  addOptions() {
    return {
      onPageLinkClick: () => {},
    };
  },

  addAttributes() {
    return {
      pageName: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-page-name"),
        renderHTML: (attrs) => ({ "data-page-name": attrs.pageName }),
      },
      pageId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-page-id"),
        renderHTML: (attrs) => ({ "data-page-id": attrs.pageId }),
      },
      // `[[Notebook::Page]]`: a page in another notebook (lib/crossNotebook.ts).
      notebook: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-notebook"),
        renderHTML: (attrs) => (attrs.notebook ? { "data-notebook": attrs.notebook } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-wiki-link]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    if (node.attrs.notebook) {
      return [
        "span",
        mergeAttributes(HTMLAttributes, { "data-wiki-link": "", class: "xnb-link" }),
        notebookLinkLabel(node.attrs.notebook, node.attrs.pageName),
      ];
    }
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-wiki-link": "",
        class: "wiki-link",
      }),
      node.attrs.pageName,
    ];
  },

  addInputRules() {
    return [
      new InputRule({
        find: /\[\[([^\]]+)\]\]$/,
        handler: ({ state, range, match, chain }) => {
          const pageName = match[1];
          const xnb = splitNotebookLink(pageName.split("|")[0]);
          const node = state.schema.nodes.wikiLink.create(
            xnb ? { pageName: xnb.page, notebook: xnb.notebook } : { pageName },
          );
          state.tr.replaceWith(range.from, range.to, node);
        },
      }),
    ];
  },

  addProseMirrorPlugins() {
    const onPageLinkClick = this.options.onPageLinkClick;
    return [
      new Plugin({
        key: new PluginKey("wikiLinkClick"),
        props: {
          handleDOMEvents: {
            // Cross-notebook chips act on the DOM click (one per click, real or
            // synthetic), not ProseMirror's mousedown/up-derived handleClick.
            click(_view, event) {
              const xnb = (event.target as HTMLElement).closest?.(".xnb-link") as HTMLElement | null;
              if (!xnb) return false;
              event.preventDefault();
              event.stopPropagation();
              followNotebookLinkElement(xnb);
              return true;
            },
          },
          handleClick(view, pos, event) {
            const target = event.target as HTMLElement;
            if (target.closest?.(".xnb-link")) return true;
            if (target.classList.contains("wiki-link") || target.closest(".wiki-link")) {
              const el = target.classList.contains("wiki-link") ? target : target.closest(".wiki-link") as HTMLElement;
              const pageId = el?.getAttribute("data-page-id");
              const pageName = pageId ? pageId : (el?.getAttribute("data-page-name") || el?.textContent);
              if (pageName) {
                event.preventDefault();
                event.stopPropagation();
                onPageLinkClick(pageName, event.shiftKey);
                return true;
              }
            }
            return false;
          },
        },
      }),
      // Resolve cross-notebook chips in the live editor (the static render is
      // hydrated by BlockItem). A leaf node's DOM text is not document content,
      // so updating it doesn't disturb ProseMirror.
      new Plugin({
        key: new PluginKey("notebookLinkHydrate"),
        view(view) {
          const run = () => { if (view.dom.isConnected) hydrateNotebookLinks(view.dom); };
          const t = setTimeout(run, 0);
          return { update: run, destroy: () => clearTimeout(t) };
        },
      }),
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          const pageName = node.attrs.pageName;
          const pageId = node.attrs.pageId;
          const target = node.attrs.notebook ? `${node.attrs.notebook}${NOTEBOOK_SEP}${pageName}` : pageName;
          state.write(pageId ? `[[${target}|${pageId}]]` : `[[${target}]]`);
        },
        parse: {
          setup(markdownit: any) {
            markdownItWikiLink(markdownit);
            // Add renderer rule to convert wiki_link tokens to HTML
            markdownit.renderer.rules.wiki_link = (tokens: any, idx: number) => {
              const pageName = tokens[idx].content;
              const pageId = tokens[idx].attrs?.find((a: any) => a.name === "data-page-id")?.value;
              const esc = (v: string) => String(v)
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#39;");
              const escaped = esc(pageName);
              const xnb = splitNotebookLink(pageName);
              if (xnb) {
                const id = pageId ? ` data-page-id="${esc(pageId)}"` : "";
                return `<span data-wiki-link data-notebook="${esc(xnb.notebook)}" data-page-name="${esc(xnb.page)}"${id} class="xnb-link">${esc(notebookLinkLabel(xnb.notebook, xnb.page))}</span>`;
              }
              if (pageId) {
                // pageId comes from user-editable markdown ([[Name|id]]): escape it too.
                return `<span data-wiki-link data-page-name="${escaped}" data-page-id="${esc(pageId)}" class="wiki-link">${escaped}</span>`;
              }
              return `<span data-wiki-link data-page-name="${escaped}" class="wiki-link">${escaped}</span>`;
            };
          },
        },
      },
    };
  },
});
