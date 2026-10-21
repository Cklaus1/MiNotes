/**
 * Pasted files and the `blob:` image safety net (UX review C-2).
 *
 * WebKitGTK (the Linux desktop webview) puts a pasted image in
 * `clipboardData.items` and leaves `clipboardData.files` empty; the editor read
 * only `.files`, so ProseMirror pasted the clipboard's HTML instead — an
 * `<img src="blob:…">` that was saved as `![](blob:tauri://localhost/…)` and was
 * gone after a restart. A `blob:` URL only lives as long as the page, so it must
 * never be stored.
 */

const EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
  "image/bmp": "bmp", "image/svg+xml": "svg", "image/tiff": "tiff", "image/avif": "avif",
};

/** A file from the clipboard, named when it has no name ("pasted-image.png"). */
function named(file: File): File {
  if (file.name) return file;
  const ext = EXT[file.type] ?? (file.type.startsWith("image/") ? file.type.slice(6).replace(/[^a-z0-9]/gi, "") : "bin");
  const base = file.type.startsWith("image/") ? "pasted-image" : "pasted-file";
  return new File([file], `${base}.${ext || "bin"}`, { type: file.type, lastModified: file.lastModified });
}

/** The files a paste carries: `clipboardData.files`, or else every `items` entry of kind "file". */
export function pastedFiles(data: Pick<DataTransfer, "files" | "items"> | null | undefined): File[] {
  if (!data) return [];
  const files = Array.from(data.files ?? []);
  if (files.length > 0) return files.map(named);
  const out: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const f = item.getAsFile();
    if (f) out.push(named(f));
  }
  return out;
}

/** `![alt](blob:…)` (optionally with a title) in stored markdown. */
const BLOB_IMAGE = /!\[[^\]\n]*\]\(\s*<?blob:[^)\s>]*>?(?:\s+"[^"\n]*")?\s*\)/g;

export function hasBlobImage(markdown: string): boolean {
  BLOB_IMAGE.lastIndex = 0;
  return BLOB_IMAGE.test(markdown);
}

/** The markdown without its `blob:` images (they can't be stored; see above). */
export function withoutBlobImages(markdown: string): string {
  if (!hasBlobImage(markdown)) return markdown;
  return markdown.replace(BLOB_IMAGE, "").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Turn the image a `blob:` URL shows into a PNG file. Drawn through a canvas
 * because the CSP doesn't allow fetching `blob:` URLs (img-src does allow them).
 */
export function blobImageToFile(src: string, name = "pasted-image.png"): Promise<File> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx || !canvas.width || !canvas.height) { reject(new Error("empty image")); return; }
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((b) => (b ? resolve(new File([b], name, { type: "image/png" })) : reject(new Error("no image data"))), "image/png");
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => reject(new Error("the image is no longer available"));
    img.src = src;
  });
}
