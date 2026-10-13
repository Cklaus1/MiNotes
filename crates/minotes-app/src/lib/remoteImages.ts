/**
 * Remote images (ARCH-findings B-6/U-16) — blocked by default, email-client style.
 *
 * The webview never loads an image from the network (the CSP has no `https:` in
 * `img-src`). An image whose src is a web address renders as a placeholder
 * (`<span class="remote-img" data-remote-src=…>`, see blockExtensions) that shows
 * its alt text and host. When remote images are allowed for that place, this
 * module asks the backend for the bytes (`fetch_remote_image`, SSRF-safe, 10 MB,
 * image only) and puts an `<img src="blob:…">` inside the placeholder.
 *
 * Policy (Settings → Remote images):
 *   never  — placeholders only;
 *   ask    — (default) placeholders, and the page shows a bar to load them for this
 *            page view (the rest of the session) or always for this notebook;
 *   always — load everywhere.
 * "Always for this notebook" is kept in this app's localStorage, keyed by the
 * notebook — deliberately not inside the notebook, so a shared or imported
 * notebook can't grant itself remote loading.
 *
 * Placeholders are found by a MutationObserver, so every renderer (static block
 * render, live editor, link-preview cards) is covered without hooks of its own.
 * A placeholder belongs to the page whose element carries `data-remote-scope`.
 */
import * as api from "./api";
import { getSettings, updateSettings } from "./settings";

export type RemoteImageMode = "never" | "ask" | "always";

/** True for a src that would make the webview hit the network. */
export function isRemoteSrc(src: string | null | undefined): boolean {
  return !!src && /^\s*(https?:)?\/\//i.test(src);
}

/** Host shown on the placeholder ("example.com"); the src itself if unparsable. */
export function remoteHost(src: string): string {
  try { return new URL(src.trim(), "https://x.invalid").host; } catch { return src; }
}

/** `![alt](https://…)` in block markdown — for the page bar and "Save to notebook". */
export const REMOTE_MD_IMAGE = /!\[([^\]]*)\]\(\s*<?((?:https?:)?\/\/[^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/gi;

export function remoteImageUrls(markdown: string): string[] {
  return [...markdown.matchAll(REMOTE_MD_IMAGE)].map((m) => m[2]);
}

// ── Policy ──

const NOTEBOOKS_KEY = "minotes-remote-images-notebooks";
export const REMOTE_IMAGES_CHANGED = "minotes-remote-images-changed";

let notebookKey = "";
const sessionPages = new Set<string>();

export function remoteImageMode(): RemoteImageMode {
  const m = getSettings().remoteImages;
  return m === "never" || m === "always" ? m : "ask";
}

export function setRemoteImageMode(mode: RemoteImageMode) {
  updateSettings({ remoteImages: mode }); // → minotes-settings-changed → changed()
}

function alwaysNotebooks(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(NOTEBOOKS_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** "Always load remote images in this notebook" for `key` (default: the open one). */
export function notebookAlways(key = notebookKey): boolean {
  return !!key && alwaysNotebooks().includes(key);
}

export function setNotebookAlways(on: boolean, key = notebookKey) {
  if (!key) return;
  const rest = alwaysNotebooks().filter((k) => k !== key);
  try {
    localStorage.setItem(NOTEBOOKS_KEY, JSON.stringify(on ? [...rest, key] : rest));
  } catch { /* storage unavailable: session only */ }
  changed();
}

/** Load the remote images of this page for the rest of the session. */
export function allowPage(pageId: string) {
  sessionPages.add(pageId);
  changed();
}

export function isAllowed(scope: string | null): boolean {
  const mode = remoteImageMode();
  if (mode === "always") return true;
  if (mode === "never") return false;
  return notebookAlways() || (!!scope && sessionPages.has(scope));
}

// ── Change notification (the page bar listens) ──

const listeners = new Set<() => void>();
let notifyQueued = false;
function notify() {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    for (const l of listeners) l();
  });
}

/** Called when placeholders appear, load, fail, or the policy changes. */
export function subscribeRemoteImages(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function changed() {
  if (typeof document !== "undefined") {
    for (const el of document.querySelectorAll<HTMLElement>(".remote-img")) consider(el);
  }
  window.dispatchEvent(new Event(REMOTE_IMAGES_CHANGED));
  notify();
}

// ── Fetching (through the backend) ──

const MAX_CACHED = 100;
const blobUrls = new Map<string, Promise<string>>();

function sniffMime(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49) return "image/gif";
  if (b[0] === 0x52 && b[8] === 0x57) return "image/webp";
  if (b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return "image/avif";
  if (b[0] === 0 && b[1] === 0 && b[2] === 1) return "image/x-icon";
  return "image/svg+xml"; // the backend only returns images; the rest is SVG text
}

/** A `blob:` URL for a remote image, fetched once per session. */
export function remoteImageBlobUrl(url: string): Promise<string> {
  const hit = blobUrls.get(url);
  if (hit) return hit;
  const p = api.fetchRemoteImage(url).then((bytes) =>
    URL.createObjectURL(new Blob([bytes as BlobPart], { type: sniffMime(bytes) })),
  );
  p.catch(() => blobUrls.delete(url)); // a failure may be retried later
  blobUrls.set(url, p);
  if (blobUrls.size > MAX_CACHED) {
    const [oldest, op] = blobUrls.entries().next().value as [string, Promise<string>];
    blobUrls.delete(oldest);
    op.then((u) => setTimeout(() => URL.revokeObjectURL(u), 60_000)).catch(() => {});
  }
  return p;
}

function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}

// ── Placeholders ──

function scopeOf(el: Element): string | null {
  return el.closest("[data-remote-scope]")?.getAttribute("data-remote-scope") ?? null;
}

function consider(el: HTMLElement) {
  const src = el.getAttribute("data-remote-src") ?? "";
  const state = el.getAttribute("data-remote-state");
  if (state === "loaded" || state === "loading") return;
  if (!isRemoteSrc(src) || !isAllowed(scopeOf(el))) {
    if (state !== "blocked") {
      el.setAttribute("data-remote-state", "blocked");
      if (!el.title) el.title = `Remote image from ${remoteHost(src)} — not loaded`;
      notify();
    }
    return;
  }
  el.setAttribute("data-remote-state", "loading");
  notify();
  remoteImageBlobUrl(src.trim()).then(
    (blobUrl) => {
      if (el.getAttribute("data-remote-src") !== src) return;
      let img = el.querySelector("img");
      if (!img) {
        img = document.createElement("img");
        img.alt = el.getAttribute("data-alt") ?? "";
        img.draggable = false;
        el.appendChild(img);
      }
      img.src = blobUrl;
      el.setAttribute("data-remote-state", "loaded");
      el.title = el.getAttribute("data-title") || "";
      notify();
    },
    (e) => {
      el.setAttribute("data-remote-state", "error");
      el.title = `Couldn't load image from ${remoteHost(src)}: ${errorText(e)}`;
      notify();
    },
  );
}

let installed = false;

/** Start watching for placeholders and track the open notebook. Idempotent. */
export function installRemoteImages(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const scan = (root: ParentNode) => {
    for (const el of root.querySelectorAll<HTMLElement>(".remote-img")) consider(el);
  };
  new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (!(n instanceof HTMLElement)) continue;
        if (n.classList.contains("remote-img")) consider(n);
        else if (n.getElementsByClassName("remote-img").length) scan(n);
      }
      // A placeholder whose src changed in place (React re-render of a link preview).
      if (r.type === "attributes" && r.target instanceof HTMLElement && r.target.classList.contains("remote-img")) {
        r.target.removeAttribute("data-remote-state");
        r.target.querySelector("img")?.remove();
        consider(r.target);
      }
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-remote-src"] });
  scan(document.body);

  const refreshNotebook = () => {
    api.getCurrentNotebook().then((k) => { notebookKey = k ?? ""; changed(); }).catch(() => {});
  };
  refreshNotebook();
  window.addEventListener("minotes-notebook-switched", (e) => {
    const key = (e as CustomEvent<{ key?: string }>).detail?.key;
    if (key) { notebookKey = key; changed(); } else refreshNotebook();
  });
  window.addEventListener("minotes-settings-changed", () => changed());
}
