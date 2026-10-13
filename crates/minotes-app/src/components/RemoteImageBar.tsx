import { useEffect, useRef, useState } from "react";
import type { Block } from "../lib/api";
import * as api from "../lib/api";
import { attachmentMarkdown } from "../lib/attachments";
import {
  allowPage, remoteImageMode, remoteImageUrls, setNotebookAlways, subscribeRemoteImages,
  REMOTE_IMAGES_CHANGED, REMOTE_MD_IMAGE,
} from "../lib/remoteImages";
import { showToast } from "../lib/toast";

interface Props {
  pageId: string;
  blocks: Block[];
  /** Write a block's new markdown (the page's normal save path). */
  onRewriteBlock: (id: string, content: string) => void;
}

interface Counts { blocked: number; loaded: number; failed: number }

/**
 * The one small bar a page shows when it has remote images (lib/remoteImages.ts):
 * "Remote images blocked on this page — Load images · Always for this notebook",
 * and once they are loaded, "Save to notebook" (download them into the
 * attachment store and point the blocks at the stored copies, so they work
 * offline and stop contacting the server).
 */
export default function RemoteImageBar({ pageId, blocks, onRewriteBlock }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [counts, setCounts] = useState<Counts>({ blocked: 0, loaded: 0, failed: 0 });
  const [saving, setSaving] = useState(false);
  const [, setPolicyVersion] = useState(0); // re-render when the policy changes
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

  useEffect(() => {
    const recount = () => {
      const scope = ref.current?.closest("[data-remote-scope]");
      if (!scope) return;
      const n = (state: string) => scope.querySelectorAll(`.remote-img[data-remote-state="${state}"]`).length;
      const next = { blocked: n("blocked"), loaded: n("loaded") + n("loading"), failed: n("error") };
      setCounts((c) => (c.blocked === next.blocked && c.loaded === next.loaded && c.failed === next.failed ? c : next));
    };
    recount();
    const t = setTimeout(recount, 50); // after this page's placeholders were considered
    const off = subscribeRemoteImages(recount);
    const onPolicy = () => setPolicyVersion((v) => v + 1);
    window.addEventListener(REMOTE_IMAGES_CHANGED, onPolicy);
    return () => { clearTimeout(t); off(); window.removeEventListener(REMOTE_IMAGES_CHANGED, onPolicy); };
  }, [pageId]);

  const mode = remoteImageMode();
  if (mode === "never") return <div ref={ref} hidden />;
  const saveable = blocks.some((b) => remoteImageUrls(b.content).length > 0);
  const show = counts.blocked > 0 || (saveable && counts.loaded + counts.failed > 0);
  if (!show) return <div ref={ref} hidden />;

  const saveToNotebook = async () => {
    setSaving(true);
    const stored = new Map<string, string>(); // url -> attachment markdown target
    const failed: string[] = [];
    let changed = 0;
    try {
      for (const b of blocksRef.current) {
        const urls = remoteImageUrls(b.content);
        if (!urls.length) continue;
        for (const url of urls) {
          if (stored.has(url) || failed.includes(url)) continue;
          try {
            const a = await api.saveRemoteImage(url);
            // attachmentMarkdown gives `![name](attachment:<hash>/<name>)`; keep only the target.
            stored.set(url, attachmentMarkdown(a).replace(/^!\[[^\]]*\]\(/, "").replace(/\)$/, ""));
          } catch (e) {
            failed.push(url);
            console.warn("save remote image failed", url, e);
          }
        }
        const next = b.content.replace(REMOTE_MD_IMAGE, (whole, alt: string, url: string) =>
          stored.has(url) ? `![${alt}](${stored.get(url)})` : whole);
        if (next !== b.content) { onRewriteBlock(b.id, next); changed++; }
      }
    } finally {
      setSaving(false);
    }
    const n = stored.size;
    showToast(failed.length
      ? `Saved ${n} image${n === 1 ? "" : "s"} to this notebook; ${failed.length} couldn't be downloaded`
      : `Saved ${n} image${n === 1 ? "" : "s"} to this notebook${changed ? "" : " (nothing to change)"}`);
  };

  return (
    <div ref={ref} className="remote-images-bar" role="status" data-testid="remote-images-bar">
      {counts.blocked > 0 ? (
        <>
          <span className="remote-images-bar-text">Remote images blocked on this page</span>
          <span className="remote-images-bar-sep">—</span>
          <button className="remote-images-bar-btn" data-testid="remote-images-load" onClick={() => allowPage(pageId)}>
            Load images
          </button>
          <span className="remote-images-bar-sep">·</span>
          <button className="remote-images-bar-btn" data-testid="remote-images-always" onClick={() => setNotebookAlways(true)}>
            Always for this notebook
          </button>
        </>
      ) : (
        <>
          <span className="remote-images-bar-text">
            {counts.failed > 0 ? "Some remote images couldn't be loaded" : "Images on this page are loaded from the web"}
          </span>
          <span className="remote-images-bar-sep">—</span>
          <button
            className="remote-images-bar-btn"
            data-testid="remote-images-save"
            disabled={saving}
            title="Download the images into this notebook so they work offline and stop contacting their servers"
            onClick={saveToNotebook}
          >
            {saving ? "Saving…" : "Save to notebook"}
          </button>
        </>
      )}
    </div>
  );
}
