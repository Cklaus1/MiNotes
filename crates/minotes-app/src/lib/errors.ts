/** Human-readable text for anything a Tauri command or a promise rejected with. */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e && typeof (e as Error).message === "string") {
    return (e as Error).message;
  }
  try { return JSON.stringify(e); } catch { return String(e); }
}

/**
 * What to tell the user when saving a block failed. The backend runs in-process,
 * so "check your connection" is never the reason: say what actually happened.
 */
export function saveErrorMessage(e: unknown): string {
  const msg = errorMessage(e);
  if (/not\s*found/i.test(msg)) {
    return "Couldn't save: this block or its page no longer exists (it was deleted permanently). Copy your text elsewhere — it can't be stored here.";
  }
  if (/locked|busy/i.test(msg)) {
    return `Couldn't save: the database is busy — try again in a moment (${msg})`;
  }
  return `Couldn't save: ${msg}`;
}
