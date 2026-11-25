import { useState } from "react";
import MiniPageView from "./MiniPageView";

interface SidebarPanel {
  id: string;
  title: string;
}

interface Props {
  panels: SidebarPanel[];
  onClose: (id: string) => void;
  onPageClick: (id: string) => void;
}

export default function RightSidebar({ panels, onClose, onPageClick }: Props) {
  const [collapsedPanels, setCollapsedPanels] = useState<Set<string>>(new Set());

  const toggleCollapse = (id: string) => {
    setCollapsedPanels(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className="right-sidebar">
      {panels.map(panel => (
        <div key={panel.id} className="right-sidebar-panel">
          <div
            className="right-sidebar-panel-header"
            onClick={() => toggleCollapse(panel.id)}
          >
            <span>
              {collapsedPanels.has(panel.id) ? "\u25B6" : "\u25BC"}{" "}
              {panel.title}
            </span>
            <button
              className="btn btn-sm"
              onClick={(e) => { e.stopPropagation(); onClose(panel.id); }}
              title="Close panel"
              style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 14 }}
            >
              \u00D7
            </button>
          </div>
          {!collapsedPanels.has(panel.id) && (
            <div className="right-sidebar-panel-content">
              <MiniPageView pageId={panel.id} onPageClick={onPageClick} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
