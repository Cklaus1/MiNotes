import * as api from "./api";

/**
 * Message when another page already has exactly this title, else null. Checked
 * before renaming so the refusal reads the same whatever the backend says.
 */
export async function pageTitleConflict(title: string, excludeId: string): Promise<string | null> {
  try {
    const pages = await api.listPages(100000);
    const clash = pages.find(p => p.id !== excludeId && p.title === title);
    return clash ? `A page titled "${title}" already exists` : null;
  } catch {
    return null; // can't check — the backend still enforces it
  }
}
