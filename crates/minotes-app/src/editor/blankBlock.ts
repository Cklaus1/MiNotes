/**
 * Document-style indent model (Evernote / Google Docs): Enter on an EMPTY nested
 * block outdents it instead of adding another empty line. "Empty" is no text at
 * all, or only a marker the user would delete anyway: a list bullet / number, a
 * task checkbox (`- [ ]`, also as the escaped `- \[ \]` an empty task item
 * serializes to) or a TODO / DOING / DONE keyword (lib/tasks.ts markers).
 */

import type { Node as PMNode } from "@tiptap/pm/model";

const LIST_MARKER = /^(?:[-*+]|\d+[.)])(?=\s|$)\s*/;
const CHECKBOX = /^\[[ xX]?\](?=\s|$)\s*/;
const TASK_KEYWORD = /^(?:TODO|DOING|DONE)$/;

/** Top-level nodes an "empty" block may consist of (an empty code block, table or quote is content). */
const BLANK_CONTAINERS = new Set(["paragraph", "heading", "bulletList", "orderedList", "taskList"]);

/**
 * The same test on the editor's document (read from the view's state in the key
 * handler — a block created by the previous Enter may not have its editor
 * instance wired yet). Any atom (a link chip, tag, image, embed) is content.
 */
export function isBlankDoc(doc: PMNode): boolean {
  let containersOk = true;
  doc.forEach((n) => { if (!BLANK_CONTAINERS.has(n.type.name)) containersOk = false; });
  if (!containersOk) return false;
  let atom = false;
  doc.descendants((n) => {
    if (n.isLeaf && !n.isText && n.type.name !== "hardBreak") atom = true;
    return !atom;
  });
  return !atom && isBlankBlock(doc.textBetween(0, doc.content.size, "\n"));
}

/** True when the block's markdown has no content beyond an optional list/task marker. */
export function isBlankBlock(markdown: string): boolean {
  let s = markdown.replace(/\\([[\]])/g, "$1").trim();
  s = s.replace(LIST_MARKER, "");
  s = s.replace(CHECKBOX, "");
  return s === "" || TASK_KEYWORD.test(s);
}
