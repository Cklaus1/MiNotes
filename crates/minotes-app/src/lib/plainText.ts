/**
 * A block's stored markdown as one line of plain text, for lists that show
 * blocks out of context (search results, the Tasks view): links show their
 * title, macros and ids disappear, formatting marks go. Not a renderer — just
 * readable text.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export interface PlainBlock {
  /** TODO / DOING / DONE marker at the start of the first line, if any. */
  state: "TODO" | "DOING" | "DONE" | null;
  text: string;
}

export function blockPlainText(content: string): PlainBlock {
  let s = content.replace(/^﻿/, "");
  let state: PlainBlock["state"] = null;
  const m = /^\s*(TODO|DOING|DONE) /.exec(s);
  if (m) {
    state = m[1] as PlainBlock["state"];
    s = s.slice(m[0].length);
  }
  s = s
    // ```fences``` → their content
    .replace(/```[^\n]*\n?/g, "")
    // {{whiteboard:id}} → Whiteboard; every other {{macro}} goes
    .replace(/\{\{whiteboard:[^}]*\}\}/gi, "Whiteboard")
    .replace(/\{\{[^}]*\}\}/g, "")
    // ((block ref)) → gone (an id means nothing out of context)
    .replace(new RegExp(`\\(\\(${UUID}\\)\\)`, "gi"), "")
    // ![alt](src) → alt; [text](url) → text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt) => alt || "image")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    // [[Notebook::Page|id]] / [[Page|alias-or-id]] / [[Page]] → Page
    .replace(/\[\[([^\]]+?)\]\]/g, (_m, inner: string) => {
      let t = inner;
      const bar = t.lastIndexOf("|");
      if (bar >= 0) {
        const after = t.slice(bar + 1).trim();
        // [[Title|<uuid>]] keeps the title; [[Title|label]] shows the label.
        t = new RegExp(`^${UUID}$`, "i").test(after) ? t.slice(0, bar) : after;
      }
      const nb = t.indexOf("::");
      return (nb >= 0 ? t.slice(nb + 2) : t).trim();
    })
    // line starts: headings, quotes, list markers, task boxes
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    // emphasis marks
    .replace(/(\*\*|__|~~|==)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, "$1$2")
    .replace(/`([^`]*)`/g, "$1")
    // html tags, stray ids
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(new RegExp(UUID, "gi"), "")
    .replace(/\s+/g, " ")
    .trim();
  return { state, text: s };
}
