/**
 * Images and attachments in rendered blocks (UX Wave 4):
 *
 * - **Width syntax.** `![alt|300](src)` (Obsidian's) shows the image 300 px
 *   wide; the markdown keeps it verbatim, so it round-trips through the editor
 *   (media.test.ts). Applied to statically rendered blocks.
 * - **Lightbox.** Clicking an image in a rendered block opens it large
 *   (components/MediaHost.tsx; Esc closes it via the layer rule).
 * - **File chips.** A link to a stored file (`[name](attachment:<hash>/<name>)`)
 *   is drawn as a chip: icon, name, size; right-click → Open / Show in folder.
 *
 * DOM post-processing of the static render only (`.block-static`), never of a
 * live ProseMirror editor (it owns its DOM).
 */
import * as api from "./api";
import { attachmentHash, type Attachment } from "./attachments";
import { iconSvg } from "./icons";

/** `alt|300` → { alt: "alt", width: 300 }; anything else → no width. */
export function parseSizedAlt(alt: string): { alt: string; width: number | null } {
  const m = /^(.*?)\s*\|\s*(\d{1,4})(?:\s*x\s*\d{1,4})?\s*$/.exec(alt);
  if (!m) return { alt, width: null };
  const w = Number(m[2]);
  return w > 0 ? { alt: m[1], width: w } : { alt, width: null };
}

/** Bytes as "512 B", "12 KB", "3.4 MB". */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** The file name shown on a chip for `attachment:<hash>/<encoded name>`. */
export function attachmentName(href: string, text: string): string {
  if (text.trim()) return text.trim();
  const enc = href.slice("attachment:".length + 65);
  try { return decodeURIComponent(enc) || "file"; } catch { return enc || "file"; }
}

const meta = new Map<string, Promise<Attachment | null>>();
export function attachmentMeta(hash: string): Promise<Attachment | null> {
  let p = meta.get(hash);
  if (!p) {
    p = api.getAttachment(hash).catch(() => null);
    meta.set(hash, p);
  }
  return p;
}

function decorateImage(img: HTMLImageElement) {
  if (img.dataset.sized) return;
  img.dataset.sized = "1";
  const { alt, width } = parseSizedAlt(img.getAttribute("alt") ?? "");
  if (width) {
    img.alt = alt;
    img.style.width = `${width}px`;
    img.style.maxWidth = "100%";
    img.dataset.width = String(width);
  }
}

function decorateChip(a: HTMLAnchorElement) {
  if (a.classList.contains("attachment-chip")) return;
  const href = a.getAttribute("href") ?? "";
  const hash = attachmentHash(href);
  if (!hash) return;
  const name = attachmentName(href, a.textContent ?? "");
  a.classList.add("attachment-chip");
  a.dataset.attachment = hash;
  a.title = `${name} — click to open, right-click for more`;
  const icon = document.createElement("span");
  icon.className = "attachment-chip-icon";
  icon.innerHTML = iconSvg("file", 14); // static markup from lib/icons
  const label = document.createElement("span");
  label.className = "attachment-chip-name";
  label.textContent = name;
  const size = document.createElement("span");
  size.className = "attachment-chip-size";
  a.replaceChildren(icon, label, size);
  attachmentMeta(hash).then((m) => {
    if (!m) { a.classList.add("is-missing"); size.textContent = "missing"; return; }
    const ext = (m.ext || name.split(".").pop() || "").toUpperCase();
    size.textContent = [ext, formatSize(m.size)].filter(Boolean).join(" · ");
  });
}

/** Decorate the images and file links under `root` (idempotent). */
export function decorateMedia(root: ParentNode) {
  for (const img of root.querySelectorAll<HTMLImageElement>(".block-static img")) decorateImage(img);
  for (const a of root.querySelectorAll<HTMLAnchorElement>('.block-static a[href^="attachment:"]')) decorateChip(a);
}

let installed = false;
/** Watch for rendered blocks and decorate them. Idempotent. */
export function installMedia(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (!(n instanceof HTMLElement)) continue;
        if (n.closest(".block-static") || n.querySelector(".block-static")) decorateMedia(n.closest(".block-static")?.parentElement ?? n);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
  decorateMedia(document.body);
}

/** Images a lightbox can step through: the rendered images of the same page. */
export function lightboxImages(from: HTMLImageElement): HTMLImageElement[] {
  const scope = from.closest(".page-view, [data-remote-scope], .right-sidebar") ?? document.body;
  return [...scope.querySelectorAll<HTMLImageElement>(".block-static img")].filter((i) => i.src && i.naturalWidth !== 0);
}
