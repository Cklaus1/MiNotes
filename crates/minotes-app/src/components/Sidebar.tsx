import { useState, useEffect, useCallback } from "react";
import type { Page, GraphStats, FolderTree, FolderTreeRoot } from "../lib/api";
import * as api from "../lib/api";

interface Props {
  activePage: Page | null;
  stats: GraphStats | null;
  onPageClick: (id: string) => void;
  onCreatePage: (title: string) => void;
  onDeletePage: (id: string) => void;
  onJournalClick: () => void;
  onSearchClick: () => void;
  refreshKey: number;
}

export default function Sidebar({
  activePage, stats, onPageClick, onCreatePage, onDeletePage,
  onJournalClick, onSearchClick, refreshKey,
}: Props) {
  const [newTitle, setNewTitle] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [showFolderCreate, setShowFolderCreate] = useState(false);
  const [treeData, setTreeData] = useState<FolderTreeRoot | null>(null);
  const [journals, setJournals] = useState<Page[]>([]);

  const loadTree = useCallback(async () => {
    try {
      const tree = await api.getFolderTree();
      setTreeData(tree);
      const pages = await api.listPages(200);
      setJournals(pages.filter(p => p.is_journal).slice(0, 7));
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
      await api.createFolder(newFolderName.trim());
      setNewFolderName("");
      setShowFolderCreate(false);
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

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <h1>MiNotes</h1>
        <div style={{ display: "flex", gap: 4 }}>
          <button className="btn btn-sm" onClick={onSearchClick} title="Search (Ctrl+K)">
            Search
          </button>
          <button className="btn btn-sm btn-primary" onClick={() => setShowCreate(!showCreate)}>
            + New
          </button>
        </div>
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

      <div className="sidebar-actions" style={{ padding: "4px 16px", display: "flex", gap: 4 }}>
        <button className="btn" onClick={onJournalClick} style={{ flex: 1, textAlign: "left" }}>
          📅 Today's Journal
        </button>
        <button
          className="btn btn-sm"
          onClick={() => setShowFolderCreate(!showFolderCreate)}
          title="New folder"
        >
          📁+
        </button>
      </div>

      {showFolderCreate && (
        <div className="sidebar-actions">
          <input
            className="search-input"
            placeholder="Folder name..."
            value={newFolderName}
            onChange={e => setNewFolderName(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") handleCreateFolder();
              if (e.key === "Escape") setShowFolderCreate(false);
            }}
            autoFocus
          />
        </div>
      )}

      <div className="sidebar-section">
        {treeData && (
          <>
            {/* Folder tree */}
            {treeData.folders.map(folder => (
              <FolderItem
                key={folder.id}
                folder={folder}
                activePage={activePage}
                depth={0}
                onPageClick={onPageClick}
                onDeletePage={onDeletePage}
                onRefresh={loadTree}
              />
            ))}

            {/* Root pages drop zone */}
            <div
              className="root-drop-zone"
              onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add("drop-target"); }}
              onDragLeave={e => e.currentTarget.classList.remove("drop-target")}
              onDrop={handleDropOnRoot}
            >
              <div className="sidebar-section-title">
                Pages ({treeData.root_pages.filter(p => !p.is_journal).length})
                <span className="drop-hint"> — drop here for root</span>
              </div>
              {treeData.root_pages.filter(p => !p.is_journal).map(page => (
                <DraggablePage
                  key={page.id}
                  page={page}
                  activePage={activePage}
                  depth={0}
                  onPageClick={onPageClick}
                  onDeletePage={onDeletePage}
                />
              ))}
            </div>
          </>
        )}

        {journals.length > 0 && (
          <>
            <div className="sidebar-section-title">Recent Journals</div>
            {journals.map(page => (
              <div
                key={page.id}
                className={`page-item ${activePage?.id === page.id ? "active" : ""}`}
                onClick={() => onPageClick(page.id)}
              >
                📅 {page.journal_date ?? page.title}
              </div>
            ))}
          </>
        )}
      </div>

      <div className="stats-bar">
        {stats && (
          <>
            <span>{stats.pages} pages</span>
            <span>{stats.blocks} blocks</span>
            <span>{stats.links} links</span>
          </>
        )}
        <span className="shortcut-hint" style={{ marginLeft: "auto" }}>Ctrl+K</span>
      </div>
    </div>
  );
}

// Draggable page item
function DraggablePage({
  page, activePage, depth, onPageClick, onDeletePage,
}: {
  page: Page;
  activePage: Page | null;
  depth: number;
  onPageClick: (id: string) => void;
  onDeletePage: (id: string) => void;
}) {
  return (
    <div
      className={`page-item ${activePage?.id === page.id ? "active" : ""}`}
      style={{ paddingLeft: 16 + depth * 16 }}
      draggable
      onDragStart={e => {
        e.dataTransfer.setData("text/page-id", page.id);
        e.dataTransfer.effectAllowed = "move";
        e.currentTarget.classList.add("dragging");
      }}
      onDragEnd={e => e.currentTarget.classList.remove("dragging")}
      onClick={() => onPageClick(page.id)}
      onContextMenu={e => {
        e.preventDefault();
        if (confirm(`Delete "${page.title}"?`)) onDeletePage(page.id);
      }}
    >
      {page.icon ?? "📄"} {page.title}
    </div>
  );
}

// Recursive folder component with drop target
function FolderItem({
  folder, activePage, depth, onPageClick, onDeletePage, onRefresh,
}: {
  folder: FolderTree;
  activePage: Page | null;
  depth: number;
  onPageClick: (id: string) => void;
  onDeletePage: (id: string) => void;
  onRefresh: () => void;
}) {
  const [collapsed, setCollapsed] = useState(folder.collapsed);
  const [dragOver, setDragOver] = useState(false);

  const handleDeleteFolder = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (confirm(`Delete folder "${folder.name}"? Pages will be moved to root.`)) {
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

  return (
    <>
      <div
        className={`folder-item ${dragOver ? "drop-target" : ""}`}
        style={{ paddingLeft: 16 + depth * 16 }}
        onClick={() => setCollapsed(!collapsed)}
        onContextMenu={handleDeleteFolder}
        onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <span className="folder-toggle">{collapsed ? "▶" : "▼"}</span>
        <span>{folder.icon ?? "📁"} {folder.name}</span>
        <span className="folder-count">{folder.pages.length + folder.children.length}</span>
      </div>
      {!collapsed && (
        <>
          {folder.children.map(child => (
            <FolderItem
              key={child.id}
              folder={child}
              activePage={activePage}
              depth={depth + 1}
              onPageClick={onPageClick}
              onDeletePage={onDeletePage}
              onRefresh={onRefresh}
            />
          ))}
          {folder.pages.map(page => (
            <DraggablePage
              key={page.id}
              page={page}
              activePage={activePage}
              depth={depth + 1}
              onPageClick={onPageClick}
              onDeletePage={onDeletePage}
            />
          ))}
        </>
      )}
    </>
  );
}
