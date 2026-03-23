import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import * as api from "../lib/api";

interface Props {
  open: boolean;
  onClose: () => void;
  onPageClick: (title: string) => void;
  onToggleTheme?: () => void;
  onNewPage?: () => void;
  onJournal?: () => void;
  onGraph?: () => void;
  onQuery?: () => void;
  onReview?: () => void;
}

interface SearchResult {
  block: api.Block;
  pageTitle?: string;
}

interface Command {
  id: string;
  label: string;
  shortcut?: string;
  action: () => void;
}

export default function SearchPanel({
  open, onClose, onPageClick,
  onToggleTheme, onNewPage, onJournal, onGraph, onQuery, onReview,
}: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [pages, setPages] = useState<api.Page[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const isCommandMode = query.startsWith(">");
  const commandQuery = isCommandMode ? query.slice(1).trim().toLowerCase() : "";

  const commands = useMemo<Command[]>(() => [
    { id: "toggle-theme", label: "Toggle Theme", shortcut: "Ctrl+Shift+T", action: () => onToggleTheme?.() },
    { id: "new-page", label: "New Page", shortcut: "Ctrl+N", action: () => onNewPage?.() },
    { id: "journal", label: "Open Today's Journal", shortcut: "Ctrl+J", action: () => onJournal?.() },
    { id: "graph", label: "Open Graph View", shortcut: "Ctrl+G", action: () => onGraph?.() },
    { id: "query", label: "Open SQL Query Panel", shortcut: "Ctrl+Q", action: () => onQuery?.() },
    { id: "review", label: "Open Flashcard Review", shortcut: "Ctrl+R", action: () => onReview?.() },
    { id: "export-markdown", label: "Export Markdown", action: () => alert("Markdown export coming soon.") },
  ], [onToggleTheme, onNewPage, onJournal, onGraph, onQuery, onReview]);

  const filteredCommands = useMemo(() => {
    if (!isCommandMode) return [];
    if (!commandQuery) return commands;
    return commands.filter(c => {
      const words = commandQuery.split(/\s+/);
      const label = c.label.toLowerCase();
      return words.every(w => label.includes(w));
    });
  }, [isCommandMode, commandQuery, commands]);

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
    if (isCommandMode) return;
    const timer = setTimeout(() => doSearch(query), 150);
    return () => clearTimeout(timer);
  }, [query, doSearch, isCommandMode]);

  const filteredPages = isCommandMode ? [] : pages.filter(p =>
    p.title.toLowerCase().includes(query.toLowerCase())
  ).slice(0, 5);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (isCommandMode) {
      const total = filteredCommands.length;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex(i => Math.min(i + 1, total - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (selectedIndex < filteredCommands.length) {
          filteredCommands[selectedIndex].action();
          onClose();
        }
      } else if (e.key === "Escape") {
        onClose();
      }
      return;
    }

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

  // Reset selection when switching modes or filtering changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [isCommandMode, commandQuery]);

  if (!open) return null;

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="command-palette" onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="command-palette-input"
          placeholder={isCommandMode ? "Type a command..." : "Search pages and blocks... (type > for commands)"}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="command-palette-results">
          {isCommandMode ? (
            <>
              <div className="command-palette-section">Commands</div>
              {filteredCommands.map((cmd, i) => (
                <div
                  key={cmd.id}
                  className={`command-palette-item ${i === selectedIndex ? "selected" : ""}`}
                  onClick={() => { cmd.action(); onClose(); }}
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                >
                  <span>{cmd.label}</span>
                  {cmd.shortcut && <span className="shortcut-hint">{cmd.shortcut}</span>}
                </div>
              ))}
              {filteredCommands.length === 0 && (
                <div className="command-palette-empty">No matching commands</div>
              )}
            </>
          ) : (
            <>
              {filteredPages.length > 0 && (
                <>
                  <div className="command-palette-section">Pages</div>
                  {filteredPages.map((page, i) => (
                    <div
                      key={page.id}
                      className={`command-palette-item ${i === selectedIndex ? "selected" : ""}`}
                      onClick={() => { onPageClick(page.id); onClose(); }}
                    >
                      {page.is_journal ? "\uD83D\uDCC5" : "\uD83D\uDCC4"} {page.title}
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
                <div className="command-palette-empty">
                  Type to search... or <strong>&gt;</strong> for commands
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
