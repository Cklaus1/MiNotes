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

    const raw = src.slice(pos + 2, closePos);
    if (!raw || raw.includes("[") || raw.includes("]")) {
      return false;
    }

    // Support [[title|id]] format — split on first "|" to extract display title and page ID
    const pipeIdx = raw.indexOf("|");
    const pageName = pipeIdx >= 0 ? raw.slice(0, pipeIdx) : raw;
    if (!pageName) {
      return false;
    }

    if (!silent) {
      const token = state.push("wiki_link", "", 0);
      token.content = pageName;
      token.attrs = pipeIdx >= 0 ? [{ name: "data-page-id", value: raw.slice(pipeIdx + 1) }] : undefined;
      token.markup = `[[${raw}]]`;
    }

    state.pos = closePos + 2;
    return true;
  });
}
