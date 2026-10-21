// Opening PDFs: the native file picker (desktop) or a file input (browser), and
// the recently opened PDFs. The recent list is kept in the notebook's own
// database (`ui_state`), never in webview storage: file paths and names say
// something about the notes (and an encrypted notebook must not leak them).
import * as api from "./api";

const RECENT_KEY = "recent-pdfs";
const MAX_RECENT = 8;

/** Names of PDFs opened from a browser file input (their path is a blob: URL). */
const blobNames = new Map<string, string>();

/** The file name to show for a path or URL. */
export function pdfDisplayName(path: string): string {
  const named = blobNames.get(path);
  if (named) return named;
  const clean = path.split(/[?#]/)[0];
  const base = clean.split(/[\\/]/).filter(Boolean).pop() ?? path;
  try { return decodeURIComponent(base); } catch { return base; }
}

/** Ask the user for a PDF. Resolves to a path (desktop) or blob: URL (browser), null if cancelled. */
export function pickPdf(): Promise<string | null> {
  if (api.isTauri) {
    return api.pickFileNative("Open a PDF", [{ name: "PDF documents", extensions: ["pdf", "PDF"] }]);
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf,.pdf";
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      const url = URL.createObjectURL(f);
      blobNames.set(url, f.name);
      resolve(url);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export async function getRecentPdfs(): Promise<string[]> {
  try {
    const raw = await api.getUiState(RECENT_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** Remember a PDF that opened (not browser blob: URLs — they die with the page). */
export async function addRecentPdf(path: string): Promise<void> {
  if (path.startsWith("blob:")) return;
  const list = (await getRecentPdfs()).filter((p) => p !== path);
  list.unshift(path);
  await api.setUiState(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT))).catch(() => {});
}

export async function forgetRecentPdf(path: string): Promise<void> {
  const list = (await getRecentPdfs()).filter((p) => p !== path);
  await api.setUiState(RECENT_KEY, JSON.stringify(list)).catch(() => {});
}
