// Whiteboard → standalone SVG (Export ▾ → SVG). The whole board, not just the
// viewport, in vector form. Kept out of Whiteboard.tsx (components-only exports).
import { isRemoteSrc } from "./remoteImages";

type Pt = { x: number; y: number };
export interface SvgBoard {
  notes?: Array<{ x: number; y: number; width: number; height: number; text: string; color: string }>;
  lines?: Array<{ points: Pt[]; color: string; width: number }>;
  images?: Array<{ x: number; y: number; width: number; height: number; dataUrl: string }>;
  texts?: Array<{ x: number; y: number; text: string; color: string; size: "S" | "M" | "L"; callout: boolean }>;
  arrows?: Array<{ x1: number; y1: number; x2: number; y2: number; color: string }>;
  boxes?: Array<{ x: number; y: number; width: number; height: number; color: string }>;
}

export interface SvgStyle {
  background: string;
  /** Display colour of a stored colour (the board follows the theme). */
  ink: (color: string) => string;
  callout: (color: string) => { bg: string; text: string; border: string };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n = (v: number) => (Math.round(v * 10) / 10).toString();
export const textFontSize = (size: "S" | "M" | "L") => (size === "S" ? 14 : size === "L" ? 24 : 18);
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

/** Rough text width (no canvas needed): average glyph ≈ 0.55 em. */
const textWidth = (s: string, size: number) => s.length * size * 0.55;

/** The board's bounding box, or null when it is empty. */
export function boardBounds(b: SvgBoard): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
  for (const r of [...(b.notes ?? []), ...(b.boxes ?? []), ...(b.images ?? [])]) { add(r.x, r.y); add(r.x + r.width, r.y + r.height); }
  for (const l of b.lines ?? []) for (const p of l.points) add(p.x, p.y);
  for (const a of b.arrows ?? []) { add(a.x1, a.y1); add(a.x2, a.y2); }
  for (const t of b.texts ?? []) {
    if (!t.text) continue;
    const fs = textFontSize(t.size), rows = t.text.split("\n");
    add(t.x - 10, t.y - 10);
    add(t.x + Math.max(...rows.map((r) => textWidth(r, fs))) + 10, t.y + rows.length * fs * 1.3 + 10);
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

export function boardToSvg(b: SvgBoard, style: SvgStyle, pad = 40): string | null {
  const bb = boardBounds(b);
  if (!bb) return null;
  const x0 = bb.minX - pad, y0 = bb.minY - pad;
  const w = bb.maxX - bb.minX + pad * 2, h = bb.maxY - bb.minY + pad * 2;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${n(w)}" height="${n(h)}" viewBox="${n(x0)} ${n(y0)} ${n(w)} ${n(h)}">`);
  out.push(`<rect x="${n(x0)}" y="${n(y0)}" width="${n(w)}" height="${n(h)}" fill="${style.background}"/>`);
  for (const l of b.lines ?? []) {
    if (l.points.length < 2) continue;
    out.push(`<polyline fill="none" stroke="${esc(style.ink(l.color))}" stroke-width="${n(l.width)}" stroke-linecap="round" stroke-linejoin="round" points="${l.points.map((p) => `${n(p.x)},${n(p.y)}`).join(" ")}"/>`);
  }
  for (const im of b.images ?? []) {
    // Embedded data: images only; a web address is never fetched (remote images).
    if (isRemoteSrc(im.dataUrl) || !im.dataUrl.startsWith("data:image/")) continue;
    out.push(`<image x="${n(im.x)}" y="${n(im.y)}" width="${n(im.width)}" height="${n(im.height)}" href="${esc(im.dataUrl)}"/>`);
  }
  for (const r of b.boxes ?? []) {
    out.push(`<rect x="${n(r.x)}" y="${n(r.y)}" width="${n(r.width)}" height="${n(r.height)}" fill="none" stroke="${esc(style.ink(r.color))}" stroke-width="2"/>`);
  }
  for (const a of b.arrows ?? []) {
    const c = esc(style.ink(a.color));
    const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1), hl = 12;
    const p1 = `${n(a.x2 - hl * Math.cos(ang - Math.PI / 6))},${n(a.y2 - hl * Math.sin(ang - Math.PI / 6))}`;
    const p2 = `${n(a.x2 - hl * Math.cos(ang + Math.PI / 6))},${n(a.y2 - hl * Math.sin(ang + Math.PI / 6))}`;
    out.push(`<line x1="${n(a.x1)}" y1="${n(a.y1)}" x2="${n(a.x2)}" y2="${n(a.y2)}" stroke="${c}" stroke-width="2" stroke-linecap="round"/>`);
    out.push(`<polygon points="${n(a.x2)},${n(a.y2)} ${p1} ${p2}" fill="${c}"/>`);
  }
  for (const t of b.texts ?? []) {
    if (!t.text) continue;
    const fs = textFontSize(t.size), rows = t.text.split("\n"), lh = fs * 1.3;
    let fill = style.ink(t.color);
    if (t.callout) {
      const cs = style.callout(t.color);
      const bw = Math.max(...rows.map((r) => textWidth(r, fs))) + 20;
      out.push(`<rect x="${n(t.x - 10)}" y="${n(t.y - 10)}" width="${n(bw)}" height="${n(rows.length * lh + 20)}" rx="8" fill="${esc(cs.bg)}" stroke="${esc(cs.border)}"/>`);
      fill = cs.text;
    }
    out.push(`<text font-family="${FONT}" font-weight="500" font-size="${fs}" fill="${esc(fill)}">${rows.map((r, i) => `<tspan x="${n(t.x)}" y="${n(t.y + i * lh + fs * 0.85)}">${esc(r)}</tspan>`).join("")}</text>`);
  }
  for (const note of b.notes ?? []) {
    out.push(`<rect x="${n(note.x)}" y="${n(note.y)}" width="${n(note.width)}" height="${n(note.height)}" fill="${esc(note.color)}"/>`);
    out.push(`<rect x="${n(note.x)}" y="${n(note.y)}" width="${n(note.width)}" height="20" fill="rgba(0,0,0,0.1)"/>`);
    const rows = (note.text || "").split("\n");
    out.push(`<text font-family="${FONT}" font-size="13" fill="#1e1e2e">${rows.map((r, i) => `<tspan x="${n(note.x + 8)}" y="${n(note.y + 36 + i * 17)}">${esc(r)}</tspan>`).join("")}</text>`);
  }
  out.push("</svg>");
  return out.join("\n");
}
