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

  // Background
  ctx.fillStyle = "#1e1e2e";
  ctx.fillRect(0, 0, THUMB_W, THUMB_H);

  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_PREFIX + whiteboardId);
  } catch { /* ignore */ }

  if (!raw) {
    ctx.fillStyle = "#45475a";
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

    if (lines.length === 0 && notes.length === 0) {
      ctx.fillStyle = "#45475a";
      ctx.font = "20px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("🎨", THUMB_W / 2, THUMB_H / 2);
      return;
    }

    // Find bounding box
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const line of lines) {
      for (const pt of line.points) {
        minX = Math.min(minX, pt.x);
        minY = Math.min(minY, pt.y);
        maxX = Math.max(maxX, pt.x);
        maxY = Math.max(maxY, pt.y);
      }
    }
    for (const note of notes) {
      minX = Math.min(minX, note.x);
      minY = Math.min(minY, note.y);
      maxX = Math.max(maxX, note.x + (note.width || 150));
      maxY = Math.max(maxY, note.y + (note.height || 100));
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
  } catch {
    ctx.fillStyle = "#45475a";
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
