import { useState } from "react";
import type { Page, GraphStats } from "../lib/api";

interface Props {
  pages: Page[];
  activePage: Page | null;
  stats: GraphStats | null;
  onPageClick: (id: string) => void;
  onCreatePage: (title: string) => void;
  onDeletePage: (id: string) => void;
  onJournalClick: () => void;
  onSearchClick: () => void;
}

export default function Sidebar({
  pages, activePage, stats, onPageClick, onCreatePage, onDeletePage, onJournalClick, onSearchClick,
}: Props) {
  const [newTitle, setNewTitle] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const journals = pages.filter(p => p.is_journal).slice(0, 7);
  const regular = pages.filter(p => !p.is_journal);

  const handleCreate = () => {
    if (newTitle.trim()) {
      onCreatePage(newTitle.trim());
      setNewTitle("");
      setShowCreate(false);
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

      <div className="sidebar-actions" style={{ padding: "4px 16px" }}>
        <button className="btn" onClick={onJournalClick} style={{ width: "100%", textAlign: "left" }}>
          📅 Today's Journal
        </button>
      </div>

      <div className="sidebar-section">
        {regular.length > 0 && (
          <>
            <div className="sidebar-section-title">Pages ({regular.length})</div>
            {regular.map(page => (
              <div
                key={page.id}
                className={`page-item ${activePage?.id === page.id ? "active" : ""}`}
                onClick={() => onPageClick(page.id)}
                onContextMenu={e => {
                  e.preventDefault();
                  if (confirm(`Delete "${page.title}"?`)) {
                    onDeletePage(page.id);
                  }
                }}
              >
                {page.icon ?? "📄"} {page.title}
              </div>
            ))}
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
