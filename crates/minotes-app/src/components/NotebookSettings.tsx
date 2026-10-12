import { useCallback, useEffect, useState } from "react";
import * as api from "../lib/api";
import { showToast } from "../lib/toast";
import { errorMessage } from "../lib/errors";
import { NOTEBOOKS_CHANGED, NOTEBOOK_SWITCHED, exportNotebook, prettyPath, tailPath, timeAgo, useCapabilities } from "../lib/notebooks";
import "./notebooks.css";

/**
 * Settings → Notebook: where the open notebook lives, and its markdown copy —
 * location, last written, a quiet status ("Up to date" / "Writing…" /
 * "Behind — retry"), Open folder and Rebuild markdown copy.
 */
export default function NotebookSettings() {
  const [session, setSession] = useState<api.NotebookSession | null>(null);
  const [mirror, setMirror] = useState<api.MirrorStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  const caps = useCapabilities();

  const load = useCallback(() => {
    api.getNotebookSession().then(s => setSession(s ?? null)).catch(() => {});
    api.mirrorStatus().then(m => setMirror(m ?? null)).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    window.addEventListener(NOTEBOOKS_CHANGED, load);
    window.addEventListener(NOTEBOOK_SWITCHED, load);
    let unlisten: (() => void) | undefined;
    if (api.isTauri) {
      import("@tauri-apps/api/event").then(({ listen }) => {
        listen<api.MirrorStatus>("mirror-status", e => setMirror(e.payload)).then(fn => { unlisten = fn; });
      });
    }
    // Keep "x s ago" fresh and pick up debounced writes.
    const t = setInterval(() => { tick(n => n + 1); api.mirrorStatus().then(m => setMirror(m ?? null)).catch(() => {}); }, 5000);
    return () => {
      window.removeEventListener(NOTEBOOKS_CHANGED, load);
      window.removeEventListener(NOTEBOOK_SWITCHED, load);
      unlisten?.();
      clearInterval(t);
    };
  }, [load]);

  const rebuild = async () => {
    setBusy(true);
    try {
      const m = await api.mirrorRebuild();
      setMirror(m);
      showToast("Markdown copy rebuilt");
    } catch (e) {
      showToast(`Markdown copy is behind: ${errorMessage(e)}`);
      load();
    } finally {
      setBusy(false);
    }
  };

  const openFolder = async () => {
    try {
      await api.mirrorOpenFolder();
    } catch (e) {
      showToast(`Couldn't open the folder: ${errorMessage(e)}`);
    }
  };

  if (!session) return null;
  const status = !mirror
    ? "…"
    : mirror.read_only
      ? "Written by the other window that has this notebook open"
      : !mirror.enabled
        ? (caps.mirror_always ? "Off for this notebook" : "Off — kept only while Git sync is on")
        : mirror.behind
          ? "Behind"
          : mirror.pending
            ? "Writing…"
            : "Up to date";

  return (
    <div className="settings-section" data-testid="notebook-settings">
      <div className="settings-section-title">Notebook</div>
      <div className="settings-row">
        <span className="settings-row-label">Name</span>
        <span className="settings-row-value">{session.name}</span>
      </div>
      <div className="settings-row">
        <span className="settings-row-label">Stored in</span>
        <span className="settings-row-value nb-path" title={session.path}>
          {caps.app_storage ? "This device (app storage)" : session.kind === "folder" ? tailPath(prettyPath(session.path), 28) : `App data (${tailPath(prettyPath(session.db_path), 22)})`}
        </span>
      </div>
      {session.kind === "legacy" && !session.read_only && caps.move_to_folder && (
        <div className="settings-row">
          <span className="settings-row-label">Folder of its own</span>
          <button
            className="btn btn-sm"
            onClick={() => window.dispatchEvent(new CustomEvent("minotes-open-notebook-dialog", { detail: "move" }))}
            data-testid="settings-move-notebook"
          >
            Move notebook to a folder…
          </button>
        </div>
      )}
      <div className="settings-subtitle">Markdown copy</div>
      <div className="nb-hint" style={{ padding: "0 0 6px" }}>
        {caps.mirror_always ? (
          <>Every page as a plain <code>.md</code> file, updated a few seconds after each edit — readable by any
          editor, and what Git sync commits.</>
        ) : (
          <>On this device only Git sync uses the markdown copy, so it is written while sync is on. For a
          readable copy elsewhere, use Export notebook (.zip) below.</>
        )}
      </div>
      {(caps.mirror_always || mirror?.enabled) && (
        <>
          <div className="settings-row">
            <span className="settings-row-label">Location</span>
            <span className="settings-row-value nb-path" title={mirror?.dir ?? session.mirror_dir} data-testid="mirror-dir">
              {tailPath(prettyPath(mirror?.dir ?? session.mirror_dir), 28)}
            </span>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">Last written</span>
            <span className="settings-row-value" data-testid="mirror-last-written">{timeAgo(mirror?.last_written_at)}</span>
          </div>
        </>
      )}
      <div className="settings-row">
        <span className="settings-row-label">Status</span>
        <span className={`settings-row-value nb-mirror-status${mirror?.behind ? " behind" : ""}`} data-testid="mirror-status">
          {status}
          {mirror?.behind && (
            <button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={rebuild} disabled={busy}>
              Retry
            </button>
          )}
        </span>
      </div>
      {mirror?.behind && mirror.error && (
        <div className="nb-hint nb-mirror-error" title={mirror.error}>The markdown copy is behind: {mirror.error}</div>
      )}
      <div className="settings-row nb-mirror-actions">
        {caps.reveal_folder && <button className="btn btn-sm" onClick={openFolder} disabled={!api.isTauri} data-testid="mirror-open-folder">
          Open folder
        </button>}
        {(caps.mirror_always || mirror?.enabled) && (
          <button className="btn btn-sm" onClick={rebuild} disabled={busy || !!mirror?.read_only} data-testid="mirror-rebuild">
            {busy ? "Rebuilding…" : "Rebuild markdown copy"}
          </button>
        )}
      </div>
      {caps.notebook_zip && (
        <div className="settings-row">
          <span className="settings-row-label">Copy</span>
          <button
            className="btn btn-sm"
            onClick={() => exportNotebook(session)}
            title="Save this notebook as one .zip file: database, attachments and a markdown copy"
            data-testid="settings-export-zip"
          >
            Export notebook (.zip)…
          </button>
        </div>
      )}
    </div>
  );
}
