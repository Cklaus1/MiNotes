/**
 * The sidebar's "Recent" section (UX Wave 4): shown or hidden, open or
 * collapsed — both remembered on this device. The palette's "Show/Hide Recent
 * Pages" command and the section header change it.
 */
import { useSyncExternalStore } from "react";

const SHOWN_KEY = "minotes-sidebar-recent-shown";
const OPEN_KEY = "minotes-sidebar-recent-open";
export const RECENT_SECTION_EVENT = "minotes:recent-section";
/** How many recent pages the section lists. */
export const RECENT_SECTION_SIZE = 5;

function read(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function write(key: string, v: boolean) {
  try { localStorage.setItem(key, v ? "1" : "0"); } catch { /* not remembered */ }
  window.dispatchEvent(new Event(RECENT_SECTION_EVENT));
}

export const recentSectionShown = () => read(SHOWN_KEY, true);
export const recentSectionOpen = () => read(OPEN_KEY, true);
export const setRecentSectionShown = (v: boolean) => write(SHOWN_KEY, v);
export const setRecentSectionOpen = (v: boolean) => write(OPEN_KEY, v);

/** { shown, open }, re-rendering when either changes. */
export function useRecentSection(): { shown: boolean; open: boolean } {
  const snap = useSyncExternalStore(
    (l) => { window.addEventListener(RECENT_SECTION_EVENT, l); return () => window.removeEventListener(RECENT_SECTION_EVENT, l); },
    () => `${recentSectionShown() ? 1 : 0}${recentSectionOpen() ? 1 : 0}`,
  );
  return { shown: snap[0] === "1", open: snap[1] === "1" };
}
