import { useState, useRef, useCallback } from "react";
import type { PageTree } from "../lib/api";
import BlockItem from "./BlockItem";

interface Props {
  pageTree: PageTree;
  onCreateBlock: (content: string) => void;
  onUpdateBlock: (id: string, content: string) => void;
  onDeleteBlock: (id: string) => void;
  onPageLinkClick: (title: string) => void;
}

export default function PageView({
  pageTree, onCreateBlock, onUpdateBlock, onDeleteBlock, onPageLinkClick,
}: Props) {
  const { page, blocks } = pageTree;
  const [newContent, setNewContent] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleAdd = useCallback(() => {
    if (newContent.trim()) {
      onCreateBlock(newContent.trim());
      setNewContent("");
      inputRef.current?.focus();
    }
  }, [newContent, onCreateBlock]);

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit",
      });
    } catch {
      return iso;
    }
  };

  return (
    <>
      <div className="main-header">
        <h2>{page.icon ?? ""} {page.title}</h2>
        <span className="page-meta">
          {blocks.length} blocks · Updated {formatDate(page.updated_at)}
        </span>
      </div>
      <div className="content">
        <div className="block-list">
          {blocks.map(block => (
            <BlockItem
              key={block.id}
              block={block}
              onUpdate={onUpdateBlock}
              onDelete={onDeleteBlock}
              onPageLinkClick={onPageLinkClick}
            />
          ))}

          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <input
              ref={inputRef}
              className="search-input"
              placeholder="Add a block..."
              value={newContent}
              onChange={e => setNewContent(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleAdd()}
              style={{ flex: 1 }}
            />
            <button className="btn btn-primary" onClick={handleAdd}>Add</button>
          </div>
        </div>
      </div>
    </>
  );
}
