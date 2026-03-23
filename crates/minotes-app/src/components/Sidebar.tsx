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

            {/* Root pages (not in any folder) */}
            {treeData.root_pages.filter(p => !p.is_journal).length > 0 && (
              <>
                <div className="sidebar-section-title">
                  Pages ({treeData.root_pages.filter(p => !p.is_journal).length})
                </div>
                {treeData.root_pages.filter(p => !p.is_journal).map(page => (
                  <div
                    key={page.id}
                    className={`page-item ${activePage?.id === page.id ? "active" : ""}`}
                    onClick={() => onPageClick(page.id)}
                    onContextMenu={e => {
                      e.preventDefault();
                      if (confirm(`Delete "${page.title}"?`)) onDeletePage(page.id);
                    }}
                  >
                    {page.icon ?? "📄"} {page.title}
                  </div>
                ))}
              </>
            )}
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

// Recursive folder component
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

  const handleDeleteFolder = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (confirm(`Delete folder "${folder.name}"? Pages will be moved to root.`)) {
      await api.deleteFolder(folder.id);
      onRefresh();
    }
  };

  return (
    <>
      <div
        className="folder-item"
        style={{ paddingLeft: 16 + depth * 16 }}
        onClick={() => setCollapsed(!collapsed)}
        onContextMenu={handleDeleteFolder}
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
            <div
              key={page.id}
              className={`page-item ${activePage?.id === page.id ? "active" : ""}`}
              style={{ paddingLeft: 32 + depth * 16 }}
              onClick={() => onPageClick(page.id)}
              onContextMenu={e => {
                e.preventDefault();
                if (confirm(`Delete "${page.title}"?`)) onDeletePage(page.id);
              }}
            >
              {page.icon ?? "📄"} {page.title}
            </div>
          ))}
        </>
      )}
    </>
  );
}
