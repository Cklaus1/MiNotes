/**
 * markdown-it plugin that tokenizes [[Page Name]] into wiki_link tokens.
 * Used by tiptap-markdown to parse wiki links from raw markdown into
 * the WikiLink ProseMirror node.
 */
export default function markdownItWikiLink(md: any) {
  md.inline.ruler.after("link", "wiki_link", (state: any, silent: boolean) => {
    const src = state.src;
    const pos = state.pos;

    // Must start with [[
    if (src.charCodeAt(pos) !== 0x5B || src.charCodeAt(pos + 1) !== 0x5B) {
      return false;
    }

    // Find closing ]]
    const closePos = src.indexOf("]]", pos + 2);
    if (closePos === -1) return false;

    const pageName = src.slice(pos + 2, closePos);
    if (!pageName || pageName.includes("[") || pageName.includes("]")) {
      return false;
    }

    if (!silent) {
      const token = state.push("wiki_link", "", 0);
      token.content = pageName;
      token.markup = `[[${pageName}]]`;
    }

    state.pos = closePos + 2;
    return true;
  });
}
