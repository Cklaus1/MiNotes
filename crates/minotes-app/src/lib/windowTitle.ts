/**
 * The window title: "Page — Notebook — MiNotes". Set on document.title and, in
 * the desktop app, on the native window (the taskbar / window switcher show
 * that one; Tauri doesn't follow document.title).
 *
 * While a notebook is locked the title is "Locked — Notebook — MiNotes": the
 * notebook's name is shown like on the unlock screen (PRD-encryption §9 Q5,
 * names shown), never a page title.
 */
import { isTauri } from "./api";

const APP = "MiNotes";
let last = "";

/** Join the parts that are present with " — ", ending in "MiNotes". */
export function composeWindowTitle(...parts: Array<string | null | undefined>): string {
  return [...parts.map(p => (p ?? "").trim()).filter(Boolean), APP].join(" — ");
}

export function setWindowTitle(title: string): void {
  if (title === last) return;
  last = title;
  document.title = title;
  if (!isTauri) return;
  import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title))
    .catch(() => { /* no window (tests) or not allowed: document.title still set */ });
}

/** "Wednesday, October 21, 2026" for a "YYYY-MM-DD" journal date. */
export function journalTitle(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1);
  return isNaN(dt.getTime()) ? date : dt.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}
