import { useCallback, useEffect, useRef, useState } from "react";
import { useLayer } from "../lib/layers";
import { useDialogFocus } from "../lib/dialogFocus";
import { attachmentHash, openAttachment } from "../lib/attachments";
import { installMedia, lightboxImages, parseSizedAlt } from "../lib/media";
import { useCapabilities } from "../lib/notebooks";
import * as api from "../lib/api";
import { showToast } from "../lib/toast";
import Icon from "./Icon";
import "./views.css";

interface Shown { src: string; alt: string; hash: string | null; list: HTMLImageElement[]; index: number }

/**
 * Images and attachments in rendered blocks (lib/media.ts): the image
 * lightbox (click an image; ←/→ step through the page's images, Esc closes)
 * and the file chips' menu (right-click: Open, Show in folder, Copy name).
 */
export default function MediaHost() {
  const [shown, setShown] = useState<Shown | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; hash: string; name: string } | null>(null);
  const caps = useCapabilities();
  const boxRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setShown(null), []);
  useLayer(!!shown, "dialog", close);
  useLayer(!!menu, "menu", () => setMenu(null));
  useDialogFocus(boxRef, !!shown);

  useEffect(() => {
    installMedia();
    const imageAt = (t: EventTarget | null) => {
      const img = (t as HTMLElement | null)?.closest?.(".block-static img") as HTMLImageElement | null;
      return img && img.src && !img.closest(".link-preview-card") ? img : null;
    };
    // An image in a rendered block opens the lightbox instead of starting to
    // edit the block (capture phase: before the block's own mousedown).
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey) return;
      if (imageAt(e.target)) { e.preventDefault(); e.stopPropagation(); }
    };
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey) return;
      const img = imageAt(e.target);
      if (!img) return;
      e.preventDefault();
      e.stopPropagation();
      const list = lightboxImages(img);
      const index = Math.max(0, list.indexOf(img));
      setShown(describe(list.length ? list : [img], list.length ? index : 0));
    };
    // In a block being edited a click selects the image; a double-click enlarges it.
    const onDouble = (e: MouseEvent) => {
      const img = (e.target as HTMLElement | null)?.closest?.(".ProseMirror img") as HTMLImageElement | null;
      if (!img || !img.src || img.closest(".link-preview-card")) return;
      e.preventDefault();
      setShown(describe([img], 0));
    };
    const onContext = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.("a.attachment-chip") as HTMLAnchorElement | null;
      if (!a) return;
      const hash = attachmentHash(a.getAttribute("href"));
      if (!hash) return;
      e.preventDefault();
      e.stopPropagation();
      setMenu({ x: e.clientX, y: e.clientY, hash, name: a.querySelector(".attachment-chip-name")?.textContent ?? "file" });
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("contextmenu", onContext, true);
    document.addEventListener("dblclick", onDouble, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("contextmenu", onContext, true);
      document.removeEventListener("dblclick", onDouble, true);
    };
  }, []);

  const step = useCallback((d: number) => {
    setShown((s) => (s && s.list.length > 1 ? describe(s.list, (s.index + d + s.list.length) % s.list.length) : s));
  }, []);

  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
      if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, step]);

  const reveal = useCallback((hash: string) => {
    api.revealAttachment(hash).catch((e) => showToast(`Couldn't show the file: ${e}`));
  }, []);
  const open = useCallback((hash: string) => {
    openAttachment(hash).catch((e) => showToast(`Couldn't open the file: ${e}`));
  }, []);

  return (
    <>
      {shown && (
        <div className="lightbox-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }} data-testid="lightbox">
          <div ref={boxRef} className="lightbox" role="dialog" aria-modal="true" aria-label={shown.alt || "Image"}>
            <div className="lightbox-bar">
              <span className="lightbox-caption" title={shown.alt}>{shown.alt || "Image"}</span>
              {shown.list.length > 1 && <span className="lightbox-count">{shown.index + 1} / {shown.list.length}</span>}
              {shown.hash && (
                <button className="btn btn-sm" onClick={() => open(shown.hash!)} title="Open with the default app">
                  <Icon name="external" size={13} /> Open
                </button>
              )}
              {shown.hash && caps.reveal_folder && (
                <button className="btn btn-sm" onClick={() => reveal(shown.hash!)} title="Show the file in its folder">
                  <Icon name="folderOpen" size={13} /> Show in folder
                </button>
              )}
              <button className="btn btn-sm lightbox-close" onClick={close} aria-label="Close" title="Close (Esc)"><Icon name="x" size={14} /></button>
            </div>
            <div className="lightbox-stage">
              {shown.list.length > 1 && <button className="lightbox-nav prev" onClick={() => step(-1)} aria-label="Previous image" title="Previous (←)">‹</button>}
              <img src={shown.src} alt={shown.alt} className="lightbox-img" />
              {shown.list.length > 1 && <button className="lightbox-nav next" onClick={() => step(1)} aria-label="Next image" title="Next (→)">›</button>}
            </div>
          </div>
        </div>
      )}
      {menu && (
        <>
          <div className="kanban-ctx-backdrop" onMouseDown={() => setMenu(null)} />
          <div className="kanban-ctx-menu attachment-menu" role="menu" style={{ position: "fixed", left: menu.x, top: menu.y }} data-testid="attachment-menu">
            <span className="kanban-ctx-label" title={menu.name}>{menu.name}</span>
            <button role="menuitem" onClick={() => { open(menu.hash); setMenu(null); }}><Icon name="external" size={13} /> Open</button>
            {caps.reveal_folder && (
              <button role="menuitem" onClick={() => { reveal(menu.hash); setMenu(null); }}><Icon name="folderOpen" size={13} /> Show in folder</button>
            )}
            <button role="menuitem" onClick={() => { navigator.clipboard.writeText(menu.name).catch(() => {}); setMenu(null); showToast("File name copied"); }}><Icon name="copy" size={13} /> Copy file name</button>
          </div>
        </>
      )}
    </>
  );
}

function describe(list: HTMLImageElement[], index: number): Shown {
  const img = list[index];
  const host = img.closest(".remote-img");
  const rawAlt = img.getAttribute("alt") ?? host?.getAttribute("data-alt") ?? "";
  return {
    src: img.currentSrc || img.src,
    alt: parseSizedAlt(rawAlt).alt,
    hash: attachmentHash(img.getAttribute("data-attachment-src")),
    list,
    index,
  };
}
