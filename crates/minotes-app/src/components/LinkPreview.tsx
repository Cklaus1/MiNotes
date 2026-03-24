import { useState, useEffect } from "react";
import type { PageTree } from "../lib/api";
import * as api from "../lib/api";

interface Props {
  pageName: string;
  x: number;
  y: number;
  onClose: () => void;
  onPageClick: (title: string) => void;
}

export default function LinkPreview({ pageName, x, y, onClose, onPageClick }: Props) {
  const [tree, setTree] = useState<PageTree | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getPageTree(pageName).then(t => {
      setTree(t);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [pageName]);

  return (
    <div
      className="link-preview"
      style={{ left: x, top: y }}
      onMouseLeave={onClose}
    >
      <div className="link-preview-title" onClick={() => onPageClick(pageName)}>
        {pageName}
      </div>
      {loading ? (
        <div className="link-preview-loading">Loading...</div>
      ) : tree ? (
        <div className="link-preview-blocks">
          {tree.blocks.slice(0, 5).map(b => (
            <div key={b.id} className="link-preview-block">
              {b.content.slice(0, 100)}
            </div>
          ))}
          {tree.blocks.length > 5 && (
            <div className="link-preview-more">+{tree.blocks.length - 5} more blocks</div>
          )}
        </div>
      ) : (
        <div className="link-preview-empty">Page not found</div>
      )}
    </div>
  );
}
