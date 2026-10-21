/**
 * C-2: a pasted image must reach the attachment store whichever way the webview
 * hands it over, and a `blob:` image URL must never be stored.
 */
import { describe, expect, test } from "vitest";
import { hasBlobImage, pastedFiles, withoutBlobImages } from "./pastedFiles";

const png = (name = "") => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" });

/** A clipboardData the way WebKitGTK fills it for a copied image: `files` empty,
 *  the image only in `items` (next to the HTML that points at a blob: URL). */
function webkitGtkClipboard(file: File): Pick<DataTransfer, "files" | "items"> {
  const items = [
    { kind: "string", type: "text/html", getAsFile: () => null },
    { kind: "file", type: file.type, getAsFile: () => file },
  ];
  return { files: [] as unknown as FileList, items: items as unknown as DataTransferItemList };
}

describe("pastedFiles", () => {
  test("reads clipboardData.items when .files is empty (WebKitGTK)", () => {
    const f = png("shot.png");
    expect(pastedFiles(webkitGtkClipboard(f))).toEqual([f]);
  });

  test("an unnamed clipboard image gets a name with the right extension", () => {
    const [f] = pastedFiles(webkitGtkClipboard(png("")));
    expect(f.name).toBe("pasted-image.png");
    expect(f.type).toBe("image/png");
  });

  test("still reads clipboardData.files (Chrome, synthetic pastes)", () => {
    const f = png("a.png");
    expect(pastedFiles({ files: [f] as unknown as FileList, items: [] as unknown as DataTransferItemList })).toEqual([f]);
  });

  test("plain text has no files", () => {
    const items = [{ kind: "string", type: "text/plain", getAsFile: () => null }];
    expect(pastedFiles({ files: [] as unknown as FileList, items: items as unknown as DataTransferItemList })).toEqual([]);
    expect(pastedFiles(null)).toEqual([]);
  });
});

describe("blob: images are never stored", () => {
  test("found", () => {
    expect(hasBlobImage("![](blob:tauri://localhost/1f2e-33)")).toBe(true);
    expect(hasBlobImage('text ![x](blob:http://localhost:1420/ab "t") more')).toBe(true);
    expect(hasBlobImage("![x](attachment:" + "a".repeat(64) + "/x.png)")).toBe(false);
    expect(hasBlobImage("a [link](blob:x) is not an image")).toBe(false);
  });

  test("left out of what is saved, the rest kept", () => {
    expect(withoutBlobImages("before ![](blob:tauri://localhost/1f2e) after")).toBe("before  after");
    expect(withoutBlobImages("![](blob:tauri://localhost/1f2e)")).toBe("");
    expect(withoutBlobImages("line one\n![](blob:x/y)\nline two")).toBe("line one\n\nline two");
    const ok = "keep ![x](attachment:" + "b".repeat(64) + "/x.png)";
    expect(withoutBlobImages(ok)).toBe(ok);
  });
});
