import { useState, useEffect } from "react";
import * as api from "../lib/api";

interface Props {
  pageId: string;
  pageTitle: string;
  onPageClick: (id: string) => void;
}

export default function UnlinkedRefsPanel({ pageId, pageTitle, onPageClick }: Props) {
  const [blocks, setBlocks] = useState<api.Block[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [hasResults, setHasResults] = useState<boolean | null>(null); // null = unknown

  // Pre-check if there are any unlinked references (lightweight)
  useEffect(() => {
    let cancelled = false;
    setHasResults(null);
    setExpanded(false);
    setBlocks([]);

    api.getUnlinkedReferences(pageId).then(results => {
      if (!cancelled) {
        setHasResults(results.length > 0);
        if (results.length > 0) setBlocks(results);
      }
    }).catch(() => { if (!cancelled) setHasResults(false); });

    return () => { cancelled = true; };
  }, [pageId]);

  // Don't render anything if no unlinked references
  if (hasResults === null || hasResults === false) return null;

  return (
    <div className="unlinked-refs">
      <h4
        className="unlinked-refs-toggle"
        onClick={() => setExpanded(e => !e)}
      >
        {expanded ? "▼" : "▶"} Unlinked References ({blocks.length})
      </h4>
      {expanded && (
        blocks.length === 0 ? (
          <div style={{ color: "var(--text-muted)", fontSize: 12, padding: "4px 0" }}>
            No unlinked mentions of "{pageTitle}" found.
          </div>
        ) : (
          blocks.map(block => (
            <div
              key={block.id}
              className="backlink-item"
              onClick={() => onPageClick(block.page_id)}
            >
              <span className="unlinked-highlight">
                {highlightMention(block.content.slice(0, 150), pageTitle)}
              </span>
            </div>
          ))
        )
      )}
    </div>
  );
}

function highlightMention(text: string, title: string) {
  const idx = text.toLowerCase().indexOf(title.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + title.length)}</mark>
      {text.slice(idx + title.length)}
    </>
  );
}
