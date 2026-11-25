/**
 * Code blocks with a header: the language as a dropdown (it changes the fence
 * language, ```` ```python ````) and a copy button (UX Wave 4).
 *
 * A plain-DOM node view, so the static renderer (staticRender.ts) draws the same
 * header for blocks that aren't being edited; BlockItem forwards clicks on a
 * static header (copy: right there; language: in the block's live editor).
 */
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { codeLanguageLabel, filterCodeLanguages } from "./codeLanguage";
import { iconSvg } from "../lib/icons";
import { openLayer } from "../lib/layers";
import { showToast } from "../lib/toast";

/** Copy a code block's text, with a toast either way. */
export function copyCode(text: string): void {
  const done = () => showToast("Code copied");
  try {
    navigator.clipboard.writeText(text).then(done, () => showToast("Couldn't copy the code"));
  } catch {
    showToast("Couldn't copy the code");
  }
}

let closeOpenPicker: (() => void) | null = null;

/**
 * The language list under `anchor`: a filter field and the languages; ↑/↓, Enter
 * picks, Esc (or a click elsewhere) closes. `pick` gets the fence id ("" = plain).
 */
export function openLanguagePicker(anchor: HTMLElement, current: string | null, pick: (id: string) => void, onClose?: () => void) {
  closeOpenPicker?.();
  const box = document.createElement("div");
  box.className = "code-lang-picker";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Code language");
  box.setAttribute("data-testid", "code-lang-picker");
  const input = document.createElement("input");
  input.className = "code-lang-filter";
  input.placeholder = "Language…";
  input.setAttribute("aria-label", "Filter languages");
  input.setAttribute("data-escape-local", "");
  const list = document.createElement("div");
  list.className = "code-lang-list";
  list.setAttribute("role", "listbox");
  box.append(input, list);

  let items: { id: string; label: string }[] = [];
  let active = 0;
  const render = () => {
    items = filterCodeLanguages(input.value, current);
    if (!input.value.trim()) active = Math.max(0, items.findIndex((i) => i.id === (current ?? "")));
    active = Math.min(active, Math.max(0, items.length - 1));
    list.replaceChildren(...items.map((it, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `code-lang-option${i === active ? " active" : ""}${it.id === (current ?? "") ? " current" : ""}`;
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", String(i === active));
      b.dataset.lang = it.id;
      b.textContent = it.label;
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => choose(i));
      return b;
    }));
    (list.children[active] as HTMLElement | undefined)?.scrollIntoView?.({ block: "nearest" });
  };

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    closeOpenPicker = null;
    unlayer();
    document.removeEventListener("mousedown", outside, true);
    box.remove();
    onClose?.();
  };
  const choose = (i: number) => {
    const it = items[i];
    if (!it) return;
    close();
    pick(it.id);
  };
  const outside = (e: MouseEvent) => { if (!box.contains(e.target as Node)) close(); };
  const unlayer = openLayer("popover", close);

  input.addEventListener("input", () => { active = 0; render(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); active = (active + 1) % Math.max(1, items.length); render(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = (active - 1 + items.length) % Math.max(1, items.length); render(); }
    else if (e.key === "Enter") { e.preventDefault(); choose(active); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "Tab") { e.preventDefault(); }
  });

  document.body.appendChild(box);
  const r = anchor.getBoundingClientRect();
  const top = r.bottom + 4 + 260 > window.innerHeight ? Math.max(8, r.top - 264) : r.bottom + 4;
  box.style.top = `${top}px`;
  box.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 228))}px`;
  render();
  input.focus();
  document.addEventListener("mousedown", outside, true);
  closeOpenPicker = close;
}

function button(cls: string, label: string, html: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.innerHTML = html; // static markup (labels are set with textContent below)
  return b;
}

export function codeBlockNodeView({ node, editor, getPos }: { node: PMNode; editor: Editor; getPos: () => number | undefined }) {
  let current = node;
  const pre = document.createElement("pre");
  pre.className = "code-block-view";
  const header = document.createElement("div");
  header.className = "code-block-header";
  header.contentEditable = "false";
  const langBtn = button("code-lang-btn", "Code language", "");
  const langText = document.createElement("span");
  langText.className = "code-lang-name";
  langBtn.append(langText);
  langBtn.insertAdjacentHTML("beforeend", iconSvg("chevron-down", 12));
  const copyBtn = button("code-copy-btn", "Copy code", iconSvg("copy", 14));
  header.append(langBtn, copyBtn);
  const code = document.createElement("code");
  pre.append(header, code);

  const sync = () => {
    const lang: string | null = current.attrs.language || null;
    const label = codeLanguageLabel(lang);
    langText.textContent = label ?? "Plain text";
    if (label) pre.setAttribute("data-language-label", label); else pre.removeAttribute("data-language-label");
    code.className = lang ? `language-${lang}` : "";
  };
  sync();

  langBtn.addEventListener("mousedown", (e) => e.preventDefault());
  copyBtn.addEventListener("mousedown", (e) => e.preventDefault());
  copyBtn.addEventListener("click", () => copyCode(current.textContent));
  langBtn.addEventListener("click", () => {
    if (!editor.isEditable) return;
    openLanguagePicker(langBtn, current.attrs.language || null, (id) => {
      const pos = getPos();
      if (typeof pos !== "number" || editor.isDestroyed) return;
      editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, language: id || null }));
      // A structure change: saved now, and the caret goes back into the code.
      (editor.storage as any).slashCallbacks?.save?.();
    }, () => { if (!editor.isDestroyed) editor.view.focus(); });
  });

  return {
    dom: pre,
    contentDOM: code,
    update(n: PMNode) {
      if (n.type !== current.type) return false;
      current = n;
      sync();
      return true;
    },
    stopEvent(e: Event) {
      return header.contains(e.target as Node);
    },
    ignoreMutation(m: { target: Node; type: string }) {
      return header.contains(m.target) || m.target === header;
    },
  };
}

/** `/code`: open the new code block's language list right away. */
export function openLanguagePickerAtCaret(editor: Editor) {
  if (editor.isDestroyed) return;
  try {
    const at = editor.view.domAtPos(editor.state.selection.from).node as Node;
    const el = (at instanceof Element ? at : at.parentElement)?.closest("pre");
    (el?.querySelector(".code-lang-btn") as HTMLButtonElement | null)?.click();
  } catch { /* the block went away */ }
}
