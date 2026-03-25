import { useEffect, useRef, useState } from "react";

const STORAGE_PREFIX = "minotes-whiteboard-";
const THUMB_W = 80;
const THUMB_H = 52;

interface Props {
  whiteboardId: string;
}

function renderThumbnail(canvas: HTMLCanvasElement, whiteboardId: string) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Background — read from saved data or default to light
  let bgColor = "#eff1f5"; // light default
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + whiteboardId);
    if (raw) {
      const d = JSON.parse(raw);
      if (d.canvasBg === "dark") bgColor = "#1e1e2e";
    }
  } catch { /* ignore */ }
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, THUMB_W, THUMB_H);

  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_PREFIX + whiteboardId);
  } catch { /* ignore */ }

  if (!raw) {
    ctx.fillStyle = "#9ca0b0";
    ctx.font = "20px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("🎨", THUMB_W / 2, THUMB_H / 2);
    return;
  }

  try {
    const data = JSON.parse(raw);
    const lines = data.lines || [];
    const notes = data.notes || [];

    const arrows = data.arrows || [];
    const boxes = data.boxes || [];
    const texts = data.texts || [];
    const images = data.images || [];

    if (lines.length === 0 && notes.length === 0 && arrows.length === 0 && boxes.length === 0 && texts.length === 0 && images.length === 0) {
      ctx.fillStyle = "#9ca0b0";
      ctx.font = "20px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("🎨", THUMB_W / 2, THUMB_H / 2);
      return;
    }

    // Find bounding box of all elements
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const line of lines) {
      for (const pt of line.points) {
        minX = Math.min(minX, pt.x); minY = Math.min(minY, pt.y);
        maxX = Math.max(maxX, pt.x); maxY = Math.max(maxY, pt.y);
      }
    }
    for (const note of notes) {
      minX = Math.min(minX, note.x); minY = Math.min(minY, note.y);
      maxX = Math.max(maxX, note.x + (note.width || 150)); maxY = Math.max(maxY, note.y + (note.height || 100));
    }
    for (const a of arrows) {
      minX = Math.min(minX, a.x1, a.x2); minY = Math.min(minY, a.y1, a.y2);
      maxX = Math.max(maxX, a.x1, a.x2); maxY = Math.max(maxY, a.y1, a.y2);
    }
    for (const b of boxes) {
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height);
    }
    for (const t of texts) {
      if (!t.text) continue;
      minX = Math.min(minX, t.x); minY = Math.min(minY, t.y);
      maxX = Math.max(maxX, t.x + 150); maxY = Math.max(maxY, t.y + 30);
    }
    for (const img of images) {
      minX = Math.min(minX, img.x); minY = Math.min(minY, img.y);
      maxX = Math.max(maxX, img.x + img.width); maxY = Math.max(maxY, img.y + img.height);
    }

    // Scale to fit
    const pad = 4;
    const contentW = maxX - minX || 1;
    const contentH = maxY - minY || 1;
    const scale = Math.min((THUMB_W - pad * 2) / contentW, (THUMB_H - pad * 2) / contentH);
    const offsetX = pad + ((THUMB_W - pad * 2) - contentW * scale) / 2;
    const offsetY = pad + ((THUMB_H - pad * 2) - contentH * scale) / 2;

    const tx = (x: number) => (x - minX) * scale + offsetX;
    const ty = (y: number) => (y - minY) * scale + offsetY;

    // Draw lines
    for (const line of lines) {
      if (line.points.length < 2) continue;
      ctx.strokeStyle = line.color || "#89b4fa";
      ctx.lineWidth = Math.max(1, (line.width || 2) * scale * 0.5);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(tx(line.points[0].x), ty(line.points[0].y));
      for (let i = 1; i < line.points.length; i++) {
        ctx.lineTo(tx(line.points[i].x), ty(line.points[i].y));
      }
      ctx.stroke();
    }

    // Draw notes as small rectangles
    for (const note of notes) {
      ctx.fillStyle = note.color || "#f9e2af";
      ctx.globalAlpha = 0.7;
      ctx.fillRect(
        tx(note.x),
        ty(note.y),
        (note.width || 150) * scale,
        (note.height || 100) * scale
      );
      ctx.globalAlpha = 1;
    }

    // Draw arrows
    for (const a of arrows) {
      ctx.strokeStyle = a.color || "#f38ba8";
      ctx.lineWidth = Math.max(1, scale);
      ctx.beginPath();
      ctx.moveTo(tx(a.x1), ty(a.y1));
      ctx.lineTo(tx(a.x2), ty(a.y2));
      ctx.stroke();
    }

    // Draw boxes
    for (const b of boxes) {
      ctx.strokeStyle = b.color || "#a6e3a1";
      ctx.lineWidth = Math.max(1, scale);
      ctx.strokeRect(tx(b.x), ty(b.y), b.width * scale, b.height * scale);
    }

    // Draw texts as small dots/marks
    for (const t of texts) {
      if (!t.text) continue;
      ctx.fillStyle = t.color || "#cdd6f4";
      ctx.globalAlpha = 0.6;
      ctx.fillRect(tx(t.x), ty(t.y), Math.min(40, 150 * scale), Math.min(6, 20 * scale));
      ctx.globalAlpha = 1;
    }

    // Draw images as filled rectangles
    for (const img of images) {
      ctx.fillStyle = "#89b4fa";
      ctx.globalAlpha = 0.3;
      ctx.fillRect(tx(img.x), ty(img.y), img.width * scale, img.height * scale);
      ctx.globalAlpha = 1;
    }
  } catch {
    ctx.fillStyle = "#9ca0b0";
    ctx.font = "20px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("🎨", THUMB_W / 2, THUMB_H / 2);
  }
}

export default function WhiteboardThumbnail({ whiteboardId }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [, setRefreshCount] = useState(0);

  // Render on mount and when whiteboardId changes
  useEffect(() => {
    if (canvasRef.current) renderThumbnail(canvasRef.current, whiteboardId);
  }, [whiteboardId]);

  // Listen for whiteboard save events to refresh thumbnail
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail === whiteboardId) {
        setRefreshCount(c => c + 1);
        if (canvasRef.current) renderThumbnail(canvasRef.current, whiteboardId);
      }
    };
    window.addEventListener("whiteboard-saved", handler);
    return () => window.removeEventListener("whiteboard-saved", handler);
  }, [whiteboardId]);

  return (
    <canvas
      ref={canvasRef}
      width={THUMB_W}
      height={THUMB_H}
      className="whiteboard-thumbnail"
    />
  );
}
