/**
 * Images in notes that fail to load would otherwise render as nothing at all.
 * Mark them so CSS can draw a visible placeholder, and put the reason in the
 * alt text (rendered inside the placeholder) and the tooltip.
 *
 * Only attributes of the <img> are touched: an image is a leaf node in the
 * editor, so ProseMirror ignores these DOM changes instead of re-rendering.
 */
function reasonFor(src: string): string {
  let url: URL | null = null;
  try { url = new URL(src, window.location.href); } catch { /* keep null */ }
  if (src.startsWith("data:")) return "Image data is damaged";
  if (url && url.protocol === "http:" && url.host !== window.location.host) {
    return `Image not shown: only https:// images are allowed (${src})`;
  }
  if (url && url.protocol === "https:") {
    return `Couldn't load image from ${url.host} — offline, or the address is wrong`;
  }
  const path = url && url.host === window.location.host ? decodeURIComponent(url.pathname) : src;
  return `Image not found: ${path} — paste or drop the image into the note to embed it`;
}

let installed = false;

export function installBrokenImageHints(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("error", (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    if (!img.closest(".block, .ProseMirror")) return;
    const src = img.getAttribute("src") ?? "";
    if (!src) return;
    const reason = reasonFor(src);
    img.classList.add("img-broken");
    img.dataset.brokenReason = reason;
    if (!img.dataset.originalAlt) img.dataset.originalAlt = img.getAttribute("alt") ?? "";
    const alt = img.dataset.originalAlt;
    img.setAttribute("alt", `⚠ ${reason}${alt ? ` (“${alt}”)` : ""}`);
    img.title = reason;
  }, true);
  document.addEventListener("load", (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains("img-broken")) return;
    img.classList.remove("img-broken");
    img.setAttribute("alt", img.dataset.originalAlt ?? "");
    delete img.dataset.brokenReason;
    img.removeAttribute("title");
  }, true);
}
