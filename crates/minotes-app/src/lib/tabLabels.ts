/**
 * What a tab shows for its current place (PRD-tabs §3.1): an icon by kind and
 * a title — journal days as "Today · Tue, Nov 17" / "Tue, Nov 12", views by
 * name, pages by their live title (`titles`: page id → title, so a rename
 * retitles every tab).
 */
import type { NavEntry, NavView } from "./navHistory";
import type { IconName } from "./icons";
import { journalTitle } from "./windowTitle";

export interface TabLabel { icon: IconName; title: string; fullTitle: string }

const VIEW_LABELS: Record<NavView, { icon: IconName; title: string }> = {
  tasks: { icon: "square-check", title: "Tasks" },
  pages: { icon: "pages", title: "All Pages" },
  trash: { icon: "trash", title: "Trash" },
  archive: { icon: "archive", title: "Archive" },
  graph: { icon: "graph", title: "Graph" },
};

/** "2026-11-17" for a journal page's title ("Journal/2026-11-17"), else null. */
export function journalDateOfTitle(title: string | undefined): string | null {
  const m = /^Journal\/(\d{4}-\d{2}-\d{2})$/.exec(title ?? "");
  return m ? m[1] : null;
}

function shortDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1);
  return isNaN(dt.getTime()) ? date : dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function journalLabel(date: string, today: string): TabLabel {
  const short = shortDay(date);
  return {
    icon: "journal",
    title: date === today ? `Today · ${short}` : short,
    fullTitle: date === today ? `Today — ${journalTitle(date)}` : journalTitle(date),
  };
}

export function tabLabel(
  entry: NavEntry | null,
  opts: { titles?: ReadonlyMap<string, string>; today: string; emptyTitle?: string },
): TabLabel {
  if (!entry) {
    const t = opts.emptyTitle ?? "New tab";
    return { icon: "file-plus", title: t, fullTitle: t };
  }
  if (entry.kind === "view") {
    const v = VIEW_LABELS[entry.view ?? "pages"] ?? VIEW_LABELS.pages;
    return { icon: v.icon, title: v.title, fullTitle: v.title };
  }
  if (entry.kind === "journal-day" && entry.date) return journalLabel(entry.date, opts.today);
  const title = (entry.pageId && opts.titles?.get(entry.pageId)) || entry.title || "Untitled";
  const date = journalDateOfTitle(title);
  if (date) return journalLabel(date, opts.today);
  return { icon: "page", title, fullTitle: title };
}
