import { readRecent, writeRecent } from "./webviewState";

const MAX_RECENT = 10;

interface RecentEntry {
  id: string;
  title: string;
  timestamp: number;
}

/** Recently opened pages. Kept in webview storage — except for an encrypted
 *  notebook, whose list (page titles) lives in its own database (webviewState). */
export function getRecentPages(): RecentEntry[] {
  try {
    return JSON.parse(readRecent() ?? "[]");
  } catch {
    return [];
  }
}

export function addRecentPage(id: string, title: string): void {
  const recent = getRecentPages().filter((r) => r.id !== id);
  recent.unshift({ id, title, timestamp: Date.now() });
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
  writeRecent(JSON.stringify(recent));
}
