/**
 * Attachments (PRD-import §5): files stored by content hash in the notebook,
 * referenced from blocks as `![alt](attachment:<hash>/<name>)` (images) or
 * `[name](attachment:<hash>/<name>)` (files).
 *
 * The desktop app serves them through the `attachment://` protocol (by hash
 * only); browser mode keeps them in memory as blob URLs.
 */
import * as api from "./api";

export interface Attachment {
  hash: string;
  name: string;
  mime: string;
  ext: string;
  size: number;
  created_at: string;
}

const HASH = /^[0-9a-f]{64}$/;

/** `attachment:<hash>/<name>` → hash (null for anything else). */
export function attachmentHash(src: string | null | undefined): string | null {
  if (!src || !src.startsWith("attachment:")) return null;
  const h = src.slice("attachment:".length, "attachment:".length + 64);
  return HASH.test(h) ? h : null;
}

// Browser mode: hash → blob URL (filled by the mock's store_attachment).
const mockUrls = new Map<string, string>();
export function registerMockAttachmentUrl(hash: string, url: string) {
  mockUrls.set(hash, url);
}

// Not `api.isTauri`: api → mockBackend → importMock → this module is a cycle,
// so nothing from api may be read while this module initialises.
const inTauri = !!(window as any).__TAURI_INTERNALS__;
let convert: ((path: string, protocol?: string) => string) | null = null;
if (inTauri) {
  import("@tauri-apps/api/core").then((m) => { convert = m.convertFileSrc; });
}

/** URL the webview loads for a stored attachment. */
export function attachmentUrl(hash: string): string {
  if (!inTauri) return mockUrls.get(hash) ?? "";
  if (convert) return convert(hash, "attachment");
  // Before the dynamic import resolved: the Linux/macOS form.
  return `attachment://localhost/${hash}`;
}

/** The `src` an <img> needs for a block's image src (attachment refs mapped). */
export function displaySrc(src: string): string {
  const h = attachmentHash(src);
  return h ? attachmentUrl(h) : src;
}

/** Percent-encode a file name the way the backend does (`encode_name`). */
export function encodeName(name: string): string {
  const safe = (name.trim() || "file").replace(/[/\\:*?"<>|\u0000-\u001f]/g, "_").replace(/[. ]+$/, "") || "_";
  const fixed = safe.startsWith(".") ? "_" + safe : safe;
  return Array.from(new TextEncoder().encode(fixed))
    .map((b) => (/[A-Za-z0-9._~-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : "%" + b.toString(16).toUpperCase().padStart(2, "0")))
    .join("");
}

export function isImage(a: Attachment): boolean {
  return a.mime.startsWith("image/");
}

/** The markdown that references `a` in a block. */
export function attachmentMarkdown(a: Attachment): string {
  const text = a.name.replace(/[[\]]/g, "_");
  const url = `attachment:${a.hash}/${encodeName(a.name)}`;
  return isImage(a) ? `![${text}](${url})` : `[${text}](${url})`;
}

/** Store a pasted / dropped browser File. */
export async function storeFile(file: File): Promise<Attachment> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return api.storeAttachment(file.name || "pasted", file.type || "", bytes);
}

/** Open a stored attachment with the OS (desktop) or in a new tab (browser). */
export async function openAttachment(hash: string): Promise<void> {
  if (inTauri) return api.openAttachment(hash);
  const url = mockUrls.get(hash);
  if (url) window.open(url, "_blank");
}
