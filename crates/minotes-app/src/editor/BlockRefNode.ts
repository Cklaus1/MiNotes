import { Node, mergeAttributes, InputRule } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

export interface BlockRefOptions {
  onBlockRefClick: (blockId: string) => void;
}

export const BlockRefNode = Node.create<BlockRefOptions>({
  name: "blockRef",
  group: "inline",
  inline: true,
  atom: true,

  addOptions() {
    return {
      onBlockRefClick: () => {},
    };
  },

  addAttributes() {
    return {
      blockId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-block-id"),
        renderHTML: (attrs) => ({ "data-block-id": attrs.blockId }),
      },
      content: {
        default: "",
        parseHTML: (el) => el.textContent ?? "",
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-block-ref]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-block-ref": "",
        class: "block-ref",
      }),
      node.attrs.content || node.attrs.blockId,
    ];
  },

  addInputRules() {
    return [
      new InputRule({
        find: /\(\(([0-9a-fA-F-]{36})\)\)$/,
        handler: ({ state, range, match }) => {
          const blockId = match[1];
          const node = state.schema.nodes.blockRef.create({
            blockId,
            content: blockId.slice(0, 8) + "...",
          });
          state.tr.replaceWith(range.from, range.to, node);
        },
      }),
    ];
  },

  addProseMirrorPlugins() {
    const onBlockRefClick = this.options.onBlockRefClick;
    return [
      new Plugin({
        key: new PluginKey("blockRefClick"),
        props: {
          handleClick(view, pos, event) {
            const target = event.target as HTMLElement;
            if (
              target.classList.contains("block-ref") ||
              target.closest(".block-ref")
            ) {
              const el = target.classList.contains("block-ref")
                ? target
                : (target.closest(".block-ref") as HTMLElement);
              const blockId = el?.getAttribute("data-block-id");
              if (blockId) {
                event.preventDefault();
                event.stopPropagation();
                onBlockRefClick(blockId);
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
          state.write(`((${node.attrs.blockId}))`);
        },
        parse: {
          setup(markdownit: any) {
            // markdown-it's `text` rule swallows everything up to its next
            // terminator character, and `(` isn't one: the block_ref rule below
            // never saw the `((` of "see ((uuid))", so block refs came back as
            // raw text after every reload (C-12). Stop plain text at `(` too.
            if (!markdownit.__minotesParenText) {
              markdownit.__minotesParenText = true;
              markdownit.inline.ruler.at("text", textUntilParen);
            }
            // Add block_ref inline rule
            markdownit.inline.ruler.after(
              "wiki_link",
              "block_ref",
              (state: any, silent: boolean) => {
                const src = state.src;
                const pos = state.pos;

                // Must start with ((
                if (
                  src.charCodeAt(pos) !== 0x28 ||
                  src.charCodeAt(pos + 1) !== 0x28
                ) {
                  return false;
                }

                // Find closing ))
                const closePos = src.indexOf("))", pos + 2);
                if (closePos === -1) return false;

                const blockId = src.slice(pos + 2, closePos);
                // Validate UUID format (loose check)
                if (!blockId || blockId.length < 8 || blockId.includes("(") || blockId.includes(")")) {
                  return false;
                }

                if (!silent) {
                  const token = state.push("block_ref", "", 0);
                  token.content = blockId;
                  token.markup = `((${blockId}))`;
                }

                state.pos = closePos + 2;
                return true;
              }
            );

            // Renderer for block_ref tokens
            markdownit.renderer.rules.block_ref = (
              tokens: any,
              idx: number
            ) => {
              const blockId = tokens[idx].content;
              const escaped = blockId
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;");
              return `<span data-block-ref data-block-id="${escaped}" class="block-ref">${escaped}</span>`;
            };
          },
        },
      },
    };
  },
});

/** markdown-it's `text` rule with `(` added to its terminator characters. */
const TERMINATORS = new Set("\n!#$%&*+-:<=>@[\\]^_`{}~(".split("").map((c) => c.charCodeAt(0)));
function textUntilParen(state: any, silent: boolean): boolean {
  let pos: number = state.pos;
  while (pos < state.posMax && !TERMINATORS.has(state.src.charCodeAt(pos))) pos++;
  if (pos === state.pos) return false;
  if (!silent) state.pending += state.src.slice(state.pos, pos);
  state.pos = pos;
  return true;
}
