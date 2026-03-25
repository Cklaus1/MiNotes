import { useEffect, useRef, useState, useCallback } from "react";
import { isTauri, savePngToDownloads } from "../lib/api";

interface StickyNote {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  color: string;
}

interface Line {
  points: Array<{ x: number; y: number }>;
  color: string;
  width: number;
}

interface WhiteboardData {
  notes: StickyNote[];
  lines: Line[];
  camera: { x: number; y: number; zoom: number };
  nextNoteId: number;
}

type Mode = "select" | "draw";

interface Props {
  whiteboardId: string;
  onClose: (hasContent: boolean) => void;
}

// Catppuccin palette colors for drawing
const DRAW_COLORS = [
  "#cdd6f4", // text
  "#89b4fa", // blue
  "#a6e3a1", // green
  "#f9e2af", // yellow
  "#f38ba8", // red
];

const NOTE_COLORS = [
  "#f9e2af", // yellow
  "#89b4fa", // blue
  "#a6e3a1", // green
  "#f38ba8", // red
  "#cba6f7", // mauve
];

const STORAGE_PREFIX = "minotes-whiteboard-";

function loadWhiteboardData(id: string): WhiteboardData | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + id);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return null;
}

function saveWhiteboardData(id: string, data: WhiteboardData) {
  localStorage.setItem(STORAGE_PREFIX + id, JSON.stringify(data));
  // Notify thumbnails to refresh
  window.dispatchEvent(new CustomEvent("whiteboard-saved", { detail: id }));
}

let nextNoteId = 1;

export default function Whiteboard({ whiteboardId, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load saved data on mount
  const saved = loadWhiteboardData(whiteboardId);

  const [notes, setNotes] = useState<StickyNote[]>(saved?.notes ?? []);
  const [lines, setLines] = useState<Line[]>(saved?.lines ?? []);
  const [mode, setMode] = useState<Mode>("draw");
  const [drawColor, setDrawColor] = useState(DRAW_COLORS[1]);
  const [noteColor, setNoteColor] = useState(NOTE_COLORS[0]);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showHint, setShowHint] = useState(() => !saved || ((saved.lines?.length ?? 0) === 0 && (saved.notes?.length ?? 0) === 0));

  // Camera / pan / zoom state stored in refs for performance
  const cameraRef = useRef(saved?.camera ?? { x: 0, y: 0, zoom: 1 });

  // Initialize nextNoteId from saved data
  if (saved?.nextNoteId) nextNoteId = saved.nextNoteId;
  const drawingRef = useRef<{ active: boolean; points: Array<{ x: number; y: number }> }>({
    active: false,
    points: [],
  });
  const panningRef = useRef<{ active: boolean; startX: number; startY: number; camStartX: number; camStartY: number }>({
    active: false,
    startX: 0,
    startY: 0,
    camStartX: 0,
    camStartY: 0,
  });
  const draggingNoteRef = useRef<{
    noteId: string | null;
    offsetX: number;
    offsetY: number;
  }>({ noteId: null, offsetX: 0, offsetY: 0 });

  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const editInputRef = useRef<HTMLTextAreaElement>(null);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; noteId: string } | null>(null);

  // Redraw flag
  const needsRedrawRef = useRef(true);
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const linesRef = useRef(lines);
  linesRef.current = lines;

  const screenToWorld = useCallback((sx: number, sy: number) => {
    const cam = cameraRef.current;
    return {
      x: (sx - cam.x) / cam.zoom,
      y: (sy - cam.y) / cam.zoom,
    };
  }, []);

  const worldToScreen = useCallback((wx: number, wy: number) => {
    const cam = cameraRef.current;
    return {
      x: wx * cam.zoom + cam.x,
      y: wy * cam.zoom + cam.y,
    };
  }, []);

  const findNoteAt = useCallback((wx: number, wy: number): StickyNote | null => {
    // Search in reverse so top-rendered notes are found first
    for (let i = notesRef.current.length - 1; i >= 0; i--) {
      const n = notesRef.current[i];
      if (wx >= n.x && wx <= n.x + n.width && wy >= n.y && wy <= n.y + n.height) {
        return n;
      }
    }
    return null;
  }, []);

  const requestRedraw = useCallback(() => {
    needsRedrawRef.current = true;
  }, []);

  // Draw everything on canvas
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const cam = cameraRef.current;
    const w = canvas.width;
    const h = canvas.height;

    // Clear
    ctx.fillStyle = "#1e1e2e";
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(cam.x, cam.y);
    ctx.scale(cam.zoom, cam.zoom);

    // Draw grid
    const gridSize = 40;
    const topLeft = { x: -cam.x / cam.zoom, y: -cam.y / cam.zoom };
    const bottomRight = { x: (w - cam.x) / cam.zoom, y: (h - cam.y) / cam.zoom };
    const startX = Math.floor(topLeft.x / gridSize) * gridSize;
    const startY = Math.floor(topLeft.y / gridSize) * gridSize;

    ctx.strokeStyle = "#313244";
    ctx.lineWidth = 0.5 / cam.zoom;
    ctx.beginPath();
    for (let gx = startX; gx <= bottomRight.x; gx += gridSize) {
      ctx.moveTo(gx, topLeft.y);
      ctx.lineTo(gx, bottomRight.y);
    }
    for (let gy = startY; gy <= bottomRight.y; gy += gridSize) {
      ctx.moveTo(topLeft.x, gy);
      ctx.lineTo(bottomRight.x, gy);
    }
    ctx.stroke();

    // Draw lines
    for (const line of linesRef.current) {
      if (line.points.length < 2) continue;
      ctx.strokeStyle = line.color;
      ctx.lineWidth = line.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(line.points[0].x, line.points[0].y);
      for (let i = 1; i < line.points.length; i++) {
        ctx.lineTo(line.points[i].x, line.points[i].y);
      }
      ctx.stroke();
    }

    // Draw current drawing line
    const drawing = drawingRef.current;
    if (drawing.active && drawing.points.length >= 2) {
      ctx.strokeStyle = drawColor;
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(drawing.points[0].x, drawing.points[0].y);
      for (let i = 1; i < drawing.points.length; i++) {
        ctx.lineTo(drawing.points[i].x, drawing.points[i].y);
      }
      ctx.stroke();
    }

    // Draw sticky notes
    for (const note of notesRef.current) {
      // Shadow
      ctx.shadowColor = "rgba(0,0,0,0.3)";
      ctx.shadowBlur = 8;
      ctx.shadowOffsetX = 2;
      ctx.shadowOffsetY = 2;

      ctx.fillStyle = note.color;
      ctx.fillRect(note.x, note.y, note.width, note.height);

      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;

      // Header bar
      ctx.fillStyle = "rgba(0,0,0,0.1)";
      ctx.fillRect(note.x, note.y, note.width, 20);

      // Text
      ctx.fillStyle = "#1e1e2e";
      ctx.font = "13px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.textBaseline = "top";

      const padding = 8;
      const maxWidth = note.width - padding * 2;
      const textLines = wrapText(ctx, note.text || "Double-click to edit", maxWidth);
      let ty = note.y + 24;
      for (const tl of textLines) {
        if (ty > note.y + note.height - 8) break;
        ctx.fillStyle = note.text ? "#1e1e2e" : "rgba(30,30,46,0.4)";
        ctx.fillText(tl, note.x + padding, ty);
        ty += 17;
      }
    }

    ctx.restore();
  }, [drawColor]);

  // Text wrapping helper
  function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
    const result: string[] = [];
    const paragraphs = text.split("\n");
    for (const para of paragraphs) {
      const words = para.split(" ");
      let currentLine = "";
      for (const word of words) {
        const test = currentLine ? currentLine + " " + word : word;
        if (ctx.measureText(test).width > maxWidth && currentLine) {
          result.push(currentLine);
          currentLine = word;
        } else {
          currentLine = test;
        }
      }
      result.push(currentLine);
    }
    return result;
  }

  // Animation loop
  useEffect(() => {
    let animId: number;
    const tick = () => {
      if (needsRedrawRef.current) {
        draw();
        needsRedrawRef.current = false;
      }
      animId = requestAnimationFrame(tick);
    };
    animId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animId);
  }, [draw]);

  // Resize canvas
  useEffect(() => {
    const resize = () => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
      requestRedraw();
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [requestRedraw]);

  // Mark redraw needed when state changes
  useEffect(() => {
    requestRedraw();
  }, [notes, lines, requestRedraw]);

  // Mouse handlers
  // Save current state (called after every interaction)
  const saveNow = useCallback(() => {
    const hasContent = notesRef.current.length > 0 || linesRef.current.length > 0;
    if (hasContent) {
      saveWhiteboardData(whiteboardId, {
        notes: notesRef.current,
        lines: linesRef.current,
        camera: { ...cameraRef.current },
        nextNoteId,
      });
    } else {
      localStorage.removeItem(STORAGE_PREFIX + whiteboardId);
    }
  }, [whiteboardId]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const world = screenToWorld(sx, sy);

      // Close context menu on any click
      setContextMenu(null);

      // Right or middle click => pan
      if (e.button === 1 || e.button === 2) {
        e.preventDefault();
        panningRef.current = {
          active: true,
          startX: e.clientX,
          startY: e.clientY,
          camStartX: cameraRef.current.x,
          camStartY: cameraRef.current.y,
        };
        return;
      }

      // Left click
      if (e.button === 0) {
        if (mode === "draw") {
          drawingRef.current = { active: true, points: [{ x: world.x, y: world.y }] };
          return;
        }

        // Select mode - check if clicking a note
        const note = findNoteAt(world.x, world.y);
        if (note) {
          draggingNoteRef.current = {
            noteId: note.id,
            offsetX: world.x - note.x,
            offsetY: world.y - note.y,
          };
          return;
        }
      }
    },
    [mode, screenToWorld, findNoteAt]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      // Panning
      if (panningRef.current.active) {
        const dx = e.clientX - panningRef.current.startX;
        const dy = e.clientY - panningRef.current.startY;
        cameraRef.current.x = panningRef.current.camStartX + dx;
        cameraRef.current.y = panningRef.current.camStartY + dy;
        requestRedraw();
        return;
      }

      // Drawing
      if (drawingRef.current.active) {
        const world = screenToWorld(sx, sy);
        drawingRef.current.points.push({ x: world.x, y: world.y });
        requestRedraw();
        return;
      }

      // Dragging note
      if (draggingNoteRef.current.noteId) {
        const world = screenToWorld(sx, sy);
        setNotes((prev) =>
          prev.map((n) =>
            n.id === draggingNoteRef.current.noteId
              ? {
                  ...n,
                  x: world.x - draggingNoteRef.current.offsetX,
                  y: world.y - draggingNoteRef.current.offsetY,
                }
              : n
          )
        );
      }
    },
    [screenToWorld, requestRedraw]
  );

  const handleMouseUp = useCallback(
    (_e: React.MouseEvent<HTMLCanvasElement>) => {
      let changed = false;

      // End pan
      if (panningRef.current.active) {
        panningRef.current.active = false;
      }

      // End draw
      if (drawingRef.current.active) {
        const pts = drawingRef.current.points;
        if (pts.length >= 2) {
          setLines((prev) => [...prev, { points: [...pts], color: drawColor, width: 2 }]);
          changed = true;
        }
        drawingRef.current = { active: false, points: [] };
      }

      // End drag
      if (draggingNoteRef.current.noteId) {
        draggingNoteRef.current = { noteId: null, offsetX: 0, offsetY: 0 };
        changed = true;
      }

      // Auto-save after every interaction
      if (changed) setTimeout(saveNow, 50);
    },
    [drawColor, saveNow]
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (mode !== "select") return;

      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const world = screenToWorld(sx, sy);

      // Check if double-clicking an existing note
      const existing = findNoteAt(world.x, world.y);
      if (existing) {
        setEditingNote(existing.id);
        setEditText(existing.text);
        setTimeout(() => editInputRef.current?.focus(), 0);
        return;
      }

      // Create new note
      const id = "note-" + nextNoteId++;
      const newNote: StickyNote = {
        id,
        x: world.x - 75,
        y: world.y - 50,
        width: 150,
        height: 100,
        text: "",
        color: noteColor,
      };
      setNotes((prev) => [...prev, newNote]);
      setEditingNote(id);
      setEditText("");
      setTimeout(() => editInputRef.current?.focus(), 0);
    },
    [mode, screenToWorld, findNoteAt, noteColor]
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const cam = cameraRef.current;

      const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
      const newZoom = Math.max(0.1, Math.min(5, cam.zoom * zoomFactor));

      // Zoom towards mouse position
      cam.x = mx - (mx - cam.x) * (newZoom / cam.zoom);
      cam.y = my - (my - cam.y) * (newZoom / cam.zoom);
      cam.zoom = newZoom;

      requestRedraw();
    },
    [requestRedraw]
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const world = screenToWorld(sx, sy);
      const note = findNoteAt(world.x, world.y);
      if (note) {
        setContextMenu({ x: e.clientX, y: e.clientY, noteId: note.id });
      }
    },
    [screenToWorld, findNoteAt]
  );

  const deleteNote = useCallback((noteId: string) => {
    setNotes((prev) => prev.filter((n) => n.id !== noteId));
    setContextMenu(null);
  }, []);

  const finishEdit = useCallback(() => {
    if (editingNote) {
      setNotes((prev) =>
        prev.map((n) => (n.id === editingNote ? { ...n, text: editText } : n))
      );
      setEditingNote(null);
      setTimeout(saveNow, 50);
    }
  }, [editingNote, editText, saveNow]);

  // Auto-save every 10 seconds if there's content
  useEffect(() => {
    const interval = setInterval(() => {
      if (notesRef.current.length > 0 || linesRef.current.length > 0) {
        saveWhiteboardData(whiteboardId, {
          notes: notesRef.current,
          lines: linesRef.current,
          camera: { ...cameraRef.current },
          nextNoteId,
        });
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [whiteboardId]);

  // Save current state (called after every interaction)
  // Close — state is already saved continuously
  const handleClose = useCallback(() => {
    saveNow();
    onClose(notesRef.current.length > 0 || linesRef.current.length > 0);
  }, [saveNow, onClose]);

  const exportPng = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const filename = `whiteboard-${whiteboardId}.png`;

    if (isTauri) {
      // Tauri mode: save directly to Downloads folder (WSL-aware)
      canvas.toBlob(async (blob) => {
        if (!blob) return;
        const arrayBuf = await blob.arrayBuffer();
        const data = Array.from(new Uint8Array(arrayBuf));
        try {
          const path = await savePngToDownloads(filename, data);
          setSaveStatus(`Exported → ${path}`);
        } catch (e) {
          setSaveStatus(`Export failed: ${e}`);
        }
        setTimeout(() => setSaveStatus(null), 4000);
      }, "image/png");
    } else {
      // Browser mode: trigger download (goes to browser's Downloads folder)
      canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.download = filename;
        link.href = url;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        setSaveStatus(`Exported → Downloads/${filename}`);
        setTimeout(() => setSaveStatus(null), 3000);
      }, "image/png");
    }
  }, [whiteboardId]);

  const clearCanvas = useCallback(() => {
    setNotes([]);
    setLines([]);
    localStorage.removeItem(STORAGE_PREFIX + whiteboardId);
    requestRedraw();
  }, [whiteboardId, requestRedraw]);

  // Keyboard: Escape to close, close editing; S/D to switch modes
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (editingNote) {
          finishEdit();
        } else if (contextMenu) {
          setContextMenu(null);
        } else {
          handleClose();
        }
      }
      // Quick mode switch (only when not editing)
      if (!editingNote) {
        if (e.key === "s" || e.key === "S") setMode("select");
        if (e.key === "d" || e.key === "D") setMode("draw");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleClose, editingNote, finishEdit, contextMenu]);

  // Compute editing note screen position
  const editScreenPos = (() => {
    if (!editingNote) return null;
    const note = notes.find((n) => n.id === editingNote);
    if (!note) return null;
    const pos = worldToScreen(note.x, note.y);
    const cam = cameraRef.current;
    return {
      left: pos.x,
      top: pos.y + 20 * cam.zoom,
      width: note.width * cam.zoom,
      height: (note.height - 20) * cam.zoom,
    };
  })();

  return (
    <div className="whiteboard" ref={containerRef}>
      <div className="whiteboard-toolbar">
        <div className="whiteboard-toolbar-group">
          <button
            className={`btn btn-sm ${mode === "select" ? "btn-primary" : ""}`}
            onClick={() => setMode("select")}
            title="Select mode (S)"
          >
            Select
          </button>
          <button
            className={`btn btn-sm ${mode === "draw" ? "btn-primary" : ""}`}
            onClick={() => setMode("draw")}
            title="Draw mode (D)"
          >
            Draw
          </button>
        </div>

        {mode === "draw" && (
          <div className="whiteboard-toolbar-group">
            <span className="whiteboard-toolbar-label">Stroke:</span>
            {DRAW_COLORS.map((c) => (
              <button
                key={c}
                className={`whiteboard-color-swatch ${drawColor === c ? "active" : ""}`}
                style={{ background: c }}
                onClick={() => setDrawColor(c)}
              />
            ))}
          </div>
        )}

        {mode === "select" && (
          <div className="whiteboard-toolbar-group">
            <span className="whiteboard-toolbar-label">Note color:</span>
            {NOTE_COLORS.map((c) => (
              <button
                key={c}
                className={`whiteboard-color-swatch ${noteColor === c ? "active" : ""}`}
                style={{ background: c }}
                onClick={() => setNoteColor(c)}
              />
            ))}
          </div>
        )}

        <div className="whiteboard-toolbar-group" style={{ position: "relative" }}>
          {saveStatus && (
            <span className="whiteboard-save-status">{saveStatus}</span>
          )}
          <button className="btn btn-sm" onClick={() => setShowExportMenu(v => !v)}>
            Export ▾
          </button>
          {showExportMenu && (
            <div className="mindmap-dropdown" style={{ right: "auto", left: 0 }} onClick={() => setShowExportMenu(false)}>
              <button onClick={exportPng}>PNG Image</button>
            </div>
          )}
          <button className="btn btn-sm" onClick={clearCanvas} title="Clear canvas">
            Clear
          </button>
        </div>
      </div>

      <canvas
        ref={canvasRef}
        className="whiteboard-canvas"
        onMouseDown={(e) => { setShowHint(false); handleMouseDown(e); }}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onDoubleClick={(e) => { setShowHint(false); handleDoubleClick(e); }}
        onWheel={handleWheel}
        onContextMenu={handleContextMenu}
      />

      {/* First-time hint — disappears on first interaction */}
      {showHint && (
        <div className="whiteboard-hint" onMouseDown={() => setShowHint(false)}>
          Start drawing
        </div>
      )}

      {/* Editing overlay for note text */}
      {editingNote && editScreenPos && (
        <textarea
          ref={editInputRef}
          className="whiteboard-note-editor"
          style={{
            left: editScreenPos.left,
            top: editScreenPos.top,
            width: editScreenPos.width,
            height: editScreenPos.height,
          }}
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          onBlur={finishEdit}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              finishEdit();
            }
            // Prevent canvas shortcuts while editing
            e.stopPropagation();
          }}
        />
      )}

      {/* Context menu */}
      {contextMenu && (
        <>
          <div
            className="whiteboard-context-backdrop"
            onClick={() => setContextMenu(null)}
          />
          <div
            className="whiteboard-context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button onClick={() => deleteNote(contextMenu.noteId)}>Delete note</button>
            <button
              onClick={() => {
                setEditingNote(contextMenu.noteId);
                const note = notes.find((n) => n.id === contextMenu.noteId);
                setEditText(note?.text ?? "");
                setContextMenu(null);
                setTimeout(() => editInputRef.current?.focus(), 0);
              }}
            >
              Edit text
            </button>
          </div>
        </>
      )}
    </div>
  );
}
