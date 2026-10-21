import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import * as api from "../lib/api";
import { getRecentPages } from "../lib/recentFiles";
import { getSettings, updateSettings } from "../lib/settings";
import { openInNotebook } from "../lib/crossNotebook";
import { setPendingReveal } from "../lib/pendingReveal";
import { blockPlainText } from "../lib/plainText";
import "./tasks.css";
import { useLayer } from "../lib/layers";
import Icon from "./Icon";
import { useDialogFocus } from "../lib/dialogFocus";
import { OPEN_SHORTCUTS_EVENT } from "../lib/shortcuts";

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
  /** Page versions (local snapshots — not git sync). */
  onSync?: () => void;
  /** Git sync now. */
  onSyncNow?: () => void;
  onAskAi?: () => void;
  onAiSettings?: () => void;
  /** Dev builds only (unsafe stub): the command is hidden without it. */
  onObsidianPlugins?: () => void;
  onCssManager?: () => void;
  onSettings?: () => void;
}

interface SearchResult {
  block: api.Block;
  pageTitle?: string;
}

/** A hit in another notebook (page title or block), labelled with the notebook. */
interface OtherHit {
  key: string;
  notebookKey: string;
  notebookName: string;
  pageId: string;
  blockId?: string;
  text: string;
  pageTitle: string;
}

function flattenOthers(r: api.CrossSearch | null): OtherHit[] {
  if (!r) return [];
  const out: OtherHit[] = [];
  for (const nb of r.results) {
    for (const p of nb.pages) {
      out.push({ key: `${nb.notebook_key}:p:${p.id}`, notebookKey: nb.notebook_key, notebookName: nb.notebook_name, pageId: p.id, text: formatTitle(p.title, p.is_journal), pageTitle: p.title });
    }
    for (const b of nb.blocks) {
      out.push({ key: `${nb.notebook_key}:b:${b.block.id}`, notebookKey: nb.notebook_key, notebookName: nb.notebook_name, pageId: b.block.page_id, blockId: b.block.id, text: blockPlainText(b.block.content).text || "(empty block)", pageTitle: formatTitle(b.page_title) });
    }
  }
  return out;
}

interface Command {
  id: string;
  label: string;
  shortcut?: string;
  action: () => void;
}

export default function SearchPanel({
  open, onClose, onPageClick,
  onToggleTheme, onNewPage, onCreatePage, onJournal, onGraph, onQuery, onReview, onSync, onSyncNow, onAskAi, onAiSettings, onObsidianPlugins, onCssManager, onSettings,
}: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  // The query `results` belongs to — the "Create page" action waits for it so Enter
  // on a half-finished search never creates a page instead of opening a result.
  const [searchedQuery, setSearchedQuery] = useState("");
  const [pages, setPages] = useState<api.Page[]>([]);
  const pagesRef = useRef<api.Page[]>([]);
  pagesRef.current = pages;
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // "All notebooks": also search every other notebook (read-only, in the backend).
  const [allNotebooks, setAllNotebooks] = useState(() => getSettings().searchAllNotebooks);
  const [others, setOthers] = useState<api.CrossSearch | null>(null);
  const [othersLoading, setOthersLoading] = useState(false);
  const latestQuery = useRef("");
  // Pages that can be shown (not trashed/archived, also not via their project):
  // Recent lists only these. Null until loaded.
  const [visibleIds, setVisibleIds] = useState<Set<string> | null>(null);

  const isCommandMode = query.startsWith(">");
  const commandQuery = isCommandMode ? query.slice(1).trim().toLowerCase() : "";

  const commands = useMemo<Command[]>(() => [
    { id: "toggle-theme", label: "Toggle Theme", shortcut: "Ctrl+Shift+T", action: () => onToggleTheme?.() },
    { id: "new-page", label: "New Page", shortcut: "Ctrl+N", action: () => onNewPage?.() },
    { id: "journal", label: "Open Today's Journal", shortcut: "Ctrl+J", action: () => onJournal?.() },
    { id: "graph", label: "Open Graph View", shortcut: "Ctrl+G", action: () => onGraph?.() },
    { id: "query", label: "Open SQL Query Panel", shortcut: "Ctrl+Q", action: () => onQuery?.() },
    { id: "review", label: "Open Flashcard Review", shortcut: "Ctrl+R", action: () => onReview?.() },
    { id: "sync-now", label: "Sync Now", action: () => onSyncNow?.() },
    { id: "sync", label: "Page Versions", action: () => onSync?.() },
    { id: "ask-ai", label: "Ask AI", shortcut: "Ctrl+Shift+A", action: () => onAskAi?.() },
    { id: "ai-settings", label: "AI Settings", action: () => onAiSettings?.() },
    ...(onObsidianPlugins ? [{ id: "obsidian-plugins", label: "Obsidian Plugins (dev)", action: () => onObsidianPlugins() }] : []),
    { id: "css-snippets", label: "CSS Snippets", action: () => onCssManager?.() },
    { id: "settings", label: "Settings", shortcut: "Ctrl+,", action: () => onSettings?.() },
    { id: "shortcuts", label: "Keyboard Shortcuts", shortcut: "Ctrl+/", action: () => { window.dispatchEvent(new Event(OPEN_SHORTCUTS_EVENT)); } },
  ], [onToggleTheme, onNewPage, onJournal, onGraph, onQuery, onReview, onSync, onSyncNow, onAskAi, onAiSettings, onObsidianPlugins, onCssManager, onSettings]);

  const filteredCommands = useMemo(() => {
    if (!isCommandMode) return [];
    if (!commandQuery) return commands;
    // Labels that start with the query first (">settings" runs Settings, not AI Settings).
    const starts = (c: Command) => (c.label.toLowerCase().startsWith(commandQuery) ? 0 : 1);
    return commands.filter(c => {
      const words = commandQuery.split(/\s+/);
      const label = c.label.toLowerCase();
      return words.every(w => label.includes(w));
    }).sort((a, b) => starts(a) - starts(b));
  }, [isCommandMode, commandQuery, commands]);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      setQuery("");
      setResults([]);
      setSearchedQuery("");
      setSelectedIndex(0);
      setOthers(null);
      setAllNotebooks(getSettings().searchAllNotebooks);
      api.listPages(1000000).then(setPages).catch(() => {}); // every page, not the first N
      setVisibleIds(null);
      api.getFolderTree().then(tree => {
        const ids = new Set<string>(tree.root_pages.map(p => p.id));
        const walk = (fs: api.FolderTree[]) => { for (const f of fs) { f.pages.forEach(p => ids.add(p.id)); walk(f.children ?? []); } };
        walk(tree.folders);
        setVisibleIds(ids);
      }).catch(() => setVisibleIds(null));
    }
  }, [open]);

  const recent = visibleIds ? getRecentPages().filter(r => visibleIds.has(r.id)).slice(0, 5) : [];

  const doSearch = useCallback(async (q: string) => {
    latestQuery.current = q;
    if (q.trim().length < 2) {
      setResults([]);
      setOthers(null);
      setSearchedQuery(q);
      return;
    }
    if (allNotebooks) {
      // Other notebooks arrive on their own; the open notebook's results don't wait.
      setOthersLoading(true);
      api.searchOtherNotebooks(q).then(
        (r) => { if (latestQuery.current === q) setOthers(r); },
        () => { if (latestQuery.current === q) setOthers(null); },
      ).finally(() => { if (latestQuery.current === q) setOthersLoading(false); });
    } else {
      setOthers(null);
    }
    try {
      const blocks = await api.search(q, 20);
      // Every block result names its page (like cross-notebook ones): titles
      // from the page list, the rest in one call.
      const titles = new Map(pagesRef.current.map(p => [p.id, formatTitle(p.title, p.is_journal, p.journal_date)]));
      const missing = blocks.filter(b => !titles.has(b.page_id)).map(b => b.id);
      if (missing.length) {
        const withPages = await api.getBlocks(missing).catch(() => [] as api.BlockWithPage[]);
        for (const b of withPages) titles.set(b.page_id, formatTitle(b.page_title));
      }
      if (latestQuery.current !== q) return;
      setResults(blocks.map(b => ({ block: b, pageTitle: titles.get(b.page_id) })));
      setSelectedIndex(0);
    } catch {
      setResults([]);
    }
    setSearchedQuery(q);
  }, [allNotebooks]);

  useEffect(() => {
    if (isCommandMode) return;
    const timer = setTimeout(() => doSearch(query), 150);
    return () => clearTimeout(timer);
  }, [query, doSearch, isCommandMode]);

  // Page titles match word by word in any order ("lisbon travel" finds
  // "Travel — Lisbon 2027"); titles containing the query as typed come first.
  // (Fuzzy ranking is UX Wave 4.)
  const filteredPages = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (isCommandMode || !q) return [];
    const words = q.split(/\s+/).filter(Boolean);
    const hits = pages.filter(p => {
      const t = formatTitle(p.title, p.is_journal, p.journal_date).toLowerCase() + " " + p.title.toLowerCase();
      return words.every(w => t.includes(w));
    });
    const exact = (p: api.Page) => (p.title.toLowerCase().includes(q) ? 0 : 1);
    return hits.sort((a, b) => exact(a) - exact(b)).slice(0, 5);
  }, [pages, query, isCommandMode]);

  // "Create page “<query>”": offered once the search for this query has settled and
  // no page has exactly that title. It is the last item, so with no results it is
  // the selected one and Enter creates + opens the page.
  const createTitle = query.trim();
  const canCreate = !!onCreatePage && !isCommandMode && createTitle.length >= 2 &&
    searchedQuery === query &&
    !pages.some(p => p.title.toLowerCase() === createTitle.toLowerCase());
  const otherHits = isCommandMode || !allNotebooks ? [] : flattenOthers(others);
  const createIndex = filteredPages.length + results.length + otherHits.length;
  const openOther = (h: OtherHit) => {
    onClose();
    openInNotebook({ key: h.notebookKey, pageId: h.pageId, blockId: h.blockId });
  };
  const toggleAllNotebooks = () => {
    const next = !allNotebooks;
    updateSettings({ searchAllNotebooks: next });
    setAllNotebooks(next);
    inputRef.current?.focus();
  };
  const createFromQuery = () => { onCreatePage?.(createTitle); onClose(); };
  /** A block result opens its page at that block. */
  const openBlock = (r: SearchResult) => {
    setPendingReveal(r.block.id);
    onPageClick(r.block.page_id);
    onClose();
  };

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
      }
      return;
    }

    // Empty query: the arrows and Enter work on Recent.
    if (!query && recent.length > 0 && ["ArrowDown", "ArrowUp", "Enter"].includes(e.key)) {
      e.preventDefault();
      if (e.key === "ArrowDown") setSelectedIndex(i => Math.min(i + 1, recent.length - 1));
      else if (e.key === "ArrowUp") setSelectedIndex(i => Math.max(i - 1, 0));
      else { onPageClick(recent[Math.min(selectedIndex, recent.length - 1)].id); onClose(); }
      return;
    }
    const total = filteredPages.length + results.length + otherHits.length + (canCreate ? 1 : 0);
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
        const otherIdx = blockIdx - results.length;
        if (blockIdx < results.length) {
          openBlock(results[blockIdx]);
        } else if (otherIdx < otherHits.length) {
          openOther(otherHits[otherIdx]);
        } else if (canCreate) {
          createFromQuery();
        }
      }
    }
  };

  // Esc closes the palette when it is the topmost layer (lib/layers.ts).
  useLayer(open, "dialog", onClose);

  // Reset selection when switching modes or filtering changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [isCommandMode, commandQuery]);

  const paletteRef = useRef<HTMLDivElement>(null);
  useDialogFocus(paletteRef, open);

  if (!open) return null;

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div ref={paletteRef} className="command-palette" role="dialog" aria-modal="true" aria-label="Search" onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="command-palette-input"
          placeholder={isCommandMode ? "Type a command..." : "Search pages and blocks... (type > for commands)"}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        {!isCommandMode && (
          <div className="command-palette-scope">
            <label title="Also search every other notebook (read-only)">
              <input
                type="checkbox"
                data-testid="search-all-notebooks"
                checked={allNotebooks}
                onChange={toggleAllNotebooks}
              />
              All notebooks
            </label>
            {allNotebooks && othersLoading && <span className="command-palette-scope-note">Searching other notebooks…</span>}
          </div>
        )}
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
              {!query && recent.length > 0 && (
                <>
                  <div className="command-palette-section"><Icon name="clock" size={12} /> Recent</div>
                  {recent.map((r, i) => (
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
                      className={`command-palette-item command-palette-page ${i === selectedIndex ? "selected" : ""}`}
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
                  {results.map((r, i) => {
                    const plain = blockPlainText(r.block.content);
                    return (
                      <div
                        key={r.block.id}
                        className={`command-palette-item command-palette-block ${i + filteredPages.length === selectedIndex ? "selected" : ""}`}
                        onClick={() => openBlock(r)}
                        title={r.pageTitle ? `Go to this block in ${r.pageTitle}` : "Go to this block"}
                      >
                        {plain.state && <span className={`tasks-state tasks-state-${plain.state.toLowerCase()} command-palette-state`}>{plain.state}</span>}
                        <span className="result-content">{plain.text || "(empty block)"}</span>
                        {r.pageTitle && <span className="command-palette-block-page">{r.pageTitle}</span>}
                      </div>
                    );
                  })}
                </>
              )}
              {otherHits.length > 0 && (() => {
                let lastNb = "";
                const base = filteredPages.length + results.length;
                return otherHits.map((h, i) => {
                  const header = h.notebookKey !== lastNb;
                  lastNb = h.notebookKey;
                  return (
                    <div key={h.key}>
                      {header && (
                        <div className="command-palette-section" data-testid="search-notebook-section">
                          In notebook {h.notebookName}
                        </div>
                      )}
                      <div
                        className={`command-palette-item command-palette-other ${base + i === selectedIndex ? "selected" : ""}`}
                        data-testid="search-other-result"
                        data-notebook-key={h.notebookKey}
                        onClick={() => openOther(h)}
                        title={`Open in notebook ${h.notebookName}`}
                      >
                        <span className="xnb-badge">{h.notebookName}</span>
                        <span className="result-content">{h.text}</span>
                        {h.blockId && <span className="command-palette-other-page">{h.pageTitle}</span>}
                      </div>
                    </div>
                  );
                });
              })()}
              {allNotebooks && others && others.skipped.length > 0 && query.length >= 2 && (
                <div className="command-palette-note" data-testid="search-skipped">
                  Skipped: {others.skipped.map(s => `${s.notebook_name} (${s.label})`).join(", ")}
                </div>
              )}
              {query.length >= 2 && filteredPages.length === 0 && results.length === 0 && otherHits.length === 0 && (
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
