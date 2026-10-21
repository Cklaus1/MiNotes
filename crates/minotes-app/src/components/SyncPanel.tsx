import { useState, useEffect, useCallback } from "react";
import { useEscapeToClose } from "../lib/escapeStack";
import * as api from "../lib/api";

interface Props {
  open: boolean;
  onClose: () => void;
  currentPageId: string | null;
  onPageRestored?: () => void;
}

export default function SyncPanel({ open, onClose, currentPageId, onPageRestored }: Props) {
  useEscapeToClose(open, onClose, "dialog");
  const [status, setStatus] = useState<api.SyncStatus | null>(null);
  const [versions, setVersions] = useState<api.VersionInfo[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const s = await api.getSyncStatus();
      setStatus(s);
    } catch (e) {
      console.error("Failed to load sync status:", e);
    }
  }, []);

  const loadVersions = useCallback(async () => {
    if (!currentPageId) {
      setVersions([]);
      return;
    }
    try {
      const v = await api.getVersionHistory(currentPageId, 20);
      setVersions(v);
    } catch {
      setVersions([]);
    }
  }, [currentPageId]);

  useEffect(() => {
    if (open) {
      loadStatus();
      loadVersions();
    }
  }, [open, loadStatus, loadVersions]);

  const handleSyncAll = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      const pages = await api.listPages(1000);
      for (const page of pages) {
        await api.syncPage(page.id);
      }
      await loadStatus();
      await loadVersions();
    } catch (e: any) {
      setError(e?.toString() ?? "Saving a version failed");
    } finally {
      setSyncing(false);
    }
  }, [loadStatus, loadVersions]);

  const handleSyncCurrent = useCallback(async () => {
    if (!currentPageId) return;
    setSyncing(true);
    setError(null);
    try {
      await api.syncPage(currentPageId);
      await loadStatus();
      await loadVersions();
    } catch (e: any) {
      setError(e?.toString() ?? "Saving a version failed");
    } finally {
      setSyncing(false);
    }
  }, [currentPageId, loadStatus, loadVersions]);

  const handleRestore = useCallback(async (hash: string) => {
    if (!currentPageId) return;
    try {
      await api.restoreVersion(currentPageId, hash);
      await loadVersions();
      onPageRestored?.();
    } catch (e: any) {
      setError(e?.toString() ?? "Restore failed");
    }
  }, [currentPageId, loadVersions, onPageRestored]);

  if (!open) return null;

  const formatTime = (ts: string) => {
    try {
      const d = new Date(ts);
      return d.toLocaleString();
    } catch {
      return ts;
    }
  };

  // The three counters never overlap: every page either has no saved version,
  // or its newest version is current, or it changed since (UX review: "Synced"
  // and "Pending" counted the same pages and could add up to twice the total).
  const total = status?.total_pages ?? null;
  const saved = status?.synced_pages ?? null;
  const never = total !== null && saved !== null ? Math.max(0, total - saved) : null;
  const changed = status && never !== null ? Math.max(0, status.pending_changes - never) : null;
  const upToDate = saved !== null && changed !== null ? Math.max(0, saved - changed) : null;
  const n = (v: number | null) => (v === null ? "…" : String(v));

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="sync-panel" role="dialog" aria-label="Page versions" data-testid="page-versions" onClick={(e) => e.stopPropagation()}>
        <div className="sync-panel-header">
          <h3>Page versions</h3>
          <button className="btn btn-sm" onClick={onClose}>Close</button>
        </div>
        <div className="sync-versions-empty" style={{ marginBottom: 10 }}>
          Snapshots of pages saved on this device, to go back to an earlier version.
          This is not git sync (that is in Settings → Sync &amp; Backup).
        </div>

        {error && <div className="sync-error">{error}</div>}

        <div className="sync-status-section">
          <div className="sync-status-grid" data-testid="page-versions-counts">
            <div className="sync-stat" title="Pages whose newest saved version matches the page">
              <span className="sync-stat-value">{n(upToDate)}</span>
              <span className="sync-stat-label">Saved, unchanged</span>
            </div>
            <div className="sync-stat" title="Pages edited since their newest saved version">
              <span className="sync-stat-value">{n(changed)}</span>
              <span className="sync-stat-label">Changed since saved</span>
            </div>
            <div className="sync-stat" title="Pages with no saved version yet">
              <span className="sync-stat-value">{n(never)}</span>
              <span className="sync-stat-label">Never saved</span>
            </div>
          </div>
          {total !== null && (
            <div className="sync-last-time">
              {total} page{total === 1 ? "" : "s"} in this notebook
              {status?.last_sync ? ` · last version saved ${formatTime(status.last_sync)}` : ""}
            </div>
          )}
        </div>

        <div className="sync-actions">
          {currentPageId && (
            <button
              className="btn btn-primary"
              disabled={syncing}
              onClick={handleSyncCurrent}
            >
              Save a version of this page
            </button>
          )}
          <button
            className="btn"
            disabled={syncing}
            onClick={handleSyncAll}
          >
            {syncing ? "Saving…" : "Save a version of every page"}
          </button>
        </div>

        {currentPageId && (
          <div className="sync-versions">
            <h4>Versions of this page</h4>
            {versions.length === 0 ? (
              <div className="sync-versions-empty">
                No saved versions yet. “Save a version of this page” keeps a snapshot you can go back to.
              </div>
            ) : (
              <div className="sync-versions-list">
                {versions.map((v, i) => (
                  <div key={v.hash + i} className="sync-version-item">
                    <div className="sync-version-info">
                      <span className="sync-version-time">{formatTime(v.timestamp)}</span>
                      <span className="sync-version-actor">{v.actor}</span>
                      {v.message && (
                        <span className="sync-version-msg">{v.message}</span>
                      )}
                    </div>
                    {i > 0 && (
                      <button
                        className="btn btn-sm"
                        onClick={() => handleRestore(v.hash)}
                      >
                        Restore
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
