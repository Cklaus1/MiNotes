// One way out for every export (page HTML, whiteboard PNG/SVG, mind map
// PNG/SVG/Markdown): the user always learns where the file went.
//
// - Desktop: the native "Save as" dialog (`save_export_file`), then a toast with
//   the saved path. The desktop webview has no download manager — an
//   `<a download>` there is saved silently into the app's working directory.
// - Browser (dev/mock): an `<a download>` link, then a toast with the file name.
// - Encrypted notebook: `confirmPlaintextExport` asks first, every time it must.
// - Failure: an error toast that says what went wrong; cancelling is silent.
import * as api from "./api";
import { confirmPlaintextExport } from "./encryption";
import { showToast } from "./toast";

export type ExportResult = { saved: true; path: string } | { saved: false; reason: "declined" | "cancelled" | "failed" };

/** A file name the OS dialogs accept: no path separators or reserved characters. */
export function exportFileName(base: string, ext: string, fallback = "export"): string {
  const clean = base.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  return `${clean || fallback}.${ext}`;
}

async function toBytes(data: Blob | string): Promise<Uint8Array> {
  if (typeof data === "string") return new TextEncoder().encode(data);
  return new Uint8Array(await data.arrayBuffer());
}

/**
 * Save `data` as `filename`. `kind` names it in the toast ("Page", "Whiteboard
 * PNG"…). Resolves once the file is written, the dialog cancelled, or it failed.
 */
export async function saveExport(filename: string, data: Blob | string, kind: string, mime = "application/octet-stream"): Promise<ExportResult> {
  // An encrypted notebook: the export is written unencrypted — ask once.
  if (!(await confirmPlaintextExport())) return { saved: false, reason: "declined" };
  try {
    if (api.isTauri) {
      const bytes = await toBytes(data);
      const path = await api.saveExportFile(filename, Array.from(bytes));
      if (!path) return { saved: false, reason: "cancelled" };
      showToast(`${kind} saved to ${path}`);
      return { saved: true, path };
    }
    const blob = typeof data === "string" ? new Blob([data], { type: mime }) : data;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.download = filename;
    link.href = url;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revoking at once can cancel a download that starts asynchronously.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    showToast(`${kind} downloaded as ${filename}`);
    return { saved: true, path: filename };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`${kind} export failed: ${msg || "unknown error"}`, 8000);
    return { saved: false, reason: "failed" };
  }
}
