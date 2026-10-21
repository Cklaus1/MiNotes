import { useEffect, useRef, useState } from "react";
import {
  chipText, errorHint, errorTitle, requestSyncNow, SYNC_CONFIRM_EVENT, useSyncView, ago,
} from "../lib/syncStatus";
import { useEscapeToClose } from "../lib/escapeStack";
import "./sync.css";

interface Props {
  onOpenSettings: () => void;
}

/**
 * The sidebar's git sync status: "Synced 2 min ago" / "Syncing…" / an error.
 * Hover: the details as a tooltip. Click: a small panel with the error, the
 * remote, Retry / Sync now and a way to Settings. Hidden while sync is off.
 */
export default function SyncChip({ onOpenSettings }: Props) {
  const v = useSyncView();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const ref = useRef<HTMLDivElement>(null);
  useEscapeToClose(open, () => setOpen(false));

  // "Synced 2 min ago" stays true without a re-render from the store.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  if (v.phase === "off") return null;

  const text = chipText(v, now);
  const remote = v.status?.remote_url ?? null;
  const lastSync = v.status?.last_sync ?? null;
  const problem = v.phase === "error" || v.phase === "offline";
  const tooltip = problem
    ? `${errorTitle(v.errorKind)}: ${v.error ?? ""}\nClick for details and Retry.`
    : v.phase === "paused"
      ? "Sync is paused: this folder was set up on another computer. Click to choose."
      : v.phase === "idle" && !remote
        ? "Sync is on, but no remote is set: changes are committed in the sync folder only and go nowhere else."
        : lastSync
          ? `Last synced ${new Date(lastSync).toLocaleString()} with ${remote}`
          : `Not synced yet with ${remote}`;

  return (
    <div className="sync-chip-wrap" ref={ref}>
      <button
        type="button"
        className={`sync-chip sync-chip-${v.phase}${v.phase === "idle" && !remote ? " sync-chip-local" : ""}`}
        title={tooltip}
        aria-expanded={open}
        aria-label={`Sync: ${text}`}
        data-testid="sync-chip"
        data-phase={v.phase}
        onClick={() => setOpen(o => !o)}
      >
        <span className="sync-chip-dot" aria-hidden="true" />
        {text}
      </button>
      {open && (
        <div className="sync-pop" role="dialog" aria-label="Sync status" data-testid="sync-details">
          <div className="sync-pop-title">
            {problem ? errorTitle(v.errorKind) : v.phase === "paused" ? "Sync paused — waiting for your OK" : v.phase === "syncing" ? "Syncing…" : remote ? "Sync is on" : "No sync remote"}
          </div>
          {problem && (
            <>
              <div className="sync-pop-hint">{errorHint(v.errorKind)}</div>
              {v.error && <div className="sync-pop-error" data-testid="sync-details-error">{v.error}</div>}
            </>
          )}
          {v.phase === "paused" && (
            <div className="sync-pop-hint">This notebook folder was set up for sync on another computer. Nothing syncs here until you say so.</div>
          )}
          {!problem && v.phase !== "paused" && !remote && (
            <div className="sync-pop-hint">Changes are committed in the sync folder only. Add a remote to the folder's git repository to sync with other devices.</div>
          )}
          {remote && <div className="sync-pop-row"><span>Remote</span><span className="sync-pop-val" title={remote}>{remote}</span></div>}
          {remote && v.phase !== "paused" && (
            <div className="sync-pop-row"><span>Last synced</span><span className="sync-pop-val">{lastSync ? `${ago(lastSync, now)} (${new Date(lastSync).toLocaleString()})` : "never"}</span></div>
          )}
          <div className="sync-pop-actions">
            {v.phase === "paused" ? (
              <button className="btn btn-sm btn-primary" onClick={() => { setOpen(false); window.dispatchEvent(new Event(SYNC_CONFIRM_EVENT)); }}>Sync it here</button>
            ) : (
              <button className="btn btn-sm btn-primary" disabled={v.phase === "syncing"} data-testid="sync-details-retry"
                onClick={() => { requestSyncNow(); }}>
                {problem ? "Retry" : "Sync now"}
              </button>
            )}
            <button className="btn btn-sm" onClick={() => { setOpen(false); onOpenSettings(); }}>Sync settings…</button>
          </div>
        </div>
      )}
    </div>
  );
}
