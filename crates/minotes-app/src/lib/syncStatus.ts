/**
 * Git sync status shared by the sidebar chip, Settings → Sync & Backup and the
 * command palette — one truth instead of three guesses (UX review: Settings
 * said "Last synced" with no remote and while paused; a missing remote showed
 * only a grey "Offline").
 *
 * App.tsx runs the sync cycles and writes here; views read with useSyncView().
 * "Sync now" anywhere = requestSyncNow().
 */
import { useSyncExternalStore } from "react";
import type { GitSyncStatus, SyncErrorKind } from "./api";

export type SyncPhase =
  /** Sync is off for this notebook (or git is missing). */
  | "off"
  /** On, but the folder was set up on another computer: waiting for the user's OK. */
  | "paused"
  | "syncing"
  /** The remote can't be reached (network); retried on the next sync. */
  | "offline"
  /** The remote is missing, refused the credentials, or the sync failed. */
  | "error"
  | "idle";

export interface SyncView {
  phase: SyncPhase;
  status: GitSyncStatus | null;
  error: string | null;
  errorKind: SyncErrorKind | null;
}

/** Ask App to run a sync now (user-initiated: it reports the outcome). */
export const SYNC_NOW_EVENT = "minotes-sync-now";
/** Ask App to confirm syncing a folder set up on another computer ("Sync it here"). */
export const SYNC_CONFIRM_EVENT = "minotes-sync-confirm";

let view: SyncView = { phase: "off", status: null, error: null, errorKind: null };
const listeners = new Set<() => void>();

export function getSyncView(): SyncView {
  return view;
}

export function setSyncView(patch: Partial<SyncView>): void {
  view = { ...view, ...patch };
  listeners.forEach(l => l());
}

/** The phase a fetched status implies when no sync is running. */
export function phaseOf(status: GitSyncStatus | null): SyncPhase {
  if (!status?.enabled) return "off";
  if (status.needs_confirmation) return "paused";
  if (status.last_error) return status.last_error_kind === "offline" ? "offline" : "error";
  return "idle";
}

/** Take a status from the backend (and the error it remembers). */
export function applySyncStatus(status: GitSyncStatus | null): void {
  setSyncView({
    status,
    phase: view.phase === "syncing" && status?.enabled ? "syncing" : phaseOf(status),
    error: status?.last_error ?? null,
    errorKind: status?.last_error_kind ?? null,
  });
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useSyncView(): SyncView {
  return useSyncExternalStore(subscribe, getSyncView, getSyncView);
}

export function requestSyncNow(): void {
  window.dispatchEvent(new Event(SYNC_NOW_EVENT));
}

/** "2 min ago" for a past ISO time. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

/** A headline for an error kind ("Remote not found"). */
export function errorTitle(kind: SyncErrorKind | null): string {
  switch (kind) {
    case "offline": return "Can't reach the sync remote";
    case "remote_not_found": return "Sync remote not found";
    case "auth": return "The sync remote refused the sign-in";
    default: return "Sync failed";
  }
}

/** What to do about it. */
export function errorHint(kind: SyncErrorKind | null): string {
  switch (kind) {
    case "offline": return "Probably no network right now. Your notes are kept here and sync when the remote is reachable again.";
    case "remote_not_found": return "Its address leads nowhere: the repository was moved, deleted or mistyped. Check the remote in Settings → Sync & Backup → Show advanced.";
    case "auth": return "Check your SSH key or credentials for this remote.";
    default: return "Your notes are kept here. Retry, or check the details below.";
  }
}

/** The short chip text for the sidebar. */
export function chipText(v: SyncView, now = Date.now()): string {
  switch (v.phase) {
    case "syncing": return "Syncing…";
    case "paused": return "Sync paused";
    case "offline": return "Offline";
    case "error": return v.errorKind === "remote_not_found" ? "Sync remote not found" : v.errorKind === "auth" ? "Sync sign-in failed" : "Sync failed";
    case "idle":
      if (!v.status?.remote_url) return "Not synced — no remote";
      return v.status.last_sync ? `Synced ${ago(v.status.last_sync, now)}` : "Not synced yet";
    default: return "";
  }
}
