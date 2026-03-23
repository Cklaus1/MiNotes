import { useState } from "react";
import type { Page, GraphStats } from "../lib/api";

interface Props {
  pages: Page[];
  activePage: Page | null;
  stats: GraphStats | null;
  onPageClick: (id: string) => void;
  onCreatePage: (title: string) => void;
}

export default function Sidebar({ pages, activePage, stats, onPageClick, onCreatePage }: Props) {
  const [newTitle, setNewTitle] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const journals = pages.filter(p => p.is_journal);
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
            onKeyDown={e => e.key === "Enter" && handleCreate()}
            autoFocus
          />
        </div>
      )}

      <div className="sidebar-section">
        {regular.length > 0 && (
          <>
            <div className="sidebar-section-title">Pages</div>
            {regular.map(page => (
              <div
                key={page.id}
                className={`page-item ${activePage?.id === page.id ? "active" : ""}`}
                onClick={() => onPageClick(page.id)}
              >
                {page.icon ?? "📄"} {page.title}
              </div>
            ))}
          </>
        )}

        {journals.length > 0 && (
          <>
            <div className="sidebar-section-title">Journal</div>
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

      {stats && (
        <div className="stats-bar">
          <span>{stats.pages} pages</span>
          <span>{stats.blocks} blocks</span>
          <span>{stats.links} links</span>
        </div>
      )}
    </div>
  );
}
