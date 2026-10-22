/**
 * The app's UI icon set (UX Wave 3): one consistent line style instead of
 * emoji, which render differently on every platform (and as colour pictures
 * next to monochrome text). 24×24 view box, drawn with `currentColor`
 * strokes — they follow the theme and the text colour around them.
 *
 * Shapes follow the Lucide set (ISC licence, https://lucide.dev), hand-copied
 * as plain path data: no runtime dependency. Render with <Icon name="…" />
 * (components/Icon.tsx); in non-React code use `iconSvg(name)`.
 *
 * Emoji a user picked themselves (page and project icons) are content, not UI,
 * and stay emoji.
 */

/** Path data per icon; `c:x,y,r` entries are circles, `r:x,y,w,h,rx` rects. */
const ICONS = {
  search: ["c:11,11,7", "M21 21l-4.35-4.35"],
  plus: ["M12 5v14", "M5 12h14"],
  x: ["M18 6 6 18", "M6 6l12 12"],
  check: ["M20 6 9 17l-5-5"],
  settings: [
    "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
    "c:12,12,3",
  ],
  calendar: ["r:3,4,18,18,2", "M16 2v4", "M8 2v4", "M3 10h18"],
  graph: ["c:6,6,2.5", "c:18,7,2.5", "c:11,18,2.5", "M8.3 7 15.6 7.1", "M7.2 8.2l2.7 7.5", "M16.4 9.1l-4 7"],
  mindmap: ["r:9,2,6,5,1", "r:2,16,6,5,1", "r:16,16,6,5,1", "M12 7v4", "M5 16v-3h14v3"],
  draw: ["M12 20h9", "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"],
  kanban: ["r:3,3,5,14,1", "r:10,3,5,9,1", "r:17,3,4,18,1"],
  page: ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z", "M14 2v6h6", "M8 13h8", "M8 17h5"],
  pages: ["M15 2H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6z", "M15 2v4h4", "M3 7v13a2 2 0 0 0 2 2h10"],
  "file-plus": ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z", "M14 2v6h6", "M12 12v6", "M9 15h6"],
  folder: ["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"],
  "folder-plus": ["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z", "M12 10v6", "M9 13h6"],
  move: ["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z", "M8 13h8", "M13 10l3 3-3 3"],
  pencil: ["M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z", "M15 5l4 4"],
  copy: ["r:8,8,14,14,2", "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"],
  trash: ["M3 6h18", "M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2", "M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6", "M10 11v6", "M14 11v6"],
  pin: ["M12 17v5", "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"],
  "pin-off": ["M12 17v5", "M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89", "M2 2l20 20", "M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11"],
  archive: ["r:2,3,20,5,1", "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8", "M10 12h4"],
  lock: ["r:3,11,18,11,2", "M7 11V7a5 5 0 0 1 10 0v4"],
  info: ["c:12,12,10", "M12 16v-4", "M12 8h.01"],
  clock: ["c:12,12,10", "M12 6v6l4 2"],
  link: ["M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71", "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"],
  sparkles: ["M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z", "M5 3v4", "M3 5h4", "M19 17v4", "M17 19h4"],
  journal: ["M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20", "M8 7h8"],
  sidebar: ["r:3,3,18,18,2", "M9 3v18"],
  keyboard: ["r:2,5,20,14,2", "M6 9h.01", "M10 9h.01", "M14 9h.01", "M18 9h.01", "M6 13h.01", "M18 13h.01", "M8 16h8"],
  // Visual views (UX Wave 4)
  file: ["M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z", "M14 2v6h6"],
  image: ["r:3,3,18,18,2", "c:9,9,2", "M21 15l-3.09-3.09a2 2 0 0 0-2.82 0L6 21"],
  refresh: ["M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8", "M21 3v5h-5"],
  external: ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
  text: ["M4 7V4h16v3", "M9 20h6", "M12 4v16"],
  folderOpen: ["M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"],
  target: ["c:12,12,10", "c:12,12,6", "c:12,12,2"],
} as const;

export type IconName = keyof typeof ICONS;

export const ICON_NAMES = Object.keys(ICONS) as IconName[];

/** SVG child elements for an icon, as markup (shared by <Icon/> and iconSvg). */
export function iconParts(name: IconName): string {
  return ICONS[name].map((d) => {
    if (d.startsWith("c:")) {
      const [cx, cy, r] = d.slice(2).split(",");
      return `<circle cx="${cx}" cy="${cy}" r="${r}"/>`;
    }
    if (d.startsWith("r:")) {
      const [x, y, w, h, rx] = d.slice(2).split(",");
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/>`;
    }
    return `<path d="${d}"/>`;
  }).join("");
}

/** A whole <svg> string (for DOM code outside React). */
export function iconSvg(name: IconName, size = 16): string {
  return `<svg class="ui-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${iconParts(name)}</svg>`;
}
