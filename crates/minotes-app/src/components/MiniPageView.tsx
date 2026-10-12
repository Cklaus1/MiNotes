import { useState, useEffect } from "react";
import type { PageTree } from "../lib/api";
import * as api from "../lib/api";
import { followNotebookLink, notebookLinkLabel, splitNotebookLink } from "../lib/crossNotebook";

interface Props {
  pageId: string;
  onPageClick: (id: string) => void;
}

function renderContent(text: string, onPageClick: (id: string) => void) {
  const parts = text.split(/(\[\[[^\]]+\]\])/g);
  return parts.map((part, i) => {
    const match = part.match(/^\[\[([^\]]+)\]\]$/);
    const xnb = match ? splitNotebookLink(match[1].split("|")[0]) : null;
    if (xnb) {
      return (
        <span
          key={i}
          className="xnb-link"
          onClick={(e) => { e.stopPropagation(); void followNotebookLink(xnb.notebook, xnb.page); }}
        >
          {notebookLinkLabel(xnb.notebook, xnb.page)}
        </span>
      );
    }
    if (match) {
      return (
        <span
          key={i}
          className="wiki-link"
          onClick={(e) => { e.stopPropagation(); onPageClick(match[1]); }}
        >
          {match[1]}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

export default function MiniPageView({ pageId, onPageClick }: Props) {
  const [tree, setTree] = useState<PageTree | null>(null);

  useEffect(() => {
    api.getPageTree(pageId).then(setTree).catch(() => {});
  }, [pageId]);

  if (!tree) return <div style={{ color: "var(--text-muted)", fontSize: 12, padding: "4px 0" }}>Loading...</div>;

  return (
    <div className="mini-page-view">
      {tree.blocks.map(block => (
        <div key={block.id} className="mini-block">
          {renderContent(block.content, onPageClick)}
        </div>
      ))}
      {tree.blocks.length === 0 && (
        <div style={{ color: "var(--text-muted)", fontSize: 12 }}>Empty page</div>
      )}
    </div>
  );
}
