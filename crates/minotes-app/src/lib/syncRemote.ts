/**
 * Sync setup helpers (UX Wave 4): wording for "Test connection" results and
 * the credentials note shared by Settings → Sync & Backup and "Join an
 * existing notebook…". The work is in the backend (core sync_remote.rs).
 */
import type { RemoteCheck, RemoteCheckStatus } from "./api";
import { errorMessage } from "./errors";

/** How a Test connection result looks: usable, usable with a caveat, or not. */
export function checkTone(c: RemoteCheck): "ok" | "warn" | "bad" {
  if (c.status === "reachable" || c.status === "empty") return c.warning ? "warn" : "ok";
  return c.status === "offline" || c.status === "timeout" ? "warn" : "bad";
}

/** A short headline per result. */
export function checkTitle(status: RemoteCheckStatus): string {
  switch (status) {
    case "reachable": return "Reachable";
    case "empty": return "Reachable — empty";
    case "not_found": return "Not found";
    case "auth": return "Sign-in refused";
    case "not_a_repo": return "Not a git repository";
    case "offline": return "Can't reach it";
    case "timeout": return "No answer";
    case "invalid": return "Not a usable address";
    default: return "Didn't work";
  }
}

export const usableCheck = (c: RemoteCheck | null | undefined) => !!c && (c.status === "reachable" || c.status === "empty");

/** Shown next to every remote field: MiNotes never handles secrets. */
export const CREDENTIALS_NOTE =
  "Signing in uses your computer's own git setup — your SSH key and ssh-agent, or git's credential helper for https. " +
  "MiNotes never asks for, sees or stores a password or token (an address with one in it is refused).";

export const REMOTE_PLACEHOLDER = "git@github.com:you/notes.git  ·  https://…  ·  /media/drive/notes.git";

/** The join refused an encrypted notebook's remote without a passphrase. */
export function isEncryptedRemote(e: unknown): boolean {
  return /ENCRYPTED_REMOTE/.test(errorMessage(e));
}

/** An error's text without the backend's code prefixes. */
export function remoteError(e: unknown): string {
  return errorMessage(e).replace(/^(Invalid input|Git error|ENCRYPTED_REMOTE): /, "");
}

/** "github.com/you/notes" for a toast (the full address is in Settings). */
export function shortRemote(url: string): string {
  const s = url.replace(/^[a-z+]+:\/\//i, "").replace(/\.git$/, "").replace(/^[^@/]+@/, "");
  return s.length > 48 ? `…${s.slice(-46)}` : s;
}
