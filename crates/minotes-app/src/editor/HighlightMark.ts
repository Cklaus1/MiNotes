/**
 * TipTap's Highlight mark with a markdown form: `==text==` (Obsidian / Logseq
 * syntax). TipTap's extension has no markdown serializer, so a highlight made
 * with `==hi==`, Ctrl+Shift+H or the toolbar was dropped on save (C-4).
 */
import Highlight from "@tiptap/extension-highlight";

export const HighlightMark = Highlight.extend({
  addStorage() {
    return {
      markdown: {
        serialize: { open: "==", close: "==", mixable: true, expelEnclosingWhitespace: true },
        parse: {
          setup(markdownit: any) {
            if (markdownit.__minotesHighlight) return;
            markdownit.__minotesHighlight = true;
            markdownit.inline.ruler.before("emphasis", "highlight", highlightRule);
          },
        },
      },
    };
  },
});

/**
 * markdown-it inline rule: `==text==` → mark_open, the inner inline content
 * (parsed normally, so `==**b**==` nests), mark_close. The content must not start
 * or end with whitespace (`a == b == c` stays text) and `===` is not an opener.
 */
function highlightRule(state: any, silent: boolean): boolean {
  const start: number = state.pos;
  const src: string = state.src;
  const max: number = state.posMax;
  if (src.charCodeAt(start) !== 0x3d || src.charCodeAt(start + 1) !== 0x3d) return false;
  if (src.charCodeAt(start + 2) === 0x3d) return false;
  const close = src.indexOf("==", start + 2);
  if (close < 0 || close + 2 > max || close === start + 2) return false;
  const inner = src.slice(start + 2, close);
  if (/^\s|\s$/.test(inner)) return false;
  if (!silent) {
    state.push("mark_open", "mark", 1).markup = "==";
    const oldMax = state.posMax;
    state.pos = start + 2;
    state.posMax = close;
    state.md.inline.tokenize(state);
    state.posMax = oldMax;
    state.push("mark_close", "mark", -1).markup = "==";
  }
  state.pos = close + 2;
  return true;
}
