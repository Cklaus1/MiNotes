import { useState, useEffect, useRef, useCallback } from "react";
import * as pdfjs from "pdfjs-dist";
import * as api from "../lib/api";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url,
).toString();

interface Props {
  filePath: string;
  onClose: () => void;
  onBlockLink?: (highlightId: string) => void;
}

const COLORS = ["yellow", "red", "green", "blue", "purple"];

const COLOR_MAP: Record<string, string> = {
  yellow: "rgba(255, 235, 59, 0.35)",
  red: "rgba(244, 67, 54, 0.30)",
  green: "rgba(76, 175, 80, 0.30)",
  blue: "rgba(33, 150, 243, 0.30)",
  purple: "rgba(156, 39, 176, 0.30)",
};

export default function PdfViewer({ filePath, onClose, onBlockLink }: Props) {
  const [pdfDoc, setPdfDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [pageNum, setPageNum] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1.2);
  const [highlights, setHighlights] = useState<api.Highlight[]>([]);
  const [selectedColor, setSelectedColor] = useState("yellow");
  const [editingHighlight, setEditingHighlight] = useState<api.Highlight | null>(null);
  const [noteText, setNoteText] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; highlight: api.Highlight } | null>(null);
  const [pageInput, setPageInput] = useState("");

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load PDF
  useEffect(() => {
    let cancelled = false;
    const loadPdf = async () => {
      try {
        const doc = await pdfjs.getDocument(filePath).promise;
        if (!cancelled) {
          setPdfDoc(doc);
          setNumPages(doc.numPages);
          setPageNum(1);
          setPageInput("1");
        }
      } catch (err) {
        console.error("Failed to load PDF:", err);
      }
    };
    loadPdf();
    return () => { cancelled = true; };
  }, [filePath]);

  // Load highlights
  const loadHighlights = useCallback(async () => {
    try {
      const hl = await api.getHighlights(filePath);
      setHighlights(hl);
    } catch (err) {
      console.error("Failed to load highlights:", err);
    }
  }, [filePath]);

  useEffect(() => {
    loadHighlights();
  }, [loadHighlights]);

  // Render page
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current || !overlayRef.current) return;
    let cancelled = false;

    const renderPage = async () => {
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current!;
      const overlay = overlayRef.current!;

      canvas.width = viewport.width;
      canvas.height = viewport.height;
      overlay.width = viewport.width;
      overlay.height = viewport.height;

      await page.render({ canvas, viewport }).promise;

      if (!cancelled) {
        drawHighlights();
      }
    };

    renderPage();
    return () => { cancelled = true; };
  }, [pdfDoc, pageNum, scale, highlights]);

  // Draw highlights on overlay canvas
  const drawHighlights = useCallback(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const ctx = overlay.getContext("2d")!;
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    const pageHighlights = highlights.filter((h) => h.page_num === pageNum);
    for (const h of pageHighlights) {
      ctx.fillStyle = COLOR_MAP[h.color] || COLOR_MAP.yellow;
      ctx.fillRect(h.x * scale, h.y * scale, h.width * scale, h.height * scale);
      // Border for selected/editing
      if (editingHighlight?.id === h.id) {
        ctx.strokeStyle = "var(--accent, #89b4fa)";
        ctx.lineWidth = 2;
        ctx.strokeRect(h.x * scale, h.y * scale, h.width * scale, h.height * scale);
      }
    }
  }, [highlights, pageNum, scale, editingHighlight]);

  useEffect(() => {
    drawHighlights();
  }, [drawHighlights]);

  // Handle mouse selection on overlay to create a highlight
  const handleMouseUp = useCallback(async () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !overlayRef.current) return;

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const overlayRect = overlayRef.current.getBoundingClientRect();

    const x = (rect.left - overlayRect.left) / scale;
    const y = (rect.top - overlayRect.top) / scale;
    const width = rect.width / scale;
    const height = rect.height / scale;

    if (width < 5 || height < 2) return;

    const text = selection.toString().trim();
    selection.removeAllRanges();

    try {
      await api.createHighlight(
        filePath,
        pageNum,
        x,
        y,
        width,
        height,
        selectedColor,
        text || undefined,
        undefined,
      );
      await loadHighlights();
    } catch (err) {
      console.error("Failed to create highlight:", err);
    }
  }, [filePath, pageNum, scale, selectedColor, loadHighlights]);

  // Handle click on overlay to select existing highlight
  const handleOverlayClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const overlay = overlayRef.current;
      if (!overlay) return;
      const rect = overlay.getBoundingClientRect();
      const cx = (e.clientX - rect.left) / scale;
      const cy = (e.clientY - rect.top) / scale;

      const pageHighlights = highlights.filter((h) => h.page_num === pageNum);
      const clicked = pageHighlights.find(
        (h) =>
          cx >= h.x && cx <= h.x + h.width && cy >= h.y && cy <= h.y + h.height,
      );

      if (clicked) {
        setEditingHighlight(clicked);
        setNoteText(clicked.note || "");
      } else {
        setEditingHighlight(null);
        setContextMenu(null);
      }
    },
    [highlights, pageNum, scale],
  );

  // Context menu on right-click
  const handleContextMenu = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const overlay = overlayRef.current;
      if (!overlay) return;
      const rect = overlay.getBoundingClientRect();
      const cx = (e.clientX - rect.left) / scale;
      const cy = (e.clientY - rect.top) / scale;

      const pageHighlights = highlights.filter((h) => h.page_num === pageNum);
      const clicked = pageHighlights.find(
        (h) =>
          cx >= h.x && cx <= h.x + h.width && cy >= h.y && cy <= h.y + h.height,
      );

      if (clicked) {
        setContextMenu({ x: e.clientX, y: e.clientY, highlight: clicked });
      }
    },
    [highlights, pageNum, scale],
  );

  const handleDeleteHighlight = useCallback(async () => {
    if (!contextMenu) return;
    try {
      await api.deleteHighlight(contextMenu.highlight.id);
      setContextMenu(null);
      if (editingHighlight?.id === contextMenu.highlight.id) {
        setEditingHighlight(null);
      }
      await loadHighlights();
    } catch (err) {
      console.error("Failed to delete highlight:", err);
    }
  }, [contextMenu, editingHighlight, loadHighlights]);

  const handleSaveNote = useCallback(async () => {
    if (!editingHighlight) return;
    try {
      await api.updateHighlightNote(editingHighlight.id, noteText);
      setEditingHighlight(null);
      await loadHighlights();
    } catch (err) {
      console.error("Failed to update note:", err);
    }
  }, [editingHighlight, noteText, loadHighlights]);

  const goToPage = useCallback(
    (n: number) => {
      const p = Math.max(1, Math.min(numPages, n));
      setPageNum(p);
      setPageInput(String(p));
    },
    [numPages],
  );

  const handlePageInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      const n = parseInt(pageInput, 10);
      if (!isNaN(n)) goToPage(n);
    }
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (contextMenu) {
          setContextMenu(null);
        } else if (editingHighlight) {
          setEditingHighlight(null);
        } else {
          onClose();
        }
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        goToPage(pageNum - 1);
      }
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        goToPage(pageNum + 1);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "=") {
        e.preventDefault();
        setScale((s) => Math.min(s + 0.2, 4));
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "-") {
        e.preventDefault();
        setScale((s) => Math.max(s - 0.2, 0.4));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [pageNum, goToPage, onClose, contextMenu, editingHighlight]);

  const pageHighlights = highlights.filter((h) => h.page_num === pageNum);

  return (
    <div className="pdf-viewer">
      {/* Toolbar */}
      <div className="pdf-toolbar">
        <div className="pdf-toolbar-group">
          <button onClick={() => goToPage(pageNum - 1)} disabled={pageNum <= 1}>
            Prev
          </button>
          <input
            className="pdf-page-input"
            type="text"
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            onKeyDown={handlePageInputKeyDown}
            onBlur={() => {
              const n = parseInt(pageInput, 10);
              if (!isNaN(n)) goToPage(n);
              else setPageInput(String(pageNum));
            }}
          />
          <span className="pdf-page-count">/ {numPages}</span>
          <button onClick={() => goToPage(pageNum + 1)} disabled={pageNum >= numPages}>
            Next
          </button>
        </div>
        <div className="pdf-toolbar-group">
          <button onClick={() => setScale((s) => Math.max(s - 0.2, 0.4))}>-</button>
          <span className="pdf-zoom-label">{Math.round(scale * 100)}%</span>
          <button onClick={() => setScale((s) => Math.min(s + 0.2, 4))}>+</button>
        </div>
        <div className="pdf-toolbar-group">
          {COLORS.map((c) => (
            <button
              key={c}
              className={`pdf-color-btn ${selectedColor === c ? "active" : ""}`}
              style={{ backgroundColor: COLOR_MAP[c]?.replace(/[\d.]+\)$/, "0.8)") }}
              onClick={() => setSelectedColor(c)}
              title={c}
            />
          ))}
        </div>
        <button className="pdf-close-btn" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="pdf-body">
        {/* Canvas area */}
        <div className="pdf-canvas-container" ref={containerRef}>
          <div className="pdf-canvas-wrapper" onMouseUp={handleMouseUp}>
            <canvas ref={canvasRef} className="pdf-canvas" />
            <canvas
              ref={overlayRef}
              className="pdf-overlay"
              onClick={handleOverlayClick}
              onContextMenu={handleContextMenu}
            />
          </div>
        </div>

        {/* Sidebar */}
        <div className="pdf-sidebar">
          <h3>Highlights ({highlights.length})</h3>
          <div className="pdf-highlight-list">
            {highlights.map((h) => (
              <div
                key={h.id}
                className={`pdf-highlight-item ${editingHighlight?.id === h.id ? "active" : ""}`}
                onClick={() => {
                  goToPage(h.page_num);
                  setEditingHighlight(h);
                  setNoteText(h.note || "");
                }}
              >
                <div className="pdf-highlight-item-header">
                  <span
                    className="pdf-highlight-color-dot"
                    style={{ backgroundColor: COLOR_MAP[h.color]?.replace(/[\d.]+\)$/, "0.9)") }}
                  />
                  <span className="pdf-highlight-page">p.{h.page_num}</span>
                </div>
                {h.text && (
                  <div className="pdf-highlight-text">
                    {h.text.length > 80 ? h.text.slice(0, 80) + "..." : h.text}
                  </div>
                )}
                {h.note && (
                  <div className="pdf-highlight-note">{h.note}</div>
                )}
              </div>
            ))}
            {highlights.length === 0 && (
              <div className="pdf-highlight-empty">
                Select text on the PDF to create highlights
              </div>
            )}
          </div>

          {/* Note editor */}
          {editingHighlight && (
            <div className="pdf-note-editor">
              <h4>Note for highlight</h4>
              <textarea
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                placeholder="Add a note..."
                rows={4}
              />
              <div className="pdf-note-actions">
                <button onClick={handleSaveNote}>Save</button>
                <button onClick={() => setEditingHighlight(null)}>Cancel</button>
                {onBlockLink && (
                  <button
                    onClick={() => {
                      onBlockLink(editingHighlight.id);
                    }}
                  >
                    Link to Block
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <>
          <div
            className="pdf-context-backdrop"
            onClick={() => setContextMenu(null)}
          />
          <div
            className="pdf-context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button
              onClick={() => {
                setEditingHighlight(contextMenu.highlight);
                setNoteText(contextMenu.highlight.note || "");
                setContextMenu(null);
              }}
            >
              Edit Note
            </button>
            <button onClick={handleDeleteHighlight}>Delete</button>
          </div>
        </>
      )}
    </div>
  );
}
