import { useState, useEffect } from "react";
import * as api from "../lib/api";

interface Props {
  pageId: string;
  onPageClick: (id: string) => void;
}

interface BacklinkEntry {
  link: api.Link;
  block?: api.BlockWithPage;
}

export default function BacklinksPanel({ pageId, onPageClick }: Props) {
  const [entries, setEntries] = useState<BacklinkEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    api.getBacklinks(pageId).then((links) => {
      if (cancelled) return;
      // get_backlinks returns each link with its source block and page title in
      // one call (it used to be one get_block call per link).
      setEntries(links.map(link => ({ link, block: link.block })));
      setLoading(false);
    }).catch(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [pageId]);

  if (loading) return null;
  if (entries.length === 0) return null;

  return (
    <div className="backlinks">
      <h4>Backlinks ({entries.length})</h4>
      {entries.map(entry => (
        <div
          key={entry.link.id}
          className="backlink-item"
          onClick={() => entry.block && onPageClick(entry.block.page_id)}
        >
          {entry.block && <strong>{entry.block.page_title}: </strong>}
          {entry.block?.content.slice(0, 100) ?? "(block not found)"}
        </div>
      ))}
    </div>
  );
}
