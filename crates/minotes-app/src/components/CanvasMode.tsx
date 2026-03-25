import { useState, useCallback } from "react";
import type { Block } from "../lib/api";
import GraphView from "./GraphView";
import MindMapView from "./mindmap/MindMapView";
import Whiteboard from "./Whiteboard";

export type CanvasModeType = "graph" | "mindmap" | "draw";

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
  onGraphSwitch: () => void;
  onWhiteboardClose: () => void;
  onRenameTitle?: (newTitle: string) => void;
}

export default function CanvasMode({
  initialMode, pageId, pageTitle, isJournal, journalDate, blocks, whiteboardId,
  onClose, onPageClick, onRefreshPage, onGraphSwitch, onWhiteboardClose, onRenameTitle,
}: Props) {
  const [mode, setMode] = useState<CanvasModeType>(initialMode);

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
            onGraphSwitch={onGraphSwitch}
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
