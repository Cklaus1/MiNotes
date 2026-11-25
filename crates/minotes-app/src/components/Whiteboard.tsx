import { useEffect, useRef, useState, useCallback, type CSSProperties } from "react";
import { isTauri } from "../lib/api";
import { saveExport } from "../lib/exportFile";
import { boardToSvg } from "../lib/whiteboardSvg";
import { loadWhiteboard, persistWhiteboard } from "../lib/whiteboardUtils";
import { showToast } from "../lib/toast";
import { registerFlush } from "../lib/pendingEdits";
import { isRemoteSrc } from "../lib/remoteImages";
import { useAppTheme } from "../lib/theme";
import { coveredAbove } from "../lib/layers";
import Icon from "./Icon";
import {
  connectorEnds, dropDanglingAttachments, elementsInRect, normRect, reattachArrows, shapeAt, shapeRect,
  snapToGuides, unionRect, type BoardShapes, type ElementRef, type Guides, type Rect, type ShapeType,
} from "../lib/whiteboardGeometry";

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

// The board follows the theme: stored colours are the dark-canvas palette
// (Catppuccin Mocha); on a light canvas each is drawn as its darker Latte twin,
// so a stroke stays readable whichever theme it is viewed in.
const LIGHT_INK: Record<string, string> = {
  "#cdd6f4": "#4c4f69", // text
  "#89b4fa": "#1e66f5", // blue
  "#a6e3a1": "#40a02b", // green
  "#f9e2af": "#df8e1d", // yellow
  "#f38ba8": "#d20f39", // red
};
const inkFor = (color: string, bg: "dark" | "light") => (bg === "light" ? LIGHT_INK[color] ?? color : color);
function calloutFor(color: string, bg: "dark" | "light") {
  const s = getCalloutStyle(color);
  if (bg === "dark") return s;
  const ink = inkFor(color, bg);
  return { bg: s.bg, text: ink, border: ink + "66" };
}

interface Arrow {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  /** Connector ends: the shapes the arrow is attached to (it follows them). */
  from?: { type: ShapeType; id: string } | null;
  to?: { type: ShapeType; id: string } | null;
}

/** A stroke's id: its own, or (old boards) its index. */
const lineKey = (l: { id?: string }, i: number) => l.id ?? String(i);
type Sel = { type: "note" | "text" | "arrow" | "box" | "image" | "line"; id: string };
const selKey = (e: { type: string; id: string }) => `${e.type}:${e.id}`;

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
  /** The canvas background in effect when saved (read by older versions). */
  canvasBg?: "dark" | "light";
  /** "auto" (default) follows the app theme; "dark"/"light" pin it for this board. */
  canvasTheme?: "auto" | "dark" | "light";
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

const MAX_UNDO = 100;
const ERROR_BANNER_STYLE: CSSProperties = {
  position: "absolute", top: 48, left: "50%", transform: "translateX(-50%)", zIndex: 20,
  background: "#f38ba8", color: "#1e1e2e", padding: "6px 12px", borderRadius: 6,
  fontSize: 13, fontWeight: 600, boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
};
const SAVE_DEBOUNCE_MS = 1000;

type Snapshot = { notes: StickyNote[]; lines: Line[]; images: CanvasImage[]; texts: TextElement[]; arrows: Arrow[]; boxes: Box[] };

/** True if the keyboard event's target is an editable element that does not
 *  belong to the whiteboard itself (e.g. search box or command palette). */
function isForeignEditable(target: EventTarget | null, container: HTMLElement | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  const editable = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
  if (!editable) return false;
  return !(container && container.contains(el));
}

/** Loads whiteboard data from the DB (importing legacy localStorage data once), then mounts the editor. */
export default function Whiteboard({ whiteboardId, onClose }: Props) {
  const [state, setState] = useState<{ id: string; data: WhiteboardData | null } | { id: string; error: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadWhiteboard(whiteboardId, { fresh: true })
      .then((d) => { if (!cancelled) setState({ id: whiteboardId, data: (d as WhiteboardData | null) ?? null }); })
      .catch((e) => { if (!cancelled) setState({ id: whiteboardId, error: String(e) }); });
    return () => { cancelled = true; };
  }, [whiteboardId]);

  if (!state || state.id !== whiteboardId) {
    return <div className="whiteboard"><div className="whiteboard-hint">Loading whiteboard…</div></div>;
  }
  if ("error" in state) {
    return (
      <div className="whiteboard">
        <div className="whiteboard-error-banner" role="alert" style={ERROR_BANNER_STYLE}>
          Could not load whiteboard: {state.error}{" "}
          <button className="btn btn-sm" onClick={() => onClose(false)}>Close</button>
        </div>
      </div>
    );
  }
  return <WhiteboardEditor key={whiteboardId} whiteboardId={whiteboardId} saved={state.data} onClose={onClose} />;
}

function WhiteboardEditor({ whiteboardId, onClose, saved }: Props & { saved: WhiteboardData | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

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
  // Multi-selection (rubber band, Shift+click): 2+ elements, moved / deleted together.
  const [multiSel, setMultiSel] = useState<Sel[]>([]);
  const multiSelRef = useRef<Sel[]>([]);
  multiSelRef.current = multiSel;
  const marqueeRef = useRef<{ x0: number; y0: number; x1: number; y1: number; additive: boolean } | null>(null);
  const groupDragRef = useRef<{ startX: number; startY: number; base: Snapshot; members: Sel[]; moved: boolean } | null>(null);
  // Alignment guides shown while a drag is snapped (world coordinates).
  const guidesRef = useRef<Guides | null>(null);
  // Arrow tool: the shape under the pointer (the end will attach to it).
  const arrowTargetRef = useRef<{ type: ShapeType; id: string } | null>(null);
  const [textSize, setTextSize] = useState<"S" | "M" | "L">("M");
  const [textStyle, setTextStyle] = useState<"callout" | "plain" | "sticky">("callout");
  // Default ink: the text colour — light on a dark canvas, dark on a light one.
  const [drawColor, setDrawColor] = useState(DRAW_COLORS[0]);
  const [noteColor, setNoteColor] = useState(NOTE_COLORS[0]);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showCanvasSettings, setShowCanvasSettings] = useState(false);
  // Boards saved before the theme setting existed had "light" by default, so
  // their old canvasBg is not a choice: they follow the theme too.
  const [canvasBg, setCanvasBg] = useState<"auto" | "dark" | "light">(saved?.canvasTheme ?? "auto");
  const appTheme = useAppTheme();
  const effectiveBg: "dark" | "light" = canvasBg === "auto" ? appTheme : canvasBg;
  const [zoomPct, setZoomPct] = useState(() => Math.round((saved?.camera?.zoom ?? 1) * 100));
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [showGrid, setShowGrid] = useState(saved?.showGrid ?? false);
  const [undoSnapshot, setUndoSnapshot] = useState<{ notes: StickyNote[]; lines: Line[]; images: CanvasImage[]; texts: TextElement[]; arrows: Arrow[]; boxes: Box[] } | null>(null);
  const redoStackRef = useRef<Snapshot[]>([]);
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
  const escapeHandledRef = useRef(0);
  const setEditText = useCallback((v: string) => { _setEditText(v); editTextRef.current = v; }, []);
  const editInputRef = useRef<HTMLTextAreaElement>(null);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; noteId: string } | null>(null);

  // Redraw flag
  const needsRedrawRef = useRef(true);
  const canvasBgRef = useRef(effectiveBg);
  canvasBgRef.current = effectiveBg;
  const canvasThemeRef = useRef(canvasBg);
  canvasThemeRef.current = canvasBg;
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
  const boardShapes = useCallback((): BoardShapes => ({
    notes: notesRef.current, boxes: boxesRef.current, images: imagesRef.current, texts: textsRef.current,
    arrows: arrowsRef.current, lines: linesRef.current,
  }), []);
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
    const bgMode = canvasBgRef.current;
    const isDark = bgMode === "dark";
    const ink = (c: string) => inkFor(c, bgMode);
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
      ctx.strokeStyle = ink(line.color);
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
      ctx.strokeStyle = ink(drawColor);
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
        // Whiteboard images are embedded data: URLs; a web address (synced or
        // imported board data) is never loaded (remote images, ARCH B-6).
        if (!isRemoteSrc(img.dataUrl)) htmlImg.src = img.dataUrl;
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
      ctx.strokeStyle = ink(box.color);
      ctx.lineWidth = 2;
      ctx.strokeRect(box.x, box.y, box.width, box.height);
    }

    // Draw in-progress box
    if (boxDrawRef.current.active) {
      ctx.strokeStyle = ink(drawColor);
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(boxDrawRef.current.x, boxDrawRef.current.y, boxDrawRef.current.w, boxDrawRef.current.h);
      ctx.setLineDash([]);
    }

    // Draw arrows
    for (const arrow of arrowsRef.current) {
      drawArrow(ctx, arrow.x1, arrow.y1, arrow.x2, arrow.y2, ink(arrow.color));
    }

    // Draw in-progress arrow (and the shape its end will attach to)
    if (arrowDrawRef.current.active) {
      const a = arrowDrawRef.current;
      drawArrow(ctx, a.x1, a.y1, a.x2, a.y2, ink(drawColor));
    }
    const target = arrowTargetRef.current ? shapeRect(boardShapes(), arrowTargetRef.current) : null;
    if (target) {
      ctx.strokeStyle = isDark ? "#89b4fa" : "#1e66f5";
      ctx.lineWidth = 2 / cam.zoom;
      ctx.setLineDash([3 / cam.zoom, 3 / cam.zoom]);
      ctx.strokeRect(target.x - 4, target.y - 4, target.w + 8, target.h + 8);
      ctx.setLineDash([]);
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
        const style = calloutFor(te.color, bgMode);

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
        ctx.fillStyle = ink(te.color);
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

    // Multi-selection: a box around each member
    const accent = isDark ? "#89b4fa" : "#1e66f5";
    for (const m of multiSelRef.current) {
      const r = shapeRect(boardShapes(), m);
      if (!r) continue;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5 / cam.zoom;
      ctx.setLineDash([4 / cam.zoom, 4 / cam.zoom]);
      ctx.strokeRect(r.x - 3, r.y - 3, r.w + 6, r.h + 6);
      ctx.setLineDash([]);
    }
    // Alignment guides
    const guides = guidesRef.current;
    if (guides) {
      ctx.strokeStyle = isDark ? "#f38ba8" : "#d20f39";
      ctx.lineWidth = 1 / cam.zoom;
      const left = -cam.x / cam.zoom, top = -cam.y / cam.zoom;
      const right = (w - cam.x) / cam.zoom, bottom = (h - cam.y) / cam.zoom;
      ctx.beginPath();
      for (const gx of guides.x) { ctx.moveTo(gx, top); ctx.lineTo(gx, bottom); }
      for (const gy of guides.y) { ctx.moveTo(left, gy); ctx.lineTo(right, gy); }
      ctx.stroke();
    }
    // Rubber band
    const mq = marqueeRef.current;
    if (mq) {
      const r = normRect(mq.x0, mq.y0, mq.x1, mq.y1);
      ctx.fillStyle = isDark ? "rgba(137,180,250,0.08)" : "rgba(30,102,245,0.08)";
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1 / cam.zoom;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
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
        const line = linesRef.current.find((l, i) => lineKey(l, i) === sel.id);
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
        ctx.strokeStyle = isDark ? "#89b4fa" : "#1e66f5";
        ctx.lineWidth = 1.5 / cam.zoom;
        ctx.setLineDash([4 / cam.zoom, 4 / cam.zoom]);
        ctx.strokeRect(sx - 3, sy - 3, sw + 6, sh + 6);
        ctx.setLineDash([]);
      }
    }

    ctx.restore();
  }, [drawColor, boardShapes]);

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

  // The board takes the keyboard while it is open: typed keys (tool shortcuts,
  // Delete, Ctrl+Z…) must never reach the page editor hidden underneath.
  useEffect(() => {
    containerRef.current?.focus({ preventScroll: true });
  }, []);

  // Mark redraw needed when state changes
  useEffect(() => {
    requestRedraw();
  }, [notes, lines, texts, arrows, boxes, images, selectedElement, multiSel, effectiveBg, requestRedraw]);

  // Connectors follow their shapes: whenever a shape moves, resizes or goes,
  // attached arrow ends are put back on its border (or released).
  useEffect(() => {
    setArrows((prev) => {
      const b = { notes, boxes, images, texts, arrows: prev, lines };
      return reattachArrows(dropDanglingAttachments(prev, b), b);
    });
  }, [notes, boxes, images, texts, lines]);

  // ── Persistence: dirty flag + debounced save to the DB ──
  // Saves only happen when something actually changed (content, canvas
  // settings, or camera), debounced SAVE_DEBOUNCE_MS after the last change,
  // and are flushed on close/unmount. Saves are serialized so an older
  // snapshot can never overwrite a newer one.
  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const [saveError, setSaveError] = useState<string | null>(null);

  const flushSave = useCallback((): Promise<void> => {
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (!dirtyRef.current) return saveChainRef.current;
    dirtyRef.current = false;
    const data: WhiteboardData = {
      notes: notesRef.current,
      lines: linesRef.current,
      images: imagesRef.current,
      texts: textsRef.current,
      arrows: arrowsRef.current,
      boxes: boxesRef.current,
      camera: { ...cameraRef.current },
      nextNoteId: nextNoteIdRef.current,
      canvasBg: canvasBgRef.current,
      canvasTheme: canvasThemeRef.current,
      showGrid: showGridRef.current,
    };
    saveChainRef.current = saveChainRef.current
      .then(() => persistWhiteboard(whiteboardId, data))
      .then(
        () => setSaveError(null),
        (e) => {
          // Keep the dirty flag so the next change/close retries the save.
          dirtyRef.current = true;
          const msg = `Whiteboard not saved: ${e?.message ?? String(e)}`;
          console.error(msg, e);
          setSaveError(msg);
          showToast(msg, 8000);
        },
      );
    return saveChainRef.current;
  }, [whiteboardId]);

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => { void flushSave(); }, SAVE_DEBOUNCE_MS);
  }, [flushSave]);

  // Kept for call sites that signal "an interaction finished". Content changes
  // are detected automatically below; this only covers camera-only changes.
  const saveNow = markDirty;

  // Flush pending changes on unmount.
  useEffect(() => () => { void flushSave(); }, [flushSave]);

  // Save barrier (notebook switch): save now, and fail the barrier if it didn't
  // stick — switching anyway would send the retry to the other notebook.
  useEffect(() => registerFlush(async () => {
    await flushSave();
    if (dirtyRef.current) throw new Error("the whiteboard couldn't be saved");
  }), [flushSave]);

  // ── Undo / redo: bounded snapshot history covering all element types ──
  const undoStackRef = useRef<Snapshot[]>([]);
  const prevSnapRef = useRef<Snapshot>({ notes, lines, images, texts, arrows, boxes });
  const prevSettingsRef = useRef({ canvasBg, showGrid });
  const lastChangeAtRef = useRef(0);
  const applyingHistoryRef = useRef(false);

  // Detect changes → history entry + dirty flag. Rapid successive changes
  // (e.g. every frame of a drag) coalesce into one undo entry.
  useEffect(() => {
    const cur: Snapshot = { notes, lines, images, texts, arrows, boxes };
    const prev = prevSnapRef.current;
    const contentChanged = (Object.keys(cur) as (keyof Snapshot)[]).some((k) => cur[k] !== prev[k]);
    const settingsChanged = prevSettingsRef.current.canvasBg !== canvasBg || prevSettingsRef.current.showGrid !== showGrid;
    if (contentChanged) {
      if (applyingHistoryRef.current) {
        applyingHistoryRef.current = false;
        lastChangeAtRef.current = 0;
      } else {
        const now = Date.now();
        if (now - lastChangeAtRef.current > 400) {
          undoStackRef.current.push(prev);
          if (undoStackRef.current.length > MAX_UNDO) undoStackRef.current.shift();
        }
        redoStackRef.current = [];
        lastChangeAtRef.current = now;
      }
      prevSnapRef.current = cur;
      setCanUndo(undoStackRef.current.length > 0);
      setCanRedo(redoStackRef.current.length > 0);
    }
    prevSettingsRef.current = { canvasBg, showGrid };
    if (contentChanged || settingsChanged) markDirty();
  }, [notes, lines, images, texts, arrows, boxes, canvasBg, showGrid, markDirty]);

  const applySnapshot = useCallback((s: Snapshot) => {
    const cur = prevSnapRef.current;
    if ((Object.keys(s) as (keyof Snapshot)[]).every((k) => s[k] === cur[k])) return;
    applyingHistoryRef.current = true;
    setNotes(s.notes); setLines(s.lines); setImages(s.images);
    setTexts(s.texts); setArrows(s.arrows); setBoxes(s.boxes);
    setSelectedElement(null);
  }, []);

  const undo = useCallback(() => {
    const snap = undoStackRef.current.pop();
    if (!snap) return;
    redoStackRef.current.push(prevSnapRef.current);
    if (redoStackRef.current.length > MAX_UNDO) redoStackRef.current.shift();
    applySnapshot(snap);
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(true);
  }, [applySnapshot]);

  const redo = useCallback(() => {
    const snap = redoStackRef.current.pop();
    if (!snap) return;
    undoStackRef.current.push(prevSnapRef.current);
    if (undoStackRef.current.length > MAX_UNDO) undoStackRef.current.shift();
    applySnapshot(snap);
    setCanUndo(true);
    setCanRedo(redoStackRef.current.length > 0);
  }, [applySnapshot]);

  // ── Drag coalescing: apply at most one position update per animation frame ──
  const pendingDragRef = useRef<{ nx: number; ny: number } | null>(null);
  const dragRafRef = useRef<number | null>(null);

  const applyPendingDrag = useCallback(() => {
    dragRafRef.current = null;
    const pending = pendingDragRef.current;
    const drag = draggingElementRef.current;
    pendingDragRef.current = null;
    if (!pending || !drag) return;
    let { nx, ny } = pending;
    const id = drag.id;
    // Alignment guides: snap a dragged shape to the other shapes' edges / centres.
    if (drag.type === "note" || drag.type === "box" || drag.type === "image" || drag.type === "text") {
      const b = boardShapes();
      const r = shapeRect(b, { type: drag.type, id });
      if (r) {
        // A text's box starts `pad` before its anchor point.
        const te = drag.type === "text" ? textsRef.current.find((t) => t.id === id) : undefined;
        const offX = te ? te.x - r.x : 0;
        const offY = te ? te.y - r.y : 0;
        const moving: Rect = { x: nx - offX, y: ny - offY, w: r.w, h: r.h };
        const others = (["note", "box", "image", "text"] as const).flatMap((t) =>
          (t === "note" ? b.notes : t === "box" ? b.boxes : t === "image" ? b.images : b.texts)
            .filter((e) => !(t === drag.type && e.id === id))
            .map((e) => shapeRect(b, { type: t, id: e.id }))
            .filter((x): x is Rect => !!x));
        const snap = snapToGuides(moving, others, 6 / cameraRef.current.zoom);
        nx += snap.dx; ny += snap.dy;
        guidesRef.current = snap.guides.x.length || snap.guides.y.length ? snap.guides : null;
      }
    }
    if (drag.type === "note") {
      setNotes((prev) => prev.map((n) => n.id === id ? { ...n, x: nx, y: ny } : n));
    } else if (drag.type === "text") {
      setTexts((prev) => prev.map((t) => t.id === id ? { ...t, x: nx, y: ny } : t));
    } else if (drag.type === "box") {
      setBoxes((prev) => prev.map((b) => b.id === id ? { ...b, x: nx, y: ny } : b));
    } else if (drag.type === "image") {
      setImages((prev) => prev.map((img) => img.id === id ? { ...img, x: nx, y: ny } : img));
    } else if (drag.type === "arrow") {
      // Move entire arrow so its top-left corner lands at (nx, ny)
      setArrows((prev) => prev.map((a) => {
        if (a.id !== id) return a;
        const dx = nx - Math.min(a.x1, a.x2);
        const dy = ny - Math.min(a.y1, a.y2);
        // Moved by hand: the arrow lets go of its shapes.
        return { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy, from: null, to: null };
      }));
    } else if (drag.type === "line") {
      setLines((prev) => prev.map((l, i) => {
        if (lineKey(l, i) !== id) return l;
        let minX = Infinity, minY = Infinity;
        for (const pt of l.points) { minX = Math.min(minX, pt.x); minY = Math.min(minY, pt.y); }
        const dx = nx - minX, dy = ny - minY;
        return { ...l, points: l.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
      }));
    }
    requestRedraw();
  }, [requestRedraw, boardShapes]);

  const queueDrag = useCallback((world: { x: number; y: number }) => {
    const drag = draggingElementRef.current;
    if (!drag) return;
    pendingDragRef.current = { nx: world.x - drag.offsetX, ny: world.y - drag.offsetY };
    if (dragRafRef.current === null) dragRafRef.current = requestAnimationFrame(applyPendingDrag);
  }, [applyPendingDrag]);

  /** Apply any queued drag position immediately (used on drag end). */
  const flushDrag = useCallback(() => {
    if (dragRafRef.current !== null) {
      cancelAnimationFrame(dragRafRef.current);
      applyPendingDrag();
    }
  }, [applyPendingDrag]);

  useEffect(() => () => { if (dragRafRef.current !== null) cancelAnimationFrame(dragRafRef.current); }, []);

  /** Move every member of `members` by (dx, dy) from their positions in `base`. */
  const applyGroupOffset = useCallback((members: Sel[], base: Snapshot, dx: number, dy: number) => {
    const has = (t: string) => new Set(members.filter((m) => m.type === t).map((m) => m.id));
    const ns = has("note"), ts = has("text"), bs = has("box"), is = has("image"), as = has("arrow"), ls = has("line");
    if (ns.size) setNotes(base.notes.map((n) => ns.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n));
    if (ts.size) setTexts(base.texts.map((t) => ts.has(t.id) ? { ...t, x: t.x + dx, y: t.y + dy } : t));
    if (bs.size) setBoxes(base.boxes.map((b) => bs.has(b.id) ? { ...b, x: b.x + dx, y: b.y + dy } : b));
    if (is.size) setImages(base.images.map((b) => is.has(b.id) ? { ...b, x: b.x + dx, y: b.y + dy } : b));
    if (as.size) setArrows(base.arrows.map((a) => as.has(a.id) ? { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy } : a));
    if (ls.size) setLines(base.lines.map((l, i) => ls.has(lineKey(l, i)) ? { ...l, points: l.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) } : l));
  }, []);

  /** Group drag to world point (x, y), snapped to the shapes outside the group. */
  const moveGroupTo = useCallback((x: number, y: number) => {
    const g = groupDragRef.current;
    if (!g) return;
    let dx = x - g.startX, dy = y - g.startY;
    if (!g.moved && Math.hypot(dx, dy) * cameraRef.current.zoom < 3) return;
    g.moved = true;
    const baseBoard: BoardShapes = { ...g.base };
    const inGroup = new Set(g.members.map(selKey));
    const rects = g.members.map((m) => shapeRect(baseBoard, m)).filter((r): r is Rect => !!r);
    const box = unionRect(rects);
    if (box) {
      const others = (["note", "box", "image", "text"] as const).flatMap((t) =>
        (t === "note" ? baseBoard.notes : t === "box" ? baseBoard.boxes : t === "image" ? baseBoard.images : baseBoard.texts)
          .filter((e) => !inGroup.has(`${t}:${e.id}`))
          .map((e) => shapeRect(baseBoard, { type: t, id: e.id }))
          .filter((r): r is Rect => !!r));
      const snap = snapToGuides({ ...box, x: box.x + dx, y: box.y + dy }, others, 6 / cameraRef.current.zoom);
      dx += snap.dx; dy += snap.dy;
      guidesRef.current = snap.guides.x.length || snap.guides.y.length ? snap.guides : null;
    }
    applyGroupOffset(g.members, g.base, dx, dy);
    requestRedraw();
  }, [applyGroupOffset, requestRedraw]);

  /** Select a set of elements: one → the single selection, 2+ → the group. */
  const selectSet = useCallback((list: Sel[]) => {
    const uniq = [...new Map(list.map((e) => [selKey(e), e])).values()];
    if (uniq.length <= 1) { setMultiSel([]); setSelectedElement(uniq[0] ?? null); }
    else { setSelectedElement(null); setMultiSel(uniq); }
  }, []);

  const snapshotNow = (): Snapshot => ({
    notes: notesRef.current, lines: linesRef.current, images: imagesRef.current,
    texts: textsRef.current, arrows: arrowsRef.current, boxes: boxesRef.current,
  });

  /** A new arrow; an end drawn on a shape is attached to it and placed on its border. */
  const makeArrow = useCallback((a: { x1: number; y1: number; x2: number; y2: number }, color: string): Arrow => {
    const b = boardShapes();
    let from = shapeAt(b, a.x1, a.y1);
    let to = shapeAt(b, a.x2, a.y2);
    if (from && to && selKey(from) === selKey(to)) { from = null; to = null; } // within one shape: a plain arrow
    const arrow: Arrow = { id: "arr-" + Date.now(), x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, color, from, to };
    return from || to ? { ...arrow, ...connectorEnds(arrow, b) } : arrow;
  }, [boardShapes]);

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
        const current: Sel[] = multiSelRef.current.length ? multiSelRef.current : selectedElementRef.current ? [selectedElementRef.current] : [];
        if (hit && e.shiftKey) {
          // Shift+click adds to / removes from the selection.
          const k = selKey(hit);
          const next = current.some((c) => selKey(c) === k) ? current.filter((c) => selKey(c) !== k) : [...current, { type: hit.type, id: hit.id }];
          selectSet(next);
          return;
        }
        if (hit && multiSelRef.current.some((m) => selKey(m) === selKey(hit))) {
          // Pressing on a member of the group drags the whole group.
          groupDragRef.current = { startX: world.x, startY: world.y, base: snapshotNow(), members: multiSelRef.current, moved: false };
          return;
        }
        if (hit) {
          setMultiSel([]);
          setSelectedElement({ type: hit.type, id: hit.id });
          draggingElementRef.current = { type: hit.type, id: hit.id, offsetX: world.x - hit.x, offsetY: world.y - hit.y };
          return;
        }
        // Empty space: a rubber band (Shift adds to the selection); a plain click deselects.
        marqueeRef.current = { x0: world.x, y0: world.y, x1: world.x, y1: world.y, additive: e.shiftKey };
        if (!e.shiftKey) { setSelectedElement(null); setMultiSel([]); }
      }
    },
    [mode, screenToWorld, findNoteAt, findElementAt, textStyle, textSize, drawColor, noteColor, selectSet]
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
        arrowTargetRef.current = shapeAt(boardShapes(), world.x, world.y);
        requestRedraw();
        return;
      }
      if (mode === "arrow") {
        // Before pressing: show which shape the arrow would start on.
        const world = screenToWorld(sx, sy);
        const t = shapeAt(boardShapes(), world.x, world.y);
        if ((t && selKey(t)) !== (arrowTargetRef.current && selKey(arrowTargetRef.current))) { arrowTargetRef.current = t; requestRedraw(); }
      }

      // Box drawing
      if (boxDrawRef.current.active) {
        const world = screenToWorld(sx, sy);
        boxDrawRef.current.w = world.x - boxDrawRef.current.x;
        boxDrawRef.current.h = world.y - boxDrawRef.current.y;
        requestRedraw();
        return;
      }

      // Rubber band
      if (marqueeRef.current) {
        const world = screenToWorld(sx, sy);
        marqueeRef.current.x1 = world.x;
        marqueeRef.current.y1 = world.y;
        requestRedraw();
        return;
      }

      // Group drag
      if (groupDragRef.current) {
        const world = screenToWorld(sx, sy);
        moveGroupTo(world.x, world.y);
        return;
      }

      // Dragging any element — coalesced to one state update per frame
      if (draggingElementRef.current) {
        queueDrag(screenToWorld(sx, sy));
      }
    },
    [screenToWorld, requestRedraw, queueDrag, mode, boardShapes, moveGroupTo]
  );

  const handleMouseUp = useCallback(
    (_e: React.MouseEvent<HTMLCanvasElement>) => {
      let changed = false;

      // End pan
      if (panningRef.current.active) {
        panningRef.current.active = false;
        if (cameraRef.current.x !== panningRef.current.camStartX || cameraRef.current.y !== panningRef.current.camStartY) changed = true;
      }

      // End draw
      if (drawingRef.current.active) {
        const pts = drawingRef.current.points;
        if (pts.length >= 2) {
          setLines((prev) => [...prev, { id: "line-" + Date.now(), points: [...pts], color: drawColor, width: 2 }]);
          changed = true;
        }
        drawingRef.current = { active: false, points: [] };
      }

      // End arrow — an end drawn on a shape attaches to it (a connector)
      if (arrowDrawRef.current.active) {
        const a = arrowDrawRef.current;
        const dist = Math.sqrt((a.x2 - a.x1) ** 2 + (a.y2 - a.y1) ** 2);
        if (dist > 10) {
          setArrows((prev) => [...prev, makeArrow(a, drawColor)]);
          changed = true;
        }
        arrowDrawRef.current = { active: false, x1: 0, y1: 0, x2: 0, y2: 0 };
        arrowTargetRef.current = null;
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
        flushDrag();
        draggingElementRef.current = null;
        changed = true;
      }

      // End rubber band: select what it covers
      const mq = marqueeRef.current;
      if (mq) {
        marqueeRef.current = null;
        const r = normRect(mq.x0, mq.y0, mq.x1, mq.y1);
        if (r.w * cameraRef.current.zoom > 3 || r.h * cameraRef.current.zoom > 3) {
          const found = elementsInRect(boardShapes(), r) as Sel[];
          const before: Sel[] = mq.additive ? (multiSelRef.current.length ? multiSelRef.current : selectedElementRef.current ? [selectedElementRef.current] : []) : [];
          selectSet([...before, ...found]);
        }
        requestRedraw();
      }

      // End group drag
      if (groupDragRef.current) {
        if (groupDragRef.current.moved) changed = true;
        groupDragRef.current = null;
      }
      if (guidesRef.current) { guidesRef.current = null; requestRedraw(); }

      // Auto-save after every interaction
      if (changed) setTimeout(saveNow, 50);
    },
    [drawColor, saveNow, flushDrag, boardShapes, selectSet, requestRedraw, makeArrow]
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
        queueDrag(screenToWorld(sx, sy));
      }
    },
    [screenToWorld, requestRedraw, getTouchPos, queueDrag]
  );

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      let changed = false;

      if (panningRef.current.active) {
        panningRef.current.active = false;
        if (cameraRef.current.x !== panningRef.current.camStartX || cameraRef.current.y !== panningRef.current.camStartY) changed = true;
      }

      if (drawingRef.current.active) {
        const pts = drawingRef.current.points;
        if (pts.length >= 2) {
          setLines((prev) => [...prev, { id: "line-" + Date.now(), points: [...pts], color: drawColor, width: 2 }]);
          changed = true;
        }
        drawingRef.current = { active: false, points: [] };
      }

      if (arrowDrawRef.current.active) {
        const a = arrowDrawRef.current;
        const dist = Math.sqrt((a.x2 - a.x1) ** 2 + (a.y2 - a.y1) ** 2);
        if (dist > 10) {
          setArrows((prev) => [...prev, makeArrow(a, drawColor)]);
          changed = true;
        }
        arrowDrawRef.current = { active: false, x1: 0, y1: 0, x2: 0, y2: 0 };
        arrowTargetRef.current = null;
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
        flushDrag();
        draggingElementRef.current = null;
        changed = true;
      }
      guidesRef.current = null;

      if (changed) setTimeout(saveNow, 50);
    },
    [drawColor, saveNow, flushDrag, makeArrow]
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
      setZoomPct(Math.round(newZoom * 100));

      requestRedraw();
      markDirty(); // camera is persisted; debounced
    },
    [requestRedraw, markDirty]
  );

  /** Zoom buttons: zoom to `z` around the middle of the canvas. */
  const zoomTo = useCallback((z: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cam = cameraRef.current;
    const newZoom = Math.max(0.1, Math.min(5, z));
    const mx = canvas.width / 2, my = canvas.height / 2;
    cam.x = mx - (mx - cam.x) * (newZoom / cam.zoom);
    cam.y = my - (my - cam.y) * (newZoom / cam.zoom);
    cam.zoom = newZoom;
    setZoomPct(Math.round(newZoom * 100));
    requestRedraw();
    markDirty();
  }, [requestRedraw, markDirty]);

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
      else { markDirty(); setZoomPct(Math.round(targetZoom * 100)); }
    }
    requestAnimationFrame(tick);
  }, [requestRedraw, markDirty]);

  const handleClose = useCallback(() => {
    // Flush any pending edit, then close. The save continues in the
    // background; on failure a toast is shown (the unmount flush retries).
    void flushSave();
    const hasContent = notesRef.current.length > 0 || linesRef.current.length > 0 || imagesRef.current.length > 0 || textsRef.current.length > 0 || arrowsRef.current.length > 0 || boxesRef.current.length > 0;
    onClose(hasContent);
  }, [flushSave, onClose]);

  // Exports go through the save dialog (desktop) with a toast naming the file
  // (lib/exportFile); an encrypted notebook is asked first.
  const exportPng = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
    if (!blob) { showToast("Whiteboard PNG export failed: the canvas could not be read", 8000); return; }
    await saveExport(`whiteboard-${whiteboardId}.png`, blob, "Whiteboard PNG", "image/png");
  }, [whiteboardId]);

  const exportSvg = useCallback(async () => {
    const svg = boardToSvg(
      { notes: notesRef.current, lines: linesRef.current, images: imagesRef.current, texts: textsRef.current, arrows: arrowsRef.current, boxes: boxesRef.current },
      { background: canvasBgRef.current === "dark" ? "#1e1e2e" : "#eff1f5", ink: (c) => inkFor(c, canvasBgRef.current), callout: (c) => calloutFor(c, canvasBgRef.current) },
    );
    if (!svg) { showToast("The whiteboard is empty — nothing to export"); return; }
    await saveExport(`whiteboard-${whiteboardId}.svg`, new Blob([svg], { type: "image/svg+xml" }), "Whiteboard SVG", "image/svg+xml");
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
    requestRedraw();
    // Auto-dismiss undo after 5 seconds (Ctrl+Z also restores via the undo history)
    setTimeout(() => setUndoSnapshot(null), 5000);
  }, [requestRedraw]);

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
      if (isForeignEditable(e.target, containerRef.current)) return;
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
      if (isForeignEditable(e.target, containerRef.current)) return;
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
      // Typing into an input outside the whiteboard (search, command palette…)
      // must not switch tools, delete elements, or close the board.
      if (isForeignEditable(e.target, containerRef.current)) return;
      // A dialog, menu or panel over the board gets the keys (and Esc).
      if (coveredAbove("canvas")) return;
      if (e.key === "Escape") {
        e.preventDefault(); // handled here — views underneath must not close too
        // If a textarea recently handled Escape (within 500ms), skip
        // WebKitGTK has different event timing than Chrome — need wider window
        if (Date.now() - escapeHandledRef.current < 500) {
          return;
        }
        if (editingNoteRef.current) {
          finishEdit();
        } else if (editingTextIdRef.current) {
          finishTextEdit();
        } else if (contextMenu) {
          setContextMenu(null);
        } else if (multiSel.length) {
          setMultiSel([]);
        } else if (selectedElement) {
          setSelectedElement(null);
        } else if (mode !== "select") {
          // Escape from a tool mode → go back to select, don't close whiteboard
          setMode("select");
        } else {
          handleClose();
        }
        return;
      }
      // Quick mode switch (only when not editing)
      if (!editingNote && !editingTextId && !e.ctrlKey && !e.metaKey && !e.altKey) {
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
      // Group: arrow keys move it, Delete removes it
      if (multiSel.length && !editingNote && !editingTextId) {
        if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          applyGroupOffset(multiSel, snapshotNow(), e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0, e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0);
          setTimeout(saveNow, 200);
          return;
        }
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          const gone = new Set(multiSel.map(selKey));
          setNotes((prev) => prev.filter((n) => !gone.has(`note:${n.id}`)));
          setTexts((prev) => prev.filter((t) => !gone.has(`text:${t.id}`)));
          setArrows((prev) => prev.filter((a) => !gone.has(`arrow:${a.id}`)));
          setBoxes((prev) => prev.filter((b) => !gone.has(`box:${b.id}`)));
          setImages((prev) => prev.filter((i) => !gone.has(`image:${i.id}`)));
          setLines((prev) => prev.filter((l, i) => !gone.has(`line:${lineKey(l, i)}`)));
          setMultiSel([]);
          setTimeout(saveNow, 50);
          return;
        }
      }
      // Ctrl+A selects everything on the board
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && !editingNote && !editingTextId) {
        e.preventDefault();
        const all = elementsInRect(boardShapes(), { x: -1e9, y: -1e9, w: 2e9, h: 2e9 }) as Sel[];
        selectSet(all);
        return;
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
        else if (type === "arrow") setArrows((prev) => prev.map((a) => a.id === id ? { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy, from: null, to: null } : a));
        else if (type === "line") {
          setLines((prev) => prev.map((l, i) => lineKey(l, i) === id ? { ...l, points: l.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) } : l));
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
        else if (type === "line") setLines((prev) => prev.filter((l, idx) => lineKey(l, idx) !== id));
        setSelectedElement(null);
        setTimeout(saveNow, 50);
      }
      // Ctrl+Z — undo (strokes, notes, texts, arrows, boxes, images: add/delete/move/clear)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey && !editingNote && !editingTextId) {
        e.preventDefault();
        undo();
      }
      // Ctrl+Shift+Z / Ctrl+Y — redo
      if ((e.ctrlKey || e.metaKey) && ((e.key.toLowerCase() === "z" && e.shiftKey) || e.key.toLowerCase() === "y") && !editingNote && !editingTextId) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleClose, editingNote, editingTextId, finishEdit, contextMenu, saveNow, selectedElement, multiSel, mode, undo, redo, applyGroupOffset, boardShapes, selectSet]);

  // For tests and tooling: the board's elements and selection.
  useEffect(() => {
    const el = containerRef.current as unknown as { __minotesBoard?: unknown } | null;
    if (!el) return;
    el.__minotesBoard = {
      data: () => ({ ...boardShapes() }),
      history: () => undoStackRef.current.map((s) => `${s.boxes.length}/${s.arrows.length}`),
      selection: () => (multiSelRef.current.length ? multiSelRef.current : selectedElementRef.current ? [selectedElementRef.current] : []).map(selKey),
      toScreen: (x: number, y: number) => {
        const r = canvasRef.current!.getBoundingClientRect();
        const cam = cameraRef.current;
        return { x: r.left + x * cam.zoom + cam.x, y: r.top + y * cam.zoom + cam.y };
      },
    };
  }, [boardShapes]);

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
    <div
      className={`whiteboard whiteboard-${effectiveBg}`}
      ref={containerRef}
      tabIndex={-1}
      data-canvas-theme={effectiveBg}
      onKeyDown={(e) => {
        // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y are the board's own: stopped here so
        // the app-wide page undo (a window listener) never runs on the board.
        const k = e.key.toLowerCase();
        if (!(e.ctrlKey || e.metaKey) || (k !== "z" && k !== "y") || editingNote || editingTextId) return;
        if ((e.target as HTMLElement).closest("textarea, input")) return;
        e.preventDefault();
        e.stopPropagation();
        if (k === "z" && !e.shiftKey) undo(); else redo();
      }}
    >
      {/* ── Base toolbar ── */}
      <div className="whiteboard-toolbar">
        <div className="whiteboard-toolbar-group">
          {(["select", "text", "arrow", "box", "draw"] as const).map((m) => (
            <button
              key={m}
              className={`btn btn-sm ${mode === m ? "btn-primary" : ""}`}
              onClick={() => { setMode(m); arrowTargetRef.current = null; requestRedraw(); }}
              title={`${m.charAt(0).toUpperCase() + m.slice(1)} (${m[0].toUpperCase()})`}
            >
              {m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>

        {/* ── Contextual controls per tool ── */}

        {/* Group selection (Select mode) */}
        {mode === "select" && multiSel.length > 1 && (
          <div className="whiteboard-toolbar-group" data-testid="wb-multi">
            <span className="whiteboard-toolbar-label">{multiSel.length} selected</span>
            <button className="btn btn-sm" onClick={() => {
              const gone = new Set(multiSel.map(selKey));
              setNotes((prev) => prev.filter((n) => !gone.has(`note:${n.id}`)));
              setTexts((prev) => prev.filter((t) => !gone.has(`text:${t.id}`)));
              setArrows((prev) => prev.filter((a) => !gone.has(`arrow:${a.id}`)));
              setBoxes((prev) => prev.filter((b) => !gone.has(`box:${b.id}`)));
              setImages((prev) => prev.filter((i) => !gone.has(`image:${i.id}`)));
              setLines((prev) => prev.filter((l, i) => !gone.has(`line:${lineKey(l, i)}`)));
              setMultiSel([]);
              setTimeout(saveNow, 50);
            }} title="Delete the selection (Delete)"><Icon name="trash" size={13} /> Delete</button>
          </div>
        )}

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
                    style={{ background: inkFor(c, effectiveBg) }}
                    onClick={() => {
                      const { type, id } = selectedElement;
                      if (type === "text") setTexts((prev) => prev.map((t) => t.id === id ? { ...t, color: c } : t));
                      else if (type === "arrow") setArrows((prev) => prev.map((a) => a.id === id ? { ...a, color: c } : a));
                      else if (type === "box") setBoxes((prev) => prev.map((b) => b.id === id ? { ...b, color: c } : b));
                      else if (type === "line") setLines((prev) => prev.map((l, i) => lineKey(l, i) === id ? { ...l, color: c } : l));
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
                style={{ background: textStyle === "sticky" && mode === "text" ? c : inkFor(c, effectiveBg) }}
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

        {/* ── Undo / redo and zoom ── */}
        <div className="whiteboard-toolbar-group" style={{ marginLeft: "auto" }}>
          <button className="btn btn-sm" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo">↶</button>
          <button className="btn btn-sm" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">↷</button>
          <span className="whiteboard-toolbar-sep" />
          <button className="btn btn-sm" onClick={() => zoomTo(cameraRef.current.zoom / 1.2)} title="Zoom out" aria-label="Zoom out">−</button>
          <button className="btn btn-sm whiteboard-zoom-pct" onClick={() => zoomTo(1)} title="Reset zoom to 100%" data-testid="whiteboard-zoom">{zoomPct}%</button>
          <button className="btn btn-sm" onClick={() => zoomTo(cameraRef.current.zoom * 1.2)} title="Zoom in" aria-label="Zoom in">+</button>
        </div>

        {/* ── Actions (always visible) ── */}
        <div className="whiteboard-toolbar-group" style={{ position: "relative" }}>
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
              <button onClick={exportPng}>PNG image (visible area)</button>
              <button onClick={exportSvg}>SVG (whole board)</button>
            </div>
          )}
          <button className="btn btn-sm" onClick={clearCanvas} title="Clear">Clear</button>
          <button className="btn btn-sm" onClick={() => { setShowCanvasSettings(v => !v); setShowExportMenu(false); }} title="Canvas settings" aria-label="Canvas settings"><Icon name="settings" size={14} /></button>
          {showCanvasSettings && (
            <div className="wb-popover" onClick={(e) => e.stopPropagation()}>
              <div className="wb-popover-row">
                <span className="wb-popover-label">Background</span>
                <div className="wb-settings-toggle">
                  <button className={canvasBg === "auto" ? "active" : ""} onClick={() => { setCanvasBg("auto"); requestRedraw(); }} title="Follow the app theme">Auto</button>
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
              escapeHandledRef.current = Date.now();
              e.nativeEvent.stopImmediatePropagation();
              finishEdit();
              return;
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
              color: te.callout ? calloutFor(te.color, effectiveBg).text : inkFor(te.color, effectiveBg),
              backgroundColor: te.callout ? calloutFor(te.color, effectiveBg).bg : "transparent",
              borderColor: te.callout ? calloutFor(te.color, effectiveBg).border : "var(--accent)",
              minWidth: 120 * cam.zoom,
              minHeight: fontSize * 1.5 * cam.zoom,
              padding: te.callout ? `${10 * cam.zoom}px` : "2px 4px",
            }}
            value={editingTextValue}
            onChange={(e) => setEditingTextValue(e.target.value)}
            onBlur={finishTextEdit}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                escapeHandledRef.current = Date.now();
                e.nativeEvent.stopImmediatePropagation();
                finishTextEdit();
                return;
              }
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

      {/* Save failure banner — stays visible until a save succeeds */}
      {saveError && (
        <div className="whiteboard-error-banner" role="alert" style={ERROR_BANNER_STYLE}>
          {saveError}{" "}
          <button className="btn btn-sm" onClick={() => { dirtyRef.current = true; void flushSave(); }}>Retry</button>
        </div>
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
