import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { Page, FolderTreeRoot, FolderTree } from "../lib/api";
import * as api from "../lib/api";
import { useEscapeToClose } from "../lib/escapeStack";
import { ContextMenuPortal } from "../lib/ContextMenuPortal";
import { fuzzyMatch } from "../lib/fuzzy";
import { plural } from "../lib/confirm";
import { showToast, showUndoToast } from "../lib/toast";
import { errorMessage } from "../lib/errors";
import { openModeFrom, openInTab, preventMiddlePaste } from "../lib/openIntent";
import Icon from "./Icon";
import "./navigation.css";

interface Props {
  activePageId?: string | null;
  onPageClick: (id: string) => void;
  onClose: () => void;
  /** Move pages to the Trash (App: one toast with Undo; leaves the open page). */
  onTrashPages?: (pages: Array<{ id: string; title: string }>) => Promise<void> | void;
  /** Something changed (pinned, moved, archived): sidebar and counts refresh. */
  onChanged?: () => void;
}

type SortField = "title" | "project" | "created_at" | "updated_at";
type SortDir = "asc" | "desc";
type Kind = "pages" | "journals" | "all";
const KINDS: Array<[Kind, string]> = [["pages", "Pages"], ["journals", "Journals"], ["all", "All"]];
const KIND_KEY = "minotes-all-pages-kind";

const pageEntry = (p: Page) => ({ notebook: "", kind: "page" as const, pageId: p.id, title: p.title });

function journalLabel(p: Page): string {
  const date = p.journal_date ?? (p.title.startsWith("Journal/") ? p.title.slice(8) : "");
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1);
  return isNaN(dt.getTime()) ? p.title : dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

const titleOf = (p: Page) => (p.is_journal ? journalLabel(p) : p.title);

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Every project with its path ("Work / Clients"), depth-first. */
function projectPaths(tree: FolderTreeRoot | null): Array<{ id: string; path: string; depth: number }> {
  const out: Array<{ id: string; path: string; depth: number }> = [];
  const walk = (fs: FolderTree[], prefix: string, depth: number) => {
    for (const f of fs) {
      const path = prefix ? `${prefix} / ${f.name}` : f.name;
      out.push({ id: f.id, path, depth });
      walk(f.children ?? [], path, depth + 1);
    }
  };
  if (tree) walk(tree.folders, "", 0);
  return out;
}

/**
 * All Pages (UX Wave 4): a view in the main pane (the sidebar stays). Sort by
 * any column, filter (typo-tolerant), Pages / Journals / All, row actions and
 * bulk actions on the ticked rows (move to a project, pin, archive, trash);
 * the keyboard moves between rows (↑/↓, Space ticks, Enter opens, Del trashes).
 */
export default function AllPagesView({ activePageId, onPageClick, onClose, onTrashPages, onChanged }: Props) {
  const [pages, setPages] = useState<Page[] | null>(null);
  const [treeData, setTreeData] = useState<FolderTreeRoot | null>(null);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [sortField, setSortField] = useState<SortField>("updated_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [kind, setKind] = useState<Kind>(() => {
    try { return (localStorage.getItem(KIND_KEY) as Kind) || "pages"; } catch { return "pages"; }
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; ids: string[]; mode: "actions" | "move" } | null>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  // Reloads overlap (an outside-write refresh during a bulk action): an answer
  // older than the one shown is dropped, or a stale list would overwrite it.
  const loadSeq = useRef(0);
  const shownSeq = useRef(0);
  const loadData = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const [allPages, tree, favs] = await Promise.all([
        api.listPages(1000000), // every page (All Pages is the full list)
        api.getFolderTree(),
        api.listFavorites().catch(() => [] as Page[]),
      ]);
      if (seq < shownSeq.current) return;
      shownSeq.current = seq;
      setPages(allPages);
      setTreeData(tree);
      setPinnedIds(new Set(favs.map(f => f.id)));
    } catch (e) {
      console.error("Failed to load all pages:", e);
      setPages([]);
    }
  }, []);

  useEffect(() => {
    loadData();
    const reload = () => { loadData(); };
    window.addEventListener("minotes-sidebar-refresh", reload);
    return () => window.removeEventListener("minotes-sidebar-refresh", reload);
  }, [loadData]);

  useEscapeToClose(true, onClose, "canvas");

  const paths = useMemo(() => projectPaths(treeData), [treeData]);
  const pathOf = useMemo(() => new Map(paths.map(p => [p.id, p.path])), [paths]);
  const projectName = useCallback((p: Page) => (p.folder_id ? pathOf.get(p.folder_id) ?? "" : ""), [pathOf]);

  const filtered = useMemo(() => {
    let result = (pages ?? []).filter(p => kind === "all" || (kind === "journals" ? p.is_journal : !p.is_journal));
    const q = searchQuery.trim();
    if (q) result = result.filter(p => fuzzyMatch(q, titleOf(p)) || fuzzyMatch(q, projectName(p)));
    const key = (p: Page): string =>
      sortField === "title" ? (p.is_journal ? p.journal_date ?? p.title : p.title.toLowerCase())
      : sortField === "project" ? projectName(p).toLowerCase()
      : sortField === "created_at" ? p.created_at : p.updated_at;
    result = [...result].sort((a, b) => {
      const cmp = sortField === "title" || sortField === "project" ? key(a).localeCompare(key(b)) : key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return result;
  }, [pages, searchQuery, sortField, sortDir, kind, projectName]);

  // Ticks that are no longer listed don't count.
  const chosen = useMemo(() => filtered.filter(p => selected.has(p.id)), [filtered, selected]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) setSortDir(d => (d === "asc" ? "desc" : "asc"));
    else {
      setSortField(field);
      setSortDir(field === "updated_at" || field === "created_at" ? "desc" : "asc");
    }
  };
  const sortAria = (field: SortField) => (sortField !== field ? "none" : sortDir === "asc" ? "ascending" : "descending");
  const sortMark = (field: SortField) => (sortField !== field ? "" : sortDir === "asc" ? " ▲" : " ▼");

  const chooseKind = (k: Kind) => {
    setKind(k);
    setSelected(new Set());
    try { localStorage.setItem(KIND_KEY, k); } catch { /* not remembered */ }
  };

  const toggle = (id: string, range: boolean) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (range && anchor) {
        const a = filtered.findIndex(p => p.id === anchor);
        const b = filtered.findIndex(p => p.id === id);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (let k = lo; k <= hi; k++) next.add(filtered[k].id);
          return next;
        }
      }
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setAnchor(id);
  };
  const allChecked = filtered.length > 0 && chosen.length === filtered.length;
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(filtered.map(p => p.id)));

  const changed = () => { loadData(); onChanged?.(); };
  const byIds = (ids: string[]) => (pages ?? []).filter(p => ids.includes(p.id));

  // ── Actions (a row's ⋮ menu or the bulk bar) ──
  const moveTo = async (ids: string[], folderId: string | null, label: string) => {
    setMenu(null);
    const list = byIds(ids);
    const before = list.map(p => ({ id: p.id, folder: p.folder_id ?? undefined }));
    let ok = 0;
    for (const p of list) {
      try { await api.movePageToFolder(p.id, folderId ?? undefined); ok++; } catch (e) { showToast(`Couldn't move “${titleOf(p)}”: ${errorMessage(e)}`); }
    }
    changed();
    if (!ok) return;
    showUndoToast(`Moved ${ok === 1 ? `“${titleOf(list[0])}”` : plural(ok, "page")} to ${label}`, async () => {
      for (const b of before) await api.movePageToFolder(b.id, b.folder).catch(() => {});
      changed();
    }, 8000);
  };

  const setPinned = async (ids: string[], pin: boolean) => {
    setMenu(null);
    for (const id of ids) {
      if (pinnedIds.has(id) === pin) continue;
      try { if (pin) await api.addFavorite(id); else await api.removeFavorite(id); } catch (e) { showToast(`Couldn't ${pin ? "pin" : "unpin"}: ${errorMessage(e)}`); }
    }
    showToast(`${pin ? "Pinned" : "Unpinned"} ${plural(ids.length, "page")}`);
    changed();
  };

  const archive = async (ids: string[]) => {
    setMenu(null);
    const list = byIds(ids);
    let ok = 0;
    for (const p of list) {
      try { await api.archivePage(p.id); ok++; } catch (e) { showToast(`Couldn't archive “${titleOf(p)}”: ${errorMessage(e)}`); }
    }
    setSelected(new Set());
    changed();
    if (ok) showUndoToast(`Archived ${ok === 1 ? `“${titleOf(list[0])}”` : plural(ok, "page")}`, async () => {
      for (const p of list) await api.unarchivePage(p.id).catch(() => {});
      changed();
    }, 8000);
  };

  const trash = async (ids: string[]) => {
    setMenu(null);
    const list = byIds(ids).map(p => ({ id: p.id, title: titleOf(p) }));
    if (!list.length) return;
    setSelected(new Set());
    if (onTrashPages) await onTrashPages(list);
    else for (const p of list) await api.trashPage(p.id).catch(() => {});
    changed();
  };

  const openMenu = (e: React.MouseEvent | React.KeyboardEvent, ids: string[], mode: "actions" | "move") => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 2, ids, mode });
    if (e.type === "keydown" || (e as React.MouseEvent).detail === 0) {
      setTimeout(() => (document.querySelector(".sidebar-context-menu .sidebar-context-menu-item:not(:disabled)") as HTMLElement | null)?.focus(), 0);
    }
  };

  // ── Keyboard: the rows are one list ──
  const focusRow = (id: string) => {
    setFocusId(id);
    requestAnimationFrame(() => bodyRef.current?.querySelector<HTMLElement>(`tr[data-page-id="${id}"]`)?.focus());
  };
  const onRowKey = (e: React.KeyboardEvent, p: Page) => {
    if (e.target !== e.currentTarget) return;
    const i = filtered.findIndex(x => x.id === p.id);
    const go = (to: number) => {
      const t = filtered[Math.max(0, Math.min(filtered.length - 1, to))];
      if (!t) return;
      if (e.shiftKey) toggle(t.id, true);
      focusRow(t.id);
    };
    if (e.key === "ArrowDown") { e.preventDefault(); go(i + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); go(i - 1); }
    else if (e.key === "Home") { e.preventDefault(); go(0); }
    else if (e.key === "End") { e.preventDefault(); go(filtered.length - 1); }
    else if (e.key === "Enter") { e.preventDefault(); if (!openInTab(pageEntry(p), openModeFrom(e))) onPageClick(p.id); }
    else if (e.key === " ") { e.preventDefault(); toggle(p.id, false); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); toggleAll(); }
    else if (e.key === "Delete") { e.preventDefault(); void trash(chosen.length ? chosen.map(c => c.id) : [p.id]); }
    else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) { e.preventDefault(); openMenu(e, [p.id], "actions"); }
  };
  // ↓ in the filter field goes to the first row.
  const onFilterKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" && filtered.length) { e.preventDefault(); focusRow(filtered[0].id); }
    else if (e.key === "Enter" && filtered.length) { e.preventDefault(); onPageClick(filtered[0].id); }
  };

  const menuPages = menu ? byIds(menu.ids) : [];
  const menuHere = menuPages.length === 1 ? menuPages[0].folder_id ?? null : undefined;
  const allPinned = (ids: string[]) => ids.length > 0 && ids.every(id => pinnedIds.has(id));
  const anyJournal = (ids: string[]) => byIds(ids).some(p => p.is_journal);

  return (
    <div className="all-pages-view all-pages-main" data-testid="all-pages-view" role="region" aria-label="All pages">
      <div className="all-pages-header">
        <h2>All Pages</h2>
        <div className="tasks-filters" role="tablist" aria-label="Show">
          {KINDS.map(([k, label]) => (
            <button
              key={k}
              role="tab"
              aria-selected={kind === k}
              className={`tasks-filter${kind === k ? " active" : ""}`}
              onClick={() => chooseKind(k)}
              data-testid={`all-pages-kind-${k}`}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          className="all-pages-search"
          type="text"
          placeholder="Filter by title or project…"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          onKeyDown={onFilterKey}
          aria-label="Filter pages"
          autoFocus
          data-testid="all-pages-filter"
        />
        <span className="all-pages-count" data-testid="all-pages-count">{plural(filtered.length, kind === "journals" ? "day" : "page")}</span>
        <button className="btn btn-sm tasks-close" onClick={onClose} title="Close (Esc)" aria-label="Close All Pages"><Icon name="x" size={14} /></button>
      </div>
      {chosen.length > 0 && (
        <div className="all-pages-bulk" role="toolbar" aria-label="Selected pages" data-testid="all-pages-bulk">
          <span className="all-pages-bulk-count">{chosen.length} selected</span>
          <button className="btn btn-sm" disabled={anyJournal(chosen.map(c => c.id))} title={anyJournal(chosen.map(c => c.id)) ? "Journal days don't go into projects" : undefined} onClick={e => openMenu(e, chosen.map(c => c.id), "move")} data-testid="bulk-move">
            <Icon name="move" size={14} /> Move to…
          </button>
          <button className="btn btn-sm" onClick={() => void setPinned(chosen.map(c => c.id), !allPinned(chosen.map(c => c.id)))} data-testid="bulk-pin">
            <Icon name={allPinned(chosen.map(c => c.id)) ? "pin-off" : "pin"} size={14} /> {allPinned(chosen.map(c => c.id)) ? "Unpin" : "Pin"}
          </button>
          <button className="btn btn-sm" onClick={() => void archive(chosen.map(c => c.id))} data-testid="bulk-archive">
            <Icon name="archive" size={14} /> Archive
          </button>
          <button className="btn btn-sm btn-danger" onClick={() => void trash(chosen.map(c => c.id))} data-testid="bulk-trash">
            <Icon name="trash" size={14} /> Move to Trash
          </button>
          <button className="btn btn-sm all-pages-bulk-clear" onClick={() => setSelected(new Set())}>Clear selection</button>
        </div>
      )}
      <div className="all-pages-table-wrap">
        <table className="all-pages-table" aria-rowcount={filtered.length}>
          <thead>
            <tr>
              <th className="all-pages-th all-pages-check">
                <input type="checkbox" checked={allChecked} onChange={toggleAll} aria-label="Select all" data-testid="all-pages-select-all" />
              </th>
              <th className="all-pages-th" aria-sort={sortAria("title")} onClick={() => toggleSort("title")}>Title{sortMark("title")}</th>
              <th className="all-pages-th" aria-sort={sortAria("project")} onClick={() => toggleSort("project")}>Project{sortMark("project")}</th>
              <th className="all-pages-th" aria-sort={sortAria("created_at")} onClick={() => toggleSort("created_at")}>Created{sortMark("created_at")}</th>
              <th className="all-pages-th" aria-sort={sortAria("updated_at")} onClick={() => toggleSort("updated_at")}>Modified{sortMark("updated_at")}</th>
              <th className="all-pages-th all-pages-actions-th"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody ref={bodyRef}>
            {filtered.map((page, i) => {
              const checked = selected.has(page.id);
              const project = projectName(page);
              const tabbable = focusId ? focusId === page.id : i === 0;
              return (
                <tr
                  key={page.id}
                  className={`all-pages-row${checked ? " checked" : ""}${page.id === activePageId ? " current" : ""}`}
                  data-page-id={page.id}
                  data-testid="all-pages-row"
                  tabIndex={tabbable ? 0 : -1}
                  aria-selected={checked}
                  onFocus={() => setFocusId(page.id)}
                  onKeyDown={e => onRowKey(e, page)}
                  onMouseDown={preventMiddlePaste}
                  onAuxClick={e => { if (e.button === 1) { e.preventDefault(); openInTab(pageEntry(page), "background"); } }}
                  onClick={e => {
                    if (openInTab(pageEntry(page), openModeFrom(e))) { e.preventDefault(); return; }
                    if (e.shiftKey || e.ctrlKey || e.metaKey) { e.preventDefault(); toggle(page.id, e.shiftKey); return; }
                    onPageClick(page.id);
                  }}
                  onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, ids: checked && chosen.length > 1 ? chosen.map(c => c.id) : [page.id], mode: "actions" }); }}
                >
                  <td className="all-pages-td all-pages-check" onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={checked}
                      tabIndex={-1}
                      onChange={e => toggle(page.id, (e.nativeEvent as MouseEvent).shiftKey)}
                      aria-label={`Select ${titleOf(page)}`}
                      data-testid="all-pages-check"
                    />
                  </td>
                  <td className="all-pages-td all-pages-title" title={titleOf(page)}>
                    {page.icon ?? <Icon name={page.is_journal ? "calendar" : "page"} size={14} />} {titleOf(page)}
                    {pinnedIds.has(page.id) && <span className="all-pages-pin" title="Pinned"><Icon name="pin" size={12} /></span>}
                  </td>
                  <td className="all-pages-td all-pages-project" title={project || "Not in a project"}>{project || "—"}</td>
                  <td className="all-pages-td all-pages-date" data-testid="all-pages-created">{formatWhen(page.created_at)}</td>
                  <td className="all-pages-td all-pages-date" data-testid="all-pages-modified">{formatWhen(page.updated_at)}</td>
                  <td className="all-pages-td all-pages-row-actions" onClick={e => e.stopPropagation()}>
                    <button
                      className="page-more-btn all-pages-more"
                      tabIndex={-1}
                      onClick={e => openMenu(e, [page.id], "actions")}
                      title="Page actions (Shift+F10)"
                      aria-label={`Actions for ${titleOf(page)}`}
                      aria-haspopup="menu"
                      data-testid="all-pages-more"
                    >&#8942;</button>
                  </td>
                </tr>
              );
            })}
            {pages !== null && filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="all-pages-empty">
                  {searchQuery ? "No pages match your filter." : kind === "journals" ? "No journal days yet." : "No pages yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {menu && (
        <ContextMenuPortal x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {menu.mode === "actions" ? (
            <>
              <button className="sidebar-context-menu-item" onClick={() => { setMenu(null); onPageClick(menu.ids[0]); }} disabled={menu.ids.length !== 1}>
                <Icon name="page" size={14} /> Open
              </button>
              <button
                className="sidebar-context-menu-item"
                onClick={() => {
                  const id = menu.ids[0];
                  setMenu(null);
                  const pg = pages?.find(x => x.id === id);
                  if (!openInTab({ notebook: "", kind: "page", pageId: id, title: pg?.title }, "foreground")) onPageClick(id);
                }}
                disabled={menu.ids.length !== 1}
                data-testid="row-open-tab"
              >
                <Icon name="external" size={14} /> Open in new tab
              </button>
              <button
                className="sidebar-context-menu-item"
                disabled={anyJournal(menu.ids)}
                title={anyJournal(menu.ids) ? "Journal days don't go into projects" : undefined}
                onClick={() => setMenu(m => (m ? { ...m, mode: "move" } : m))}
                data-testid="row-move"
              >
                <Icon name="move" size={14} /> Move to…
              </button>
              <button className="sidebar-context-menu-item" onClick={() => void setPinned(menu.ids, !allPinned(menu.ids))} data-testid="row-pin">
                {allPinned(menu.ids) ? <><Icon name="pin-off" size={14} /> Unpin</> : <><Icon name="pin" size={14} /> Pin</>}
              </button>
              <button className="sidebar-context-menu-item" onClick={() => void archive(menu.ids)} data-testid="row-archive">
                <Icon name="archive" size={14} /> Archive
              </button>
              <div className="sidebar-context-menu-sep" />
              <button className="sidebar-context-menu-item danger" onClick={() => void trash(menu.ids)} data-testid="row-trash">
                <Icon name="trash" size={14} /> Move to Trash
              </button>
            </>
          ) : (
            <div className="sidebar-context-submenu" role="group" aria-label="Move to" data-testid="move-targets">
              <button
                className="sidebar-context-menu-item"
                disabled={menuHere === null}
                title={menuHere === null ? "Already at the top level" : "Out of every project"}
                onClick={() => void moveTo(menu.ids, null, "the top level")}
              >
                &#8679; Top level
              </button>
              {paths.map(p => (
                <button
                  key={p.id}
                  className="sidebar-context-menu-item"
                  style={{ paddingLeft: 12 + p.depth * 14 }}
                  disabled={menuHere === p.id}
                  title={menuHere === p.id ? "It is already here" : p.path}
                  onClick={() => void moveTo(menu.ids, p.id, p.path)}
                  data-testid="move-target"
                  data-folder-id={p.id}
                >
                  <Icon name="folder" size={14} /> {p.path.split(" / ").pop()}
                </button>
              ))}
            </div>
          )}
        </ContextMenuPortal>
      )}
    </div>
  );
}
