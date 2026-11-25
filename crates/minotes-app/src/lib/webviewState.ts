/**
 * Webview storage and encrypted notebooks (PRD-encryption §4.5).
 *
 * The webview's localStorage is a plain file on disk. For an encrypted notebook
 * nothing content-derived may land there: the recent-pages list (page titles)
 * lives in the notebook's own (encrypted) database instead (`ui_state`), and is
 * held in memory while the notebook is open. Ids-only keys (collapsed blocks,
 * expanded folders, kanban column ids/colours) reveal no content and stay.
 */
import * as api from "./api";

const RECENT_KEY = "minotes-recent-pages";
const UI_RECENT = "recent-pages";
const LEGACY_WHITEBOARD_PREFIX = "minotes-whiteboard-";

let encryptedOpen = false;
let memory: string | null = null;

/** Is the open notebook encrypted? (Set by the lock gate from the session.) */
export function isOpenNotebookEncrypted(): boolean {
  return encryptedOpen;
}

/** The lock gate reports the open notebook: when it is encrypted and unlocked,
 *  its recent pages are loaded from its database into memory. */
export async function setOpenNotebook(session: api.NotebookSession | null): Promise<void> {
  const enc = !!session?.encrypted;
  encryptedOpen = enc;
  memory = null;
  if (enc && !session?.locked) {
    try {
      memory = (await api.getUiState(UI_RECENT)) ?? null;
    } catch {
      memory = null;
    }
  }
}

/** Read the recent-pages list (JSON text) from wherever it lives. */
export function readRecent(): string | null {
  if (encryptedOpen) return memory;
  try {
    return localStorage.getItem(RECENT_KEY);
  } catch {
    return null;
  }
}

/** Write the recent-pages list: the database for an encrypted notebook, else localStorage. */
export function writeRecent(json: string): void {
  if (encryptedOpen) {
    memory = json;
    api.setUiState(UI_RECENT, json).catch(() => { /* locked meanwhile: not remembered */ });
    return;
  }
  try {
    localStorage.setItem(RECENT_KEY, json);
  } catch {
    /* storage unavailable */
  }
}

/**
 * After encrypting the open notebook (`key`): remove what webview storage holds
 * about it in plain text — its recent pages (current and parked copies) and the
 * legacy localStorage copies of its whiteboards (they are in its database).
 */
export async function forgetPlaintextWebviewState(key: string): Promise<void> {
  let recent: string | null = null;
  try {
    recent = localStorage.getItem(RECENT_KEY);
    localStorage.removeItem(RECENT_KEY);
    localStorage.removeItem(`${RECENT_KEY}@notebook:${key}`);
  } catch {
    /* storage unavailable */
  }
  encryptedOpen = true;
  memory = recent;
  if (recent) api.setUiState(UI_RECENT, recent).catch(() => {});
  let ids: string[] = [];
  try {
    ids = Object.keys(localStorage)
      .filter(k => k.startsWith(LEGACY_WHITEBOARD_PREFIX))
      .map(k => k.slice(LEGACY_WHITEBOARD_PREFIX.length));
  } catch {
    return;
  }
  for (const id of ids) {
    try {
      // Only boards this notebook has (imported into its database).
      if ((await api.getWhiteboard(id)) != null) localStorage.removeItem(LEGACY_WHITEBOARD_PREFIX + id);
    } catch {
      /* not this notebook's board */
    }
  }
}
