import { useState, useEffect } from "react";
import * as api from "../lib/api";

interface Props {
  pageId: string;
  onPageClick: (id: string) => void;
}

interface BacklinkEntry {
  link: api.Link;
  block?: api.Block;
  page?: api.Page;
}

export default function BacklinksPanel({ pageId, onPageClick }: Props) {
  const [entries, setEntries] = useState<BacklinkEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    api.getBacklinks(pageId).then(async (links) => {
      if (cancelled) return;
      // For each backlink, try to get the source block and its page
      const enriched: BacklinkEntry[] = [];
      const pages = await api.listPages(500);
      const pageMap = new Map(pages.map(p => [p.id, p]));

      for (const link of links) {
        try {
          const blocks = await api.search(link.from_block.slice(0, 8), 1);
          const block = blocks.find(b => b.id === link.from_block);
          const page = block ? pageMap.get(block.page_id) : undefined;
          enriched.push({ link, block, page });
        } catch {
          enriched.push({ link });
        }
      }
      if (!cancelled) {
        setEntries(enriched);
        setLoading(false);
      }
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
          {entry.page && <strong>{entry.page.title}: </strong>}
          {entry.block?.content.slice(0, 100) ?? entry.link.from_block.slice(0, 8)}
        </div>
      ))}
    </div>
  );
}
