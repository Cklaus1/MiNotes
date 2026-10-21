import { useState, useEffect, useRef, useCallback } from "react";
import * as pdfjs from "pdfjs-dist";
import * as api from "../lib/api";
import { addRecentPdf, pdfDisplayName } from "../lib/pdfFiles";

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
  const [loadError, setLoadError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  // pdf.js text layer: transparent, positioned text over the page, so text can
  // be selected (and highlighted) like in any PDF reader.
  const textLayerRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load PDF — destroy the previous document (and its worker resources) on
  // file change / unmount.
  useEffect(() => {
    let cancelled = false;
    let loadingTask: pdfjs.PDFDocumentLoadingTask | null = null;
    setLoadError(null);
    setNumPages(0);
    (async () => {
      try {
        // Desktop: bytes over IPC (the webview can't fetch a filesystem path).
        // Browser mode: readPdfFile returns null and filePath is loaded as a URL.
        const data = await api.readPdfFile(filePath);
        if (cancelled) return;
        loadingTask = pdfjs.getDocument(data ? { data } : filePath);
        const doc = await loadingTask.promise;
        if (cancelled) return;
        setPdfDoc(doc);
        setNumPages(doc.numPages);
        setPageNum(1);
        setPageInput("1");
        void addRecentPdf(filePath);
      } catch (err: any) {
        if (cancelled) return;
        console.error("Failed to load PDF:", err);
        setLoadError(typeof err === "string" ? err : err?.message ?? String(err));
      }
    })();
    return () => {
      cancelled = true;
      setPdfDoc(null);
      // Destroys the PDFDocumentProxy too, if loading finished.
      void loadingTask?.destroy();
    };
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

  // Render page. Highlights live on a separate overlay canvas, so they are
  // intentionally NOT a dependency here — changing a highlight only redraws
  // the overlay. In-flight render tasks are cancelled before a new one starts.
  const drawHighlightsRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current || !overlayRef.current) return;
    let cancelled = false;
    let renderTask: ReturnType<pdfjs.PDFPageProxy["render"]> | null = null;
    let textLayer: pdfjs.TextLayer | null = null;

    const renderPage = async () => {
      const page = await pdfDoc.getPage(pageNum);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      const overlay = overlayRef.current;
      if (!canvas || !overlay) return;

      canvas.width = viewport.width;
      canvas.height = viewport.height;
      overlay.width = viewport.width;
      overlay.height = viewport.height;
      // Resizing clears the overlay; repaint highlights right away.
      drawHighlightsRef.current();

      // The text layer sizes itself from --scale-factor (pdf.js CSS contract).
      const textDiv = textLayerRef.current;
      if (textDiv) {
        textDiv.replaceChildren();
        textDiv.style.setProperty("--scale-factor", String(scale));
        textDiv.style.setProperty("--total-scale-factor", String(scale));
        textLayer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textDiv, viewport });
      }

      renderTask = page.render({ canvas, viewport });
      await renderTask.promise;
      if (cancelled) return;
      await textLayer?.render();
      if (textDiv && !cancelled) textDiv.dataset.ready = "1";
    };

    renderPage().catch((err) => {
      if (err?.name !== "RenderingCancelledException" && !cancelled) {
        console.error("Failed to render PDF page:", err);
      }
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
      if (textLayerRef.current) delete textLayerRef.current.dataset.ready;
    };
  }, [pdfDoc, pageNum, scale]);

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

  drawHighlightsRef.current = drawHighlights;
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

    if (width < 2 || height < 2) return;

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
    (e: React.MouseEvent<HTMLElement>) => {
      const overlay = overlayRef.current;
      if (!overlay) return;
      // A click that ended a text selection is not a click on a highlight.
      if (window.getSelection()?.isCollapsed === false) return;
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
    (e: React.MouseEvent<HTMLElement>) => {
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
        e.preventDefault();
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

  const ready = !!pdfDoc && !loadError;
  const fileName = pdfDisplayName(filePath);

  return (
    <div className="pdf-viewer">
      {/* Toolbar */}
      <div className="pdf-toolbar">
        <span className="pdf-file-name" title={filePath} data-testid="pdf-file-name">{fileName}</span>
        {/* Controls only work on an open document: disabled while loading or on the error card. */}
        <div className="pdf-toolbar-group">
          <button onClick={() => goToPage(pageNum - 1)} disabled={!ready || pageNum <= 1} aria-label="Previous page">
            Prev
          </button>
          <input
            className="pdf-page-input"
            type="text"
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            onKeyDown={handlePageInputKeyDown}
            disabled={!ready}
            aria-label="Page number"
            onBlur={() => {
              const n = parseInt(pageInput, 10);
              if (!isNaN(n)) goToPage(n);
              else setPageInput(String(pageNum));
            }}
          />
          <span className="pdf-page-count">/ {numPages}</span>
          <button onClick={() => goToPage(pageNum + 1)} disabled={!ready || pageNum >= numPages} aria-label="Next page">
            Next
          </button>
        </div>
        <div className="pdf-toolbar-group">
          <button onClick={() => setScale((s) => Math.max(s - 0.2, 0.4))} disabled={!ready} aria-label="Zoom out">-</button>
          <span className="pdf-zoom-label">{Math.round(scale * 100)}%</span>
          <button onClick={() => setScale((s) => Math.min(s + 0.2, 4))} disabled={!ready} aria-label="Zoom in">+</button>
        </div>
        <div className="pdf-toolbar-group">
          {COLORS.map((c) => (
            <button
              key={c}
              className={`pdf-color-btn ${selectedColor === c ? "active" : ""}`}
              style={{ backgroundColor: COLOR_MAP[c]?.replace(/[\d.]+\)$/, "0.8)") }}
              onClick={() => setSelectedColor(c)}
              disabled={!ready}
              title={`Highlight colour: ${c}`}
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
          {loadError && (
            <div className="pdf-load-error" role="alert">
              <strong>Couldn't open this PDF</strong>
              <span>{loadError}</span>
              <code>{filePath}</code>
            </div>
          )}
          <div className="pdf-canvas-wrapper" onMouseUp={handleMouseUp} style={loadError ? { display: "none" } : undefined}>
            <canvas ref={canvasRef} className="pdf-canvas" />
            <canvas ref={overlayRef} className="pdf-overlay" />
            <div
              ref={textLayerRef}
              className="textLayer pdf-text-layer"
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
