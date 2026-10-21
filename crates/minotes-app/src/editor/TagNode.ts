import { Node, mergeAttributes, InputRule } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { TAG_NAME, isHexColorTag } from "../lib/tagExtractor";

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
      // `#tag` followed by a space (or other whitespace) becomes a tag chip. Only at
      // the start of the block or after whitespace (not `a#b`, `page.html#x`), never
      // `# ` (a heading) or `#123` / `#f0f0f0`.
      new InputRule({
        find: new RegExp(`(?:^|\\s)#(${TAG_NAME})(\\s)$`),
        handler: ({ state, range, match }) => {
          const tag = match[1];
          if (!tag || isHexColorTag(tag)) return null;
          // The match starts at the leading space (if any) and ends at the cursor:
          // the whitespace that triggered the rule is being typed and is not in the
          // doc yet. Replace `#tag` (all of it) and type that whitespace after it.
          const from = range.from + match[0].indexOf("#");
          state.tr.replaceWith(from, range.to, state.schema.nodes.tag.create({ tag })).insertText(match[2]);
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

  // Stored as plain `#tag` text; parsed back into a tag chip (same grammar as
  // lib/tagExtractor). Without this the serializer wrote `[tag]` (C-3).
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          state.write(`#${node.attrs.tag}`);
        },
        parse: {
          setup(markdownit: any) {
            if (markdownit.__minotesTag) return;
            markdownit.__minotesTag = true;
            markdownit.inline.ruler.before("emphasis", "hashtag", hashtagRule);
            markdownit.renderer.rules.hashtag = (tokens: any, idx: number) => {
              const t = escapeHtml(tokens[idx].content);
              return `<span data-tag="${t}" class="tag-pill">#${t}</span>`;
            };
          },
        },
      },
    };
  },
});

const TAG_AT = new RegExp(`^#(${TAG_NAME})`);

function escapeHtml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** markdown-it inline rule: `#tag` at the start or after whitespace → a `hashtag` token. */
function hashtagRule(state: any, silent: boolean): boolean {
  const pos: number = state.pos;
  if (state.src.charCodeAt(pos) !== 0x23 /* # */) return false;
  if (pos > 0 && !/\s/.test(state.src[pos - 1])) return false;
  const m = TAG_AT.exec(state.src.slice(pos, state.posMax));
  if (!m || isHexColorTag(m[1])) return false;
  if (!silent) {
    const token = state.push("hashtag", "", 0);
    token.content = m[1];
    token.markup = m[0];
  }
  state.pos = pos + m[0].length;
  return true;
}
