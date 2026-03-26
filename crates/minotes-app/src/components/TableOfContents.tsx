import { useMemo } from "react";
import type { Block } from "../lib/api";

interface Props {
  blocks: Block[];
  visible: boolean;
  onClose: () => void;
}

interface Heading {
  blockId: string;
  text: string;
  level: number;
}

export default function TableOfContents({ blocks, visible, onClose }: Props) {
  const headings = useMemo(() => {
    const result: Heading[] = [];
    for (const b of blocks) {
      const match = b.content.match(/^(#{1,4})\s+(.+)/);
      if (match) {
        result.push({
          blockId: b.id,
          text: match[2].replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1").trim(),
          level: match[1].length,
        });
      }
    }
    return result;
  }, [blocks]);

  if (!visible) return null;

  const scrollTo = (blockId: string) => {
    const el = document.querySelector(`[data-block-id="${blockId}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  return (
    <div className="toc-panel">
      <div className="toc-header">
        <span>Outline</span>
        <button className="toc-close" onClick={onClose}>x</button>
      </div>
      <div className="toc-list">
        {headings.length === 0 && (
          <div className="toc-empty">No headings found. Use # to create headings.</div>
        )}
        {headings.map((h) => (
          <button
            key={h.blockId}
            className="toc-item"
            style={{ paddingLeft: `${(h.level - 1) * 16 + 12}px` }}
            onClick={() => scrollTo(h.blockId)}
          >
            {h.text}
          </button>
        ))}
      </div>
    </div>
  );
}
