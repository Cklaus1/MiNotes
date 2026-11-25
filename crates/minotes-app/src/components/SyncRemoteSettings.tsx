import { useEffect, useState } from "react";
import * as api from "../lib/api";
import { withBusy } from "../lib/busy";
import { confirmDialog } from "../lib/confirm";
import { showToast } from "../lib/toast";
import { applySyncStatus, getSyncView, setSyncView, useSyncView } from "../lib/syncStatus";
import { CREDENTIALS_NOTE, remoteError, shortRemote, usableCheck } from "../lib/syncRemote";
import JoinNotebookDialog from "./JoinNotebookDialog";
import RemoteAddressField from "./RemoteAddressField";
import "./sync.css";

/**
 * Settings → Sync & Backup: the remote. Without one: an address, Test
 * connection and "Set up sync" (init + remote + first push). With one: it,
 * with Change and Remove. And "Join an existing notebook…".
 */
export default function SyncRemoteSettings({ encrypted, notebookName }: { encrypted: boolean; notebookName: string }) {
  const v = useSyncView();
  const remote = v.status?.remote_url ?? null;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [check, setCheck] = useState<api.RemoteCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [join, setJoin] = useState(false);

  // A new address: the last test and error were about the old one.
  useEffect(() => { setError(null); setCheck(null); }, [value]);

  // The field forgets its result when the address changes: a result is current.
  const testNow = async (): Promise<api.RemoteCheck> => {
    if (check) return check;
    const c = await api.gitSyncTestRemote(value.trim());
    setCheck(c);
    return c;
  };

  const finish = (st: api.GitSyncStatus) => {
    setSyncView({ phase: "idle" });
    applySyncStatus(st);
    window.dispatchEvent(new Event("minotes-sidebar-refresh"));
  };

  const setUp = async () => {
    if (!value.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const c = await testNow();
      if (!usableCheck(c)) { setError(c.message); return; }
      if (c.status === "reachable") {
        const ok = await confirmDialog({
          title: "This repository already holds notes",
          message: `Setting up sync here brings them into “${notebookName}” and sends this notebook's pages there — nothing is lost; ` +
            "pages with the same title get a number.\n\nTo open those notes as a separate notebook instead, use “Join an existing notebook…”.",
          confirmLabel: `Merge into “${notebookName}”`,
        });
        if (!ok) return;
      }
      setSyncView({ phase: "syncing" });
      const st = await withBusy("Setting up sync…", () => api.gitSyncSetup(value.trim()), {
        done: (s) => s.last_error ? null : `Sync is set up: “${notebookName}” is on ${shortRemote(s.remote_url ?? value)}`,
        failed: null,
      });
      finish(st);
      if (st.last_error) showToast(`Sync is on, but it couldn't reach the remote yet: ${st.last_error}`);
      setValue("");
      setCheck(null);
    } catch (e) {
      setError(remoteError(e));
      applySyncStatus(await api.gitSyncStatus().catch(() => null));
    } finally {
      setBusy(false);
      if (getSyncView().phase === "syncing") setSyncView({ phase: "idle" });
    }
  };

  const save = async () => {
    if (!value.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const c = await testNow();
      if (!usableCheck(c)) { setError(c.message); return; }
      const st = await api.gitSyncSetRemote(value.trim());
      finish(st);
      setEditing(false);
      setValue("");
      setCheck(null);
      showToast(`Sync remote changed to ${shortRemote(st.remote_url ?? value)}${st.enabled ? " — syncing now" : ""}`);
      if (st.enabled) window.dispatchEvent(new Event("minotes-sync-now"));
    } catch (e) {
      setError(remoteError(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!remote) return;
    const ok = await confirmDialog({
      title: "Stop syncing with this remote?",
      message: `${remote}\n\n“${notebookName}” stays on this device with its history, and nothing is deleted on the remote — ` +
        "other devices keep their copies. Until you add a remote again, changes stay on this device.",
      confirmLabel: "Remove remote",
      danger: true,
    });
    if (!ok) return;
    try {
      finish(await api.gitSyncRemoveRemote());
      showToast("Removed the sync remote: this notebook now syncs nowhere");
    } catch (e) {
      showToast(`Couldn't remove the remote: ${remoteError(e)}`);
    }
  };

  const showForm = !remote || editing;
  return (
    <div className="sync-remote" data-testid="sync-remote">
      {!showForm ? (
        <div className="settings-row sync-remote-current">
          <span className="settings-row-label">Remote</span>
          <span className="settings-row-value sync-remote-url" title={remote ?? ""} data-testid="sync-remote-url">{remote}</span>
          <span className="sync-remote-buttons">
            <button className="btn btn-sm" onClick={() => { setEditing(true); setValue(remote ?? ""); setCheck(null); }} data-testid="sync-remote-edit">Change…</button>
            <button className="btn btn-sm btn-danger" onClick={remove} data-testid="sync-remote-remove">Remove</button>
          </span>
        </div>
      ) : (
        <div className="sync-remote-form">
          <div className="sync-remote-title">{remote ? "Change the sync remote" : "Sync with your other devices"}</div>
          {!remote && (
            <p className="nb-hint">
              Put this notebook in a git repository your other devices can reach — GitHub, GitLab, Gitea, your own server, or a
              bare repository on a shared drive. Start with an empty one{encrypted ? "; only encrypted files go there" : ""}.
            </p>
          )}
          <RemoteAddressField value={value} onChange={setValue} onChecked={setCheck} disabled={busy} autoFocus={editing} />
          {error && <div className="nb-field-error" role="alert" data-testid="sync-remote-error">{error}</div>}
          <div className="sync-remote-actions">
            {!value.trim() && <span className="disabled-reason">Enter the repository's address.</span>}
            {remote ? (
              <>
                <button className="btn btn-sm" onClick={() => { setEditing(false); setValue(""); setError(null); }} disabled={busy}>Cancel</button>
                <button className="btn btn-sm btn-primary" onClick={save} disabled={busy || !value.trim()} data-testid="sync-remote-save">
                  {busy ? "Checking…" : "Use this remote"}
                </button>
              </>
            ) : (
              <button className="btn btn-sm btn-primary" onClick={setUp} disabled={busy || !value.trim()} data-testid="sync-setup">
                {busy ? "Setting up…" : "Set up sync"}
              </button>
            )}
          </div>
        </div>
      )}
      <p className="nb-hint sync-credentials" data-testid="sync-credentials-note">{CREDENTIALS_NOTE}</p>
      {!remote && (
        <div className="sync-remote-join">
          <span className="nb-hint">Already syncing this notebook on another device?</span>
          <button className="btn btn-sm" onClick={() => setJoin(true)} data-testid="sync-join-open">Join an existing notebook…</button>
        </div>
      )}
      {join && <JoinNotebookDialog onClose={() => setJoin(false)} />}
    </div>
  );
}
