import * as api from "./api";

/**
 * Message when another page already has exactly this title, else null. Checked
 * before renaming so the refusal reads the same whatever the backend says.
 */
export async function pageTitleConflict(title: string, excludeId: string): Promise<string | null> {
  try {
    return (await api.titleInUse(title, excludeId)) ? `A page titled "${title}" already exists` : null;
  } catch {
    return null; // can't check — the backend still enforces it
  }
}
