import { useState, useCallback, useEffect } from "react";
import type { Block } from "../lib/api";
import GraphView from "./GraphView";
import MindMapView from "./mindmap/MindMapView";
import KanbanView from "./kanban/KanbanView";
import Whiteboard from "./Whiteboard";
import AllPagesView from "./AllPagesView";
import { useEscapeToClose } from "../lib/escapeStack";

export type CanvasModeType = "graph" | "mindmap" | "draw" | "kanban" | "pages";

interface Props {
  initialMode: CanvasModeType;
  pageId: string | null;
  pageTitle: string;
  isJournal?: boolean;
  journalDate?: string;
  blocks: Block[];
  whiteboardId: string | null;
  onClose: () => void;
  onPageClick: (id: string) => void;
  onRefreshPage: () => void;
  onWhiteboardClose: () => void;
  onRenameTitle?: (newTitle: string) => void;
}

export default function CanvasMode({
  initialMode, pageId, pageTitle, isJournal, journalDate, blocks, whiteboardId,
  onClose, onPageClick, onRefreshPage, onWhiteboardClose, onRenameTitle,
}: Props) {
  const [mode, setMode] = useState<CanvasModeType>(initialMode);
  // App changes initialMode while the canvas is already open (Ctrl+G from Draw,
  // Ctrl+M from Graph…). Follow it; the in-canvas tabs still switch locally.
  useEffect(() => { setMode(initialMode); }, [initialMode]);

  // Graph, mind map and whiteboard close themselves on Escape; kanban and All
  // Pages have no handler of their own.
  useEscapeToClose(mode === "kanban" || mode === "pages", onClose);

  const handleModeSwitch = useCallback((newMode: CanvasModeType) => {
    setMode(newMode);
  }, []);

  // Render the active canvas — each fills the canvas-content area
  const renderCanvas = () => {
    switch (mode) {
      case "graph":
        return (
          <GraphView
            onPageClick={(id) => { onPageClick(id); onClose(); }}
            onClose={onClose}
          />
        );
      case "mindmap":
        if (!pageId) return <div className="canvas-empty">Open a page to use Mind Map</div>;
        return (
          <MindMapView
            pageId={pageId}
            pageTitle={pageTitle}
            isJournal={isJournal}
            journalDate={journalDate}
            blocks={blocks}
            onClose={onClose}
            onRefreshPage={onRefreshPage}
            onRenameTitle={onRenameTitle}
          />
        );
      case "draw":
        if (!whiteboardId) return <div className="canvas-empty">No whiteboard open</div>;
        return (
          <Whiteboard
            whiteboardId={whiteboardId}
            onClose={onWhiteboardClose}
          />
        );
      case "kanban":
        if (!pageId) return <div className="canvas-empty">Open a page to use Kanban</div>;
        return (
          <KanbanView
            pageId={pageId}
            pageTitle={pageTitle}
            blocks={blocks}
            onRefreshPage={onRefreshPage}
          />
        );
      case "pages":
        return (
          <AllPagesView
            onPageClick={(id) => { onPageClick(id); onClose(); }}
            onClose={onClose}
          />
        );
    }
  };

  return (
    <div className="canvas-layer">
      <div className="canvas-topbar">
        <button className="canvas-back-btn" onClick={onClose} title="Back to notes">
          ← Notes
        </button>

        <div className="canvas-mode-switcher">
          <button
            className={`canvas-mode-btn ${mode === "graph" ? "active" : ""}`}
            onClick={() => handleModeSwitch("graph")}
          >
            🔗 Graph
          </button>
          <button
            className={`canvas-mode-btn ${mode === "mindmap" ? "active" : ""}`}
            onClick={() => handleModeSwitch("mindmap")}
          >
            🧠 Mindmap
          </button>
          <button
            className={`canvas-mode-btn ${mode === "draw" ? "active" : ""}`}
            onClick={() => handleModeSwitch("draw")}
          >
            🎨 Draw
          </button>
          <button
            className={`canvas-mode-btn ${mode === "kanban" ? "active" : ""}`}
            onClick={() => handleModeSwitch("kanban")}
          >
            📋 Kanban
          </button>
          <button
            className={`canvas-mode-btn ${mode === "pages" ? "active" : ""}`}
            onClick={() => handleModeSwitch("pages")}
          >
            📄 Pages
          </button>
        </div>

        {pageId && (
          <span className="canvas-page-context">
            {pageTitle}
          </span>
        )}
      </div>

      <div className="canvas-content">
        {renderCanvas()}
      </div>
    </div>
  );
}
