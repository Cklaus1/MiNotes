import { useState, useRef, useEffect } from "react";
import type { Block } from "../lib/api";

interface Props {
  block: Block;
  onUpdate: (id: string, content: string) => void;
  onDelete: (id: string) => void;
  onPageLinkClick: (title: string) => void;
}

export default function BlockItem({ block, onUpdate, onDelete, onPageLinkClick }: Props) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(block.content);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setContent(block.content);
  }, [block.content]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.selectionStart = inputRef.current.value.length;
    }
  }, [editing]);

  const handleBlur = () => {
    setEditing(false);
    if (content !== block.content) {
      onUpdate(block.id, content);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleBlur();
    }
    if (e.key === "Escape") {
      setContent(block.content);
      setEditing(false);
    }
  };

  // Render content with [[wiki links]] highlighted
  const renderContent = (text: string) => {
    const parts = text.split(/(\[\[[^\]]+\]\])/g);
    return parts.map((part, i) => {
      const match = part.match(/^\[\[([^\]]+)\]\]$/);
      if (match) {
        return (
          <span
            key={i}
            className="wiki-link"
            onClick={(e) => { e.stopPropagation(); onPageLinkClick(match[1]); }}
          >
            {match[1]}
          </span>
        );
      }
      return <span key={i}>{part}</span>;
    });
  };

  return (
    <div className="block">
      {editing ? (
        <textarea
          ref={inputRef}
          className="block-content"
          value={content}
          onChange={e => setContent(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          rows={Math.max(1, content.split("\n").length)}
          style={{
            width: "100%",
            border: "none",
            background: "transparent",
            resize: "none",
            font: "inherit",
            color: "inherit",
          }}
        />
      ) : (
        <div
          className="block-content"
          onClick={() => setEditing(true)}
          style={{ cursor: "text" }}
        >
          {renderContent(block.content)}
        </div>
      )}
    </div>
  );
}
