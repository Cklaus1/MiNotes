import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { Block } from "../lib/api";
import GraphView from "./GraphView";
import MindMapView from "./mindmap/MindMapView";
import KanbanView from "./kanban/KanbanView";
import Whiteboard from "./Whiteboard";
import AllPagesView from "./AllPagesView";
import { useEscapeToClose } from "../lib/escapeStack";
import { WHITEBOARD_REGEX } from "../lib/whiteboardUtils";

export type CanvasModeType = "graph" | "mindmap" | "draw" | "kanban" | "pages";

interface Props {
  initialMode: CanvasModeType;
  pageId: string | null;
  pageTitle: string;
  isJournal?: boolean;
  journalDate?: string;
  blocks: Block[];
  whiteboardId: string | null;
  /** The open board is new: it is added to the page once something is drawn. */
  whiteboardIsNew?: boolean;
  /** Open one of this page's boards (Draw tab with no board open). */
  onOpenWhiteboard?: (whiteboardId: string) => void;
  /** Start a new board on this page. */
  onNewWhiteboard?: () => void;
  onClose: () => void;
  onPageClick: (id: string) => void;
  onRefreshPage: () => void;
  onWhiteboardClose: () => void;
  onRenameTitle?: (newTitle: string) => void;
}

export default function CanvasMode({
  initialMode, pageId, pageTitle, isJournal, journalDate, blocks, whiteboardId,
  whiteboardIsNew, onOpenWhiteboard, onNewWhiteboard,
  onClose, onPageClick, onRefreshPage, onWhiteboardClose, onRenameTitle,
}: Props) {
  // The canvas takes the keyboard: typing must not reach the page editor that
  // is hidden underneath (children such as the whiteboard focus themselves).
  const layerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const layer = layerRef.current;
    if (layer && !layer.contains(document.activeElement)) layer.focus({ preventScroll: true });
  }, []);

  // This page's boards, for the Draw tab when no board is open.
  const pageBoards = useMemo(
    () => blocks.map((b) => b.content.trim().match(WHITEBOARD_REGEX)?.[1]).filter((id): id is string => !!id),
    [blocks],
  );
  const [mode, setMode] = useState<CanvasModeType>(initialMode);
  // App changes initialMode while the canvas is already open (Ctrl+G from Draw,
  // Ctrl+M from Graph…). Follow it; the in-canvas tabs still switch locally.
  useEffect(() => { setMode(initialMode); }, [initialMode]);

  // Graph, mind map and whiteboard close themselves on Escape; kanban and All
  // Pages have no handler of their own.
  useEscapeToClose(mode === "kanban" || mode === "pages", onClose, "canvas");

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
        if (!whiteboardId) {
          // No dead end: open this page's board(s) or start a new one here.
          if (!pageId) return <div className="canvas-empty">Open a page to draw on it — its boards live on the page.</div>;
          return (
            <div className="canvas-empty canvas-draw-chooser" data-testid="draw-chooser">
              <div className="canvas-draw-chooser-title">Whiteboards on “{pageTitle}”</div>
              {pageBoards.length > 0 ? (
                <div className="canvas-draw-chooser-list">
                  {pageBoards.map((id, i) => (
                    <button key={id} className="btn" data-board-id={id} onClick={() => onOpenWhiteboard?.(id)}>
                      {pageBoards.length === 1 ? "Open this page's board" : `Open board ${i + 1}`}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="canvas-draw-chooser-hint">This page has no board yet.</div>
              )}
              <button className="btn btn-primary" onClick={() => onNewWhiteboard?.()} data-testid="draw-new-board">
                New board on this page
              </button>
              <div className="canvas-draw-chooser-hint">A new board is added to the end of “{pageTitle}” once you draw on it (Ctrl+W).</div>
            </div>
          );
        }
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
            onOpenPage={(title) => { onPageClick(title); onClose(); }}
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
    <div className="canvas-layer" ref={layerRef} tabIndex={-1}>
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
          <span className="canvas-page-context" data-testid="canvas-page-context">
            {mode === "draw" && whiteboardId
              ? whiteboardIsNew
                ? <>New board · added to “{pageTitle}” when you draw</>
                : <>Board on “{pageTitle}”</>
              : pageTitle}
          </span>
        )}
      </div>

      <div className="canvas-content">
        {renderCanvas()}
      </div>
    </div>
  );
}
