import { Node, mergeAttributes, InputRule } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { hydrateBlockRefs } from "../lib/blockRefs";

/**
 * `((uuid))` — a block reference: one inline chip showing the referenced
 * block's text (lib/blockRefs.ts keeps it current).
 * `{{embed ((uuid))}}` — a block embed: a small "Embedded block" chip in the
 * text, and BlockItem shows the referenced block as a card under the block.
 * Only the uuid is stored; the chip text is never part of the markdown.
 */

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
      // A label known at insert time (the (( picker); never parsed from text —
      // markdown only carries the uuid, so a parsed chip's text is the uuid.
      content: {
        default: "",
        parseHTML: () => "",
        renderHTML: () => ({}),
      },
      embed: {
        default: false,
        parseHTML: (el) => el.hasAttribute("data-embed"),
        renderHTML: (attrs) => (attrs.embed ? { "data-embed": "" } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-block-ref]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    if (node.attrs.embed) {
      return [
        "span",
        mergeAttributes(HTMLAttributes, { "data-block-ref": "", class: "block-ref block-embed-chip" }),
        "Embedded block",
      ];
    }
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-block-ref": "",
        class: "block-ref",
      }),
      // Filled with the referenced text by lib/blockRefs (hydrateBlockRefs).
      node.attrs.content || "…",
    ];
  },

  // The chip's text is set from outside ProseMirror (lib/blockRefs), so the
  // view must not treat that as an edit to reconcile.
  addNodeView() {
    return ({ node, HTMLAttributes }) => {
      const dom = document.createElement("span");
      const attrs = mergeAttributes(HTMLAttributes, {
        "data-block-ref": "",
        class: node.attrs.embed ? "block-ref block-embed-chip" : "block-ref",
      });
      for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined && v !== false) dom.setAttribute(k, String(v));
      dom.textContent = node.attrs.embed ? "Embedded block" : (node.attrs.content || "…");
      dom.contentEditable = "false";
      if (!node.attrs.embed) queueMicrotask(() => { if (dom.isConnected) hydrateBlockRefs(dom.parentElement ?? dom); });
      return { dom, ignoreMutation: () => true };
    };
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
          state.write(node.attrs.embed ? `{{embed ((${node.attrs.blockId}))}}` : `((${node.attrs.blockId}))`);
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
            // {{embed ((uuid))}}: a block embed (checked before the plain ref).
            markdownit.inline.ruler.after(
              "wiki_link",
              "block_embed",
              (state: any, silent: boolean) => {
                const m = /^\{\{embed \(\(([0-9a-fA-F-]{8,36})\)\)\}\}/.exec(state.src.slice(state.pos, state.pos + 60));
                if (!m) return false;
                if (!silent) {
                  const token = state.push("block_ref", "", 0);
                  token.content = m[1];
                  token.meta = { embed: true };
                  token.markup = m[0];
                }
                state.pos += m[0].length;
                return true;
              }
            );
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
              const embed = tokens[idx].meta?.embed ? " data-embed" : "";
              return `<span data-block-ref${embed} data-block-id="${escaped}" class="block-ref">${escaped}</span>`;
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
