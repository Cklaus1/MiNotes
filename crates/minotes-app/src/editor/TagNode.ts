import { Node, mergeAttributes, InputRule } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

export interface TagNodeOptions {
  onTagClick: (tag: string) => void;
}

export const TagNode = Node.create<TagNodeOptions>({
  name: "tag",
  group: "inline",
  inline: true,
  atom: true,

  addOptions() {
    return {
      onTagClick: () => {},
    };
  },

  addAttributes() {
    return {
      tag: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-tag"),
        renderHTML: (attrs) => ({ "data-tag": attrs.tag }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-tag]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-tag": node.attrs.tag,
        class: "tag-pill",
      }),
      `#${node.attrs.tag}`,
    ];
  },

  addInputRules() {
    return [
      // Match #tag at word boundary — but not ## (heading) or # at line start followed by space
      new InputRule({
        find: /(?:^|[\s(])#([\w][\w-]*)[\s]$/,
        handler: ({ state, range, match }) => {
          const tag = match[1];
          if (!tag) return;
          // Adjust range to only replace the #tag part (not the leading space)
          const fullMatch = match[0];
          const hashIndex = fullMatch.indexOf("#");
          const from = range.from + hashIndex;
          const to = range.to - 1; // exclude the trailing space that triggered the rule
          const node = state.schema.nodes.tag.create({ tag });
          const tr = state.tr.replaceWith(from, to, node);
          // Add the space back after the tag node
          tr.insertText(" ");
          state.apply(tr);
        },
      }),
    ];
  },

  addProseMirrorPlugins() {
    const { onTagClick } = this.options;
    return [
      new Plugin({
        key: new PluginKey("tagClick"),
        props: {
          handleClick(view, pos, event) {
            const target = event.target as HTMLElement;
            if (target.classList.contains("tag-pill")) {
              const tag = target.getAttribute("data-tag");
              if (tag) {
                event.preventDefault();
                onTagClick(tag);
                return true;
              }
            }
            return false;
          },
        },
      }),
    ];
  },
});
