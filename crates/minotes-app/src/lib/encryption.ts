/**
 * Encrypted notebooks in the UI (PRD-encryption §4.4, §5): locking and
 * unlocking the open notebook, the events that tie the lock gate, the switcher
 * and the settings together, and the "this writes unencrypted files" check.
 *
 * Locking runs the same save barrier and cache reset as a notebook switch; the
 * lock gate (components/LockGate) then unmounts every view, so no page data
 * stays in the window while the notebook is locked.
 */
import * as api from "./api";
import { flushPendingEdits } from "./pendingEdits";
import { clearWhiteboardCache } from "./whiteboardUtils";
import { clearPrefetchedProperties } from "./blockProperties";
import { undoStack } from "./undoStack";
import { errorMessage } from "./errors";

/** The open notebook was locked or unlocked (detail: the new NotebookSession, if known). */
export const LOCK_CHANGED = "minotes-lock-changed";
/** Ask the lock gate to show the passphrase prompt (detail: PassphraseRequest). */
export const ASK_PASSPHRASE = "minotes-ask-passphrase";

export interface PassphraseRequest {
  title: string;
  message: string;
  resolve: (secret: string | null) => void;
}

/** Drop everything the window remembers about the open notebook's content. */
export function resetNotebookCaches() {
  clearWhiteboardCache();
  clearPrefetchedProperties();
  undoStack.clear();
}

function announce(session?: api.NotebookSession | null) {
  window.dispatchEvent(new CustomEvent(LOCK_CHANGED, { detail: session ?? null }));
}

/** "Lock now" / auto-lock. Unsaved edits are written first (if that fails the
 *  notebook is locked anyway — the failed edit is reported, not kept in memory). */
export async function lockNow(): Promise<void> {
  try {
    await flushPendingEdits();
  } catch (e) {
    console.warn("Locking: some edits could not be saved:", errorMessage(e));
  }
  const s = await api.lockNotebook();
  resetNotebookCaches();
  announce(s);
}

/** Unlock the open notebook. Throws the backend's error (WRONG_PASSPHRASE …). */
export async function unlock(secret: string, opts: { recovery?: boolean; remember?: boolean } = {}): Promise<api.NotebookSession> {
  const s = await api.unlockNotebook(secret, !!opts.recovery, !!opts.remember);
  resetNotebookCaches();
  announce(s);
  return s;
}

/** Tell the gate the lock state may have changed (after recover / encrypt / switch). */
export async function refreshLockState(): Promise<api.NotebookSession | null> {
  try {
    const s = await api.getNotebookSession();
    announce(s);
    return s;
  } catch {
    return null;
  }
}

/** Show the in-app passphrase prompt (never a native prompt: it would echo). */
export function askPassphrase(title: string, message: string): Promise<string | null> {
  return new Promise(resolve => {
    const req: PassphraseRequest = { title, message, resolve };
    window.dispatchEvent(new CustomEvent(ASK_PASSPHRASE, { detail: req }));
  });
}

const exportConfirmed = new Set<string>();

/**
 * Before writing note content outside the encrypted database (image / mind map
 * exports): ask once per notebook and session. True when the export may go on.
 */
export async function confirmPlaintextExport(): Promise<boolean> {
  let s: api.NotebookSession | null = null;
  try {
    s = await api.getNotebookSession();
  } catch {
    return true;
  }
  if (!s?.encrypted || exportConfirmed.has(s.key)) return true;
  const ok = window.confirm(
    `“${s.name}” is encrypted. This export writes an unencrypted file that anyone with access to it can read. Continue?`,
  );
  if (ok) exportConfirmed.add(s.key);
  return ok;
}

/** Recovery key as a plain-text file's content. */
export function recoveryKeyFileText(notebook: string, key: string): string {
  return [
    `MiNotes recovery key for the notebook “${notebook}”`,
    "",
    key,
    "",
    "Keep this somewhere safe and separate from your computer. It is the only way",
    "into this notebook if the passphrase is forgotten. Anyone who has it and the",
    "notebook's files can read the notebook.",
    "",
  ].join("\n");
}
