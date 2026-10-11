import type { Node } from "@xyflow/react";
import type { MindMapNodeData } from "./blocksToFlow";

/**
 * Mind map → standalone SVG.
 *
 * React Flow renders nodes as HTML <div>s and only the edges as SVG, so
 * serialising its <svg> loses every label. Instead we rebuild the picture from
 * the layout: edge paths are copied from the rendered edges (they are already
 * in flow coordinates), and each node becomes a <rect> + <text> styled with
 * the node's computed CSS (so theme, depth fading and TODO colours carry over).
 * No <foreignObject>, so the SVG also rasterises to PNG without tainting.
 */

const PAD = 32;

interface Measured {
  x: number; y: number; w: number; h: number;
  bg: string; border: string; borderWidth: number; borderLeft: string; borderLeftWidth: number;
  color: string; fontSize: number; fontWeight: string; fontFamily: string; radius: number; opacity: string;
  lines: string[]; textX: number;
  prefix: { text: string; color: string; x: number } | null;
  badge: { text: string; bg: string; color: string; x: number; w: number } | null;
  strike: boolean;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const px = (v: string, fallback = 0) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(text: string, font: string): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * 7.5;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

/** Wrap `text` into at most `maxLines` lines of `maxWidth`, ellipsizing the last. */
export function wrapLabel(text: string, maxWidth: number, font: string, maxLines = 2): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  const fits = (s: string) => textWidth(s, font) <= maxWidth;
  for (let i = 0; i < words.length; i++) {
    let word = words[i];
    const candidate = cur ? `${cur} ${word}` : word;
    if (fits(candidate)) { cur = candidate; continue; }
    if (cur) { lines.push(cur); cur = ""; }
    // A single word wider than the box: hard-break it.
    while (!fits(word) && word.length > 1) {
      let cut = word.length - 1;
      while (cut > 1 && !fits(word.slice(0, cut))) cut--;
      lines.push(word.slice(0, cut));
      word = word.slice(cut);
    }
    cur = word;
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last.length > 0 && !fits(last + "…")) last = last.slice(0, -1).trimEnd();
  kept[maxLines - 1] = last + "…";
  return kept;
}

function measureNode(node: Node, root: HTMLElement): Measured | null {
  const data = node.data as unknown as MindMapNodeData & { journalDate?: string; displayTitle?: string; isJournal?: boolean };
  const el = root.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(node.id)}"] .mm-node`);
  const w = node.measured?.width ?? el?.offsetWidth ?? 150;
  const h = node.measured?.height ?? el?.offsetHeight ?? 40;
  const cs = el ? getComputedStyle(el) : null;
  const fontSize = cs ? px(cs.fontSize, 13) : 13;
  const fontWeight = cs?.fontWeight ?? "400";
  const fontFamily = cs?.fontFamily ?? "sans-serif";
  const font = `${fontWeight} ${fontSize}px ${fontFamily}`;
  const padX = cs ? px(cs.paddingLeft, 14) : 14;
  // Horizontal offsets come from the rendered layout, unscaled from the zoom.
  const nodeRect = el?.getBoundingClientRect();
  const scale = el && nodeRect && el.offsetWidth ? nodeRect.width / el.offsetWidth : 1;
  const offsetOf = (child: Element) => (child.getBoundingClientRect().left - (nodeRect?.left ?? 0)) / (scale || 1);

  let prefix: Measured["prefix"] = null;
  const checkEl = el?.querySelector<HTMLElement>(".mm-check, .mm-root-icon");
  if (checkEl) prefix = { text: checkEl.textContent ?? "", color: getComputedStyle(checkEl).color, x: offsetOf(checkEl) };

  let badge: Measured["badge"] = null;
  const badgeEl = el?.querySelector<HTMLElement>(".mm-collapse-badge");
  if (badgeEl && data.collapsed) {
    const bcs = getComputedStyle(badgeEl);
    badge = { text: badgeEl.textContent ?? "", bg: bcs.backgroundColor, color: bcs.color, x: offsetOf(badgeEl), w: badgeEl.offsetWidth };
  }

  const label = data.isRoot && data.isJournal
    ? [data.journalDate, data.displayTitle].filter(Boolean).join(" — ")
    : data.label;
  const labelEl = el?.querySelector<HTMLElement>(".mm-label, .mm-root-title-group");
  const reserved = (prefix ? fontSize + 6 : 0) + (badge ? 30 : 0);
  // The label box as laid out (+ a little slack for canvas vs. DOM metrics).
  const maxWidth = labelEl?.offsetWidth ? labelEl.offsetWidth + 2 : Math.max(20, w - padX * 2 - reserved);
  const lines = wrapLabel(label, maxWidth, font);
  const textX = labelEl ? offsetOf(labelEl) : padX + (prefix ? fontSize + 6 : 0);

  return {
    x: node.position.x, y: node.position.y, w, h,
    bg: cs?.backgroundColor ?? "#313244",
    border: cs?.borderTopColor ?? "#45475a",
    borderWidth: cs ? px(cs.borderTopWidth, 1) : 1,
    borderLeft: cs?.borderLeftColor ?? "#45475a",
    borderLeftWidth: cs ? px(cs.borderLeftWidth, 1) : 1,
    color: cs?.color ?? "#cdd6f4",
    fontSize, fontWeight, fontFamily,
    radius: cs ? px(cs.borderTopLeftRadius, 8) : 8,
    opacity: cs?.opacity ?? "1",
    lines, textX, prefix, badge,
    strike: data.todoState === "done",
  };
}

/** Build the SVG markup for the current mind map. `root` is the .mindmap-overlay element. */
export function buildMindMapSvg(nodes: Node[], root: HTMLElement): { svg: string; width: number; height: number } {
  const measured = nodes.map((n) => measureNode(n, root)).filter((m): m is Measured => m !== null);
  if (measured.length === 0) return { svg: "", width: 0, height: 0 };

  const minX = Math.min(...measured.map((m) => m.x)) - PAD;
  const minY = Math.min(...measured.map((m) => m.y)) - PAD;
  const maxX = Math.max(...measured.map((m) => m.x + m.w)) + PAD;
  const maxY = Math.max(...measured.map((m) => m.y + m.h)) + PAD;
  const width = Math.ceil(maxX - minX);
  const height = Math.ceil(maxY - minY);

  const overlayCs = getComputedStyle(root);
  const bg = overlayCs.backgroundColor && overlayCs.backgroundColor !== "rgba(0, 0, 0, 0)"
    ? overlayCs.backgroundColor : "#1e1e2e";

  const parts: string[] = [];
  parts.push(`<rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="${bg}"/>`);

  // Edges: the rendered paths, with their computed stroke.
  for (const path of Array.from(root.querySelectorAll<SVGPathElement>(".react-flow__edge path.react-flow__edge-path"))) {
    const d = path.getAttribute("d");
    if (!d) continue;
    const pcs = getComputedStyle(path);
    const stroke = pcs.stroke && pcs.stroke !== "none" ? pcs.stroke : "rgba(166,173,200,0.5)";
    const sw = px(pcs.strokeWidth, 1.5);
    parts.push(`<path d="${esc(d)}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`);
  }

  for (const m of measured) {
    const g: string[] = [];
    g.push(`<rect x="${m.x}" y="${m.y}" width="${m.w}" height="${m.h}" rx="${m.radius}" ry="${m.radius}" fill="${m.bg}" stroke="${m.border}" stroke-width="${m.borderWidth}"/>`);
    if (m.borderLeftWidth > m.borderWidth + 0.5) {
      g.push(`<rect x="${m.x}" y="${m.y + 1}" width="${m.borderLeftWidth}" height="${m.h - 2}" fill="${m.borderLeft}"/>`);
    }
    const lineH = Math.round(m.fontSize * 1.35);
    const blockH = lineH * m.lines.length;
    const firstBaseline = m.y + (m.h - blockH) / 2 + lineH * 0.75;
    const textX = m.x + m.textX;
    if (m.prefix) {
      g.push(`<text x="${m.x + m.prefix.x}" y="${firstBaseline}" font-size="${m.fontSize - 2}" font-family="${esc(m.fontFamily)}" fill="${m.prefix.color}">${esc(m.prefix.text)}</text>`);
    }
    m.lines.forEach((line, i) => {
      g.push(
        `<text x="${textX}" y="${firstBaseline + i * lineH}" font-size="${m.fontSize}" font-weight="${m.fontWeight}" ` +
        `font-family="${esc(m.fontFamily)}" fill="${m.color}"${m.strike ? ' text-decoration="line-through"' : ""}>${esc(line)}</text>`,
      );
    });
    if (m.badge) {
      const bw = m.badge.w || Math.max(22, m.badge.text.length * 7 + 10);
      const bx = m.x + m.badge.x;
      const by = m.y + m.h / 2 - 8;
      g.push(`<rect x="${bx}" y="${by}" width="${bw}" height="16" rx="8" fill="${m.badge.bg}"/>`);
      g.push(`<text x="${bx + bw / 2}" y="${by + 12}" text-anchor="middle" font-size="10" font-weight="700" font-family="${esc(m.fontFamily)}" fill="${m.badge.color}">${esc(m.badge.text)}</text>`);
    }
    parts.push(`<g opacity="${m.opacity}">${g.join("")}</g>`);
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="${minX} ${minY} ${width} ${height}">${parts.join("")}</svg>`;
  return { svg, width, height };
}

/** Rasterise SVG markup to PNG bytes at `scale`× (crisp on HiDPI). */
export function svgToPng(svg: string, width: number, height: number, scale = 2): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(width * scale);
      canvas.height = Math.ceil(height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("no 2d context")); return; }
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encoding failed"))), "image/png");
    };
    img.onerror = () => reject(new Error("could not render the mind map SVG"));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
}
