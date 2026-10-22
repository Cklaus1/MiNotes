/**
 * Callouts — `> [!note] text` (Obsidian's syntax; GitHub's alerts look the same),
 * so a callout stays a callout in the markdown copy, in git sync and in Obsidian.
 * A blockquote whose first line starts with `[!type]` parses as this node; it
 * serializes back as the same `> [!type] …` lines.
 *
 * Kinds: note / info, tip / hint / success, warning / caution / important / danger.
 * Any other `[!word]` keeps its word and is drawn as a note.
 */
import { Node, InputRule, mergeAttributes } from "@tiptap/core";

export type CalloutKind = "note" | "tip" | "warning";

/** How a `[!type]` is drawn. */
export function calloutKind(type: string): CalloutKind {
  const t = type.toLowerCase();
  if (["tip", "hint", "success", "check", "done"].includes(t)) return "tip";
  if (["warning", "caution", "attention", "important", "danger", "error", "bug"].includes(t)) return "warning";
  return "note";
}

/** The label above a callout ("Note", "Warning", or the type as written). */
export function calloutLabel(type: string): string {
  const t = type.toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const PREFIX = /^\[!([A-Za-z][\w-]*)\][+-]?[ \t]*\n?/;

/** markdown-it core rule: `> [!type] …` → `<div data-callout="type">…</div>`. */
function calloutRule(state: any) {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i];
    if (open.type !== "blockquote_open" || open.meta?.callout) continue;
    const para = tokens[i + 1];
    const inline = tokens[i + 2];
    if (para?.type !== "paragraph_open" || inline?.type !== "inline") continue;
    const m = PREFIX.exec(inline.content);
    if (!m) continue;
    let depth = 0;
    let j = i;
    for (; j < tokens.length; j++) {
      if (tokens[j].type === "blockquote_open") depth++;
      else if (tokens[j].type === "blockquote_close" && --depth === 0) break;
    }
    if (j >= tokens.length) continue;
    open.tag = "div";
    open.meta = { ...(open.meta ?? {}), callout: true };
    open.attrSet("data-callout", m[1].toLowerCase());
    tokens[j].tag = "div";
    inline.content = inline.content.slice(m[0].length);
  }
}

export const CalloutNode = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      type: {
        default: "note",
        parseHTML: (el: HTMLElement) => el.getAttribute("data-callout") || "note",
        renderHTML: (attrs: { type?: string }) => ({ "data-callout": attrs.type || "note" }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-callout]", priority: 60 }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const type: string = node.attrs.type || "note";
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        class: `callout callout-${calloutKind(type)}`,
        "data-callout-label": calloutLabel(type),
      }),
      0,
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          state.wrapBlock("> ", `> [!${node.attrs.type || "note"}] `, node, () => state.renderContent(node));
        },
        parse: {
          setup(markdownit: any) {
            if (markdownit.__minotesCallout) return;
            markdownit.__minotesCallout = true;
            markdownit.core.ruler.after("block", "minotes_callout", calloutRule);
          },
        },
      },
    };
  },

  addInputRules() {
    // `[!note] ` typed at the start of a quote turns the quote into a callout.
    return [
      new InputRule({
        find: /^\[!([A-Za-z][\w-]*)\]\s$/,
        handler: ({ state, range, match }) => {
          const $from = state.doc.resolve(range.from);
          const d = $from.depth;
          if (d < 2 || $from.node(d - 1).type.name !== "blockquote" || $from.index(d - 1) !== 0) return null;
          const { tr } = state;
          tr.delete(range.from, range.to);
          tr.setNodeMarkup($from.before(d - 1), this.type, { type: match[1].toLowerCase() });
        },
      }),
    ];
  },
});
