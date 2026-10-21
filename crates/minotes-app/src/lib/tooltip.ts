/**
 * The app's tooltip (UX Wave 3): one small bubble, drawn by us, for every
 * element with a `title` (or `data-tip`). Native `title` tooltips are drawn by
 * the platform on top of everything — in WebKitGTK they covered open menus
 * ("Page actions (Shift+F10)" hid Rename / Move to…) and dialogs.
 *
 * Rules:
 * - Shown after a short hover delay, hidden on any click, key, scroll or wheel.
 * - Never shown while a menu, popover or dialog is open, unless the element is
 *   inside that menu/popover/dialog; never placed over an open menu/popover.
 * - Placed below (or above) the element, away from the pointer, inside the window.
 * - Keep writing `title=` (and `aria-label` on icon buttons): the `title` is
 *   only lifted off the element while the pointer is over it (so the platform
 *   doesn't draw its own) and put back when the pointer leaves, so assistive
 *   technology still reads it. `data-tip` works the same without a `title`.
 */
import { hasOpenLayer } from "./layers";

const SHOW_DELAY_MS = 450;
const QUICK_DELAY_MS = 80; // moving from one tooltip to the next
const GAP = 8;

/** Floating menus and popovers: a tooltip must not cover or compete with them. */
const MENU_SELECTOR = [
  '[role="menu"]', '[role="listbox"]', ".sidebar-context-menu", ".block-context-menu",
  ".nb-menu", ".slash-menu", ".sync-pop", ".kanban-color-picker", ".kanban-ctx-menu",
  ".whiteboard-context-menu", ".pdf-context-menu", ".mindmap-context-menu",
  ".mindmap-dropdown", ".wb-popover",
].join(",");
/** Modal dialogs: only their own elements get tooltips. */
const DIALOG_SELECTOR = '[aria-modal="true"], .command-palette';
const OVERLAY_SELECTOR = `${MENU_SELECTOR},${DIALOG_SELECTOR}`;

let bubble: HTMLDivElement | null = null;
let target: HTMLElement | null = null;
/** Titles lifted off the hovered element AND its ancestors (the platform
 *  shows an ancestor's title when the hovered element has none). */
let stashed: Array<{ el: HTMLElement; title: string }> = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let lastHiddenAt = 0;
let pointer = { x: 0, y: 0 };

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
}

function openOverlays(selector: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(selector)].filter(visible);
}

/** May `el` show a tooltip now? */
export function tooltipAllowed(el: HTMLElement): boolean {
  if (document.querySelector("[data-confirm-dialog]")) return !!el.closest("[data-confirm-dialog]");
  const menus = openOverlays(MENU_SELECTOR);
  if (menus.length > 0 || hasOpenLayer(["menu", "popover"])) {
    return menus.some(m => m.contains(el));
  }
  const dialogs = openOverlays(DIALOG_SELECTOR);
  if (dialogs.length > 0) return dialogs.some(d => d.contains(el));
  return true;
}

function tipText(el: HTMLElement): string {
  return (stashed.find(s => s.el === el)?.title ?? el.getAttribute("title")) || el.dataset.tip || "";
}

function restoreTitle() {
  for (const { el, title } of stashed) {
    // React may have set a new title meanwhile; never overwrite it.
    if (!el.hasAttribute("title")) el.setAttribute("title", title);
  }
  stashed = [];
}

function liftTitle(el: HTMLElement) {
  restoreTitle();
  for (let n: HTMLElement | null = el; n && n !== document.body; n = n.parentElement) {
    const t = n.getAttribute("title");
    if (t == null) continue;
    stashed.push({ el: n, title: t });
    n.removeAttribute("title");
  }
}

function ensureBubble(): HTMLDivElement {
  if (bubble && document.body.contains(bubble)) return bubble;
  bubble = document.createElement("div");
  bubble.className = "app-tooltip";
  bubble.setAttribute("role", "tooltip");
  bubble.setAttribute("data-testid", "app-tooltip");
  document.body.appendChild(bubble);
  return bubble;
}

function overlaps(a: DOMRect | { left: number; top: number; right: number; bottom: number }, b: DOMRect) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function place(el: HTMLElement, b: HTMLDivElement): boolean {
  const r = el.getBoundingClientRect();
  const w = b.offsetWidth, h = b.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  // A big target (a row, a canvas): anchor at the pointer instead of the box.
  const anchor = r.height > 48
    ? { left: pointer.x - 1, right: pointer.x + 1, top: pointer.y - 12, bottom: pointer.y + 18 }
    : { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  const cx = (anchor.left + anchor.right) / 2;
  const left = Math.min(Math.max(4, cx - w / 2), vw - w - 4);
  const candidates = [
    { left, top: anchor.bottom + GAP },             // below
    { left, top: anchor.top - GAP - h },            // above
    { left: anchor.right + GAP, top: (anchor.top + anchor.bottom) / 2 - h / 2 }, // right
    { left: anchor.left - GAP - w, top: (anchor.top + anchor.bottom) / 2 - h / 2 }, // left
  ];
  const avoid = openOverlays(OVERLAY_SELECTOR).filter(o => !o.contains(el)).map(o => o.getBoundingClientRect());
  for (const c of candidates) {
    const box = { left: c.left, top: c.top, right: c.left + w, bottom: c.top + h };
    if (box.left < 0 || box.top < 0 || box.right > vw || box.bottom > vh) continue;
    // Away from the pointer, and never over an open menu.
    if (pointer.x >= box.left - 2 && pointer.x <= box.right + 2 && pointer.y >= box.top - 2 && pointer.y <= box.bottom + 2) continue;
    if (avoid.some(a => overlaps(box as DOMRect, a))) continue;
    b.style.left = `${Math.round(c.left)}px`;
    b.style.top = `${Math.round(c.top)}px`;
    return true;
  }
  return false;
}

export function hideTooltip() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (bubble?.classList.contains("visible")) lastHiddenAt = Date.now();
  bubble?.classList.remove("visible");
  if (bubble) bubble.textContent = "";
}

function show(el: HTMLElement) {
  timer = null;
  if (target !== el || !document.contains(el)) return;
  const text = tipText(el).trim();
  if (!text || !tooltipAllowed(el)) return;
  const b = ensureBubble();
  b.textContent = text;
  b.style.left = "-9999px";
  b.style.top = "0px";
  b.classList.add("visible");
  if (!place(el, b)) hideTooltip();
}

function onOver(e: PointerEvent) {
  pointer = { x: e.clientX, y: e.clientY };
  const el = (e.target as Element | null)?.closest?.<HTMLElement>("[title], [data-tip]") ?? null;
  if (el === target) return;
  hideTooltip();
  if (target && target !== el) restoreTitle();
  target = el;
  if (!el) return;
  // An element whose title is its only text for the platform (SVG <title>
  // children aside) — lift it so the platform tooltip never appears.
  liftTitle(el);
  const quick = Date.now() - lastHiddenAt < 600;
  timer = setTimeout(() => show(el), quick ? QUICK_DELAY_MS : SHOW_DELAY_MS);
}

function onOut(e: PointerEvent) {
  if (!target) return;
  const to = e.relatedTarget as Node | null;
  if (to && target.contains(to)) return;
  hideTooltip();
  restoreTitle();
  target = null;
}

function onMove(e: PointerEvent) {
  pointer = { x: e.clientX, y: e.clientY };
}

let installed = false;

/** Install the tooltip once, for the whole app. */
export function installTooltips(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  document.addEventListener("pointerover", onOver, true);
  document.addEventListener("pointerout", onOut, true);
  document.addEventListener("pointermove", onMove, { capture: true, passive: true });
  const dismiss = () => hideTooltip();
  document.addEventListener("pointerdown", dismiss, true);
  window.addEventListener("keydown", dismiss, true);
  window.addEventListener("wheel", dismiss, { capture: true, passive: true });
  window.addEventListener("scroll", dismiss, true);
  window.addEventListener("blur", dismiss);
}
