import { useCallback, useEffect, useState } from "react";
import type { OgMetadata } from "../lib/api";
import * as api from "../lib/api";
import { isRemoteSrc } from "../lib/remoteImages";
import Icon from "./Icon";
import "./views.css";

/**
 * A `{{link-preview:<url>}}` block: a card with the page's title, description,
 * a wide 16:9 image and the site's icon (both remote images: placeholders that
 * lib/remoteImages fills through the backend once allowed), in loading /
 * loaded / unavailable states. Actions: Refresh (fetch again) and Convert to
 * plain link (the block becomes `[title](url)`, or `<url>` without a title).
 */
export default function LinkPreviewCard({ url, onReplace }: { url: string; onReplace: (markdown: string) => void }) {
  const [meta, setMeta] = useState<OgMetadata | "loading" | "failed">("loading");
  const [gen, setGen] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setMeta("loading");
    api.fetchOgMetadata(url)
      .then((m) => { if (!cancelled) setMeta(m.title || m.description ? m : "failed"); })
      .catch(() => { if (!cancelled) setMeta("failed"); });
    return () => { cancelled = true; };
  }, [url, gen]);

  const loaded = typeof meta === "object" ? meta : null;
  const state = loaded ? "loaded" : meta;
  let domain = url;
  try { domain = new URL(url).hostname.replace(/^www\./, ""); } catch { /* keep the URL */ }

  const convert = useCallback(() => {
    const title = loaded?.title?.trim().replace(/[[\]]/g, "") ?? "";
    onReplace(title ? `[${title}](${url})` : `<${url}>`);
  }, [loaded, url, onReplace]);

  return (
    <div className="link-preview-wrap" data-preview-url={url}>
      <a
        className={`link-preview-card link-preview-${state}${loaded && isRemoteSrc(loaded.image) ? " has-image" : ""}`}
        data-preview-state={state}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title={url}
      >
        {/* Remote images are never loaded by the webview: placeholders that
            lib/remoteImages fills through the backend once allowed. */}
        {loaded && isRemoteSrc(loaded.image) && (
          <span className="remote-img link-preview-image" data-remote-src={loaded.image} data-alt="" />
        )}
        <div className="link-preview-body">
          {state === "loading" ? (
            <>
              <div className="link-preview-skeleton" aria-hidden="true" />
              <div className="link-preview-status">Loading preview…</div>
            </>
          ) : state === "failed" ? (
            <div className="link-preview-status">Preview unavailable · open link</div>
          ) : (
            <>
              <div className="link-preview-title">{loaded!.title || domain}</div>
              {loaded!.description && (
                <div className="link-preview-description">{loaded!.description}</div>
              )}
            </>
          )}
          <div className="link-preview-url">
            {loaded && isRemoteSrc(loaded.favicon) ? (
              <span className="remote-img link-preview-favicon" data-remote-src={loaded.favicon} data-alt="" />
            ) : (
              <span className="link-preview-favicon-fallback" aria-hidden="true"><Icon name="link" size={12} /></span>
            )}
            <span className="link-preview-domain">{domain}</span>
          </div>
        </div>
      </a>
      <div className="link-preview-actions" role="toolbar" aria-label="Link preview">
        <button
          type="button"
          className="link-preview-action link-preview-refresh"
          onClick={() => setGen((g) => g + 1)}
          disabled={state === "loading"}
          title={state === "loading" ? "Loading…" : "Refresh the preview"}
          aria-label="Refresh the preview"
        >
          <Icon name="refresh" size={13} />
        </button>
        <button
          type="button"
          className="link-preview-action link-preview-convert"
          onClick={convert}
          title="Convert to a plain link"
          aria-label="Convert to a plain link"
        >
          <Icon name="text" size={13} />
        </button>
      </div>
    </div>
  );
}
