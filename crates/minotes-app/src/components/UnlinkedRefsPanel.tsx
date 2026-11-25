import { useState, useEffect, useMemo } from "react";
import * as api from "../lib/api";
import { blockPlainText } from "../lib/plainText";
import { findUnlinkedMention, linkFirstMention } from "../lib/linkMention";
import { groupByPage, BACKLINK_PAGE_SIZE } from "../lib/backlinkGroups";
import { undoStack } from "../lib/undoStack";
import { executeUndo } from "../lib/undoManager";
import { noteBlockContent } from "../lib/blockRefs";
import { showToast, showUndoToast } from "../lib/toast";
import { errorMessage } from "../lib/errors";
import Icon from "./Icon";

interface Props {
  pageId: string;
  pageTitle: string;
  onPageClick: (id: string) => void;
  /** Open the mentioning block itself (its page, scrolled to and highlighted). */
  onBlockClick?: (blockId: string) => void;
  /** A mention was linked (or unlinked again): the backlinks changed. */
  onLinked?: () => void;
}

type Mention = api.Block & { page_title?: string };

/**
 * Unlinked mentions of this page (blocks that name it without a [[link]]),
 * grouped by page, each with a one-click "Link" that wraps the mention in
 * [[ ]] in its block (undoable: the toast's Undo or Ctrl+Z).
 */
export default function UnlinkedRefsPanel({ pageId, pageTitle, onPageClick, onBlockClick, onLinked }: Props) {
  const [blocks, setBlocks] = useState<Mention[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [hasResults, setHasResults] = useState<boolean | null>(null); // null = unknown
  const [limit, setLimit] = useState(BACKLINK_PAGE_SIZE);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setHasResults(null);
    setBlocks([]);
    setLimit(BACKLINK_PAGE_SIZE);
    api.getUnlinkedReferences(pageId).then(async (results) => {
      if (cancelled) return;
      // Which page each mention is on (one call for all of them).
      const titles = new Map<string, string>();
      try {
        for (const b of await api.getBlocks(results.map((r) => r.id))) titles.set(b.id, b.page_title);
      } catch { /* titles stay unknown */ }
      if (cancelled) return;
      setBlocks(results.map((r) => ({ ...r, page_title: titles.get(r.id) })));
      setHasResults(results.length > 0);
    }).catch(() => { if (!cancelled) setHasResults(false); });
    return () => { cancelled = true; };
  }, [pageId, pageTitle, reload]);

  // A new page: start collapsed again.
  useEffect(() => { setExpanded(false); }, [pageId]);

  const groups = useMemo(() => groupByPage(blocks, (b) => b.page_id, (b) => b.page_title ?? ""), [blocks]);

  const link = async (b: Mention) => {
    const next = linkFirstMention(b.content, pageTitle);
    if (!next) { showToast("Nothing left to link in that block"); return; }
    try {
      await api.updateBlock(b.id, next);
    } catch (e) {
      showToast(`Couldn't link it: ${errorMessage(e)}`);
      return;
    }
    noteBlockContent(b.id, next);
    const entry = { type: "update" as const, blockId: b.id, pageId: b.page_id, oldContent: b.content, newContent: next, timestamp: Date.now() };
    undoStack.push(entry);
    setBlocks((prev) => prev.filter((x) => x.id !== b.id));
    onLinked?.();
    showUndoToast(`Linked “${pageTitle}” in “${b.page_title ?? "a page"}”`, () => {
      const undo = undoStack.peekUndo() === entry
        ? executeUndo()
        : api.updateBlock(b.id, b.content);
      Promise.resolve(undo)
        .then(() => { noteBlockContent(b.id, b.content); onLinked?.(); setReload((n) => n + 1); })
        .catch((e) => showToast(`Couldn't undo: ${errorMessage(e)}`));
    }, 8000);
  };

  if (hasResults === null || hasResults === false || blocks.length === 0) return null;

  let budget = limit;
  let hidden = 0;

  return (
    <div className="unlinked-refs" data-testid="unlinked-refs">
      <h4 className="unlinked-refs-toggle">
        <button type="button" className="unlinked-refs-toggle-btn" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}>
          <Icon name={expanded ? "chevron-down" : "chevron-right"} size={14} />
          Unlinked mentions ({blocks.length})
        </button>
      </h4>
      {expanded && groups.map((g) => {
        const shown = g.items.slice(0, Math.max(0, budget));
        budget -= shown.length;
        hidden += g.items.length - shown.length;
        if (!shown.length) return null;
        return (
          <div className="backlink-group" key={g.pageId} data-page-id={g.pageId}>
            <div className="backlink-group-header">
              <button type="button" className="backlink-page" title={`Open “${g.title}”`} onClick={() => onPageClick(g.pageId)}>
                {g.title}
              </button>
              <span className="backlink-count">{g.items.length}</span>
            </div>
            {shown.map((block) => (
              <div
                key={block.id}
                className="backlink-item unlinked-item"
                role="link"
                title={`Open “${g.title}” at this block`}
                onClick={() => (onBlockClick ? onBlockClick(block.id) : onPageClick(block.page_id))}
              >
                <span className="unlinked-highlight">{highlightMention(block.content, pageTitle)}</span>
                <button
                  type="button"
                  className="btn btn-sm unlinked-link-btn"
                  data-testid="unlinked-link"
                  title={`Make this mention a link to “${pageTitle}”`}
                  disabled={!findUnlinkedMention(block.content, pageTitle)}
                  onClick={(e) => { e.stopPropagation(); void link(block); }}
                >
                  <Icon name="link" size={13} /> Link
                </button>
              </div>
            ))}
          </div>
        );
      })}
      {expanded && hidden > 0 && (
        <button type="button" className="btn btn-sm backlinks-more" onClick={() => setLimit((l) => l + BACKLINK_PAGE_SIZE)}>
          Show {Math.min(hidden, BACKLINK_PAGE_SIZE)} more ({hidden} not shown)
        </button>
      )}
    </div>
  );
}

/** The block as plain text (no markup) with the mention marked; long text is cut around it. */
function highlightMention(content: string, title: string) {
  const text = blockPlainText(content).text;
  const idx = text.toLowerCase().indexOf(title.toLowerCase());
  if (idx === -1) return text.slice(0, 160);
  const from = Math.max(0, idx - 60);
  const to = Math.min(text.length, idx + title.length + 90);
  return (
    <>
      {from > 0 ? "…" : ""}{text.slice(from, idx)}
      <mark>{text.slice(idx, idx + title.length)}</mark>
      {text.slice(idx + title.length, to)}{to < text.length ? "…" : ""}
    </>
  );
}
