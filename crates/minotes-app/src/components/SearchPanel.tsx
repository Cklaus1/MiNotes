import { useState, useRef, useEffect, useCallback, useMemo, useSyncExternalStore, type ReactNode } from "react";
import * as api from "../lib/api";
import { getRecentPages } from "../lib/recentFiles";
import { getSettings, updateSettings } from "../lib/settings";
import { openInNotebook } from "../lib/crossNotebook";
import { setPendingReveal } from "../lib/pendingReveal";
import { blockPlainText } from "../lib/plainText";
import "./tasks.css";
import "./navigation.css";
import { useLayer } from "../lib/layers";
import { canOpenInTab, openModeFrom, openInTab, preventMiddlePaste, type OpenMode } from "../lib/openIntent";
import { ContextMenuPortal } from "../lib/ContextMenuPortal";
import Icon from "./Icon";
import { useDialogFocus } from "../lib/dialogFocus";
import { highlightParts, rankByFuzzy, snippetAround, type Range } from "../lib/fuzzy";
import {
  commandsRevision, listCommands, noteCommandRun, rankCommands, recentCommandIds, subscribeCommands,
  type ListedCommand, type PickItem,
} from "../lib/commands";

function formatTitle(title: string, isJournal?: boolean, journalDate?: string): string {
  const dateStr = journalDate ?? (title.startsWith("Journal/") ? title.slice(8) : null);
  if ((isJournal || title.startsWith("Journal/")) && dateStr) {
    try {
      const [y, m, d] = dateStr.split("-").map(Number);
      const dt = new Date(y, m - 1, d);
      if (!isNaN(dt.getTime())) return dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
    } catch { /* fall through */ }
  }
  return title;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onPageClick: (id: string) => void;
  /** Create a page with this title and open it ("Create page" row for unmatched queries). */
  onCreatePage?: (title: string) => void;
}

type Filter = "all" | "pages" | "blocks" | "journals";
const FILTERS: Array<[Filter, string]> = [["all", "All"], ["pages", "Pages"], ["blocks", "Blocks"], ["journals", "Journals"]];

/** One selectable row; sections group them under a header. */
interface Row {
  key: string;
  className: string;
  content: ReactNode;
  title?: string;
  testId?: string;
  data?: Record<string, string>;
  disabled?: string;
  run: () => void;
  /** Page rows: the page this row opens, so Ctrl/middle-click and Ctrl+Enter can open it in a tab. */
  page?: { id: string; title: string };
}
interface Section {
  key: string;
  /** Header text (none for the "Create page" row). */
  title?: ReactNode;
  testId?: string;
  rows: Row[];
  /** Rendered after the rows (a note). */
  after?: ReactNode;
}

/** Text with the matched parts marked. */
function Hl({ text, ranges }: { text: string; ranges: readonly Range[] }) {
  if (!ranges.length) return <>{text}</>;
  return (
    <>
      {highlightParts(text, ranges).map((p, i) =>
        p.hit ? <mark key={i} className="palette-hit">{p.text}</mark> : <span key={i}>{p.text}</span>)}
    </>
  );
}

const PAGE_LIMIT = { all: 6, focused: 60 };
const BLOCK_LIMIT = { all: 8, focused: 40 };

export default function SearchPanel({ open, onClose, onPageClick, onCreatePage }: Props) {
  const [query, setQuery] = useState("");
  // Right-click on a page result: Open / Open in new tab (PRD-tabs §3.2).
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; page: { id: string; title: string } } | null>(null);
  useEffect(() => { if (!open) setRowMenu(null); }, [open]);
  const [filter, setFilter] = useState<Filter>("all");
  const [results, setResults] = useState<api.Block[]>([]);
  const [blockPages, setBlockPages] = useState<Map<string, { title: string; journal: boolean }>>(new Map());
  // The query `results` belongs to — the "Create page" row waits for it so Enter
  // on a half-finished search never creates a page instead of opening a result.
  const [searchedQuery, setSearchedQuery] = useState("");
  const [pages, setPages] = useState<api.Page[]>([]);
  const pagesRef = useRef<api.Page[]>([]);
  pagesRef.current = pages;
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  // "All notebooks": also search every other notebook (read-only, in the backend).
  const [allNotebooks, setAllNotebooks] = useState(() => getSettings().searchAllNotebooks);
  const [others, setOthers] = useState<api.CrossSearch | null>(null);
  const [othersLoading, setOthersLoading] = useState(false);
  const latestQuery = useRef("");
  // Pages that can be shown (not trashed/archived, also not via their project):
  // Recent lists only these. Null until loaded.
  const [visibleIds, setVisibleIds] = useState<Set<string> | null>(null);
  // A command that asks for one more choice (notebook, project…).
  const [picker, setPicker] = useState<{ cmd: ListedCommand; items: PickItem[] | null } | null>(null);
  const commandsVersion = useSyncExternalStore(subscribeCommands, commandsRevision, commandsRevision);

  const isCommandMode = !picker && query.startsWith(">");
  const commandQuery = isCommandMode ? query.slice(1).trim() : "";

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      setQuery("");
      setFilter("all");
      setPicker(null);
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
      const blocks = await api.search(q, 40);
      // Every block result names its page: titles from the page list, the rest in one call.
      const byId = new Map(pagesRef.current.map(p => [p.id, { title: formatTitle(p.title, p.is_journal, p.journal_date), journal: p.is_journal }]));
      const missing = blocks.filter(b => !byId.has(b.page_id)).map(b => b.id);
      if (missing.length) {
        const withPages = await api.getBlocks(missing).catch(() => [] as api.BlockWithPage[]);
        for (const b of withPages) byId.set(b.page_id, { title: formatTitle(b.page_title), journal: b.page_title.startsWith("Journal/") });
      }
      if (latestQuery.current !== q) return;
      setBlockPages(byId);
      setResults(blocks);
    } catch {
      setResults([]);
    }
    setSearchedQuery(q);
  }, [allNotebooks]);

  useEffect(() => {
    if (isCommandMode || picker) return;
    const timer = setTimeout(() => doSearch(query), 120);
    return () => clearTimeout(timer);
  }, [query, doSearch, isCommandMode, picker]);

  // ── Ranking (lib/fuzzy.ts): prefix > word start > inside a word > words in any order > letters in order > typos ──
  const q = query.trim();
  const searching = !isCommandMode && !picker && q.length > 0;
  const rankedPages = useMemo(() => {
    if (!searching) return { pages: [], journals: [] };
    const plain = pages.filter(p => !p.is_journal);
    const journals = pages.filter(p => p.is_journal);
    return {
      pages: rankByFuzzy(plain, q, p => p.title, { limit: PAGE_LIMIT.focused }),
      // A day is found by its date as shown ("oct 17") or as written (2026-10-17).
      journals: rankByFuzzy(journals, q, p => `${formatTitle(p.title, true, p.journal_date)} · ${p.journal_date ?? p.title}`, { limit: PAGE_LIMIT.focused }),
    };
  }, [pages, q, searching]);

  const recent = !query && !picker && visibleIds ? getRecentPages().filter(r => visibleIds.has(r.id)).slice(0, 6) : [];

  const createTitle = q;
  const canCreate = !!onCreatePage && searching && (filter === "all" || filter === "pages") && createTitle.length >= 2 &&
    searchedQuery === query &&
    !pages.some(p => p.title.toLowerCase() === createTitle.toLowerCase());

  const close = onClose;
  const openPage = (id: string) => { onPageClick(id); close(); };
  /** Page rows and the Recent list: a new tab (Ctrl/middle-click, Ctrl+Enter) or, with no tab handler, as a plain open. */
  const openPageIn = (pg: { id: string; title: string }, mode: OpenMode): boolean => {
    if (!openInTab({ notebook: "", kind: "page", pageId: pg.id, title: pg.title }, mode)) return false;
    close();
    return true;
  };
  const openBlock = (b: api.Block) => { setPendingReveal(b.id); onPageClick(b.page_id); close(); };
  const runCommand = (cmd: ListedCommand) => {
    noteCommandRun(cmd.id);
    if (cmd.pick) {
      const pick = cmd.pick;
      setPicker({ cmd, items: null });
      setQuery("");
      setSelectedIndex(0);
      Promise.resolve(pick.items()).then(
        items => setPicker(p => (p && p.cmd.id === cmd.id ? { cmd, items } : p)),
        () => setPicker(p => (p && p.cmd.id === cmd.id ? { cmd, items: [] } : p)),
      );
      inputRef.current?.focus();
      return;
    }
    // Close the palette FIRST: many commands open another panel through the
    // same "which panel is open" state, and closing afterwards would clear it.
    close();
    void cmd.run?.();
  };

  // ── The rows, in sections ──
  const sections: Section[] = useMemo(() => {
    void commandsVersion;
    const out: Section[] = [];
    if (picker) {
      const items = picker.items ?? [];
      const ranked = rankByFuzzy(items, q, i => i.label, {});
      out.push({
        key: "pick", title: picker.cmd.label.replace(/…$/, ""), rows: ranked.map(({ item, match }) => ({
          key: `pick:${item.id}`,
          className: "command-palette-item command-palette-pick",
          disabled: item.disabled,
          title: item.disabled,
          testId: "palette-pick-item",
          content: <><span className="palette-label"><Hl text={item.label} ranges={match.ranges} /></span>{item.detail && <span className="palette-detail">{item.detail}</span>}</>,
          run: () => { if (item.disabled) return; close(); void picker.cmd.pick!.onPick(item); },
        })),
      });
      return out;
    }
    if (isCommandMode) {
      const recentIds = recentCommandIds();
      const cmds = listCommands();
      const ranked = rankCommands(cmds, commandQuery, recentIds);
      out.push({
        key: "commands", title: "Commands", rows: ranked.map(({ cmd, ranges }) => ({
          key: `cmd:${cmd.id}`,
          className: "command-palette-item command-palette-command",
          data: { commandId: cmd.id },
          testId: "palette-command",
          content: <>
            <span className="palette-label"><Hl text={cmd.label} ranges={ranges} /></span>
            {!commandQuery && recentIds.includes(cmd.id) && <span className="palette-detail">recent</span>}
            {cmd.shortcut && <span className="shortcut-hint">{cmd.shortcut}</span>}
          </>,
          run: () => runCommand(cmd),
        })),
      });
      return out;
    }
    if (!query) {
      if (recent.length) {
        out.push({
          key: "recent", title: <><Icon name="clock" size={12} /> Recent</>, rows: recent.map(r => ({
            key: `recent:${r.id}`, className: "command-palette-item command-palette-recent",
            content: formatTitle(r.title), run: () => openPage(r.id), page: { id: r.id, title: r.title },
          })),
        });
      }
      return out;
    }
    const focused = filter !== "all";
    const pageRows: Row[] = (filter === "all" || filter === "pages")
      ? rankedPages.pages.slice(0, focused ? PAGE_LIMIT.focused : PAGE_LIMIT.all).map(({ item: p, match }) => ({
        key: `page:${p.id}`, className: "command-palette-item command-palette-page",
        data: { pageId: p.id },
        content: <><Icon name="page" size={13} className="palette-icon" /><span className="palette-label"><Hl text={p.title} ranges={match.ranges} /></span></>,
        run: () => openPage(p.id),
        page: { id: p.id, title: p.title },
      }))
      : [];
    const blockRow = (b: api.Block): Row => {
      const plain = blockPlainText(b.content);
      const snip = snippetAround(plain.text || "(empty block)", q);
      const where = blockPages.get(b.page_id)?.title;
      return {
        key: `block:${b.id}`, className: "command-palette-item command-palette-block",
        title: where ? `Go to this block in ${where}` : "Go to this block",
        content: <>
          {plain.state && <span className={`tasks-state tasks-state-${plain.state.toLowerCase()} command-palette-state`}>{plain.state}</span>}
          <span className="result-content"><Hl text={snip.text} ranges={snip.ranges} /></span>
          {where && <span className="command-palette-block-page">{where}</span>}
        </>,
        run: () => openBlock(b),
      };
    };
    const isJournalBlock = (b: api.Block) => !!blockPages.get(b.page_id)?.journal;
    const blockRows: Row[] = (filter === "all" || filter === "blocks")
      ? results.filter(b => !isJournalBlock(b)).slice(0, focused ? BLOCK_LIMIT.focused : BLOCK_LIMIT.all).map(blockRow)
      : [];
    const journalRows: Row[] = (filter === "all" || filter === "journals")
      ? [
        ...rankedPages.journals.slice(0, focused ? PAGE_LIMIT.focused : 4).map(({ item: p, match }) => {
          const label = formatTitle(p.title, true, p.journal_date);
          return {
            key: `journal:${p.id}`, className: "command-palette-item command-palette-page command-palette-journal",
            data: { pageId: p.id },
            content: <><Icon name="calendar" size={13} className="palette-icon" /><span className="palette-label"><Hl text={label} ranges={match.ranges.filter(([s]) => s < label.length)} /></span></>,
            run: () => openPage(p.id),
            page: { id: p.id, title: p.title },
          };
        }),
        ...results.filter(isJournalBlock).slice(0, focused ? BLOCK_LIMIT.focused : 4).map(blockRow),
      ]
      : [];
    if (pageRows.length) out.push({ key: "pages", title: "Pages", testId: "search-section-pages", rows: pageRows });
    if (blockRows.length) out.push({ key: "blocks", title: "Blocks", testId: "search-section-blocks", rows: blockRows });
    if (journalRows.length) out.push({ key: "journals", title: "Journals", testId: "search-section-journals", rows: journalRows });
    if (filter === "all" && allNotebooks && others) {
      for (const nb of others.results) {
        const rows: Row[] = [
          ...nb.pages.map(p => {
            const label = formatTitle(p.title, p.is_journal);
            const m = rankByFuzzy([label], q, s => s)[0]?.match;
            return {
              key: `${nb.notebook_key}:p:${p.id}`, className: "command-palette-item command-palette-other",
              testId: "search-other-result", data: { notebookKey: nb.notebook_key }, title: `Open in notebook ${nb.notebook_name}`,
              content: <><span className="xnb-badge">{nb.notebook_name}</span><span className="result-content"><Hl text={label} ranges={m?.ranges ?? []} /></span></>,
              run: () => { close(); openInNotebook({ key: nb.notebook_key, pageId: p.id }); },
            };
          }),
          ...nb.blocks.map(b => {
            const snip = snippetAround(blockPlainText(b.block.content).text || "(empty block)", q);
            return {
              key: `${nb.notebook_key}:b:${b.block.id}`, className: "command-palette-item command-palette-other",
              testId: "search-other-result", data: { notebookKey: nb.notebook_key }, title: `Open in notebook ${nb.notebook_name}`,
              content: <>
                <span className="xnb-badge">{nb.notebook_name}</span>
                <span className="result-content"><Hl text={snip.text} ranges={snip.ranges} /></span>
                <span className="command-palette-other-page">{formatTitle(b.page_title)}</span>
              </>,
              run: () => { close(); openInNotebook({ key: nb.notebook_key, pageId: b.block.page_id, blockId: b.block.id }); },
            };
          }),
        ];
        if (rows.length) {
          out.push({
            key: `nb:${nb.notebook_key}`,
            title: <>Other notebooks · <span data-testid="search-notebook-section">In notebook {nb.notebook_name}</span></>,
            testId: "search-section-other",
            rows,
          });
        }
      }
    }
    if (canCreate) {
      out.push({
        key: "create", rows: [{
          key: "create", className: "command-palette-item command-palette-create",
          title: "Create a new page with this title",
          content: <span><span className="command-palette-create-plus">+</span> Create page &ldquo;{createTitle}&rdquo;</span>,
          run: () => { onCreatePage?.(createTitle); close(); },
        }],
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picker, isCommandMode, commandQuery, query, q, filter, rankedPages, results, blockPages, allNotebooks, others, canCreate, recent.map(r => r.id).join(), commandsVersion]);

  const rows = useMemo(() => sections.flatMap(s => s.rows), [sections]);
  const sel = Math.min(selectedIndex, Math.max(rows.length - 1, 0));

  // Reset the selection when what is listed changes kind.
  useEffect(() => { setSelectedIndex(0); }, [isCommandMode, commandQuery, filter, picker?.cmd.id, q]);
  // With no results but a "Create page" row, that row is the one Enter runs.
  useEffect(() => {
    if (canCreate && rows.length === 1) setSelectedIndex(0);
  }, [canCreate, rows.length]);
  // Keep the selected row in view.
  useEffect(() => {
    resultsRef.current?.querySelector(".command-palette-item.selected")?.scrollIntoView({ block: "nearest" });
  }, [sel, rows.length]);

  const cycleFilter = (dir: 1 | -1) => {
    const i = FILTERS.findIndex(([f]) => f === filter);
    setFilter(FILTERS[(i + dir + FILTERS.length) % FILTERS.length][0]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex(Math.min(sel + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex(Math.max(sel - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Enter before the search for this query settled never creates a page.
      const row = rows[sel];
      // Ctrl/⌘+Enter on a page result: a new tab, switched to.
      if (row?.page && (e.ctrlKey || e.metaKey) && openPageIn(row.page, "foreground")) return;
      if (row && !(row.key === "create" && searchedQuery !== query)) row.run();
    } else if (e.key === "Tab" && !isCommandMode && !picker) {
      e.preventDefault();
      cycleFilter(e.shiftKey ? -1 : 1);
    } else if (e.key === "Backspace" && picker && !query) {
      e.preventDefault();
      setPicker(null);
      setQuery(">");
    }
  };

  // Esc closes the palette when it is the topmost layer (lib/layers.ts).
  useLayer(open, "dialog", onClose);

  const toggleAllNotebooks = () => {
    const next = !allNotebooks;
    updateSettings({ searchAllNotebooks: next });
    setAllNotebooks(next);
    inputRef.current?.focus();
  };

  const paletteRef = useRef<HTMLDivElement>(null);
  useDialogFocus(paletteRef, open);

  if (!open) return null;

  const placeholder = picker ? picker.cmd.pick!.placeholder
    : isCommandMode ? "Type a command…"
    : "Search pages and blocks… (type > for commands)";
  const nothing = rows.length === 0;
  let index = 0;

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div ref={paletteRef} className="command-palette" role="dialog" aria-modal="true" aria-label={isCommandMode || picker ? "Commands" : "Search"} onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="command-palette-input"
          placeholder={placeholder}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label={placeholder}
          role="combobox"
          aria-expanded="true"
          aria-controls="command-palette-results"
        />
        {!isCommandMode && !picker && (
          <div className="command-palette-scope">
            <div className="palette-filters" role="tablist" aria-label="Show">
              {FILTERS.map(([f, label]) => (
                <button
                  key={f}
                  type="button"
                  role="tab"
                  tabIndex={-1}
                  aria-selected={filter === f}
                  className={`palette-filter${filter === f ? " active" : ""}`}
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => { setFilter(f); inputRef.current?.focus(); }}
                  data-testid={`search-filter-${f}`}
                >
                  {label}
                </button>
              ))}
            </div>
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
        <div className="command-palette-results" id="command-palette-results" role="listbox" ref={resultsRef}>
          {sections.map(s => (
            <div key={s.key} className="command-palette-group" data-testid={s.testId}>
              {s.title && <div className="command-palette-section">{s.title}</div>}
              {s.rows.map(r => {
                const i = index++;
                const dataAttrs = Object.fromEntries(Object.entries(r.data ?? {}).map(([k, v]) => [`data-${k.replace(/[A-Z]/g, c => "-" + c.toLowerCase())}`, v]));
                return (
                  <div
                    key={r.key}
                    role="option"
                    aria-selected={i === sel}
                    aria-disabled={r.disabled ? true : undefined}
                    className={`${r.className}${i === sel ? " selected" : ""}${r.disabled ? " disabled" : ""}`}
                    onMouseDown={e => { e.preventDefault(); preventMiddlePaste(e); }}
                    onClick={e => { if (r.page && openPageIn(r.page, openModeFrom(e))) return; r.run(); }}
                    onAuxClick={e => { if (e.button === 1 && r.page) { e.preventDefault(); openPageIn(r.page, "background"); } }}
                    onContextMenu={e => {
                      if (!r.page || !canOpenInTab()) return;
                      e.preventDefault();
                      setSelectedIndex(i);
                      setRowMenu({ x: e.clientX, y: e.clientY, page: r.page });
                    }}
                    title={r.title}
                    data-testid={r.testId}
                    {...dataAttrs}
                  >
                    {r.content}
                    {r.key === "create" && i === sel && <span className="shortcut-hint">Enter</span>}
                  </div>
                );
              })}
            </div>
          ))}
          {!isCommandMode && !picker && allNotebooks && others && others.skipped.length > 0 && query.length >= 2 && (
            <div className="command-palette-note" data-testid="search-skipped">
              Skipped: {others.skipped.map(s => `${s.notebook_name} (${s.label})`).join(", ")}
            </div>
          )}
          {picker && picker.items === null && <div className="command-palette-empty">Loading…</div>}
          {picker && picker.items !== null && nothing && <div className="command-palette-empty">Nothing matches</div>}
          {isCommandMode && nothing && <div className="command-palette-empty">No matching commands</div>}
          {searching && q.length >= 2 && searchedQuery === query && rows.filter(r => r.key !== "create").length === 0 && (
            <div className="command-palette-empty">
              No {filter === "all" ? "results" : FILTERS.find(([f]) => f === filter)![1].toLowerCase()} for &ldquo;{createTitle}&rdquo;
            </div>
          )}
          {!query && !picker && recent.length === 0 && (
            <div className="command-palette-empty">
              Type to search… or <strong>&gt;</strong> for commands
            </div>
          )}
        </div>
        {rowMenu && (
          <ContextMenuPortal x={rowMenu.x} y={rowMenu.y} onClose={() => setRowMenu(null)}>
            <button
              className="sidebar-context-menu-item"
              role="menuitem"
              onClick={() => { const { page } = rowMenu; setRowMenu(null); openPage(page.id); }}
              data-testid="search-row-open"
            >
              <Icon name="page" size={14} /> Open
            </button>
            <button
              className="sidebar-context-menu-item"
              role="menuitem"
              onClick={() => { const { page } = rowMenu; setRowMenu(null); openPageIn(page, "foreground"); }}
              data-testid="search-row-open-tab"
            >
              <Icon name="external" size={14} /> Open in new tab
            </button>
          </ContextMenuPortal>
        )}
        <div className="command-palette-hints" aria-hidden="true" data-testid="palette-hints">
          <span><kbd>↑</kbd><kbd>↓</kbd> select</span>
          <span><kbd>Enter</kbd> {isCommandMode ? "run" : "open"}</span>
          {!isCommandMode && !picker && <span><kbd>Ctrl+Enter</kbd> new tab</span>}
          {!isCommandMode && !picker && <span><kbd>Tab</kbd> filter</span>}
          {!isCommandMode && !picker && <span><kbd>&gt;</kbd> commands</span>}
          {picker && <span><kbd>Backspace</kbd> back</span>}
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
