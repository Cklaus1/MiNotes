/**
 * The left sidebar: shown, hidden by the user (remembered on this device), or —
 * in a window narrower than DRAWER_BELOW_PX — a drawer over the page that
 * opens on demand. Toggle: the button in the sidebar header / at the page's
 * top-left, or Ctrl+Shift+\ (Ctrl+\ is the right sidebar).
 * Below 769 px the mobile layout takes over (styles.css), untouched here.
 */
import { useEffect, useState } from "react";

export const DRAWER_BELOW_PX = 900;
const MOBILE_MAX_PX = 768;
const KEY = "minotes-sidebar-collapsed";

export function loadSidebarCollapsed(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}

export function saveSidebarCollapsed(collapsed: boolean): void {
  try { localStorage.setItem(KEY, collapsed ? "1" : "0"); } catch { /* not remembered */ }
}

/** True while the window is in the drawer range (narrow desktop, not mobile). */
export function isDrawerWidth(width = typeof window === "undefined" ? 1200 : window.innerWidth): boolean {
  return width < DRAWER_BELOW_PX && width > MOBILE_MAX_PX;
}

export function useDrawerWidth(): boolean {
  const [drawer, setDrawer] = useState(() => isDrawerWidth());
  useEffect(() => {
    const onResize = () => setDrawer(isDrawerWidth());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return drawer;
}

/** Ctrl+Shift+\ (any layout: matched by the physical key too). */
export function isSidebarToggleKey(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.code === "Backslash" || e.key === "|" || e.key === "\\");
}
