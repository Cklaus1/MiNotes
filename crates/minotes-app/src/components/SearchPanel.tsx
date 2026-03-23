import { useState, useRef, useEffect, useCallback } from "react";
import * as api from "../lib/api";

interface Props {
  open: boolean;
  onClose: () => void;
  onPageClick: (title: string) => void;
}

interface SearchResult {
  block: api.Block;
  pageTitle?: string;
}

export default function SearchPanel({ open, onClose, onPageClick }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [pages, setPages] = useState<api.Page[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      setQuery("");
      setResults([]);
      setSelectedIndex(0);
      api.listPages(50).then(setPages).catch(() => {});
    }
  }, [open]);

  const doSearch = useCallback(async (q: string) => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    try {
      const blocks = await api.search(q, 20);
      setResults(blocks.map(b => ({ block: b })));
      setSelectedIndex(0);
    } catch {
      setResults([]);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => doSearch(query), 150);
    return () => clearTimeout(timer);
  }, [query, doSearch]);

  const filteredPages = pages.filter(p =>
    p.title.toLowerCase().includes(query.toLowerCase())
  ).slice(0, 5);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const total = filteredPages.length + results.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, total - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (selectedIndex < filteredPages.length) {
        onPageClick(filteredPages[selectedIndex].id);
        onClose();
      } else {
        const blockIdx = selectedIndex - filteredPages.length;
        if (blockIdx < results.length) {
          onPageClick(results[blockIdx].block.page_id);
          onClose();
        }
      }
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  if (!open) return null;

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="command-palette" onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="command-palette-input"
          placeholder="Search pages and blocks..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="command-palette-results">
          {filteredPages.length > 0 && (
            <>
              <div className="command-palette-section">Pages</div>
              {filteredPages.map((page, i) => (
                <div
                  key={page.id}
                  className={`command-palette-item ${i === selectedIndex ? "selected" : ""}`}
                  onClick={() => { onPageClick(page.id); onClose(); }}
                >
                  {page.is_journal ? "📅" : "📄"} {page.title}
                </div>
              ))}
            </>
          )}
          {results.length > 0 && (
            <>
              <div className="command-palette-section">Blocks</div>
              {results.map((r, i) => (
                <div
                  key={r.block.id}
                  className={`command-palette-item ${i + filteredPages.length === selectedIndex ? "selected" : ""}`}
                  onClick={() => { onPageClick(r.block.page_id); onClose(); }}
                >
                  <span className="result-content">{r.block.content.slice(0, 80)}</span>
                </div>
              ))}
            </>
          )}
          {query.length >= 2 && filteredPages.length === 0 && results.length === 0 && (
            <div className="command-palette-empty">No results</div>
          )}
          {query.length < 2 && filteredPages.length === 0 && (
            <div className="command-palette-empty">Type to search...</div>
          )}
        </div>
      </div>
    </div>
  );
}
