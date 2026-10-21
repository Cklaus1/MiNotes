import { useState, useEffect, useLayoutEffect, useRef } from "react";
import * as api from "../lib/api";
import { renderBlockStatic, staticRootClass } from "../editor/staticRender";

interface Props {
  pageId: string;
  /** Changes when the backlinks may have changed without a page change (a rename rewrites them). */
  refreshKey?: string;
  onPageClick: (id: string) => void;
  /** Open the referencing block itself (its page, scrolled to and highlighted). */
  onBlockClick?: (blockId: string) => void;
}

interface BacklinkEntry {
  link: api.Link;
  block?: api.BlockWithPage;
}

/** `{{todo:pending}}` macros read as their keyword (a row is not an editor). */
const forDisplay = (content: string) =>
  content.replace(/\{\{todo:(pending|doing|done)\}\}/g, (_, s: string) =>
    s === "pending" ? "TODO" : s === "doing" ? "DOING" : "DONE");

/** The referencing block rendered like the block itself (rich text, no raw markdown). */
function BacklinkContent({ content }: { content: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.replaceChildren(renderBlockStatic(forDisplay(content)));
  }, [content]);
  // Inside .block-content so the editor's styles (links, marks, tags) apply.
  return (
    <div className="block-content backlink-content">
      <div ref={ref} className={`${staticRootClass()} block-static`} translate="no" />
    </div>
  );
}

export default function BacklinksPanel({ pageId, refreshKey, onPageClick, onBlockClick }: Props) {
  const [entries, setEntries] = useState<BacklinkEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // A refresh of the same page keeps the rows on screen while it loads.
    if (loadedFor.current !== pageId) setLoading(true);

    api.getBacklinks(pageId).then((links) => {
      if (cancelled) return;
      // get_backlinks returns each link with its source block and page title in
      // one call (it used to be one get_block call per link).
      setEntries(links.map(link => ({ link, block: link.block })));
      loadedFor.current = pageId;
      setLoading(false);
    }).catch(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [pageId, refreshKey]);

  if (loading) return null;
  if (entries.length === 0) return null;

  return (
    <div className="backlinks">
      <h4>Backlinks ({entries.length})</h4>
      {entries.map(entry => (
        <div
          key={entry.link.id}
          className="backlink-item"
          role="link"
          title={entry.block ? `Open “${entry.block.page_title}” at this block` : undefined}
          onClick={(e) => {
            if (!entry.block) return;
            e.preventDefault();
            e.stopPropagation();
            if (onBlockClick) onBlockClick(entry.block.id);
            else onPageClick(entry.block.page_id);
          }}
        >
          {entry.block ? (
            <>
              <span className="backlink-page">{entry.block.page_title}</span>
              <BacklinkContent content={entry.block.content} />
            </>
          ) : "(block not found)"}
        </div>
      ))}
    </div>
  );
}
