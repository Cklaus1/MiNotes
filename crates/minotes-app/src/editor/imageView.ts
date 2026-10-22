/**
 * Image resize handles (UX Wave 4). The width lives in the alt text —
 * `![alt|300](src)` (px after the last `|`), the syntax the views work renders —
 * so it round-trips through the markdown unchanged. Dragging the corner handle
 * writes it; double-clicking the handle removes it (natural size). Remote images
 * keep their placeholder (lib/remoteImages.ts) and get no handle.
 */
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";

const WIDTH = /^(.*)\|(\d{1,5})$/s;

/** The alt text without its width, and the width (px) if there is one. */
export function parseImageAlt(alt: string | null | undefined): { text: string; width: number | null } {
  const a = alt ?? "";
  const m = WIDTH.exec(a);
  return m ? { text: m[1], width: Number(m[2]) } : { text: a, width: null };
}

/** The alt text with this width (null: no width). */
export function withImageWidth(alt: string | null | undefined, width: number | null): string {
  const { text } = parseImageAlt(alt);
  return width && width > 0 ? `${text}|${Math.round(width)}` : text;
}

export const MIN_IMAGE_WIDTH = 40;

/** Node view for a local (attachment / data) image: <img> + a corner handle. */
export function imageNodeView(
  { node, editor, getPos, HTMLAttributes }: { node: PMNode; editor: Editor; getPos: () => number | undefined; HTMLAttributes: Record<string, any> },
  fallback: () => { dom: HTMLElement },
) {
  let current = node;
  if (!/^(attachment:|data:|blob:|\/|asset:)/.test(String(node.attrs.src ?? ""))) return fallback();
  const wrap = document.createElement("span");
  wrap.className = "img-resizable";
  wrap.contentEditable = "false";
  const img = document.createElement("img");
  for (const [k, v] of Object.entries(HTMLAttributes)) if (v != null && k !== "alt") img.setAttribute(k, String(v));
  const handle = document.createElement("span");
  handle.className = "img-resize-handle";
  handle.title = "Drag to resize · double-click for the natural size";
  handle.setAttribute("aria-hidden", "true");
  wrap.append(img, handle);

  const sync = () => {
    const { text, width } = parseImageAlt(current.attrs.alt);
    img.alt = text;
    if (width) { img.style.width = `${width}px`; wrap.dataset.width = String(width); }
    else { img.style.removeProperty("width"); delete wrap.dataset.width; }
  };
  sync();

  const write = (width: number | null) => {
    const pos = getPos();
    if (typeof pos !== "number" || editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, alt: withImageWidth(current.attrs.alt, width) }));
    (editor.storage as any).slashCallbacks?.save?.();
  };

  handle.addEventListener("pointerdown", (e) => {
    if (!editor.isEditable) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = img.getBoundingClientRect().width;
    const maxW = (wrap.parentElement?.getBoundingClientRect().width ?? 2000) || 2000;
    let w = startW;
    try { handle.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    const move = (ev: PointerEvent) => {
      w = Math.max(MIN_IMAGE_WIDTH, Math.min(maxW, startW + ev.clientX - startX));
      img.style.width = `${Math.round(w)}px`;
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      window.removeEventListener("pointerup", up);
      if (Math.abs(w - startW) >= 1) write(w); else sync();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    window.addEventListener("pointerup", up);
  });
  handle.addEventListener("dblclick", (e) => { e.preventDefault(); e.stopPropagation(); write(null); });

  return {
    dom: wrap,
    update(n: PMNode) {
      if (n.type !== current.type || n.attrs.src !== current.attrs.src) return false;
      current = n;
      sync();
      return true;
    },
    stopEvent(e: Event) { return e.target === handle; },
    ignoreMutation() { return true; },
  };
}
