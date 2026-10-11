import { useState } from "react";
import { openImport } from "../lib/importPicks";

interface Props {
  onCreatePage: (title: string) => void;
}

export default function EmptyState({ onCreatePage }: Props) {
  const [title, setTitle] = useState("");

  return (
    <div className="empty-state">
      <h3>Welcome to MiNotes</h3>
      <p>Create a page to get started</p>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          className="search-input"
          placeholder="Page title..."
          value={title}
          onChange={e => setTitle(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && title.trim()) {
              onCreatePage(title.trim());
              setTitle("");
            }
          }}
        />
        <button
          className="btn btn-primary"
          onClick={() => {
            if (title.trim()) {
              onCreatePage(title.trim());
              setTitle("");
            }
          }}
        >
          Create
        </button>
      </div>
      <button className="btn btn-sm" onClick={() => openImport()} style={{ marginTop: 10 }} data-testid="empty-state-import">
        Import notes from Obsidian, Evernote or markdown…
      </button>
    </div>
  );
}
