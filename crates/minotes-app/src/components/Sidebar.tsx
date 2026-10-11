import { useState, useEffect, useCallback, useRef } from "react";
import type { Page, GraphStats, FolderTree, FolderTreeRoot, Folder } from "../lib/api";
import * as api from "../lib/api";
import { localDateKey } from "../lib/dates";
import CalendarWidget from "./CalendarWidget";
import { showToast, showUndoToast } from "../lib/toast";
import { ContextMenuPortal } from "../lib/ContextMenuPortal";
import { getSettings, type MiNotesSettings } from "../lib/settings";
import NotebookSwitcher from "./NotebookSwitcher";
import { NOTEBOOK_SWITCHED } from "../lib/notebooks";
import { useEscapeToClose } from "../lib/escapeStack";
import { folderNameConflict } from "../lib/folderNames";
import { errorMessage } from "../lib/errors";
import { pageTitleConflict } from "../lib/pageNames";
function formatJournalDate(dateStr: string): string {
  try {
    const [y, m, d] = dateStr.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  } catch {
    return dateStr;
  }
}

/** Display title for any page — formats journal dates, falls back to title. */
function displayTitle(page: { title: string; is_journal?: boolean; journal_date?: string }): string {
  if (page.is_journal && page.journal_date) return formatJournalDate(page.journal_date);
  if (page.title.startsWith("Journal/")) return formatJournalDate(page.title.slice(8));
  return page.title;
}

/** Display icon for a page — only if the user set a custom icon. */
function displayIcon(page: { icon?: string }): string {
  return page.icon ?? "";
}

// localStorage helpers for expanded project state
const EXPANDED_STORAGE_KEY = "minotes-expanded-projects";
const MAX_EXPANDED = 2;

function loadExpandedIds(): string[] {
  try {
    const raw = localStorage.getItem(EXPANDED_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}

function saveExpandedIds(ids: string[]): void {
  localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(ids));
}

interface Props {
  activePage: Page | null;
  stats: GraphStats | null;
  onPageClick: (id: string) => void;
  /** Resolves true when the page was created (false/rejects keeps the field open). */
  onCreatePage: (title: string) => Promise<boolean> | void;
  /** Move a page to Trash (App leaves it first if it is open, and offers Undo). */
  onDeletePage: (id: string, title?: string) => void;
  onJournalClick: (date?: string) => void;
  onSearchClick: () => void;
  onGraphClick: () => void;
  onMindmapClick: () => void;
  onWhiteboardClick: () => void;
  onKanbanClick: () => void;
  onPagesClick: () => void;
  onSettingsClick: () => void;
  onFolderSettings: (folderId: string) => void;
  onTodoBadgeClick: () => void;
  /** Opens flashcard review (shown once any flashcard exists). */
  onReviewClick?: () => void;
  activeMode: "graph" | "mindmap" | "whiteboard" | "kanban" | "pages" | null;
  refreshKey: number;
  syncState?: "idle" | "syncing" | "error" | "offline";
}

export default function Sidebar({
  activePage, stats, onPageClick, onCreatePage, onDeletePage,
  onJournalClick, onSearchClick, onGraphClick, onMindmapClick, onWhiteboardClick, onKanbanClick, onPagesClick, onSettingsClick, onFolderSettings, onTodoBadgeClick, activeMode, refreshKey,
  syncState, onReviewClick,
}: Props) {
  const [newTitle, setNewTitle] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [showFolderCreate, setShowFolderCreate] = useState(false);
  const [folderCreateError, setFolderCreateError] = useState<string | null>(null);
  const [treeData, setTreeData] = useState<FolderTreeRoot | null>(null);
  const [journals, setJournals] = useState<Page[]>([]);
  const [showCalendar, setShowCalendar] = useState(false);
  const [favorites, setFavorites] = useState<Page[]>([]);
  const [showAllPinned, setShowAllPinned] = useState(false);
  const [trashItems, setTrashItems] = useState<api.TrashItem[]>([]);
  const [showTrash, setShowTrash] = useState(false);
  const [archivedItems, setArchivedItems] = useState<api.ArchiveItem[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [pendingTodos, setPendingTodos] = useState(0);
  const [srs, setSrs] = useState<api.SrsStats | null>(null);
  // settings.ai.todoExtraction gates the TODO badge; updates live via the
  // minotes-settings-changed event (no reload needed).
  const [todoExtraction, setTodoExtraction] = useState(() => getSettings().ai?.todoExtraction ?? true);
  useEffect(() => {
    const handler = (e: Event) => {
      const s = (e as CustomEvent<MiNotesSettings>).detail ?? getSettings();
      setTodoExtraction(s.ai?.todoExtraction ?? true);
    };
    window.addEventListener("minotes-settings-changed", handler);
    return () => window.removeEventListener("minotes-settings-changed", handler);
  }, []);

  // Phase 3a: Track expanded project IDs (max 2), persisted
  const [expandedProjectIds, setExpandedProjectIds] = useState<string[]>(() => loadExpandedIds());
  // Phase 2d: Collapse/expand all toggle — stores IDs that were open before collapse-all
  const [allCollapsed, setAllCollapsed] = useState(false);
  const [preCollapseIds, setPreCollapseIds] = useState<string[]>([]);

  // Persist expanded state
  useEffect(() => {
    saveExpandedIds(expandedProjectIds);
  }, [expandedProjectIds]);

  // Another notebook: its own expanded projects; panels from the old one close.
  useEffect(() => {
    const onSwitch = () => {
      setExpandedProjectIds(loadExpandedIds());
      setAllCollapsed(false);
      setShowTrash(false);
      setShowArchived(false);
      setShowCreate(false);
      setShowFolderCreate(false);
      setShowCalendar(false);
    };
    window.addEventListener(NOTEBOOK_SWITCHED, onSwitch);
    return () => window.removeEventListener(NOTEBOOK_SWITCHED, onSwitch);
  }, []);

  const toggleProjectExpanded = useCallback((folderId: string, shiftKey: boolean) => {
    setExpandedProjectIds(prev => {
      if (prev.includes(folderId)) {
        // Collapse this project
        return prev.filter(id => id !== folderId);
      }
      // Expanding
      if (shiftKey) {
        // Shift+click: force open without collapsing others
        if (prev.includes(folderId)) return prev;
        return [...prev, folderId];
      }
      // Normal expand: cap at MAX_EXPANDED, auto-collapse oldest
      const next = [...prev, folderId];
      if (next.length > MAX_EXPANDED) {
        return next.slice(next.length - MAX_EXPANDED);
      }
      return next;
    });
    setAllCollapsed(false);
  }, []);

  const loadTree = useCallback(async () => {
    try {
      const tree = await api.getFolderTree();
      setTreeData(tree);
      const pages = await api.listPages(200);
      // Filter journals: only show ones with actual content
      const journalPages = pages.filter(p => p.is_journal).slice(0, 20);
      const withContent: typeof journalPages = [];
      for (const jp of journalPages) {
        try {
          const tree = await api.getPageTree(jp.id);
          if (tree.blocks.some(b => b.content && b.content.trim().length > 0)) {
            withContent.push(jp);
          }
        } catch {
          withContent.push(jp); // Show if we can't check
        }
        if (withContent.length >= 10) break; // Cap at 10
      }
      setJournals(withContent);
      const favs = await api.listFavorites();
      setFavorites(favs);
      const trashed = await api.listTrash();
      setTrashItems(trashed);
      const arch = await api.listArchived();
      setArchivedItems(arch);
    } catch (e) {
      console.error("Failed to load folder tree:", e);
    }
  }, []);

  // TODO badge: fetch pending count from a simple API call.
  // Bug #33: re-fetch on refreshKey and on sidebar-refresh events so the badge
  // updates as TODOs are added/completed, instead of being frozen at mount.
  useEffect(() => {
    if (!todoExtraction) { setPendingTodos(0); return; } // feature off: skip counting
    const refetch = () => api.getPendingTodoCount().then((count) => setPendingTodos(count)).catch(() => {});
    refetch();
    window.addEventListener("minotes-sidebar-refresh", refetch);
    return () => window.removeEventListener("minotes-sidebar-refresh", refetch);
  }, [refreshKey, todoExtraction]);

  // Flashcard review entry: due count, refreshed whenever cards change (made,
  // removed, reviewed), on sidebar refreshes, and when the window regains focus
  // (cards fall due with time).
  useEffect(() => {
    const refetch = () => api.getSrsStats().then(setSrs).catch(() => {});
    refetch();
    window.addEventListener("minotes-cards-changed", refetch);
    window.addEventListener("minotes-sidebar-refresh", refetch);
    window.addEventListener("focus", refetch);
    return () => {
      window.removeEventListener("minotes-cards-changed", refetch);
      window.removeEventListener("minotes-sidebar-refresh", refetch);
      window.removeEventListener("focus", refetch);
    };
  }, [refreshKey]);

  useEffect(() => { loadTree(); }, [loadTree, refreshKey]);

  // Listen for direct sidebar refresh events (from FolderSettingsPanel, etc.)
  useEffect(() => {
    const handler = () => loadTree();
    window.addEventListener("minotes-sidebar-refresh", handler);
    return () => window.removeEventListener("minotes-sidebar-refresh", handler);
  }, [loadTree]);

  // Inline "new page" / "new project" fields: Enter or clicking away commits a
  // non-empty name and cancels an empty one (the same as every rename field).
  const creatingRef = useRef(false);
  const handleCreate = async () => {
    const title = newTitle.trim();
    if (!title) { setShowCreate(false); setNewTitle(""); return; }
    if (creatingRef.current) return;
    creatingRef.current = true;
    try {
      const ok = await onCreatePage(title);
      if (ok !== false) {
        setNewTitle("");
        setShowCreate(false);
      }
    } finally {
      creatingRef.current = false;
    }
  };

  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) { setShowFolderCreate(false); setNewFolderName(""); setFolderCreateError(null); return; }
    if (creatingRef.current) return;
    creatingRef.current = true;
    try {
      const conflict = await folderNameConflict(name, null);
      if (conflict) { setFolderCreateError(conflict); return; }
      let folder: api.Folder;
      try {
        folder = await api.createFolder(name);
      } catch (e) {
        setFolderCreateError(`Couldn't create project: ${errorMessage(e)}`);
        return;
      }
      setNewFolderName("");
      setFolderCreateError(null);
      setShowFolderCreate(false);
      // Auto-expand the new project
      setExpandedProjectIds(prev => {
        const next = [...prev, folder.id];
        if (next.length > MAX_EXPANDED) return next.slice(next.length - MAX_EXPANDED);
        return next;
      });
      loadTree();
    } finally {
      creatingRef.current = false;
    }
  };

  useEscapeToClose(showCalendar, () => setShowCalendar(false));

  const handleDropOnRoot = async (e: React.DragEvent) => {
    e.preventDefault();
    e.currentTarget.classList.remove("drop-target");
    const pageId = e.dataTransfer.getData("text/page-id");
    const fromFolder = e.dataTransfer.getData("text/page-folder");
    const wasPinned = e.dataTransfer.getData("text/page-pinned") === "true";
    if (!pageId) return;
    // Ignore drops from pages already in root (no folder, not pinned) — prevents no-op reorder
    if (!fromFolder && !wasPinned) return;
    if (wasPinned) {
      await api.removeFavorite(pageId);
    }
    await api.movePageToFolder(pageId, undefined);
    loadTree();
  };

  // Phase 2d: collapse/expand all projects
  const handleCollapseExpandAll = () => {
    if (allCollapsed) {
      // Restore previously expanded
      setExpandedProjectIds(preCollapseIds);
      setAllCollapsed(false);
    } else {
      // Save current, then collapse all
      setPreCollapseIds(expandedProjectIds);
      setExpandedProjectIds([]);
      setAllCollapsed(true);
    }
  };

  const today = new Date();
  const todayStr = localDateKey(today);
  const todayLabel = today.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

  // Quick Access: pinned pages only
  const pinnedIds = new Set(favorites.map(f => f.id));
  const showQuickAccess = favorites.length > 0;

  // Projects: first 5 visible, rest overflow
  const allProjects = treeData?.folders ?? [];
  const visibleProjects = allProjects.slice(0, 5);
  const overflowProjects = allProjects.slice(5);

  return (
    <div className="sidebar workspace-ribbon">
      {/* -- Sticky top: Search + New -- */}
      <div className="sidebar-header">
        <h1>MiNotes</h1>
        <NotebookSwitcher />
        <button className="sidebar-gear-btn" onClick={onSettingsClick} title="Settings (Ctrl+,)">&#x2699;</button>
      </div>
      <div className="sidebar-actions-bar">
        <button className="btn btn-sm" onClick={onSearchClick} title="Search (Ctrl+K)" style={{ flex: 1 }}>
          &#128269; Search
        </button>
        <button
          className="btn btn-sm btn-primary"
          // mousedown would blur the open field first (which commits/cancels it)
          onMouseDown={e => { if (showCreate) e.preventDefault(); }}
          onClick={() => setShowCreate(!showCreate)}
          title="New page (Ctrl+N)"
        >
          + New
        </button>
      </div>

      {showCreate && (
        <div className="sidebar-actions">
          <input
            className="search-input"
            placeholder="Page title..."
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") handleCreate();
              if (e.key === "Escape") { e.preventDefault(); setShowCreate(false); setNewTitle(""); }
            }}
            onBlur={handleCreate}
            aria-label="New page title"
            autoFocus
          />
        </div>
      )}

      {/* -- Journal + Calendar -- */}
      <div className="sidebar-journal-row">
        <span className="sidebar-journal-text" onClick={() => onJournalClick()} title="Open today's journal (Ctrl+J)">
          &#128197; <strong>Today</strong> &middot; {todayLabel}
        </span>
        <span
          className="sidebar-section-chevron"
          role="button"
          tabIndex={0}
          aria-expanded={showCalendar}
          onClick={() => setShowCalendar(c => !c)}
          onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setShowCalendar(c => !c); } }}
          title={showCalendar ? "Hide calendar (Esc)" : "Show calendar"}
        >
          {showCalendar ? "\u25B4" : "\u25BE"}
        </span>
      </div>
      {showCalendar && (
        <CalendarWidget
          journalDates={new Set(journals.map(j => j.journal_date).filter(Boolean) as string[])}
          onDateClick={(date) => onJournalClick(date)}
        />
      )}

      <div className="sidebar-section">
        {/* -- Pinned -- */}
        {showQuickAccess && (
          <>
            <div
              className="sidebar-section-title pinned-drop-zone"
              onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add("drop-target"); }}
              onDragLeave={e => e.currentTarget.classList.remove("drop-target")}
              onDrop={async e => {
                e.preventDefault();
                e.currentTarget.classList.remove("drop-target");
                const pageId = e.dataTransfer.getData("text/page-id");
                if (pageId) {
                  await api.addFavorite(pageId);
                  loadTree();
                }
              }}
            >&#128204; Pinned</div>
            {/* Pinned items — user-ordered via drag, soft cap at 7 */}
            {(() => {
              const PINNED_CAP = 7;
              const visiblePinned = showAllPinned ? favorites : favorites.slice(0, PINNED_CAP);
              const hiddenPinnedCount = favorites.length - PINNED_CAP;

              return (
                <>
                  {visiblePinned.map(page => (
                    <DraggablePage
                      key={page.id}
                      page={page}
                      activePage={activePage}
                      depth={0}
                      onPageClick={onPageClick}
                      onDeletePage={onDeletePage}
                      onRefresh={loadTree}
                      allFolders={allProjects}
                      isPinned={true}
                      pinnedSiblings={favorites}
                    />
                  ))}
                  {!showAllPinned && hiddenPinnedCount > 0 && (
                    <>
                      <div className="sidebar-overflow-fade" />
                      <div
                        className="page-item sidebar-more-pages"
                        onClick={() => setShowAllPinned(true)}
                      >
                        + {hiddenPinnedCount} more
                      </div>
                    </>
                  )}
                  {showAllPinned && favorites.length > PINNED_CAP && (
                    <div
                      className="page-item sidebar-more-pages"
                      onClick={() => setShowAllPinned(false)}
                    >
                      Show less
                    </div>
                  )}
                </>
              );
            })()}
          </>
        )}
        {/* Spacing after Pinned section */}
        {showQuickAccess && <div className="sidebar-section-gap" />}

        {/* TODO badge */}
        {todoExtraction && pendingTodos > 0 && (
          <div
            className="sidebar-todo-badge"
            onClick={onTodoBadgeClick}
            title={`${pendingTodos} pending TODOs`}
          >
            <span className="sidebar-todo-count">{pendingTodos}</span> TODOs
          </div>
        )}

        {/* Flashcard review */}
        {onReviewClick && srs && srs.total_cards > 0 && (
          <div
            className="sidebar-todo-badge sidebar-review-badge"
            role="button"
            tabIndex={0}
            onClick={onReviewClick}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onReviewClick(); } }}
            title={`Review flashcards (Ctrl+R) — ${srs.due_count} due, ${srs.total_cards} total`}
          >
            Review <span className="sidebar-todo-count">{srs.due_count}</span> due
          </div>
        )}

        {/* -- Projects -- */}
        {(allProjects.length > 0 || treeData) && (
          <>
            {/* Phase 2d: PROJECTS header with collapse/expand all toggle */}
            <div className="sidebar-section-title sidebar-section-hover-actions">
              <span>Projects</span>
              <button
                className="sidebar-collapse-all-btn"
                onClick={handleCollapseExpandAll}
                title={allCollapsed ? "Expand projects" : "Collapse all projects"}
              >
                {allCollapsed ? "\u25B8" : "\u25BE"}
              </button>
            </div>

            {/* + New Project */}
            {showFolderCreate ? (
              <div className="sidebar-actions" style={{ padding: "2px 16px" }}>
                <input
                  className="search-input"
                  placeholder="Project name..."
                  value={newFolderName}
                  onChange={e => { setNewFolderName(e.target.value); setFolderCreateError(null); }}
                  onKeyDown={e => {
                    if (e.key === "Enter") handleCreateFolder();
                    if (e.key === "Escape") { e.preventDefault(); setShowFolderCreate(false); setNewFolderName(""); setFolderCreateError(null); }
                  }}
                  onBlur={() => { if (!folderCreateError) handleCreateFolder(); }}
                  aria-label="New project name"
                  aria-invalid={!!folderCreateError}
                  autoFocus
                />
                {folderCreateError && <div className="inline-field-error" role="alert">{folderCreateError}</div>}
              </div>
            ) : (
              <div
                className="page-item sidebar-new-project"
                onClick={() => setShowFolderCreate(true)}
              >
                + New Project
              </div>
            )}

            {visibleProjects.map(folder => (
              <FolderItem
                key={folder.id}
                folder={folder}
                activePage={activePage}
                depth={0}
                isExpanded={expandedProjectIds.includes(folder.id)}
                onToggleExpanded={(shiftKey) => toggleProjectExpanded(folder.id, shiftKey)}
                onPageClick={onPageClick}
                onDeletePage={onDeletePage}
                onRefresh={loadTree}
                allFolders={allProjects}
                pinnedIds={pinnedIds}
                onFolderSettings={onFolderSettings}
              />
            ))}

            {overflowProjects.length > 0 && (
              <details className="sidebar-overflow">
                <summary className="sidebar-overflow-trigger">&#x22EF; {overflowProjects.length} more</summary>
                {overflowProjects.map(folder => (
                  <FolderItem
                    key={folder.id}
                    folder={folder}
                    activePage={activePage}
                    depth={0}
                    isExpanded={expandedProjectIds.includes(folder.id)}
                    onToggleExpanded={(shiftKey) => toggleProjectExpanded(folder.id, shiftKey)}
                    onPageClick={onPageClick}
                    onDeletePage={onDeletePage}
                    onRefresh={loadTree}
                    allFolders={allProjects}
                    pinnedIds={pinnedIds}
                    onFolderSettings={onFolderSettings}
                  />
                ))}
              </details>
            )}

            {/* Pages (not in any project, excluding pinned) */}
            {treeData && treeData.root_pages.filter(p => !p.is_journal && !pinnedIds.has(p.id)).length > 0 && (
              <>
              <div className="sidebar-section-title">
                Pages <span className="sidebar-section-count">({treeData.root_pages.filter(p => !p.is_journal && !pinnedIds.has(p.id)).length})</span>
              </div>
              <div
                className="root-drop-zone"
                onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add("drop-target"); }}
                onDragLeave={e => e.currentTarget.classList.remove("drop-target")}
                onDrop={handleDropOnRoot}
              >
                {treeData.root_pages
                  .filter(p => !p.is_journal && !pinnedIds.has(p.id))
                  .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
                  .map(page => (
                  <DraggablePage
                    key={page.id}
                    page={page}
                    activePage={activePage}
                    depth={0}
                    onPageClick={onPageClick}
                    onDeletePage={onDeletePage}
                    onRefresh={loadTree}
                    allFolders={allProjects}
                    isPinned={false}
                  />
                ))}
              </div>
              </>
            )}

          </>
        )}
      </div>

      {/* -- Sticky bottom: System states + Tools -- */}
      <div className="stats-bar">
        {/* System states: Archived + Trash */}
        <div className="sidebar-system-states">
          <div className="stats-modes-divider" />
          {archivedItems.length > 0 && (
            <>
              <div
                className="sidebar-system-item"
                onClick={() => setShowArchived(v => !v)}
              >
                <span>&#128230; Archived ({archivedItems.length})</span>
                <span className="sidebar-section-chevron">{showArchived ? "\u25B4" : "\u25BE"}</span>
              </div>
              {showArchived && (
                <div className="sidebar-trash-list">
                  {archivedItems.map(item => (
                    <div key={item.id} className="page-item sidebar-trash-item">
                      <span>
                        {item.item_type === "folder" ? "\uD83D\uDCC1 " : ""}
                        {displayTitle({ title: item.title })}
                        {item.item_type === "folder" && item.page_count > 0 && (
                          <span className="folder-count"> ({item.page_count})</span>
                        )}
                      </span>
                      <span className="sidebar-trash-actions">
                        <button
                          className="sidebar-trash-action-btn"
                          title="Restore"
                          onClick={async e => {
                            e.stopPropagation();
                            if (item.item_type === "folder") {
                              await api.unarchiveFolder(item.id);
                            } else {
                              await api.unarchivePage(item.id);
                            }
                            loadTree();
                          }}
                        >&#8634;</button>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          <div
            className="sidebar-system-item"
            onClick={() => setShowTrash(v => !v)}
          >
            <span>&#128465; Trash{trashItems.length > 0 ? ` (${trashItems.length})` : ""}</span>
            {trashItems.length > 0 && (
              <span className="sidebar-section-chevron">{showTrash ? "\u25B4" : "\u25BE"}</span>
            )}
          </div>
          {showTrash && trashItems.length > 0 && (
            <div className="sidebar-trash-list">
              {trashItems.map(item => (
                <div key={item.id} className="page-item sidebar-trash-item">
                  <span>
                    {item.item_type === "folder" ? "\uD83D\uDCC1" : ""} {displayTitle({ title: item.title })}
                    {item.item_type === "folder" && item.page_count > 0 && (
                      <span className="folder-count"> ({item.page_count})</span>
                    )}
                  </span>
                  <span className="sidebar-trash-actions">
                    <button
                      className="sidebar-trash-action-btn"
                      title="Restore"
                      onClick={async e => {
                        e.stopPropagation();
                        await api.restoreFromTrash(item.id, item.item_type);
                        loadTree();
                      }}
                    >&#8634;</button>
                    <button
                      className="sidebar-trash-action-btn danger"
                      title="Delete permanently"
                      onClick={async e => {
                        e.stopPropagation();
                        await api.permanentlyDelete(item.id, item.item_type);
                        loadTree();
                      }}
                    >&#10005;</button>
                  </span>
                </div>
              ))}
              {trashItems.length > 1 && (
                <div
                  className="page-item sidebar-more-pages"
                  onClick={async () => {
                    await api.emptyTrash();
                    loadTree();
                  }}
                >
                  Empty trash
                </div>
              )}
            </div>
          )}
        </div>

        {/* Tools */}
        <div className="stats-modes-divider" />
        {syncState === "syncing" && (
          <div className="sync-indicator sync-syncing">Syncing\u2026</div>
        )}
        {syncState === "error" && (
          <div className="sync-indicator sync-error">\u26A0 Sync failed</div>
        )}
        {syncState === "offline" && (
          <div className="sync-indicator sync-offline">Offline</div>
        )}
        <div className="stats-modes-grid">
          <button className={`stats-mode-btn ${activeMode === "graph" ? "active" : ""}`} onClick={onGraphClick} title="Graph (Ctrl+G)">
            &#128202;Graph
          </button>
          <button className={`stats-mode-btn ${activeMode === "mindmap" ? "active" : ""}`} onClick={onMindmapClick} title="Mindmap (Ctrl+M)">
            &#129504;Mind
          </button>
          <button className={`stats-mode-btn ${activeMode === "whiteboard" ? "active" : ""}`} onClick={onWhiteboardClick} title="Draw (Ctrl+W)">
            &#127912;Draw
          </button>
          <button className={`stats-mode-btn ${activeMode === "kanban" ? "active" : ""}`} onClick={onKanbanClick} title="Kanban (Ctrl+Shift+K)">
            &#128450;Kanban
          </button>
          <button className={`stats-mode-btn ${activeMode === "pages" ? "active" : ""}`} onClick={onPagesClick} title="All Pages">
            &#128196;Pages
          </button>
        </div>
      </div>
    </div>
  );
}

// Draggable page item — drag to move between folders, auto-sorted by last edited
function DraggablePage({
  page, activePage, depth, onPageClick, onDeletePage, onRefresh, allFolders, isPinned, pinnedSiblings,
}: {
  page: Page;
  activePage: Page | null;
  depth: number;
  onPageClick: (id: string) => void;
  onDeletePage: (id: string, title?: string) => void;
  onRefresh: () => void;
  allFolders?: FolderTree[];
  isPinned?: boolean;
  pinnedSiblings?: Page[];  // pass favorites array for pinned reorder
}) {
  const mouseStart = useRef<{ x: number; y: number } | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [showMoveSubmenu, setShowMoveSubmenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(page.title);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [dropPos, setDropPos] = useState<"above" | "below" | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  // `viaKeyboard`: focus the first menu item so arrows/Enter work right away.
  const openMenu = (x: number, y: number, viaKeyboard = false) => {
    setCtxMenu({ x, y });
    setShowMoveSubmenu(false);
    if (viaKeyboard) {
      setTimeout(() => {
        (document.querySelector(".sidebar-context-menu .sidebar-context-menu-item") as HTMLElement | null)?.focus();
      }, 0);
    }
  };
  const closeMenu = () => {
    setCtxMenu(null);
    setShowMoveSubmenu(false);
  };

  const folderName = (id: string | undefined | null) =>
    id ? (allFolders?.find(f => f.id === id)?.name ?? "project") : null;

  const handleMoveToFolder = async (folderId: string | undefined) => {
    const fromFolder = page.folder_id ?? undefined;
    closeMenu();
    try {
      await api.movePageToFolder(page.id, folderId);
    } catch (e) {
      showToast(`Couldn't move "${displayTitle(page)}": ${errorMessage(e)}`);
      return;
    }
    onRefresh();
    const where = folderName(folderId);
    showUndoToast(
      where ? `Moved "${displayTitle(page)}" to ${where}` : `Moved "${displayTitle(page)}" out of ${folderName(fromFolder) ?? "its project"}`,
      async () => {
        await api.movePageToFolder(page.id, fromFolder).catch(() => {});
        onRefresh();
      },
      8000,
    );
    rowRef.current?.focus();
  };

  const renamingDone = useRef(false);
  const handleRename = async () => {
    if (renamingDone.current) return;
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === page.title) {
      setRenaming(false);
      setRenameError(null);
      return;
    }
    renamingDone.current = true;
    try {
      const conflict = await pageTitleConflict(trimmed, page.id);
      if (conflict) throw new Error(conflict);
      await api.renamePage(page.id, trimmed);
      setRenaming(false);
      setRenameError(null);
      onRefresh();
      window.dispatchEvent(new Event("minotes-page-renamed"));
    } catch (e) {
      // Keep the field open with the reason; the page keeps its old title.
      setRenameError(errorMessage(e).replace(/^Already exists:\s*/i, ""));
    } finally {
      renamingDone.current = false;
    }
  };

  const handleTogglePin = async () => {
    if (isPinned) {
      await api.removeFavorite(page.id);
    } else {
      await api.addFavorite(page.id);
    }
    setCtxMenu(null);
    onRefresh();
  };

  const handleDuplicate = async () => {
    setCtxMenu(null);
    try {
      const tree = await api.getPageTree(page.id);
      const newPage = await api.createPage(page.title + " (copy)");
      if (page.folder_id) {
        await api.movePageToFolder(newPage.id, page.folder_id);
      }
      for (const block of tree.blocks) {
        await api.createBlock(newPage.id, block.content, block.parent_id ?? undefined);
      }
      onRefresh();
    } catch (e) {
      console.error("Duplicate failed:", e);
    }
  };

  const handleCopyPage = async () => {
    setCtxMenu(null);
    try {
      const tree = await api.getPageTree(page.id);
      const text = tree.blocks.map(b => b.content).join("\n");
      await navigator.clipboard.writeText(text);
      showToast("Page content copied to clipboard");
    } catch (e) {
      console.error("Copy page failed:", e);
      showToast("Failed to copy page");
    }
  };

  return (
    <>
    <div
      ref={rowRef}
      className={`page-item ${activePage?.id === page.id ? "active" : ""} ${ctxMenu ? "menu-open" : ""} ${dropPos === "above" ? "drop-above" : ""} ${dropPos === "below" ? "drop-below" : ""}`}
      style={{ paddingLeft: 16 + depth * 16 }}
      tabIndex={renaming ? -1 : 0}
      role="link"
      aria-current={activePage?.id === page.id ? "page" : undefined}
      aria-haspopup="menu"
      title={`${displayTitle(page)} — Shift+F10 or the menu key for actions`}
      onKeyDown={e => {
        if (renaming || e.target !== e.currentTarget) return;
        if (e.key === "Enter") { e.preventDefault(); onPageClick(page.id); }
        if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          openMenu(r.left + 24, r.bottom + 2, true);
        }
      }}
      draggable={!renaming}
      onDragStart={e => {
        e.dataTransfer.setData("text/page-id", page.id);
        e.dataTransfer.setData("text/page-folder", page.folder_id ?? "");
        e.dataTransfer.setData("text/page-pinned", isPinned ? "true" : "");
        e.dataTransfer.effectAllowed = "move";
        e.currentTarget.classList.add("dragging");
      }}
      onDragEnd={e => { e.currentTarget.classList.remove("dragging"); setDropPos(null); }}
      onDragOver={isPinned && pinnedSiblings ? (e => {
        e.preventDefault();
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        setDropPos(e.clientY < rect.top + rect.height / 2 ? "above" : "below");
      }) : undefined}
      onDragLeave={isPinned ? (() => setDropPos(null)) : undefined}
      onDrop={isPinned && pinnedSiblings ? (async e => {
        e.preventDefault();
        e.stopPropagation();
        setDropPos(null);
        const draggedId = e.dataTransfer.getData("text/page-id");
        if (!draggedId || draggedId === page.id) return;
        const siblings = pinnedSiblings;
        const idx = siblings.findIndex(p => p.id === page.id);
        const rect = e.currentTarget.getBoundingClientRect();
        const above = e.clientY < rect.top + rect.height / 2;
        let newPos: number;
        if (above) {
          const prevPos = idx > 0 ? siblings[idx - 1].position : 0;
          newPos = (prevPos + page.position) / 2;
        } else {
          const nextPos = idx < siblings.length - 1 ? siblings[idx + 1].position : page.position + 1;
          newPos = (page.position + nextPos) / 2;
        }
        const wasPinned = e.dataTransfer.getData("text/page-pinned") === "true";
        if (!wasPinned) {
          await api.addFavorite(draggedId);
        }
        await api.reorderFavorite(draggedId, newPos);
        onRefresh();
      }) : undefined}
      onMouseDown={e => {
        // Only a primary click on the row itself navigates: not right-click, not
        // the ⋮ button, and not clicks inside the menu (a portal, so React still
        // bubbles its events through this row).
        const t = e.target as HTMLElement;
        const onRow = e.currentTarget.contains(t) && !t.closest(".page-more-btn");
        mouseStart.current = !renaming && e.button === 0 && onRow ? { x: e.clientX, y: e.clientY } : null;
      }}
      onMouseUp={e => {
        if (renaming || e.button !== 0) { mouseStart.current = null; return; }
        const start = mouseStart.current;
        if (start) {
          const dx = Math.abs(e.clientX - start.x);
          const dy = Math.abs(e.clientY - start.y);
          if (dx < 5 && dy < 5) {
            onPageClick(page.id);
          }
        }
        mouseStart.current = null;
      }}
      onContextMenu={e => {
        e.preventDefault();
        e.stopPropagation();
        openMenu(e.clientX, e.clientY);
      }}
    >
      {renaming ? (
        <input
          className="sidebar-rename-input"
          value={renameValue}
          onChange={e => { setRenameValue(e.target.value); setRenameError(null); }}
          onKeyDown={e => {
            e.stopPropagation();
            if (e.key === "Enter") handleRename();
            if (e.key === "Escape") { e.preventDefault(); setRenaming(false); setRenameError(null); }
          }}
          onBlur={() => { if (renameError) { setRenaming(false); setRenameError(null); } else handleRename(); }}
          autoFocus
          aria-label="Page title"
          aria-invalid={!!renameError}
          onClick={e => e.stopPropagation()}
        />
      ) : (
        <span>{displayIcon(page)} {displayTitle(page)}</span>
      )}
      {/* ⋮ more button — shown on hover, on keyboard focus and for the open page */}
      <button
        ref={moreRef}
        className="page-more-btn"
        onClick={(e) => {
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          openMenu(rect.left, rect.bottom + 2, e.detail === 0);
        }}
        title="Page actions (Shift+F10)"
        aria-label={`Actions for ${displayTitle(page)}`}
        aria-haspopup="menu"
        tabIndex={-1}
      >&#8942;</button>
      {/* Context menu — rendered via portal to avoid clipping */}
      {ctxMenu && (
        <ContextMenuPortal x={ctxMenu.x} y={ctxMenu.y} onClose={() => { closeMenu(); }}>
          {!page.is_journal && (
            <button
              className="sidebar-context-menu-item"
              onClick={() => { setCtxMenu(null); setRenameValue(page.title); setRenaming(true); }}
            >
              &#9998; Rename
            </button>
          )}
          <button
            className="sidebar-context-menu-item"
            onClick={() => setShowMoveSubmenu(v => !v)}
          >
            &#128194; Move to... {showMoveSubmenu ? "\u25B4" : "\u25BE"}
          </button>
          {showMoveSubmenu && allFolders && (
            <div className="sidebar-context-submenu">
              {page.folder_id && (
                <button
                  className="sidebar-context-menu-item"
                  onClick={() => handleMoveToFolder(undefined)}
                >
                  (No project)
                </button>
              )}
              {allFolders.filter(f => f.id !== page.folder_id).map(f => (
                <button
                  key={f.id}
                  className="sidebar-context-menu-item"
                  onClick={() => handleMoveToFolder(f.id)}
                >
                  {f.icon ?? "\uD83D\uDCC1"} {f.name}
                </button>
              ))}
            </div>
          )}
          <button
            className="sidebar-context-menu-item"
            onClick={handleDuplicate}
          >
            &#128203; Duplicate
          </button>
          <button
            className="sidebar-context-menu-item"
            onClick={handleCopyPage}
          >
            &#8627; Copy
          </button>
          <button
            className="sidebar-context-menu-item"
            onClick={handleTogglePin}
          >
            {isPinned ? "\uD83D\uDDD9 Unpin" : "\uD83D\uDCCC Pin"}
          </button>
          <div className="sidebar-context-menu-sep" />
          <button
            className="sidebar-context-menu-item danger"
            onClick={() => {
              closeMenu();
              onDeletePage(page.id, displayTitle(page));
            }}
          >
            &#128465; Delete
          </button>
        </ContextMenuPortal>
      )}
    </div>
    {renaming && renameError && (
      <div className="inline-field-error sidebar-inline-error" role="alert" style={{ marginLeft: 16 + depth * 16 }}>
        {renameError}
      </div>
    )}
    </>
  );
}

// Recursive folder component with drop target
function FolderItem({
  folder, activePage, depth, isExpanded, onToggleExpanded, onPageClick, onDeletePage, onRefresh, allFolders, pinnedIds, onFolderSettings,
}: {
  folder: FolderTree;
  activePage: Page | null;
  depth: number;
  isExpanded: boolean;
  onToggleExpanded: (shiftKey: boolean) => void;
  onPageClick: (id: string) => void;
  onDeletePage: (id: string, title?: string) => void;
  onRefresh: () => void;
  allFolders?: FolderTree[];
  pinnedIds?: Set<string>;
  onFolderSettings?: (folderId: string) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [showAllPages, setShowAllPages] = useState(false);
  const [showInlineCreate, setShowInlineCreate] = useState(false);
  const [inlineTitle, setInlineTitle] = useState("");
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number } | null>(null);
  const [renamingFolder, setRenamingFolder] = useState(false);
  const [folderRenameValue, setFolderRenameValue] = useState(folder.name);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);

  const PAGE_CAP = 8;
  const sortedPages = [...folder.pages]
    .filter(p => !pinnedIds?.has(p.id))
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
  const totalPages = sortedPages.length;
  const displayedPages = showAllPages ? sortedPages : sortedPages.slice(0, PAGE_CAP);
  const hiddenCount = totalPages - PAGE_CAP;

  const handleTrashFolder = async () => {
    setFolderMenu(null);
    const count = await api.trashFolder(folder.id);
    onRefresh();
    showUndoToast(`"${folder.name}" deleted (${count} pages)`, async () => {
      await api.restoreFromTrash(folder.id, "folder");
      onRefresh();
    });
  };

  const handleRenameFolder = async () => {
    if (!renamingFolder) return; // guard against double-fire
    const trimmed = folderRenameValue.trim();
    if (!trimmed || trimmed === folder.name) { setRenamingFolder(false); setFolderError(null); return; }
    const conflict = await folderNameConflict(trimmed, folder.parent_id ?? null, folder.id);
    if (conflict) { setFolderError(conflict); return; }
    setRenamingFolder(false);
    setFolderError(null);
    try {
      await api.renameFolder(folder.id, trimmed);
    } catch (e) {
      showToast(`Couldn't rename project: ${errorMessage(e)}`);
    }
    onRefresh();
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const pageId = e.dataTransfer.getData("text/page-id");
    if (pageId) {
      if (e.dataTransfer.getData("text/page-pinned") === "true") {
        await api.removeFavorite(pageId);
      }
      await api.movePageToFolder(pageId, folder.id);
      onRefresh();
    }
  };

  const inlineBusy = useRef(false);
  const handleInlineCreate = async () => {
    const title = inlineTitle.trim();
    if (!title) { setShowInlineCreate(false); setInlineTitle(""); setInlineError(null); return; }
    if (inlineBusy.current) return;
    inlineBusy.current = true;
    try {
      const page = await api.createPage(title);
      await api.movePageToFolder(page.id, folder.id);
      setInlineTitle("");
      setInlineError(null);
      setShowInlineCreate(false);
      onRefresh();
      onPageClick(page.id);
    } catch (e) {
      setInlineError(`Couldn't create page: ${errorMessage(e)}`);
    } finally {
      inlineBusy.current = false;
    }
  };


  return (
    <>
      <div
        className={`folder-item ${dragOver ? "drop-target" : ""}`}
        style={{ paddingLeft: 16 + depth * 16 }}
        onClick={(e) => { if (!renamingFolder) onToggleExpanded(e.shiftKey); }}
        onContextMenu={e => {
          e.preventDefault();
          e.stopPropagation();
          setFolderMenu({ x: e.clientX, y: e.clientY });
        }}
        onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <span className="folder-toggle">{isExpanded ? "\u25BC" : "\u25B6"}</span>
        {renamingFolder ? (
          <input
            className="sidebar-rename-input"
            value={folderRenameValue}
            onChange={e => { setFolderRenameValue(e.target.value); setFolderError(null); }}
            onKeyDown={e => {
              e.stopPropagation();
              if (e.key === "Enter") handleRenameFolder();
              if (e.key === "Escape") { e.preventDefault(); setRenamingFolder(false); setFolderError(null); }
            }}
            onBlur={() => { if (folderError) { setRenamingFolder(false); setFolderError(null); } else handleRenameFolder(); }}
            aria-label="Project name"
            aria-invalid={!!folderError}
            onClick={e => e.stopPropagation()}
            onMouseDown={e => e.stopPropagation()}
            autoFocus
          />
        ) : (
          <span style={folder.color ? { color: folder.color } : undefined}>{folder.icon ?? "\uD83D\uDCC1"} {folder.name}</span>
        )}
        {!isExpanded && totalPages > 0 && (
          <span className="folder-count folder-count-hover">{totalPages}</span>
        )}
        {isExpanded && (
          <span className="folder-count">{totalPages}</span>
        )}
        <button
          className="page-more-btn"
          onClick={(e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            setFolderMenu({ x: rect.left, y: rect.bottom + 2 });
          }}
          title="Project actions"
          aria-label={`Actions for project ${folder.name}`}
          aria-haspopup="menu"
        >&#8942;</button>
      </div>
      {renamingFolder && folderError && (
        <div className="inline-field-error sidebar-inline-error" role="alert" style={{ marginLeft: 16 + depth * 16 }}>
          {folderError}
        </div>
      )}
      {/* Folder context menu — rendered via portal */}
      {folderMenu && (
        <ContextMenuPortal x={folderMenu.x} y={folderMenu.y} onClose={() => setFolderMenu(null)}>
          <button
            className="sidebar-context-menu-item"
            onClick={() => { setFolderMenu(null); setShowInlineCreate(true); }}
          >
            &#128196; New Page
          </button>
          <button
            className="sidebar-context-menu-item"
            onClick={() => { setFolderMenu(null); setFolderRenameValue(folder.name); setRenamingFolder(true); }}
          >
            &#9998; Rename
          </button>
          <button
            className="sidebar-context-menu-item"
            onClick={async () => {
              setFolderMenu(null);
              const count = await api.archiveFolder(folder.id);
              onRefresh();
              showUndoToast(`"${folder.name}" archived (${count} pages)`, async () => {
                await api.unarchiveFolder(folder.id);
                onRefresh();
              });
            }}
          >
            &#128230; Archive
          </button>
          <div className="sidebar-context-menu-sep" />
          <button
            className="sidebar-context-menu-item danger"
            onClick={handleTrashFolder}
          >
            &#128465; Delete
          </button>
          <div className="sidebar-context-menu-sep" />
          <button
            className="sidebar-context-menu-item"
            onClick={() => { setFolderMenu(null); onFolderSettings?.(folder.id); }}
          >
            &#9881; Settings...
          </button>
        </ContextMenuPortal>
      )}
      {/* Phase 2c: inline create input */}
      {showInlineCreate && (
        <div className="sidebar-actions" style={{ padding: "2px 16px 2px " + (32 + depth * 16) + "px" }}>
          <input
            className="search-input"
            placeholder="Page title..."
            value={inlineTitle}
            onChange={e => { setInlineTitle(e.target.value); setInlineError(null); }}
            onKeyDown={e => {
              if (e.key === "Enter") handleInlineCreate();
              if (e.key === "Escape") { e.preventDefault(); setShowInlineCreate(false); setInlineTitle(""); setInlineError(null); }
            }}
            onBlur={() => { if (!inlineError) handleInlineCreate(); }}
            aria-label={`New page in ${folder.name}`}
            autoFocus
          />
          {inlineError && <div className="inline-field-error" role="alert">{inlineError}</div>}
        </div>
      )}
      {/* Phase 4: animated expand/collapse */}
      <div className={`folder-children ${isExpanded ? "folder-children-expanded" : ""}`}>
        <div className="folder-children-inner">
          {folder.children.map(child => (
            <FolderItem
              key={child.id}
              folder={child}
              activePage={activePage}
              depth={depth + 1}
              isExpanded={false}
              onToggleExpanded={() => {}}
              onPageClick={onPageClick}
              onDeletePage={onDeletePage}
              onRefresh={onRefresh}
              allFolders={allFolders}
              pinnedIds={pinnedIds}
            />
          ))}
          {displayedPages.map(page => (
            <DraggablePage
              key={page.id}
              page={page}
              activePage={activePage}
              depth={depth + 1}
              onPageClick={onPageClick}
              onDeletePage={onDeletePage}
              onRefresh={onRefresh}
              allFolders={allFolders}
            />
          ))}
          {/* Phase 3b: ...+N more link */}
          {!showAllPages && hiddenCount > 0 && (
            <div
              className="page-item sidebar-more-pages"
              style={{ paddingLeft: 16 + (depth + 1) * 16 }}
              onClick={() => setShowAllPages(true)}
            >
              ...+{hiddenCount} more
            </div>
          )}
        </div>
      </div>
    </>
  );
}
