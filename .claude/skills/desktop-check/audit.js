// Async function body run inside the desktop app by `desktop.sh audit`.
// Measures UX/accessibility signals on whatever is currently on screen and
// returns them as JSON. Heuristics, not verdicts: each finding names the
// element so a reviewer can look at the screenshot and decide.

const vis = el => {
  const r = el.getBoundingClientRect(), s = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && +s.opacity > 0.05
    && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
};
const name = el => {
  const id = el.id ? "#" + el.id : "";
  const cls = el.className && el.className.toString ? "." + el.className.toString().trim().split(/\s+/).slice(0, 2).join(".") : "";
  const txt = (el.innerText || el.value || "").trim().replace(/\s+/g, " ").slice(0, 30);
  return el.tagName.toLowerCase() + id + (cls === "." ? "" : cls) + (txt ? ` "${txt}"` : "");
};
const rgb = str => { const m = str.match(/[\d.]+/g); return m ? m.map(Number) : null; };
const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const bgOf = el => { // first non-transparent background walking up
  for (let e = el; e; e = e.parentElement) {
    const c = rgb(getComputedStyle(e).backgroundColor);
    if (c && (c.length < 4 || c[3] > 0.5)) return c;
  }
  return [255, 255, 255];
};
const contrast = (fg, bg) => { const a = lum(fg), b = lum(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
const top = (arr, n = 8) => arr.slice(0, n);

const interactive = [...document.querySelectorAll('a,button,input,select,textarea,[role="button"],[onclick],[tabindex]:not([tabindex="-1"])')].filter(vis);

// 1. Controls with no accessible name (icon-only buttons without title/aria-label).
const unlabeled = interactive.filter(el => {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) {
    return !(el.getAttribute("aria-label") || el.placeholder || el.title || (el.id && document.querySelector(`label[for="${el.id}"]`)) || el.closest("label"));
  }
  const text = (el.innerText || "").replace(/[^\p{L}\p{N}]/gu, "");
  return !text && !el.getAttribute("aria-label") && !el.title;
});

// 2. Click targets smaller than 24x24 CSS px (WCAG 2.2 AA minimum).
const small = interactive.filter(el => { const r = el.getBoundingClientRect(); return r.width < 24 || r.height < 24; });

// 3. Low-contrast text (WCAG AA: 4.5, or 3.0 for large text).
const lowContrast = [];
const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
const seenEl = new Set();
for (let n = walker.nextNode(); n; n = walker.nextNode()) {
  const el = n.parentElement;
  if (!el || seenEl.has(el) || !n.textContent.trim() || !vis(el)) continue;
  seenEl.add(el);
  const s = getComputedStyle(el), fg = rgb(s.color);
  if (!fg) continue;
  const size = parseFloat(s.fontSize), bold = parseInt(s.fontWeight) >= 700;
  const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
  const ratio = contrast(fg, bgOf(el));
  if (ratio < need) lowContrast.push({el: name(el), ratio: +ratio.toFixed(2), need, px: size});
}
lowContrast.sort((a, b) => a.ratio - b.ratio);

// 4. Text cut off by its container.
const clipped = [...document.querySelectorAll("body *")].filter(el => {
  if (!vis(el) || el.children.length > 0 || !(el.innerText || "").trim()) return false;
  const s = getComputedStyle(el);
  return (s.overflow !== "visible" || s.textOverflow === "ellipsis") && el.scrollWidth > el.clientWidth + 1;
});

// 5. Consistency: how many distinct font sizes / text colours are on screen.
const sizes = {}, colors = {};
for (const el of seenEl) { const s = getComputedStyle(el); sizes[s.fontSize] = (sizes[s.fontSize] || 0) + 1; colors[s.color] = (colors[s.color] || 0) + 1; }

// 6. Keyboard: focusable controls that show no visible focus style.
let noFocusRing = 0;
for (const el of interactive.slice(0, 40)) {
  const before = getComputedStyle(el).outlineStyle + getComputedStyle(el).boxShadow + getComputedStyle(el).borderColor;
  try { el.focus({preventScroll: true}); } catch { continue; }
  if (document.activeElement !== el) continue;
  const s = getComputedStyle(el);
  if (s.outlineStyle + s.boxShadow + s.borderColor === before && (s.outlineStyle === "none" || parseFloat(s.outlineWidth) === 0)) noFocusRing++;
}
if (document.activeElement && document.activeElement.blur) document.activeElement.blur();

// 7. Layout: horizontal overflow of the page, and empty-looking main area.
const hOverflow = document.documentElement.scrollWidth > innerWidth + 1;
const main = document.querySelector(".content, main, .page-view") || document.body;
const mainText = (main.innerText || "").trim().length;

return {
  view: (window.__MINOTES__ && window.__MINOTES__.getCurrentPage && window.__MINOTES__.getCurrentPage()) || document.title,
  counts: {
    interactive: interactive.length, unlabeled: unlabeled.length, smallTargets: small.length,
    lowContrast: lowContrast.length, clippedText: clipped.length, noFocusRing,
    fontSizes: Object.keys(sizes).length, textColors: Object.keys(colors).length,
  },
  unlabeled: top(unlabeled.map(name)),
  smallTargets: top(small.map(el => { const r = el.getBoundingClientRect(); return `${name(el)} ${Math.round(r.width)}x${Math.round(r.height)}`; })),
  lowContrast: top(lowContrast),
  clippedText: top(clipped.map(name)),
  fontSizes: sizes,
  horizontalOverflow: hOverflow,
  mainAreaTextChars: mainText,
  errors: (window.__dcErrors || []).filter(e => e.kind !== "console.error").length,
};
