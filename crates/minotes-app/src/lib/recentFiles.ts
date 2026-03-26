const STORAGE_KEY = "minotes-recent-pages";
const MAX_RECENT = 10;

interface RecentEntry {
  id: string;
  title: string;
  timestamp: number;
}

export function getRecentPages(): RecentEntry[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function addRecentPage(id: string, title: string): void {
  const recent = getRecentPages().filter((r) => r.id !== id);
  recent.unshift({ id, title, timestamp: Date.now() });
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(recent));
}
