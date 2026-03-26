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
  id?: string;
  points: Array<{ x: number; y: number }>;
  color: string;
  width: number;
}

interface CanvasImage {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  dataUrl: string;
}

interface TextElement {
  id: string;
  x: number;
  y: number;
  text: string;
  color: string;
  size: "S" | "M" | "L";
  callout: boolean; // true = rounded bg, false = plain text
}

// Callout color mapping: user color → light bg + dark text (high contrast)
const CALLOUT_STYLES: Record<string, { bg: string; text: string; border: string }> = {
  "#cdd6f4": { bg: "rgba(205,214,244,0.15)", text: "#cdd6f4", border: "rgba(205,214,244,0.3)" },  // white/text
  "#89b4fa": { bg: "rgba(137,180,250,0.15)", text: "#89b4fa", border: "rgba(137,180,250,0.3)" },  // blue
  "#a6e3a1": { bg: "rgba(166,227,161,0.15)", text: "#a6e3a1", border: "rgba(166,227,161,0.3)" },  // green
  "#f9e2af": { bg: "rgba(249,226,175,0.15)", text: "#1e1e2e", border: "rgba(249,226,175,0.4)" },  // yellow
  "#f38ba8": { bg: "rgba(243,139,168,0.15)", text: "#f38ba8", border: "rgba(243,139,168,0.3)" },  // red
};

function getCalloutStyle(color: string) {
  return CALLOUT_STYLES[color] ?? { bg: "rgba(255,255,255,0.1)", text: color, border: "rgba(255,255,255,0.2)" };
}

interface Arrow {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
}

interface Box {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

interface WhiteboardData {
  notes: StickyNote[];
  lines: Line[];
  images?: CanvasImage[];
  texts?: TextElement[];
  arrows?: Arrow[];
  boxes?: Box[];
  camera: { x: number; y: number; zoom: number };
  nextNoteId: number;
  canvasBg?: "dark" | "light";
  showGrid?: boolean;
}

type Mode = "select" | "text" | "arrow" | "box" | "draw";

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

let saving = false;

/** Returns true if image data was truncated due to size. */
function saveWhiteboardData(id: string, data: WhiteboardData): boolean {
  if (saving) return false;
  saving = true;
  let truncated = false;
  try {
    let json = JSON.stringify(data);
    // If payload is > 4MB, strip image dataUrls to avoid quota issues
    if (json.length > 4 * 1024 * 1024 && data.images && data.images.length > 0) {
      const trimmed: WhiteboardData = { ...data, images: data.images.map(img => ({ ...img, dataUrl: "" })) };
      json = JSON.stringify(trimmed);
      truncated = true;
      console.warn("Whiteboard save: payload exceeded 4 MB — image data was stripped to fit localStorage.");
    }
    try {
      localStorage.setItem(STORAGE_PREFIX + id, json);
    } catch (e) {
      console.warn("Whiteboard save failed (QuotaExceededError). Data may not persist.", e);
      return truncated;
    }
    // Notify thumbnails to refresh
    window.dispatchEvent(new CustomEvent("whiteboard-saved", { detail: id }));
    return truncated;
  } finally {
    saving = false;
  }
}

export default function Whiteboard({ whiteboardId, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load saved data on mount
  const saved = loadWhiteboardData(whiteboardId);

  const [notes, setNotes] = useState<StickyNote[]>(saved?.notes ?? []);
  const [lines, setLines] = useState<Line[]>(saved?.lines ?? []);
  const [images, setImages] = useState<CanvasImage[]>(saved?.images ?? []);
  const [texts, setTexts] = useState<TextElement[]>(() =>
    (saved?.texts ?? []).map((t: any) => ({ ...t, callout: t.callout ?? false }))
  );
  const [arrows, setArrows] = useState<Arrow[]>(saved?.arrows ?? []);
  const [boxes, setBoxes] = useState<Box[]>(saved?.boxes ?? []);
  const [mode, setMode] = useState<Mode>("select");
  const [selectedElement, setSelectedElement] = useState<{ type: "note" | "text" | "arrow" | "box" | "image" | "line"; id: string } | null>(null);
  const draggingElementRef = useRef<{ type: string; id: string; offsetX: number; offsetY: number } | null>(null);
  const [textSize, setTextSize] = useState<"S" | "M" | "L">("M");
  const [textStyle, setTextStyle] = useState<"callout" | "plain" | "sticky">("callout");
  const [drawColor, setDrawColor] = useState(DRAW_COLORS[1]);
  const [noteColor, setNoteColor] = useState(NOTE_COLORS[0]);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showCanvasSettings, setShowCanvasSettings] = useState(false);
  const [canvasBg, setCanvasBg] = useState<"dark" | "light">(saved?.canvasBg ?? "light");
  const [showGrid, setShowGrid] = useState(saved?.showGrid ?? false);
  const [undoSnapshot, setUndoSnapshot] = useState<{ notes: StickyNote[]; lines: Line[]; images: CanvasImage[]; texts: TextElement[]; arrows: Arrow[]; boxes: Box[] } | null>(null);
  const redoStackRef = useRef<Line[]>([]);
  const [showHint, setShowHint] = useState(() => !saved || ((saved.lines?.length ?? 0) === 0 && (saved.notes?.length ?? 0) === 0));

  // Camera / pan / zoom state stored in refs for performance
  const cameraRef = useRef(saved?.camera ?? { x: 0, y: 0, zoom: 1 });

  // Initialize nextNoteId from saved data
  const nextNoteIdRef = useRef(saved?.nextNoteId ?? 1);
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

  const [editingNote, _setEditingNote] = useState<string | null>(null);
  const editingNoteRef = useRef<string | null>(null);
  const setEditingNote = useCallback((v: string | null) => { _setEditingNote(v); editingNoteRef.current = v; }, []);
  const [editingTextId, _setEditingTextId] = useState<string | null>(null);
  const [editingTextValue, _setEditingTextValue] = useState("");
  const editingTextIdRef = useRef<string | null>(null);
  const editingTextValueRef = useRef("");
  const setEditingTextId = useCallback((v: string | null) => { _setEditingTextId(v); editingTextIdRef.current = v; }, []);
  const setEditingTextValue = useCallback((v: string) => { _setEditingTextValue(v); editingTextValueRef.current = v; }, []);
  const textInputRef = useRef<HTMLTextAreaElement>(null);
  const [editText, _setEditText] = useState("");
  const editTextRef = useRef("");
  const setEditText = useCallback((v: string) => { _setEditText(v); editTextRef.current = v; }, []);
  const editInputRef = useRef<HTMLTextAreaElement>(null);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; noteId: string } | null>(null);

  // Redraw flag
  const needsRedrawRef = useRef(true);
  const canvasBgRef = useRef(canvasBg);
  canvasBgRef.current = canvasBg;
  const showGridRef = useRef(showGrid);
  showGridRef.current = showGrid;
  const selectedElementRef = useRef(selectedElement);
  selectedElementRef.current = selectedElement;
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const textsRef = useRef(texts);
  textsRef.current = texts;
  const arrowsRef = useRef(arrows);
  arrowsRef.current = arrows;
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;
  const loadedImagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const arrowDrawRef = useRef<{ active: boolean; x1: number; y1: number; x2: number; y2: number }>({ active: false, x1: 0, y1: 0, x2: 0, y2: 0 });
  const boxDrawRef = useRef<{ active: boolean; x: number; y: number; w: number; h: number }>({ active: false, x: 0, y: 0, w: 0, h: 0 });

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
    for (let i = notesRef.current.length - 1; i >= 0; i--) {
      const n = notesRef.current[i];
      if (wx >= n.x && wx <= n.x + n.width && wy >= n.y && wy <= n.y + n.height) {
        return n;
      }
    }
    return null;
  }, []);

  // Unified hit-test: find any element at world coordinates
  const findElementAt = useCallback((wx: number, wy: number): { type: "note" | "text" | "arrow" | "box" | "image" | "line"; id: string; x: number; y: number } | null => {
    // Early exit: compute a rough content bounding box across all elements.
    // If the click is far outside, skip individual checks entirely.
    const MARGIN = 50;
    let contentMinX = Infinity, contentMinY = Infinity, contentMaxX = -Infinity, contentMaxY = -Infinity;
    let hasAny = false;
    for (const n of notesRef.current) { hasAny = true; contentMinX = Math.min(contentMinX, n.x); contentMinY = Math.min(contentMinY, n.y); contentMaxX = Math.max(contentMaxX, n.x + n.width); contentMaxY = Math.max(contentMaxY, n.y + n.height); }
    for (const te of textsRef.current) { hasAny = true; contentMinX = Math.min(contentMinX, te.x); contentMinY = Math.min(contentMinY, te.y); contentMaxX = Math.max(contentMaxX, te.x + 220); contentMaxY = Math.max(contentMaxY, te.y + 100); }
    for (const b of boxesRef.current) { hasAny = true; contentMinX = Math.min(contentMinX, b.x); contentMinY = Math.min(contentMinY, b.y); contentMaxX = Math.max(contentMaxX, b.x + b.width); contentMaxY = Math.max(contentMaxY, b.y + b.height); }
    for (const img of imagesRef.current) { hasAny = true; contentMinX = Math.min(contentMinX, img.x); contentMinY = Math.min(contentMinY, img.y); contentMaxX = Math.max(contentMaxX, img.x + img.width); contentMaxY = Math.max(contentMaxY, img.y + img.height); }
    for (const a of arrowsRef.current) { hasAny = true; contentMinX = Math.min(contentMinX, Math.min(a.x1, a.x2)); contentMinY = Math.min(contentMinY, Math.min(a.y1, a.y2)); contentMaxX = Math.max(contentMaxX, Math.max(a.x1, a.x2)); contentMaxY = Math.max(contentMaxY, Math.max(a.y1, a.y2)); }
    for (const line of linesRef.current) { for (const pt of line.points) { hasAny = true; contentMinX = Math.min(contentMinX, pt.x); contentMinY = Math.min(contentMinY, pt.y); contentMaxX = Math.max(contentMaxX, pt.x); contentMaxY = Math.max(contentMaxY, pt.y); } }
    if (hasAny && (wx < contentMinX - MARGIN || wx > contentMaxX + MARGIN || wy < contentMinY - MARGIN || wy > contentMaxY + MARGIN)) {
      return null;
    }

    // Notes (top layer)
    for (let i = notesRef.current.length - 1; i >= 0; i--) {
      const n = notesRef.current[i];
      if (wx >= n.x && wx <= n.x + n.width && wy >= n.y && wy <= n.y + n.height) {
        return { type: "note", id: n.id, x: n.x, y: n.y };
      }
    }
    // Texts
    for (let i = textsRef.current.length - 1; i >= 0; i--) {
      const te = textsRef.current[i];
      if (!te.text) continue;
      const fontSize = te.size === "S" ? 14 : te.size === "L" ? 24 : 18;
      const pad = te.callout ? 10 : 4;
      const h = te.text.split("\n").length * fontSize * 1.3 + pad * 2;
      const w = 200 + pad * 2; // approximate
      if (wx >= te.x - pad && wx <= te.x + w && wy >= te.y - pad && wy <= te.y + h) {
        return { type: "text", id: te.id, x: te.x, y: te.y };
      }
    }
    // Boxes
    for (let i = boxesRef.current.length - 1; i >= 0; i--) {
      const b = boxesRef.current[i];
      const margin = 6;
      if (wx >= b.x - margin && wx <= b.x + b.width + margin && wy >= b.y - margin && wy <= b.y + b.height + margin) {
        return { type: "box", id: b.id, x: b.x, y: b.y };
      }
    }
    // Images
    for (let i = imagesRef.current.length - 1; i >= 0; i--) {
      const img = imagesRef.current[i];
      if (wx >= img.x && wx <= img.x + img.width && wy >= img.y && wy <= img.y + img.height) {
        return { type: "image", id: img.id, x: img.x, y: img.y };
      }
    }
    // Arrows (hit test with distance to line segment)
    for (let i = arrowsRef.current.length - 1; i >= 0; i--) {
      const a = arrowsRef.current[i];
      const dx = a.x2 - a.x1, dy = a.y2 - a.y1;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) continue;
      const t = Math.max(0, Math.min(1, ((wx - a.x1) * dx + (wy - a.y1) * dy) / len2));
      const px = a.x1 + t * dx, py = a.y1 + t * dy;
      const dist = Math.sqrt((wx - px) ** 2 + (wy - py) ** 2);
      if (dist < 10) {
        return { type: "arrow", id: a.id, x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2) };
      }
    }
    // Drawing lines (distance to any segment in the polyline)
    // Use bounding-box pre-check per line to skip expensive segment iteration
    const LINE_HIT = 8;
    for (let i = linesRef.current.length - 1; i >= 0; i--) {
      const line = linesRef.current[i];
      if (line.points.length < 2) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const pt of line.points) { minX = Math.min(minX, pt.x); minY = Math.min(minY, pt.y); maxX = Math.max(maxX, pt.x); maxY = Math.max(maxY, pt.y); }
      // Skip line if click is outside its bounding box (with margin)
      if (wx < minX - LINE_HIT || wx > maxX + LINE_HIT || wy < minY - LINE_HIT || wy > maxY + LINE_HIT) continue;
      for (let j = 0; j < line.points.length - 1; j++) {
        const p1 = line.points[j], p2 = line.points[j + 1];
        const dx = p2.x - p1.x, dy = p2.y - p1.y;
        const len2 = dx * dx + dy * dy;
        if (len2 === 0) continue;
        const t = Math.max(0, Math.min(1, ((wx - p1.x) * dx + (wy - p1.y) * dy) / len2));
        const px = p1.x + t * dx, py = p1.y + t * dy;
        if (Math.sqrt((wx - px) ** 2 + (wy - py) ** 2) < LINE_HIT) {
          return { type: "line", id: line.id ?? String(i), x: minX, y: minY };
        }
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

    // Clear — background color
    const isDark = canvasBgRef.current === "dark";
    ctx.fillStyle = isDark ? "#1e1e2e" : "#eff1f5";
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(cam.x, cam.y);
    ctx.scale(cam.zoom, cam.zoom);

    // Draw grid
    if (showGridRef.current) {
      const gridSize = 40;
      const topLeft = { x: -cam.x / cam.zoom, y: -cam.y / cam.zoom };
      const bottomRight = { x: (w - cam.x) / cam.zoom, y: (h - cam.y) / cam.zoom };
      const startX = Math.floor(topLeft.x / gridSize) * gridSize;
      const startY = Math.floor(topLeft.y / gridSize) * gridSize;

      ctx.strokeStyle = isDark ? "#313244" : "#ccd0da";
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
    }

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

    // Draw images
    for (const img of imagesRef.current) {
      let htmlImg = loadedImagesRef.current.get(img.id);
      if (!htmlImg) {
        htmlImg = new Image();
        htmlImg.src = img.dataUrl;
        loadedImagesRef.current.set(img.id, htmlImg);
        htmlImg.onload = () => requestRedraw();
        htmlImg.onerror = () => { loadedImagesRef.current.delete(img.id); };
      }
      if (htmlImg.complete && htmlImg.naturalWidth > 0) {
        ctx.shadowColor = "rgba(0,0,0,0.2)";
        ctx.shadowBlur = 6;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1;
        ctx.drawImage(htmlImg, img.x, img.y, img.width, img.height);
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
      }
    }

    // Draw boxes
    for (const box of boxesRef.current) {
      ctx.strokeStyle = box.color;
      ctx.lineWidth = 2;
      ctx.strokeRect(box.x, box.y, box.width, box.height);
    }

    // Draw in-progress box
    if (boxDrawRef.current.active) {
      ctx.strokeStyle = drawColor;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(boxDrawRef.current.x, boxDrawRef.current.y, boxDrawRef.current.w, boxDrawRef.current.h);
      ctx.setLineDash([]);
    }

    // Draw arrows
    for (const arrow of arrowsRef.current) {
      drawArrow(ctx, arrow.x1, arrow.y1, arrow.x2, arrow.y2, arrow.color);
    }

    // Draw in-progress arrow
    if (arrowDrawRef.current.active) {
      const a = arrowDrawRef.current;
      drawArrow(ctx, a.x1, a.y1, a.x2, a.y2, drawColor);
    }

    // Draw text elements (plain + callout)
    for (const te of textsRef.current) {
      if (!te.text) continue;
      const fontSize = te.size === "S" ? 14 : te.size === "L" ? 24 : 18;
      ctx.font = `500 ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.textBaseline = "top";
      const textLines = te.text.split("\n");
      const lineHeight = fontSize * 1.3;
      const pad = 10;

      if (te.callout) {
        // Measure text for callout background
        let maxW = 0;
        for (const line of textLines) {
          const w = ctx.measureText(line).width;
          if (w > maxW) maxW = w;
        }
        const totalH = textLines.length * lineHeight;
        const style = getCalloutStyle(te.color);

        // Background
        const rx = 8; // border radius
        const bx = te.x - pad;
        const by = te.y - pad;
        const bw = maxW + pad * 2;
        const bh = totalH + pad * 2;

        ctx.fillStyle = style.bg;
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, rx);
        ctx.fill();
        ctx.strokeStyle = style.border;
        ctx.lineWidth = 1;
        ctx.stroke();

        // Text
        ctx.fillStyle = style.text;
        for (let i = 0; i < textLines.length; i++) {
          ctx.fillText(textLines[i], te.x, te.y + i * lineHeight);
        }
      } else {
        // Plain text
        ctx.fillStyle = te.color;
        for (let i = 0; i < textLines.length; i++) {
          ctx.fillText(textLines[i], te.x, te.y + i * lineHeight);
        }
      }
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
      const textLines = wrapText(ctx, note.text || "", maxWidth);
      let ty = note.y + 24;
      for (const tl of textLines) {
        if (ty > note.y + note.height - 8) break;
        ctx.fillStyle = note.text ? "#1e1e2e" : "rgba(30,30,46,0.4)";
        ctx.fillText(tl, note.x + padding, ty);
        ty += 17;
      }
    }

    // Draw selection bounding box
    const sel = selectedElementRef.current;
    if (sel) {
      let sx = 0, sy = 0, sw = 0, sh = 0;
      let found = false;
      if (sel.type === "note") {
        const n = notesRef.current.find((n) => n.id === sel.id);
        if (n) { sx = n.x; sy = n.y; sw = n.width; sh = n.height; found = true; }
      } else if (sel.type === "text") {
        const te = textsRef.current.find((t) => t.id === sel.id);
        if (te && te.text) {
          const fs = te.size === "S" ? 14 : te.size === "L" ? 24 : 18;
          const pad = te.callout ? 10 : 4;
          const h = te.text.split("\n").length * fs * 1.3 + pad * 2;
          sx = te.x - pad; sy = te.y - pad; sw = 200 + pad * 2; sh = h; found = true;
        }
      } else if (sel.type === "box") {
        const b = boxesRef.current.find((b) => b.id === sel.id);
        if (b) { sx = b.x; sy = b.y; sw = b.width; sh = b.height; found = true; }
      } else if (sel.type === "image") {
        const img = imagesRef.current.find((i) => i.id === sel.id);
        if (img) { sx = img.x; sy = img.y; sw = img.width; sh = img.height; found = true; }
      } else if (sel.type === "arrow") {
        const a = arrowsRef.current.find((a) => a.id === sel.id);
        if (a) {
          sx = Math.min(a.x1, a.x2) - 5; sy = Math.min(a.y1, a.y2) - 5;
          sw = Math.abs(a.x2 - a.x1) + 10; sh = Math.abs(a.y2 - a.y1) + 10; found = true;
        }
      } else if (sel.type === "line") {
        const idx = parseInt(sel.id);
        const line = linesRef.current[idx];
        if (line && line.points.length > 0) {
          let lMinX = Infinity, lMinY = Infinity, lMaxX = -Infinity, lMaxY = -Infinity;
          for (const pt of line.points) {
            lMinX = Math.min(lMinX, pt.x); lMinY = Math.min(lMinY, pt.y);
            lMaxX = Math.max(lMaxX, pt.x); lMaxY = Math.max(lMaxY, pt.y);
          }
          sx = lMinX; sy = lMinY; sw = lMaxX - lMinX; sh = lMaxY - lMinY; found = true;
        }
      }
      if (found) {
        ctx.strokeStyle = "#89b4fa";
        ctx.lineWidth = 1.5 / cam.zoom;
        ctx.setLineDash([4 / cam.zoom, 4 / cam.zoom]);
        ctx.strokeRect(sx - 3, sy - 3, sw + 6, sh + 6);
        ctx.setLineDash([]);
      }
    }

    ctx.restore();
  }, [drawColor]);

  // Text wrapping helper
  function drawArrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string) {
    const headLen = 12;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    // Arrowhead
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  }

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
  }, [notes, lines, texts, arrows, boxes, images, selectedElement, requestRedraw]);

  // Mouse handlers
  // Save current state (called after every interaction)
  const saveNow = useCallback(() => {
    const hasContent = notesRef.current.length > 0 || linesRef.current.length > 0 || imagesRef.current.length > 0 || textsRef.current.length > 0 || arrowsRef.current.length > 0 || boxesRef.current.length > 0;
    if (hasContent) {
      const truncated = saveWhiteboardData(whiteboardId, {
        notes: notesRef.current,
        lines: linesRef.current,
        images: imagesRef.current,
        texts: textsRef.current,
        arrows: arrowsRef.current,
        boxes: boxesRef.current,
        camera: { ...cameraRef.current },
        nextNoteId: nextNoteIdRef.current,
        canvasBg: canvasBgRef.current,
        showGrid: showGridRef.current,
      });
      if (truncated) {
        setSaveStatus("Images too large to save — use smaller images");
        setTimeout(() => setSaveStatus(null), 5000);
      }
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

      // Clicking canvas commits any active text/note edit (like clicking away)
      // Skip if clicking inside the text mode handler (it handles its own finish)
      if (mode !== "text") {
        if (editingTextIdRef.current) finishTextEdit();
        if (editingNoteRef.current) finishEdit();
      }

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

        if (mode === "arrow") {
          arrowDrawRef.current = { active: true, x1: world.x, y1: world.y, x2: world.x, y2: world.y };
          return;
        }

        if (mode === "box") {
          boxDrawRef.current = { active: true, x: world.x, y: world.y, w: 0, h: 0 };
          return;
        }

        if (mode === "text") {
          // Finish any active edit first (clicking away = save)
          if (editingTextIdRef.current) finishTextEdit();
          if (editingNoteRef.current) finishEdit();

          if (textStyle === "sticky") {
            // Create sticky note
            const id = "note-" + nextNoteIdRef.current++;
            const newNote: StickyNote = {
              id, x: world.x - 75, y: world.y - 50,
              width: 150, height: 100, text: "", color: noteColor,
            };
            setNotes((prev) => [...prev, newNote]);
            setEditingNote(id);
            setEditText("");
            setTimeout(() => editInputRef.current?.focus(), 0);
          } else {
            // Create text element
            const id = "txt-" + Date.now();
            setTexts((prev) => [...prev, { id, x: world.x, y: world.y, text: "", color: drawColor, size: textSize, callout: textStyle === "callout" }]);
            setTimeout(() => {
              setEditingTextId(id);
              setEditingTextValue("");
              setTimeout(() => textInputRef.current?.focus(), 50);
            }, 20);
          }
          return;
        }

        // Select mode — unified hit test for all elements
        const hit = findElementAt(world.x, world.y);
        if (hit) {
          setSelectedElement({ type: hit.type, id: hit.id });
          draggingElementRef.current = { type: hit.type, id: hit.id, offsetX: world.x - hit.x, offsetY: world.y - hit.y };
          return;
        }
        // Click empty space → deselect
        setSelectedElement(null);
      }
    },
    [mode, screenToWorld, findNoteAt, findElementAt, textStyle, textSize, drawColor, noteColor]
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

      // Arrow drawing
      if (arrowDrawRef.current.active) {
        const world = screenToWorld(sx, sy);
        arrowDrawRef.current.x2 = world.x;
        arrowDrawRef.current.y2 = world.y;
        requestRedraw();
        return;
      }

      // Box drawing
      if (boxDrawRef.current.active) {
        const world = screenToWorld(sx, sy);
        boxDrawRef.current.w = world.x - boxDrawRef.current.x;
        boxDrawRef.current.h = world.y - boxDrawRef.current.y;
        requestRedraw();
        return;
      }

      // Dragging any element
      if (draggingElementRef.current) {
        const world = screenToWorld(sx, sy);
        const nx = world.x - draggingElementRef.current.offsetX;
        const ny = world.y - draggingElementRef.current.offsetY;
        const id = draggingElementRef.current.id;

        if (draggingElementRef.current.type === "note") {
          setNotes((prev) => prev.map((n) => n.id === id ? { ...n, x: nx, y: ny } : n));
        } else if (draggingElementRef.current.type === "text") {
          setTexts((prev) => prev.map((t) => t.id === id ? { ...t, x: nx, y: ny } : t));
        } else if (draggingElementRef.current.type === "box") {
          setBoxes((prev) => prev.map((b) => b.id === id ? { ...b, x: nx, y: ny } : b));
        } else if (draggingElementRef.current.type === "image") {
          setImages((prev) => prev.map((img) => img.id === id ? { ...img, x: nx, y: ny } : img));
        } else if (draggingElementRef.current.type === "arrow") {
          // Move entire arrow by delta
          const arrow = arrowsRef.current.find((a) => a.id === id);
          if (arrow) {
            const dx = nx - Math.min(arrow.x1, arrow.x2);
            const dy = ny - Math.min(arrow.y1, arrow.y2);
            setArrows((prev) => prev.map((a) => a.id === id ? { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy } : a));
            // Update offset to prevent drift
            draggingElementRef.current.offsetX = world.x - nx;
            draggingElementRef.current.offsetY = world.y - ny;
          }
        } else if (draggingElementRef.current.type === "line") {
          const idx = parseInt(id);
          const line = linesRef.current[idx];
          if (line) {
            let minX = Infinity, minY = Infinity;
            for (const pt of line.points) { minX = Math.min(minX, pt.x); minY = Math.min(minY, pt.y); }
            const dx = nx - minX, dy = ny - minY;
            setLines((prev) => prev.map((l, i) => i === idx ? { ...l, points: l.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) } : l));
            draggingElementRef.current.offsetX = world.x - nx;
            draggingElementRef.current.offsetY = world.y - ny;
          }
        }
        requestRedraw();
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
          setLines((prev) => [...prev, { id: "line-" + Date.now(), points: [...pts], color: drawColor, width: 2 }]);
          redoStackRef.current = []; // New stroke clears redo history
          changed = true;
        }
        drawingRef.current = { active: false, points: [] };
      }

      // End arrow
      if (arrowDrawRef.current.active) {
        const a = arrowDrawRef.current;
        const dist = Math.sqrt((a.x2 - a.x1) ** 2 + (a.y2 - a.y1) ** 2);
        if (dist > 10) {
          setArrows((prev) => [...prev, { id: "arr-" + Date.now(), x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, color: drawColor }]);
          changed = true;
        }
        arrowDrawRef.current = { active: false, x1: 0, y1: 0, x2: 0, y2: 0 };
      }

      // End box
      if (boxDrawRef.current.active) {
        const b = boxDrawRef.current;
        if (Math.abs(b.w) > 10 && Math.abs(b.h) > 10) {
          // Normalize negative width/height
          const x = b.w < 0 ? b.x + b.w : b.x;
          const y = b.h < 0 ? b.y + b.h : b.y;
          setBoxes((prev) => [...prev, { id: "box-" + Date.now(), x, y, width: Math.abs(b.w), height: Math.abs(b.h), color: drawColor }]);
          changed = true;
        }
        boxDrawRef.current = { active: false, x: 0, y: 0, w: 0, h: 0 };
      }

      // End drag (any element)
      if (draggingElementRef.current) {
        draggingElementRef.current = null;
        changed = true;
      }

      // Auto-save after every interaction
      if (changed) setTimeout(saveNow, 50);
    },
    [drawColor, saveNow]
  );

  // --- Touch event support ---
  const getTouchPos = useCallback((e: React.TouchEvent<HTMLCanvasElement>): { clientX: number; clientY: number } => {
    const touch = e.touches[0] ?? e.changedTouches[0];
    return { clientX: touch.clientX, clientY: touch.clientY };
  }, []);

  const handleTouchStart = useCallback(
    (e: React.TouchEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const { clientX, clientY } = getTouchPos(e);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const sx = clientX - rect.left;
      const sy = clientY - rect.top;
      const world = screenToWorld(sx, sy);

      setContextMenu(null);

      if (mode === "draw") {
        drawingRef.current = { active: true, points: [{ x: world.x, y: world.y }] };
        return;
      }
      if (mode === "arrow") {
        arrowDrawRef.current = { active: true, x1: world.x, y1: world.y, x2: world.x, y2: world.y };
        return;
      }
      if (mode === "box") {
        boxDrawRef.current = { active: true, x: world.x, y: world.y, w: 0, h: 0 };
        return;
      }
      if (mode === "select") {
        const hit = findElementAt(world.x, world.y);
        if (hit) {
          setSelectedElement({ type: hit.type, id: hit.id });
          draggingElementRef.current = { type: hit.type, id: hit.id, offsetX: world.x - hit.x, offsetY: world.y - hit.y };
          return;
        }
        // No element hit — start panning
        panningRef.current = {
          active: true,
          startX: clientX,
          startY: clientY,
          camStartX: cameraRef.current.x,
          camStartY: cameraRef.current.y,
        };
        setSelectedElement(null);
      }
    },
    [mode, screenToWorld, findElementAt, getTouchPos]
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const { clientX, clientY } = getTouchPos(e);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const sx = clientX - rect.left;
      const sy = clientY - rect.top;

      if (panningRef.current.active) {
        const dx = clientX - panningRef.current.startX;
        const dy = clientY - panningRef.current.startY;
        cameraRef.current.x = panningRef.current.camStartX + dx;
        cameraRef.current.y = panningRef.current.camStartY + dy;
        requestRedraw();
        return;
      }

      if (drawingRef.current.active) {
        const world = screenToWorld(sx, sy);
        drawingRef.current.points.push({ x: world.x, y: world.y });
        requestRedraw();
        return;
      }

      if (arrowDrawRef.current.active) {
        const world = screenToWorld(sx, sy);
        arrowDrawRef.current.x2 = world.x;
        arrowDrawRef.current.y2 = world.y;
        requestRedraw();
        return;
      }

      if (boxDrawRef.current.active) {
        const world = screenToWorld(sx, sy);
        boxDrawRef.current.w = world.x - boxDrawRef.current.x;
        boxDrawRef.current.h = world.y - boxDrawRef.current.y;
        requestRedraw();
        return;
      }

      if (draggingElementRef.current) {
        const world = screenToWorld(sx, sy);
        const nx = world.x - draggingElementRef.current.offsetX;
        const ny = world.y - draggingElementRef.current.offsetY;
        const id = draggingElementRef.current.id;

        if (draggingElementRef.current.type === "note") {
          setNotes((prev) => prev.map((n) => n.id === id ? { ...n, x: nx, y: ny } : n));
        } else if (draggingElementRef.current.type === "text") {
          setTexts((prev) => prev.map((t) => t.id === id ? { ...t, x: nx, y: ny } : t));
        } else if (draggingElementRef.current.type === "box") {
          setBoxes((prev) => prev.map((b) => b.id === id ? { ...b, x: nx, y: ny } : b));
        } else if (draggingElementRef.current.type === "image") {
          setImages((prev) => prev.map((img) => img.id === id ? { ...img, x: nx, y: ny } : img));
        } else if (draggingElementRef.current.type === "arrow") {
          const arrow = arrowsRef.current.find((a) => a.id === id);
          if (arrow) {
            const dx = nx - Math.min(arrow.x1, arrow.x2);
            const dy = ny - Math.min(arrow.y1, arrow.y2);
            setArrows((prev) => prev.map((a) => a.id === id ? { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy } : a));
            draggingElementRef.current.offsetX = world.x - nx;
            draggingElementRef.current.offsetY = world.y - ny;
          }
        } else if (draggingElementRef.current.type === "line") {
          const idx = parseInt(id);
          const line = linesRef.current[idx];
          if (line) {
            let minX = Infinity, minY = Infinity;
            for (const pt of line.points) { minX = Math.min(minX, pt.x); minY = Math.min(minY, pt.y); }
            const dx = nx - minX, dy = ny - minY;
            setLines((prev) => prev.map((l, i) => i === idx ? { ...l, points: l.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) } : l));
            draggingElementRef.current.offsetX = world.x - nx;
            draggingElementRef.current.offsetY = world.y - ny;
          }
        }
        requestRedraw();
      }
    },
    [screenToWorld, requestRedraw, getTouchPos]
  );

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      let changed = false;

      if (panningRef.current.active) {
        panningRef.current.active = false;
      }

      if (drawingRef.current.active) {
        const pts = drawingRef.current.points;
        if (pts.length >= 2) {
          setLines((prev) => [...prev, { id: "line-" + Date.now(), points: [...pts], color: drawColor, width: 2 }]);
          redoStackRef.current = [];
          changed = true;
        }
        drawingRef.current = { active: false, points: [] };
      }

      if (arrowDrawRef.current.active) {
        const a = arrowDrawRef.current;
        const dist = Math.sqrt((a.x2 - a.x1) ** 2 + (a.y2 - a.y1) ** 2);
        if (dist > 10) {
          setArrows((prev) => [...prev, { id: "arr-" + Date.now(), x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, color: drawColor }]);
          changed = true;
        }
        arrowDrawRef.current = { active: false, x1: 0, y1: 0, x2: 0, y2: 0 };
      }

      if (boxDrawRef.current.active) {
        const b = boxDrawRef.current;
        if (Math.abs(b.w) > 10 && Math.abs(b.h) > 10) {
          const x = b.w < 0 ? b.x + b.w : b.x;
          const y = b.h < 0 ? b.y + b.h : b.y;
          setBoxes((prev) => [...prev, { id: "box-" + Date.now(), x, y, width: Math.abs(b.w), height: Math.abs(b.h), color: drawColor }]);
          changed = true;
        }
        boxDrawRef.current = { active: false, x: 0, y: 0, w: 0, h: 0 };
      }

      if (draggingElementRef.current) {
        draggingElementRef.current = null;
        changed = true;
      }

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

      // Double-click existing note → edit it
      const existing = findNoteAt(world.x, world.y);
      if (existing) {
        setEditingNote(existing.id);
        setEditText(existing.text);
        setTimeout(() => editInputRef.current?.focus(), 0);
        return;
      }

      // Double-click existing text → edit it
      for (let i = textsRef.current.length - 1; i >= 0; i--) {
        const te = textsRef.current[i];
        if (!te.text) continue;
        const fontSize = te.size === "S" ? 14 : te.size === "L" ? 24 : 18;
        const pad = te.callout ? 10 : 0;
        const textLines = te.text.split("\n");
        const lineH = fontSize * 1.3;
        const maxW = 200;
        if (world.x >= te.x - pad && world.x <= te.x + maxW + pad &&
            world.y >= te.y - pad && world.y <= te.y + textLines.length * lineH + pad) {
          setEditingTextId(te.id);
          setEditingTextValue(te.text);
          setTimeout(() => textInputRef.current?.focus(), 50);
          return;
        }
      }
    },
    [mode, screenToWorld, findNoteAt]
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
    const id = editingNoteRef.current;
    const text = editTextRef.current;
    if (id) {
      setNotes((prev) =>
        prev.map((n) => (n.id === id ? { ...n, text } : n))
      );
      setEditingNote(null);
      setEditText("");
      setTimeout(saveNow, 50);
    }
  }, [saveNow, setEditingNote, setEditText]);

  const finishTextEdit = useCallback(() => {
    // Read from refs to avoid stale closure (mouseDown handler may have outdated state)
    const id = editingTextIdRef.current;
    const val = editingTextValueRef.current.trim();
    if (id) {
      if (val) {
        setTexts((prev) => prev.map((t) => (t.id === id ? { ...t, text: val } : t)));
      } else {
        // Remove empty text elements
        setTexts((prev) => prev.filter((t) => t.id !== id));
      }
      setEditingTextId(null);
      editingTextIdRef.current = null;
      setEditingTextValue("");
      editingTextValueRef.current = "";
      setTimeout(saveNow, 50);
    }
  }, [saveNow]);

  // Auto-save every 2 seconds
  useEffect(() => {
    const interval = setInterval(saveNow, 2000);
    return () => clearInterval(interval);
  }, [whiteboardId]);

  // Save current state (called after every interaction)
  // Close — state is already saved continuously
  // Insert image from file/blob
  const insertImage = useCallback((file: File | Blob) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const img = new Image();
      img.onload = () => {
        const cam = cameraRef.current;
        const canvas = canvasRef.current;
        // Place at center of current viewport
        const cx = canvas ? ((canvas.width / 2) - cam.x) / cam.zoom : 200;
        const cy = canvas ? ((canvas.height / 2) - cam.y) / cam.zoom : 200;
        // Scale down large images to max 400px
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        const maxDim = 400;
        if (w > maxDim || h > maxDim) {
          const scale = maxDim / Math.max(w, h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }
        const id = "img-" + Date.now();
        setImages((prev) => [...prev, { id, x: cx - w / 2, y: cy - h / 2, width: w, height: h, dataUrl }]);
        setShowHint(false);
        setTimeout(saveNow, 50);
        requestRedraw();
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }, [saveNow, requestRedraw]);

  // Fit All — zoom to show all elements
  const handleFitAll = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let hasContent = false;

    for (const n of notesRef.current) {
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.width); maxY = Math.max(maxY, n.y + n.height);
      hasContent = true;
    }
    for (const te of textsRef.current) {
      if (!te.text) continue;
      const fs = te.size === "S" ? 14 : te.size === "L" ? 24 : 18;
      const h = te.text.split("\n").length * fs * 1.3 + 20;
      minX = Math.min(minX, te.x - 10); minY = Math.min(minY, te.y - 10);
      maxX = Math.max(maxX, te.x + 200); maxY = Math.max(maxY, te.y + h);
      hasContent = true;
    }
    for (const a of arrowsRef.current) {
      minX = Math.min(minX, a.x1, a.x2); minY = Math.min(minY, a.y1, a.y2);
      maxX = Math.max(maxX, a.x1, a.x2); maxY = Math.max(maxY, a.y1, a.y2);
      hasContent = true;
    }
    for (const b of boxesRef.current) {
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height);
      hasContent = true;
    }
    for (const img of imagesRef.current) {
      minX = Math.min(minX, img.x); minY = Math.min(minY, img.y);
      maxX = Math.max(maxX, img.x + img.width); maxY = Math.max(maxY, img.y + img.height);
      hasContent = true;
    }
    for (const line of linesRef.current) {
      for (const pt of line.points) {
        minX = Math.min(minX, pt.x); minY = Math.min(minY, pt.y);
        maxX = Math.max(maxX, pt.x); maxY = Math.max(maxY, pt.y);
      }
      if (line.points.length > 0) hasContent = true;
    }

    if (!hasContent) return;

    const pad = 40;
    const contentW = maxX - minX + pad * 2;
    const contentH = maxY - minY + pad * 2;
    const targetZoom = Math.min(canvas.width / contentW, canvas.height / contentH, 2);
    const targetX = (canvas.width - contentW * targetZoom) / 2 - (minX - pad) * targetZoom;
    const targetY = (canvas.height - contentH * targetZoom) / 2 - (minY - pad) * targetZoom;

    // Animate to target
    const startX = cameraRef.current.x;
    const startY = cameraRef.current.y;
    const startZoom = cameraRef.current.zoom;
    const duration = 250;
    const start = performance.now();

    function tick(now: number) {
      const t = Math.min((now - start) / duration, 1);
      const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      cameraRef.current.x = startX + (targetX - startX) * ease;
      cameraRef.current.y = startY + (targetY - startY) * ease;
      cameraRef.current.zoom = startZoom + (targetZoom - startZoom) * ease;
      requestRedraw();
      if (t < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }, [requestRedraw]);

  const handleClose = useCallback(() => {
    saveNow();
    const hasContent = notesRef.current.length > 0 || linesRef.current.length > 0 || imagesRef.current.length > 0 || textsRef.current.length > 0 || arrowsRef.current.length > 0 || boxesRef.current.length > 0;
    onClose(hasContent);
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
    // Snapshot for undo
    setUndoSnapshot({ notes: [...notesRef.current], lines: [...linesRef.current], images: [...imagesRef.current], texts: [...textsRef.current], arrows: [...arrowsRef.current], boxes: [...boxesRef.current] });
    setNotes([]);
    setLines([]);
    setImages([]);
    setTexts([]);
    setArrows([]);
    setBoxes([]);
    localStorage.removeItem(STORAGE_PREFIX + whiteboardId);
    requestRedraw();
    // Auto-dismiss undo after 5 seconds
    setTimeout(() => setUndoSnapshot(null), 5000);
  }, [whiteboardId, requestRedraw]);

  const undoClear = useCallback(() => {
    if (!undoSnapshot) return;
    setNotes(undoSnapshot.notes);
    setLines(undoSnapshot.lines);
    setImages(undoSnapshot.images);
    setTexts(undoSnapshot.texts);
    setArrows(undoSnapshot.arrows);
    setBoxes(undoSnapshot.boxes);
    setUndoSnapshot(null);
    setTimeout(saveNow, 50);
  }, [undoSnapshot, saveNow]);

  // Paste from Tauri clipboard
  const pasteFromTauriClipboard = useCallback(async () => {
    setSaveStatus("Reading clipboard...");

    // Try WSL PowerShell bridge first (reads Windows clipboard)
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const base64: string = await invoke("paste_image_wsl");
      if (base64 && base64.length > 0) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: "image" });
        insertImage(blob);
        setSaveStatus("Pasted!");
        setTimeout(() => setSaveStatus(null), 1500);
        return;
      }
    } catch (wslErr) {
      console.warn("WSL clipboard bridge:", wslErr);
    }

    // Fallback: try Tauri clipboard plugin (Linux clipboard)
    try {
      const { readImage } = await import("@tauri-apps/plugin-clipboard-manager");
      const img = await readImage();
      if (img) {
        const [rgba, { width: w, height: h }] = await Promise.all([img.rgba(), img.size()]);
        if (w && h && rgba && rgba.length > 0) {
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            const imageData = ctx.createImageData(w, h);
            imageData.data.set(new Uint8ClampedArray(rgba));
            ctx.putImageData(imageData, 0, 0);
            canvas.toBlob((blob) => {
              if (blob) {
                insertImage(blob);
                setSaveStatus("Pasted!");
                setTimeout(() => setSaveStatus(null), 1500);
              }
            }, "image/png");
            return;
          }
        }
      }
    } catch (pluginErr) {
      console.warn("Tauri clipboard plugin:", pluginErr);
    }

    setSaveStatus("No image in clipboard");
    setTimeout(() => setSaveStatus(null), 2000);
  }, [insertImage]);

  // Tauri file drop handler (WebKitGTK doesn't fire HTML5 drag events from OS)
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const webview = getCurrentWebviewWindow();
        unlisten = await webview.onDragDropEvent((event) => {
          if (event.payload.type === "drop") {
            const paths = event.payload.paths;
            for (const path of paths) {
              if (/\.(png|jpg|jpeg|gif|bmp|webp|svg)$/i.test(path)) {
                // Read file via fetch (Tauri allows file:// or asset://)
                fetch(`asset://localhost/${path}`).then(r => r.blob()).then(blob => {
                  insertImage(blob);
                }).catch(() => {
                  // Fallback: read via Rust
                  import("@tauri-apps/api/core").then(({ invoke }) => {
                    invoke("read_file_base64", { path }).then((base64: unknown) => {
                      if (typeof base64 === "string" && base64.length > 0) {
                        const binary = atob(base64);
                        const bytes = new Uint8Array(binary.length);
                        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                        insertImage(new Blob([bytes], { type: "image" }));
                      }
                    }).catch(() => {});
                  });
                });
                return;
              }
            }
          }
        });
      } catch {}
    })();
    return () => { unlisten?.(); };
  }, [insertImage]);

  // Paste image from clipboard (browser paste event + Tauri Ctrl+V)
  useEffect(() => {
    const pasteHandler = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (items) {
        for (const item of items) {
          if (item.type.startsWith("image/")) {
            e.preventDefault();
            const blob = item.getAsFile();
            if (blob) insertImage(blob);
            return;
          }
        }
      }
      // Browser paste had no image — try Tauri clipboard
      if (isTauri) pasteFromTauriClipboard();
    };

    const keyHandler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "v" && !editingNote && !editingTextId) {
        if (isTauri) {
          e.preventDefault();
          pasteFromTauriClipboard();
        }
        // Browser: let native paste event fire
      }
    };

    window.addEventListener("paste", pasteHandler);
    window.addEventListener("keydown", keyHandler);
    return () => {
      window.removeEventListener("paste", pasteHandler);
      window.removeEventListener("keydown", keyHandler);
    };
  }, [insertImage, editingNote, editingTextId, pasteFromTauriClipboard]);

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
      if (!editingNote && !editingTextId) {
        if (e.key === "s" || e.key === "S") setMode("select");
        if (e.key === "t" || e.key === "T") setMode("text");
        if (e.key === "a" || e.key === "A") setMode("arrow");
        if (e.key === "b" || e.key === "B") setMode("box");
        if (e.key === "d" || e.key === "D") setMode("draw");
        if (e.key === "f" || e.key === "F") handleFitAll();
      }
      // Delete / Backspace — remove selected element
      // Enter on selected text element → edit it
      if (e.key === "Enter" && selectedElement && !editingNote && !editingTextId) {
        if (selectedElement.type === "text") {
          const te = textsRef.current.find((t) => t.id === selectedElement.id);
          if (te) {
            e.preventDefault();
            setEditingTextId(te.id);
            setEditingTextValue(te.text);
            setTimeout(() => textInputRef.current?.focus(), 50);
          }
        } else if (selectedElement.type === "note") {
          const note = notesRef.current.find((n) => n.id === selectedElement.id);
          if (note) {
            e.preventDefault();
            setEditingNote(note.id);
            setEditText(note.text);
            setTimeout(() => editInputRef.current?.focus(), 0);
          }
        }
      }
      // Arrow keys — move selected element (1px, or 10px with Shift)
      if (selectedElement && !editingNote && !editingTextId &&
          (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        const { type, id } = selectedElement;
        if (type === "note") setNotes((prev) => prev.map((n) => n.id === id ? { ...n, x: n.x + dx, y: n.y + dy } : n));
        else if (type === "text") setTexts((prev) => prev.map((t) => t.id === id ? { ...t, x: t.x + dx, y: t.y + dy } : t));
        else if (type === "box") setBoxes((prev) => prev.map((b) => b.id === id ? { ...b, x: b.x + dx, y: b.y + dy } : b));
        else if (type === "image") setImages((prev) => prev.map((img) => img.id === id ? { ...img, x: img.x + dx, y: img.y + dy } : img));
        else if (type === "arrow") setArrows((prev) => prev.map((a) => a.id === id ? { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy } : a));
        else if (type === "line") {
          const idx = parseInt(id);
          setLines((prev) => prev.map((l, i) => i === idx ? { ...l, points: l.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) } : l));
        }
        setTimeout(saveNow, 200);
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedElement && !editingNote && !editingTextId) {
        e.preventDefault();
        const { type, id } = selectedElement;
        if (type === "note") setNotes((prev) => prev.filter((n) => n.id !== id));
        else if (type === "text") setTexts((prev) => prev.filter((t) => t.id !== id));
        else if (type === "arrow") setArrows((prev) => prev.filter((a) => a.id !== id));
        else if (type === "box") setBoxes((prev) => prev.filter((b) => b.id !== id));
        else if (type === "image") setImages((prev) => prev.filter((i) => i.id !== id));
        else if (type === "line") setLines((prev) => prev.filter((_, idx) => String(idx) !== id));
        setSelectedElement(null);
        setTimeout(saveNow, 50);
      }
      // Ctrl+Z — undo last stroke
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey && !editingNote) {
        e.preventDefault();
        setLines((prev) => {
          if (prev.length === 0) return prev;
          redoStackRef.current.push(prev[prev.length - 1]);
          return prev.slice(0, -1);
        });
        setTimeout(saveNow, 50);
      }
      // Ctrl+Shift+Z — redo
      if ((e.ctrlKey || e.metaKey) && e.key === "Z" && !editingNote) {
        e.preventDefault();
        const stroke = redoStackRef.current.pop();
        if (stroke) {
          setLines((prev) => [...prev, stroke]);
          setTimeout(saveNow, 50);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleClose, editingNote, editingTextId, finishEdit, contextMenu, saveNow, selectedElement]);

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
      {/* ── Base toolbar ── */}
      <div className="whiteboard-toolbar">
        <div className="whiteboard-toolbar-group">
          {(["select", "text", "arrow", "box", "draw"] as const).map((m) => (
            <button
              key={m}
              className={`btn btn-sm ${mode === m ? "btn-primary" : ""}`}
              onClick={() => setMode(m)}
              title={`${m.charAt(0).toUpperCase() + m.slice(1)} (${m[0].toUpperCase()})`}
            >
              {m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>

        {/* ── Contextual controls per tool ── */}

        {/* Selected element info (Select mode) */}
        {mode === "select" && selectedElement && (
          <div className="whiteboard-toolbar-group">
            <span className="whiteboard-toolbar-label">
              {selectedElement.type === "text" ? "Text" : selectedElement.type === "note" ? "Sticky" : selectedElement.type === "arrow" ? "Arrow" : selectedElement.type === "box" ? "Box" : selectedElement.type === "line" ? "Stroke" : selectedElement.type === "image" ? "Image" : ""}
            </span>
            {(selectedElement.type === "text" || selectedElement.type === "arrow" || selectedElement.type === "box" || selectedElement.type === "line") && (
              <>
                {DRAW_COLORS.map((c) => (
                  <button
                    key={c}
                    className="whiteboard-color-swatch"
                    style={{ background: c }}
                    onClick={() => {
                      const { type, id } = selectedElement;
                      if (type === "text") setTexts((prev) => prev.map((t) => t.id === id ? { ...t, color: c } : t));
                      else if (type === "arrow") setArrows((prev) => prev.map((a) => a.id === id ? { ...a, color: c } : a));
                      else if (type === "box") setBoxes((prev) => prev.map((b) => b.id === id ? { ...b, color: c } : b));
                      else if (type === "line") setLines((prev) => prev.map((l, i) => String(i) === id ? { ...l, color: c } : l));
                      setTimeout(saveNow, 50);
                    }}
                  />
                ))}
              </>
            )}
            {selectedElement.type === "note" && (
              <>
                {NOTE_COLORS.map((c) => (
                  <button
                    key={c}
                    className="whiteboard-color-swatch"
                    style={{ background: c }}
                    onClick={() => {
                      setNotes((prev) => prev.map((n) => n.id === selectedElement.id ? { ...n, color: c } : n));
                      setTimeout(saveNow, 50);
                    }}
                  />
                ))}
              </>
            )}
          </div>
        )}

        {mode !== "select" && (
          <div className="whiteboard-toolbar-group">
            {(textStyle === "sticky" && mode === "text" ? NOTE_COLORS : DRAW_COLORS).map((c) => (
              <button
                key={c}
                className={`whiteboard-color-swatch ${(textStyle === "sticky" && mode === "text" ? noteColor : drawColor) === c ? "active" : ""}`}
                style={{ background: c }}
                onClick={() => textStyle === "sticky" && mode === "text" ? setNoteColor(c) : setDrawColor(c)}
              />
            ))}
          </div>
        )}

        {mode === "text" && (
          <div className="whiteboard-toolbar-group">
            <span className="whiteboard-toolbar-label">Style:</span>
            {(["callout", "plain", "sticky"] as const).map((s) => (
              <button
                key={s}
                className={`btn btn-sm ${textStyle === s ? "btn-primary" : ""}`}
                onClick={() => setTextStyle(s)}
                style={{ fontSize: 11, padding: "2px 8px" }}
              >
                {s === "callout" ? "Callout" : s === "plain" ? "Plain" : "Sticky"}
              </button>
            ))}
            <span className="whiteboard-toolbar-label" style={{ marginLeft: 4 }}>Size:</span>
            {(["S", "M", "L"] as const).map((s) => (
              <button
                key={s}
                className={`btn btn-sm ${textSize === s ? "btn-primary" : ""}`}
                onClick={() => setTextSize(s)}
                style={{ minWidth: 24, padding: "2px 5px", fontSize: 10 }}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {(mode === "arrow" || mode === "draw") && (
          <div className="whiteboard-toolbar-group">
            <span className="whiteboard-toolbar-label">Width:</span>
            {(["S", "M", "L"] as const).map((s) => (
              <button key={s} className="btn btn-sm" style={{ minWidth: 24, padding: "2px 5px", fontSize: 10, opacity: s === "M" ? 1 : 0.5 }} disabled>
                {s}
              </button>
            ))}
          </div>
        )}

        {/* ── Actions (always visible) ── */}
        <div className="whiteboard-toolbar-group" style={{ marginLeft: "auto", position: "relative" }}>
          {saveStatus && <span className="whiteboard-save-status">{saveStatus}</span>}
          <button className="btn btn-sm" onClick={() => {
            const input = document.createElement("input");
            input.type = "file";
            input.accept = "image/*";
            input.onchange = () => {
              const file = input.files?.[0];
              if (file) insertImage(file);
            };
            input.click();
          }} title="Upload image">Upload</button>
          <button className="btn btn-sm" onClick={handleFitAll} title="Zoom to fit all (F)">Fit</button>
          <button className="btn btn-sm" onClick={() => { setShowExportMenu(v => !v); setShowCanvasSettings(false); }}>Export ▾</button>
          {showExportMenu && (
            <div className="mindmap-dropdown" onClick={() => setShowExportMenu(false)}>
              <button onClick={exportPng}>PNG Image</button>
            </div>
          )}
          <button className="btn btn-sm" onClick={clearCanvas} title="Clear">Clear</button>
          <button className="btn btn-sm" onClick={() => { setShowCanvasSettings(v => !v); setShowExportMenu(false); }} title="Canvas settings">⚙</button>
          {showCanvasSettings && (
            <div className="wb-popover" onClick={(e) => e.stopPropagation()}>
              <div className="wb-popover-row">
                <span className="wb-popover-label">Background</span>
                <div className="wb-settings-toggle">
                  <button className={canvasBg === "dark" ? "active" : ""} onClick={() => { setCanvasBg("dark"); requestRedraw(); }}>Dark</button>
                  <button className={canvasBg === "light" ? "active" : ""} onClick={() => { setCanvasBg("light"); requestRedraw(); }}>Light</button>
                </div>
              </div>
              <div className="wb-popover-row">
                <span className="wb-popover-label">Grid</span>
                <div className="wb-settings-toggle">
                  <button className={showGrid ? "active" : ""} onClick={() => { setShowGrid(true); requestRedraw(); }}>On</button>
                  <button className={!showGrid ? "active" : ""} onClick={() => { setShowGrid(false); requestRedraw(); }}>Off</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <canvas
        ref={canvasRef}
        className="whiteboard-canvas"
        style={{ cursor: mode === "select" ? "default" : mode === "text" ? "text" : "crosshair" }}
        onMouseDown={(e) => { setShowHint(false); setShowCanvasSettings(false); setShowExportMenu(false); handleMouseDown(e); }}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onTouchStart={(e) => { setShowHint(false); setShowCanvasSettings(false); setShowExportMenu(false); handleTouchStart(e); }}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onDoubleClick={(e) => { setShowHint(false); handleDoubleClick(e); }}
        onWheel={handleWheel}
        onContextMenu={handleContextMenu}
        onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add("whiteboard-drop-active"); }}
        onDragLeave={(e) => { e.currentTarget.classList.remove("whiteboard-drop-active"); }}
        onDrop={(e) => {
          e.preventDefault();
          e.currentTarget.classList.remove("whiteboard-drop-active");
          const files = e.dataTransfer.files;
          for (const file of files) {
            if (file.type.startsWith("image/")) {
              insertImage(file);
              return;
            }
          }
        }}
      />

      {/* First-time hint — disappears on first interaction */}
      {showHint && (
        <div className="whiteboard-hint" onMouseDown={() => setShowHint(false)}>
          Draw, paste image (Ctrl+V), or drop file
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

      {/* Text element editing overlay */}
      {editingTextId && (() => {
        const te = texts.find((t) => t.id === editingTextId);
        if (!te) return null;
        const cam = cameraRef.current;
        const sx = te.x * cam.zoom + cam.x;
        const sy = te.y * cam.zoom + cam.y;
        const fontSize = te.size === "S" ? 14 : te.size === "L" ? 24 : 18;
        return (
          <textarea
            ref={textInputRef}
            className={`whiteboard-text-editor ${te.callout ? "whiteboard-text-callout" : ""}`}
            style={{
              left: sx - (te.callout ? 10 * cam.zoom : 0),
              top: sy - (te.callout ? 10 * cam.zoom : 0),
              fontSize: fontSize * cam.zoom,
              color: te.callout ? getCalloutStyle(te.color).text : te.color,
              backgroundColor: te.callout ? getCalloutStyle(te.color).bg : "transparent",
              borderColor: te.callout ? getCalloutStyle(te.color).border : "var(--accent)",
              minWidth: 120 * cam.zoom,
              minHeight: fontSize * 1.5 * cam.zoom,
              padding: te.callout ? `${10 * cam.zoom}px` : "2px 4px",
            }}
            value={editingTextValue}
            onChange={(e) => setEditingTextValue(e.target.value)}
            onBlur={finishTextEdit}
            onKeyDown={(e) => {
              if (e.key === "Escape") finishTextEdit();
              e.stopPropagation();
            }}
            autoFocus
            placeholder="Type here..."
          />
        );
      })()}

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

      {/* Undo clear toast */}
      {undoSnapshot && (
        <div className="whiteboard-undo-toast">
          Canvas cleared
          <button onClick={undoClear}>Undo</button>
        </div>
      )}
    </div>
  );
}
