import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import * as api from "../lib/api";
import { getRecentPages } from "../lib/recentFiles";

function formatTitle(title: string, isJournal?: boolean, journalDate?: string): string {
  const dateStr = journalDate ?? (title.startsWith("Journal/") ? title.slice(8) : null);
  if ((isJournal || title.startsWith("Journal/")) && dateStr) {
    try {
      const [y, m, d] = dateStr.split("-").map(Number);
      return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    } catch { /* fall through */ }
  }
  return title;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onPageClick: (title: string) => void;
  onToggleTheme?: () => void;
  onNewPage?: () => void;
  /** Create a page with this title and open it ("Create page" action for unmatched queries). */
  onCreatePage?: (title: string) => void;
  onJournal?: () => void;
  onGraph?: () => void;
  onQuery?: () => void;
  onReview?: () => void;
  onSync?: () => void;
  onObsidianPlugins?: () => void;
  onCssManager?: () => void;
  onSettings?: () => void;
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
  onToggleTheme, onNewPage, onCreatePage, onJournal, onGraph, onQuery, onReview, onSync, onObsidianPlugins, onCssManager, onSettings,
}: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  // The query `results` belongs to — the "Create page" action waits for it so Enter
  // on a half-finished search never creates a page instead of opening a result.
  const [searchedQuery, setSearchedQuery] = useState("");
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
    { id: "sync", label: "Sync & Version History", action: () => onSync?.() },
    { id: "obsidian-plugins", label: "Obsidian Plugins", action: () => onObsidianPlugins?.() },
    { id: "css-snippets", label: "CSS Snippets", action: () => onCssManager?.() },
    { id: "settings", label: "Settings", action: () => onSettings?.() },
  ], [onToggleTheme, onNewPage, onJournal, onGraph, onQuery, onReview, onSync, onObsidianPlugins, onCssManager, onSettings]);

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
      setSearchedQuery("");
      setSelectedIndex(0);
      api.listPages(1000).then(setPages).catch(() => {});
    }
  }, [open]);

  const doSearch = useCallback(async (q: string) => {
    if (q.trim().length < 2) {
      setResults([]);
      setSearchedQuery(q);
      return;
    }
    try {
      const blocks = await api.search(q, 20);
      setResults(blocks.map(b => ({ block: b })));
      setSelectedIndex(0);
    } catch {
      setResults([]);
    }
    setSearchedQuery(q);
  }, []);

  useEffect(() => {
    if (isCommandMode) return;
    const timer = setTimeout(() => doSearch(query), 150);
    return () => clearTimeout(timer);
  }, [query, doSearch, isCommandMode]);

  const filteredPages = isCommandMode || !query.trim() ? [] : pages.filter(p =>
    p.title.toLowerCase().includes(query.toLowerCase())
  ).slice(0, 5);

  // "Create page “<query>”": offered once the search for this query has settled and
  // no page has exactly that title. It is the last item, so with no results it is
  // the selected one and Enter creates + opens the page.
  const createTitle = query.trim();
  const canCreate = !!onCreatePage && !isCommandMode && createTitle.length >= 2 &&
    searchedQuery === query &&
    !pages.some(p => p.title.toLowerCase() === createTitle.toLowerCase());
  const createIndex = filteredPages.length + results.length;
  const createFromQuery = () => { onCreatePage?.(createTitle); onClose(); };

  // Close the palette FIRST: many commands open another panel through the same
  // "which panel is open" state, and closing afterwards would clear it again.
  const runCommand = (cmd: Command) => {
    onClose();
    cmd.action();
  };

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
        if (selectedIndex < filteredCommands.length) runCommand(filteredCommands[selectedIndex]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
      return;
    }

    const total = filteredPages.length + results.length + (canCreate ? 1 : 0);
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
        } else if (canCreate) {
          createFromQuery();
        }
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
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
                  onClick={() => runCommand(cmd)}
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
              {!query && getRecentPages().length > 0 && (
                <>
                  <div className="command-palette-section">&#128336; Recent</div>
                  {getRecentPages().slice(0, 5).map((r, i) => (
                    <div
                      key={r.id}
                      className={`command-palette-item ${i === selectedIndex ? "selected" : ""}`}
                      onClick={() => { onPageClick(r.id); onClose(); }}
                    >
                      {formatTitle(r.title)}
                    </div>
                  ))}
                </>
              )}
              {filteredPages.length > 0 && (
                <>
                  {filteredPages.map((page, i) => (
                    <div
                      key={page.id}
                      className={`command-palette-item ${i === selectedIndex ? "selected" : ""}`}
                      onClick={() => { onPageClick(page.id); onClose(); }}
                    >
                      {formatTitle(page.title, page.is_journal, page.journal_date)}
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
                <div className="command-palette-empty">No results for &ldquo;{createTitle}&rdquo;</div>
              )}
              {canCreate && (
                <div
                  className={`command-palette-item command-palette-create ${createIndex === selectedIndex ? "selected" : ""}`}
                  onClick={createFromQuery}
                  title="Create a new page with this title"
                >
                  <span><span className="command-palette-create-plus">+</span> Create page &ldquo;{createTitle}&rdquo;</span>
                  {createIndex === selectedIndex && <span className="shortcut-hint">Enter</span>}
                </div>
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
