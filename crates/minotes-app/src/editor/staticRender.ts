/**
 * Static rendering of a block's markdown — the exact DOM its TipTap editor would
 * show, without an editor per block.
 *
 * One hidden "renderer" editor (same extensions as a live block editor, never in
 * the document) parses the markdown and lets ProseMirror render it, node views
 * and decorations included (task checkboxes, table wrappers, code highlighting,
 * placeholder classes, trailing <br>s). The result is deep-cloned per block and
 * cached by markdown. No HTML string is ever inserted into the page: the DOM is
 * built by ProseMirror from the schema (markdown `html` is off), and the clone is
 * still sanitised (event-handler attributes, script/embedding elements and
 * javascript:/vbscript:/non-image data: URLs are dropped) before it is used.
 */
import { Editor, createDocument } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { createBlockExtensions } from "./blockExtensions";

let renderer: Editor | null = null;
let rootClass = "tiptap ProseMirror block-editor-prosemirror";

/**
 * tiptap-markdown runs every extension's markdown-it `setup` on EVERY parse, so
 * plugins/rules are appended again each time (thousands of parses = thousands of
 * duplicate rules). The renderer parses once to install them, then freezes the
 * markdown-it instance against further additions.
 */
function freezeMarkdownIt(md: any) {
  if (!md) return;
  md.use = () => md;
  for (const ruler of [md.core?.ruler, md.block?.ruler, md.inline?.ruler, md.inline?.ruler2]) {
    if (!ruler) continue;
    for (const m of ["after", "before", "push", "at"]) ruler[m] = () => {};
  }
}

function getRenderer(): Editor {
  if (renderer && !renderer.isDestroyed) return renderer;
  const noop = () => {};
  renderer = new Editor({
    element: document.createElement("div"),
    extensions: createBlockExtensions({ onPageLinkClick: noop, onBlockRefClick: noop, onTagClick: noop }),
    content: "",
    editorProps: { attributes: { class: "block-editor-prosemirror" } },
  });
  const parser = (renderer.storage as any).markdown?.parser;
  parser?.parse?.("x"); // installs every extension's markdown-it rules once
  freezeMarkdownIt(parser?.md);
  rootClass = renderer.view.dom.className.replace(/\bProseMirror-focused\b/, "").trim();
  return renderer;
}

const BLOCKED_TAGS = new Set(["SCRIPT", "IFRAME", "OBJECT", "EMBED", "STYLE", "LINK", "META", "BASE", "FORM", "FRAME", "FRAMESET"]);

function unsafeUrl(value: string, allowDataImage: boolean): boolean {
  // Browsers ignore ASCII whitespace/control characters inside a scheme.
  const v = value.replace(/[\u0000- \u007f-\u009f]+/g, "").toLowerCase();
  if (v.startsWith("javascript:") || v.startsWith("vbscript:")) return true;
  if (v.startsWith("data:")) return !(allowDataImage && v.startsWith("data:image/") && !v.startsWith("data:image/svg"));
  return false;
}

function sanitize(root: Node) {
  if (!(root instanceof Element || root instanceof DocumentFragment)) return;
  const all: Element[] = root instanceof Element ? [root, ...root.querySelectorAll("*")] : [...root.querySelectorAll("*")];
  for (const el of all) {
    if (BLOCKED_TAGS.has(el.tagName.toUpperCase())) { el.remove(); continue; }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || name === "srcdoc" || name === "formaction") { el.removeAttribute(attr.name); continue; }
      if ((name === "href" || name === "src" || name === "xlink:href" || name === "action") &&
          unsafeUrl(attr.value, name === "src" && el.tagName === "IMG")) {
        el.removeAttribute(attr.name);
      }
    }
  }
}

const CACHE_MAX = 5000;
/** markdown -> rendered template (cloned for every use; never inserted itself). */
const cache = new Map<string, DocumentFragment>();

function renderTemplate(markdown: string): DocumentFragment {
  const hit = cache.get(markdown);
  if (hit) {
    cache.delete(markdown); // LRU: most recently used last
    cache.set(markdown, hit);
    return hit;
  }
  const r = getRenderer();
  const frag = document.createDocumentFragment();
  try {
    // A fresh state, not setContent(): a live editor is created with its content
    // and has had no transaction yet, so plugins that append on transactions (the
    // trailing paragraph) must not run here either.
    const html = (r.storage as any).markdown.parser.parse(markdown);
    const doc = createDocument(html, r.schema, r.options.parseOptions);
    r.view.updateState(EditorState.create({ doc, plugins: r.state.plugins }));
    for (const child of r.view.dom.childNodes) frag.appendChild(child.cloneNode(true));
  } catch (e) {
    console.error("static render failed; showing plain text", e);
    const p = document.createElement("p");
    p.textContent = markdown;
    frag.appendChild(p);
  }
  sanitize(frag);
  cache.set(markdown, frag);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return frag;
}

/** A fresh DOM copy of what the block editor renders for `markdown`. */
export function renderBlockStatic(markdown: string): DocumentFragment {
  return renderTemplate(markdown).cloneNode(true) as DocumentFragment;
}

/** Class list of the editor's root element (`tiptap ProseMirror block-editor-prosemirror`). */
export function staticRootClass(): string {
  getRenderer();
  return rootClass;
}
