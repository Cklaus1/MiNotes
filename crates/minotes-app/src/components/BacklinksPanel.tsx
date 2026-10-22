import { useState, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as api from "../lib/api";
import { renderBlockStatic, staticRootClass } from "../editor/staticRender";
import { groupByPage, BACKLINK_PAGE_SIZE } from "../lib/backlinkGroups";
import Icon from "./Icon";

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

/**
 * Backlinks, grouped by the page they're on (UX Wave 4): one collapsible group
 * per page with its count; rows render lazily, BACKLINK_PAGE_SIZE at a time
 * ("Show more"), so a page with hundreds of backlinks opens instantly.
 */
export default function BacklinksPanel({ pageId, refreshKey, onPageClick, onBlockClick }: Props) {
  const [entries, setEntries] = useState<BacklinkEntry[]>([]);
  const [loading, setLoading] = useState(false);
  // Rows a group shows beyond its share of the first BACKLINK_PAGE_SIZE ("Show more").
  const [extra, setExtra] = useState<Map<string, number>>(new Map());
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // A refresh of the same page keeps the rows on screen while it loads.
    if (loadedFor.current !== pageId) {
      setLoading(true);
      setExtra(new Map());
      setFolded(new Set());
    }

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

  const groups = useMemo(() => groupByPage(
    entries.filter((e) => !!e.block),
    (e) => e.block!.page_id,
    (e) => e.block!.page_title,
  ), [entries]);

  if (loading) return null;
  if (entries.length === 0) return null;

  // The first BACKLINK_PAGE_SIZE rows go to the groups in order (folded groups
  // take none); every group keeps its header, and "Show more" adds to its own rows.
  let budget = BACKLINK_PAGE_SIZE;
  const missing = entries.filter((e) => !e.block).length;

  return (
    <div className="backlinks" data-testid="backlinks">
      <h4>
        Backlinks ({entries.length})
        {groups.length > 1 && <span className="backlinks-sub"> · {groups.length} pages</span>}
      </h4>
      {groups.map((g) => {
        const isFolded = folded.has(g.pageId);
        const share = isFolded ? 0 : Math.min(g.items.length, Math.max(0, budget));
        if (!isFolded) budget -= share;
        const shown = isFolded ? [] : g.items.slice(0, share + (extra.get(g.pageId) ?? 0));
        const rest = isFolded ? 0 : g.items.length - shown.length;
        return (
          <div className="backlink-group" key={g.pageId} data-page-id={g.pageId}>
            <div className="backlink-group-header">
              <button
                type="button"
                className="backlink-group-toggle"
                aria-expanded={!isFolded}
                aria-label={isFolded ? `Show backlinks from ${g.title}` : `Hide backlinks from ${g.title}`}
                onClick={() => setFolded((prev) => {
                  const next = new Set(prev);
                  if (next.has(g.pageId)) next.delete(g.pageId); else next.add(g.pageId);
                  return next;
                })}
              >
                <Icon name={isFolded ? "chevron-right" : "chevron-down"} size={14} />
              </button>
              <button type="button" className="backlink-page" title={`Open “${g.title}”`} onClick={() => onPageClick(g.pageId)}>
                {g.title}
              </button>
              <span className="backlink-count" aria-label={`${g.items.length} backlinks`}>{g.items.length}</span>
            </div>
            {shown.map((entry) => (
              <div
                key={entry.link.id}
                className="backlink-item"
                role="link"
                title={`Open “${entry.block!.page_title}” at this block`}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (onBlockClick) onBlockClick(entry.block!.id);
                  else onPageClick(entry.block!.page_id);
                }}
              >
                <BacklinkContent content={entry.block!.content} />
              </div>
            ))}
            {rest > 0 && (
              <button
                type="button"
                className="btn btn-sm backlinks-more"
                data-testid="backlinks-more"
                onClick={() => setExtra((prev) => new Map(prev).set(g.pageId, (prev.get(g.pageId) ?? 0) + BACKLINK_PAGE_SIZE))}
              >
                Show {Math.min(rest, BACKLINK_PAGE_SIZE)} more{rest > BACKLINK_PAGE_SIZE ? ` (of ${rest})` : ""}
              </button>
            )}
          </div>
        );
      })}
      {missing > 0 && <div className="backlinks-missing">{missing} linking block{missing === 1 ? "" : "s"} not found</div>}
    </div>
  );
}
