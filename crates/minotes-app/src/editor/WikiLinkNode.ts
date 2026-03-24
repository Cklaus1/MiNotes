import { Node, mergeAttributes, InputRule } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import markdownItWikiLink from "./markdownItWikiLink";

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
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-wiki-link]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
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
          const node = state.schema.nodes.wikiLink.create({ pageName });
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
          handleClick(view, pos, event) {
            const target = event.target as HTMLElement;
            if (target.classList.contains("wiki-link") || target.closest(".wiki-link")) {
              const el = target.classList.contains("wiki-link") ? target : target.closest(".wiki-link") as HTMLElement;
              const pageName = el?.getAttribute("data-page-name") || el?.textContent;
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
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          state.write(`[[${node.attrs.pageName}]]`);
        },
        parse: {
          setup(markdownit: any) {
            markdownItWikiLink(markdownit);
            // Add renderer rule to convert wiki_link tokens to HTML
            markdownit.renderer.rules.wiki_link = (tokens: any, idx: number) => {
              const pageName = tokens[idx].content;
              const escaped = pageName
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;");
              return `<span data-wiki-link data-page-name="${escaped}" class="wiki-link">${escaped}</span>`;
            };
          },
        },
      },
    };
  },
});
