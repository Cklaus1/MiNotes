import { useMemo, useEffect, useState, useRef } from "react";
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
  const [activeId, setActiveId] = useState<string | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

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

  // Highlight current section via IntersectionObserver
  useEffect(() => {
    if (!visible || headings.length === 0) return;

    observerRef.current?.disconnect();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.getAttribute("data-block-id"));
          }
        }
      },
      { rootMargin: "-20% 0px -70% 0px" },
    );
    observerRef.current = observer;

    for (const h of headings) {
      const el = document.querySelector(`[data-block-id="${h.blockId}"]`);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, [visible, headings]);

  // Hide entirely when no headings
  if (!visible || headings.length === 0) return null;

  const scrollTo = (blockId: string) => {
    const el = document.querySelector(`[data-block-id="${blockId}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="toc-right-panel">
      <div className="toc-right-header">
        <span>On this page</span>
        <button className="toc-close" onClick={onClose} aria-label="Close outline">x</button>
      </div>
      <nav className="toc-right-list">
        {headings.map((h) => (
          <button
            key={h.blockId}
            className={`toc-right-item${activeId === h.blockId ? " active" : ""}`}
            data-level={h.level}
            style={{ paddingLeft: `${(h.level - 1) * 12 + 8}px` }}
            onClick={() => scrollTo(h.blockId)}
          >
            {h.text}
          </button>
        ))}
      </nav>
    </div>
  );
}
