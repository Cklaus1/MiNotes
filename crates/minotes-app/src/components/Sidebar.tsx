import { useState, useEffect, useCallback, useRef } from "react";
import type { Page, GraphStats, FolderTree, FolderTreeRoot } from "../lib/api";
import * as api from "../lib/api";
import CalendarWidget from "./CalendarWidget";
import { getRecentPages } from "../lib/recentFiles";
function formatJournalDate(dateStr: string): string {
  try {
    const [y, m, d] = dateStr.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  } catch {
    return dateStr;
  }
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
  onCreatePage: (title: string) => void;
  onDeletePage: (id: string) => void;
  onJournalClick: (date?: string) => void;
  onSearchClick: () => void;
  onGraphClick: () => void;
  onMindmapClick: () => void;
  onWhiteboardClick: () => void;
  onKanbanClick: () => void;
  onPagesClick: () => void;
  onSettingsClick: () => void;
  activeMode: "graph" | "mindmap" | "whiteboard" | "kanban" | "pages" | null;
  refreshKey: number;
}

export default function Sidebar({
  activePage, stats, onPageClick, onCreatePage, onDeletePage,
  onJournalClick, onSearchClick, onGraphClick, onMindmapClick, onWhiteboardClick, onKanbanClick, onPagesClick, onSettingsClick, activeMode, refreshKey,
}: Props) {
  const [newTitle, setNewTitle] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [showFolderCreate, setShowFolderCreate] = useState(false);
  const [treeData, setTreeData] = useState<FolderTreeRoot | null>(null);
  const [journals, setJournals] = useState<Page[]>([]);
  const [showCalendar, setShowCalendar] = useState(false);
  const [favorites, setFavorites] = useState<Page[]>([]);

  // Phase 3a: Track expanded project IDs (max 2), persisted
  const [expandedProjectIds, setExpandedProjectIds] = useState<string[]>(() => loadExpandedIds());
  // Phase 2d: Collapse/expand all toggle — stores IDs that were open before collapse-all
  const [allCollapsed, setAllCollapsed] = useState(false);
  const [preCollapseIds, setPreCollapseIds] = useState<string[]>([]);

  // Persist expanded state
  useEffect(() => {
    saveExpandedIds(expandedProjectIds);
  }, [expandedProjectIds]);

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
    } catch (e) {
      console.error("Failed to load folder tree:", e);
    }
  }, []);

  useEffect(() => { loadTree(); }, [loadTree, refreshKey]);

  const handleCreate = () => {
    if (newTitle.trim()) {
      onCreatePage(newTitle.trim());
      setNewTitle("");
      setShowCreate(false);
    }
  };

  const handleCreateFolder = async () => {
    if (newFolderName.trim()) {
      const folder = await api.createFolder(newFolderName.trim());
      setNewFolderName("");
      setShowFolderCreate(false);
      // Auto-expand the new project
      setExpandedProjectIds(prev => {
        const next = [...prev, folder.id];
        if (next.length > MAX_EXPANDED) return next.slice(next.length - MAX_EXPANDED);
        return next;
      });
      loadTree();
    }
  };

  const handleDropOnRoot = async (e: React.DragEvent) => {
    e.preventDefault();
    e.currentTarget.classList.remove("drop-target");
    const pageId = e.dataTransfer.getData("text/page-id");
    if (pageId) {
      await api.movePageToFolder(pageId, undefined);
      loadTree();
    }
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
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const todayLabel = today.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

  // Quick Access: pinned (favorites) + recent, deduped
  const recentPages = getRecentPages().slice(0, 5);
  const pinnedIds = new Set(favorites.map(f => f.id));
  const recentFiltered = recentPages.filter(r => !pinnedIds.has(r.id));
  const showQuickAccess = favorites.length > 0 || recentFiltered.length > 0;

  // Projects: first 5 visible, rest overflow
  const allProjects = treeData?.folders ?? [];
  const visibleProjects = allProjects.slice(0, 5);
  const overflowProjects = allProjects.slice(5);

  return (
    <div className="sidebar workspace-ribbon">
      {/* -- Sticky top: Search + New -- */}
      <div className="sidebar-header">
        <h1>MiNotes</h1>
        <button className="sidebar-gear-btn" onClick={onSettingsClick} title="Settings (Ctrl+,)">&#x2699;</button>
      </div>
      <div className="sidebar-actions-bar">
        <button className="btn btn-sm" onClick={onSearchClick} title="Search (Ctrl+K)" style={{ flex: 1 }}>
          &#128269; Search
        </button>
        <button className="btn btn-sm btn-primary" onClick={() => setShowCreate(!showCreate)}>
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
              if (e.key === "Escape") setShowCreate(false);
            }}
            autoFocus
          />
        </div>
      )}

      {/* -- Journal: one line -- */}
      <div className="sidebar-journal-row">
        <span className="sidebar-journal-text" onClick={() => onJournalClick()} title="Open today's journal (Ctrl+J)">
          &#128197; {todayLabel}
        </span>
        <button
          className="cal-toggle-btn"
          onClick={() => setShowCalendar(c => !c)}
          title="Toggle calendar"
        >
          &#128197;
        </button>
      </div>
      {showCalendar && (
        <CalendarWidget
          journalDates={new Set(journals.map(j => j.journal_date).filter(Boolean) as string[])}
          onDateClick={(date) => onJournalClick(date)}
        />
      )}

      <div className="sidebar-section">
        {/* -- Quick Access: Pinned + Recent -- */}
        {showQuickAccess && (
          <>
            <div className="sidebar-section-title">Quick Access</div>
            {favorites.map(page => (
              <div
                key={page.id}
                className={`page-item ${activePage?.id === page.id ? "active" : ""}`}
                onClick={() => onPageClick(page.id)}
                onContextMenu={e => {
                  e.preventDefault();
                  api.removeFavorite(page.id).then(loadTree);
                }}
                title="Right-click to unpin"
              >
                <span>&#128204; {page.title}</span>
              </div>
            ))}
            {recentFiltered.map(r => (
              <div
                key={r.id}
                className={`page-item ${activePage?.id === r.id ? "active" : ""}`}
                onClick={() => onPageClick(r.id)}
              >
                <span>{r.title}</span>
                <button
                  className="pin-btn"
                  onClick={(e) => { e.stopPropagation(); api.addFavorite(r.id).then(loadTree); }}
                  title="Pin to Quick Access"
                >&#128204;</button>
              </div>
            ))}
          </>
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
                  />
                ))}
              </details>
            )}

            {/* Root pages (not in any project) */}
            {treeData && treeData.root_pages.filter(p => !p.is_journal).length > 0 && (
              <div
                className="root-drop-zone"
                onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add("drop-target"); }}
                onDragLeave={e => e.currentTarget.classList.remove("drop-target")}
                onDrop={handleDropOnRoot}
              >
                {treeData.root_pages.filter(p => !p.is_journal).map(page => (
                  <DraggablePage
                    key={page.id}
                    page={page}
                    activePage={activePage}
                    depth={0}
                    onPageClick={onPageClick}
                    onDeletePage={onDeletePage}
                    siblings={treeData.root_pages.filter(p => !p.is_journal)}
                    onRefresh={loadTree}
                  />
                ))}
              </div>
            )}

            {/* + New Project */}
            {showFolderCreate ? (
              <div className="sidebar-actions" style={{ padding: "2px 16px" }}>
                <input
                  className="search-input"
                  placeholder="Project name..."
                  value={newFolderName}
                  onChange={e => setNewFolderName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") handleCreateFolder();
                    if (e.key === "Escape") setShowFolderCreate(false);
                  }}
                  autoFocus
                />
              </div>
            ) : (
              <div
                className="page-item sidebar-new-project"
                onClick={() => setShowFolderCreate(true)}
              >
                + New Project
              </div>
            )}
          </>
        )}
      </div>

      {/* -- Sticky bottom: Mode buttons -- */}
      <div className="stats-bar">
        <div className="stats-modes-divider" />
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

// Draggable page item with reorder drop zones
function DraggablePage({
  page, activePage, depth, onPageClick, onDeletePage, siblings, onRefresh, showPinButton,
}: {
  page: Page;
  activePage: Page | null;
  depth: number;
  onPageClick: (id: string) => void;
  onDeletePage: (id: string) => void;
  siblings: Page[];
  onRefresh: () => void;
  showPinButton?: boolean;
}) {
  const [dropPosition, setDropPosition] = useState<"above" | "below" | null>(null);
  const mouseStart = useRef<{ x: number; y: number } | null>(null);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    setDropPosition(e.clientY < midY ? "above" : "below");
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropPosition(null);

    const draggedId = e.dataTransfer.getData("text/page-id");
    if (!draggedId || draggedId === page.id) return;

    const idx = siblings.findIndex(p => p.id === page.id);
    let newPos: number;

    if (dropPosition === "above") {
      const prevPos = idx > 0 ? siblings[idx - 1].position : 0;
      newPos = (prevPos + page.position) / 2;
    } else {
      const nextPos = idx < siblings.length - 1 ? siblings[idx + 1].position : page.position + 1;
      newPos = (page.position + nextPos) / 2;
    }

    await api.movePageToFolder(draggedId, page.folder_id ?? undefined);
    await api.reorderPage(draggedId, newPos);
    onRefresh();
  };

  return (
    <div
      className={`page-item ${activePage?.id === page.id ? "active" : ""} ${dropPosition === "above" ? "drop-above" : ""} ${dropPosition === "below" ? "drop-below" : ""}`}
      style={{ paddingLeft: 16 + depth * 16 }}
      draggable
      onDragStart={e => {
        e.dataTransfer.setData("text/page-id", page.id);
        e.dataTransfer.setData("text/page-folder", page.folder_id ?? "");
        e.dataTransfer.effectAllowed = "move";
        e.currentTarget.classList.add("dragging");
      }}
      onDragEnd={e => { e.currentTarget.classList.remove("dragging"); setDropPosition(null); }}
      onMouseDown={e => { mouseStart.current = { x: e.clientX, y: e.clientY }; }}
      onMouseUp={e => {
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
      onDragOver={handleDragOver}
      onDragLeave={() => setDropPosition(null)}
      onDrop={handleDrop}
      onContextMenu={e => {
        e.preventDefault();
        if (confirm(`Delete "${page.title}"?`)) onDeletePage(page.id);
      }}
    >
      <span>{page.icon ?? "\uD83D\uDCC4"} {page.title}</span>
      {/* Phase 2b: pin button on hover for pages in project folders */}
      {showPinButton !== false && (
        <button
          className="pin-btn"
          onClick={(e) => { e.stopPropagation(); api.addFavorite(page.id).then(onRefresh); }}
          title="Pin to Quick Access"
        >&#128204;</button>
      )}
    </div>
  );
}

// Recursive folder component with drop target
function FolderItem({
  folder, activePage, depth, isExpanded, onToggleExpanded, onPageClick, onDeletePage, onRefresh,
}: {
  folder: FolderTree;
  activePage: Page | null;
  depth: number;
  isExpanded: boolean;
  onToggleExpanded: (shiftKey: boolean) => void;
  onPageClick: (id: string) => void;
  onDeletePage: (id: string) => void;
  onRefresh: () => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  // Phase 3b: show all pages or capped at 8
  const [showAllPages, setShowAllPages] = useState(false);
  // Phase 2c: inline create page inside this project
  const [showInlineCreate, setShowInlineCreate] = useState(false);
  const [inlineTitle, setInlineTitle] = useState("");

  const PAGE_CAP = 8;
  const totalPages = folder.pages.length;
  const displayedPages = showAllPages ? folder.pages : folder.pages.slice(0, PAGE_CAP);
  const hiddenCount = totalPages - PAGE_CAP;

  const handleDeleteFolder = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (confirm(`Delete project "${folder.name}"? Pages will be moved to root.`)) {
      await api.deleteFolder(folder.id);
      onRefresh();
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const pageId = e.dataTransfer.getData("text/page-id");
    if (pageId) {
      await api.movePageToFolder(pageId, folder.id);
      onRefresh();
    }
  };

  const handleInlineCreate = async () => {
    if (inlineTitle.trim()) {
      const page = await api.createPage(inlineTitle.trim());
      await api.movePageToFolder(page.id, folder.id);
      setInlineTitle("");
      setShowInlineCreate(false);
      onRefresh();
    }
  };

  return (
    <>
      <div
        className={`folder-item ${dragOver ? "drop-target" : ""}`}
        style={{ paddingLeft: 16 + depth * 16 }}
        onClick={(e) => onToggleExpanded(e.shiftKey)}
        onContextMenu={handleDeleteFolder}
        onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <span className="folder-toggle">{isExpanded ? "\u25BC" : "\u25B6"}</span>
        <span>{folder.icon ?? "\uD83D\uDCC1"} {folder.name}</span>
        {/* Phase 3: page count on hover for collapsed projects */}
        {!isExpanded && totalPages > 0 && (
          <span className="folder-count folder-count-hover">{totalPages}</span>
        )}
        {isExpanded && (
          <span className="folder-count">{totalPages}</span>
        )}
        {/* Phase 2c: [+] button on hover to create page inside project */}
        <button
          className="folder-add-btn"
          onClick={(e) => { e.stopPropagation(); setShowInlineCreate(true); }}
          title="New page in this project"
        >+</button>
      </div>
      {/* Phase 2c: inline create input */}
      {showInlineCreate && (
        <div className="sidebar-actions" style={{ padding: "2px 16px 2px " + (32 + depth * 16) + "px" }}>
          <input
            className="search-input"
            placeholder="Page title..."
            value={inlineTitle}
            onChange={e => setInlineTitle(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") handleInlineCreate();
              if (e.key === "Escape") { setShowInlineCreate(false); setInlineTitle(""); }
            }}
            autoFocus
          />
        </div>
      )}
      {isExpanded && (
        <>
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
              siblings={folder.pages}
              onRefresh={onRefresh}
              showPinButton={true}
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
        </>
      )}
    </>
  );
}
