import { useState, useEffect, useCallback } from "react";
import * as api from "../lib/api";

interface Props {
  open: boolean;
  onClose: () => void;
  currentPageId: string | null;
  onPageRestored?: () => void;
}

export default function SyncPanel({ open, onClose, currentPageId, onPageRestored }: Props) {
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
      setError(e?.toString() ?? "Sync failed");
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
      setError(e?.toString() ?? "Sync failed");
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

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="sync-panel" onClick={(e) => e.stopPropagation()}>
        <div className="sync-panel-header">
          <h3>Sync &amp; Versions</h3>
          <button className="btn btn-sm" onClick={onClose}>Close</button>
        </div>

        {error && <div className="sync-error">{error}</div>}

        <div className="sync-status-section">
          <div className="sync-status-grid">
            <div className="sync-stat">
              <span className="sync-stat-value">{status?.total_pages ?? "..."}</span>
              <span className="sync-stat-label">Total Pages</span>
            </div>
            <div className="sync-stat">
              <span className="sync-stat-value">{status?.synced_pages ?? "..."}</span>
              <span className="sync-stat-label">Synced</span>
            </div>
            <div className="sync-stat">
              <span className="sync-stat-value">{status?.pending_changes ?? "..."}</span>
              <span className="sync-stat-label">Pending</span>
            </div>
          </div>
          {status?.last_sync && (
            <div className="sync-last-time">
              Last sync: {formatTime(status.last_sync)}
            </div>
          )}
        </div>

        <div className="sync-actions">
          <button
            className="btn btn-primary"
            disabled={syncing}
            onClick={handleSyncAll}
          >
            {syncing ? "Syncing..." : "Sync All Pages"}
          </button>
          {currentPageId && (
            <button
              className="btn"
              disabled={syncing}
              onClick={handleSyncCurrent}
            >
              Sync Current Page
            </button>
          )}
        </div>

        {currentPageId && (
          <div className="sync-versions">
            <h4>Version History</h4>
            {versions.length === 0 ? (
              <div className="sync-versions-empty">
                No versions yet. Sync the page to create a snapshot.
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
