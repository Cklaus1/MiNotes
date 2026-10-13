import { useEffect, useRef, useState, type ReactNode } from "react";
import * as api from "../lib/api";
import { showToast } from "../lib/toast";
import { errorMessage } from "../lib/errors";
import { flushPendingEdits } from "../lib/pendingEdits";
import {
  exportNotebook, formatSize, importNotebookFromZip, notebooksChanged, pickFolder, prettyPath, switchNotebook, timeAgo,
  useCapabilities,
} from "../lib/notebooks";

function Modal({ title, onClose, children, wide, testId }: {
  title: string; onClose: () => void; children: ReactNode; wide?: boolean; testId?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="nb-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`nb-modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} data-testid={testId}>
        <div className="nb-modal-header">
          <span className="nb-modal-title">{title}</span>
          <button className="settings-close-btn" onClick={onClose} aria-label="Close" title="Close (Esc)">×</button>
        </div>
        <div className="nb-modal-body">{children}</div>
      </div>
    </div>
  );
}

/** Same check as minotes-core notebook::validate_name. */
function nameProblem(name: string, existing: string[]): string | null {
  if (!name.trim()) return null;
  if (name.trim() !== name) return "No spaces at the start or end.";
  if (/[/\\.\0]/.test(name) || /[\u0000-\u001f]/.test(name)) return "Letters, numbers, spaces, - and _ only (no dots or slashes).";
  if (name.length > 100) return "At most 100 characters.";
  if (existing.includes(name)) return `There already is a notebook named “${name}”.`;
  return null;
}

const CLOUD_RE = /(^|[/\\])(dropbox( \([^)]*\))?|icloud drive|mobile documents|onedrive( - [^/\\]*)?|google drive|googledrive|my drive|pcloud drive|box|box sync|nextcloud|owncloud)([/\\]|$)|com~apple~clouddocs/i;

function cloudName(path: string): string | null {
  const m = CLOUD_RE.exec(path);
  if (!m) return null;
  const s = (m[2] ?? "iCloud Drive").toLowerCase();
  if (s.startsWith("dropbox")) return "Dropbox";
  if (s.startsWith("onedrive")) return "OneDrive";
  if (s.includes("icloud") || s.includes("mobile documents") || s.includes("clouddocs")) return "iCloud Drive";
  if (s.includes("google") || s === "my drive") return "Google Drive";
  return "a file-sync service";
}

function CloudWarning({ service }: { service: string }) {
  return (
    <div className="nb-warning" role="note" data-testid="cloud-warning">
      <strong>This folder looks like it is synced by {service}.</strong> A live database in a file-sync
      folder can be damaged when the service copies it mid-write, and two computers editing it at once
      will conflict. MiNotes saves the database cleanly when idle and on quit, but for using a notebook on
      several devices, Git sync (Settings → Sync &amp; Backup) is the safe way — or keep only the markdown
      copy in {service}.
    </div>
  );
}

/** "New notebook…": a name and a folder (default ~/MiNotes/<name>). */
export function NewNotebookDialog({ existingNames, onClose }: { existingNames: string[]; onClose: () => void }) {
  const [name, setName] = useState("");
  const [parent, setParent] = useState<string | null>(null); // chosen parent folder
  const [defaultLoc, setDefaultLoc] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const caps = useCapabilities();
  const problem = nameProblem(name, existingNames);

  useEffect(() => {
    let cancelled = false;
    api.defaultNotebookLocation(name.trim() || "Notebook").then(p => { if (!cancelled) setDefaultLoc(p); }).catch(() => {});
    return () => { cancelled = true; };
  }, [name]);

  const location = parent ? `${parent.replace(/[/\\]+$/, "")}/${name.trim() || "Notebook"}` : defaultLoc;
  const cloud = cloudName(location);

  const choose = async () => {
    // Start in the folder the default location would go into (~/MiNotes's parent).
    const start = parent ?? defaultLoc.replace(/[/\\][^/\\]*[/\\][^/\\]*$/, "");
    const picked = await pickFolder("Choose where to put the notebook", start || undefined);
    if (picked) setParent(picked);
  };

  const create = async () => {
    if (!name.trim() || problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const nb = await api.createNotebook(name.trim(), caps.choose_location ? location : undefined);
      await switchNotebook(nb.key);
      notebooksChanged();
      showToast(`Created notebook “${nb.name}” in ${prettyPath(nb.path)}`);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="New notebook" onClose={onClose} testId="new-notebook-dialog">
      <label className="nb-field">
        <span className="nb-label">Name</span>
        <input
          className="search-input"
          autoFocus
          value={name}
          placeholder="e.g. Work"
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") create(); }}
          aria-label="Notebook name"
          data-testid="new-notebook-name"
        />
      </label>
      {problem && <div className="nb-field-error">{problem}</div>}
      {!caps.choose_location ? (
        <div className="nb-hint" data-testid="new-notebook-app-storage">
          Kept in MiNotes' own storage on this device. Use Export notebook… for a copy you can keep
          elsewhere, or Git sync to use it on other devices.
        </div>
      ) : (
      <div className="nb-field">
        <span className="nb-label">Location</span>
        <div className="nb-location-row">
          <code className="nb-location" title={location} data-testid="new-notebook-location">{prettyPath(location)}</code>
          <button className="btn btn-sm" onClick={choose} data-testid="new-notebook-choose">Choose…</button>
        </div>
        <span className="nb-hint">
          A folder you own: the database, plus a plain-markdown copy of every page in <code>notes/</code>.
          Copying the folder is a complete backup.
        </span>
      </div>
      )}
      {caps.choose_location && cloud && <CloudWarning service={cloud} />}
      {error && <div className="nb-field-error" role="alert">{error}</div>}
      <div className="nb-modal-actions">
        <button className="btn btn-sm" onClick={onClose}>Cancel</button>
        <button
          className="btn btn-sm btn-primary"
          onClick={create}
          disabled={!name.trim() || !!problem || busy}
          data-testid="new-notebook-create"
        >
          {busy ? "Creating…" : "Create notebook"}
        </button>
      </div>
    </Modal>
  );
}

/** Delete with "type the notebook's name" confirmation. */
function DeleteConfirm({ nb, onCancel, onDeleted }: { nb: api.NotebookInfo; onCancel: () => void; onDeleted: () => void }) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const del = async () => {
    if (typed !== nb.name) return;
    try {
      await api.deleteNotebook(nb.key);
      showToast(`Deleted notebook “${nb.name}”`);
      onDeleted();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <div className="nb-delete-confirm" data-testid="delete-notebook-confirm">
      <p>
        Delete <strong>{nb.name}</strong>? Its database is deleted and cannot be restored from MiNotes.
        The plain-markdown copy in <code>{prettyPath(nb.mirror_dir)}</code> is kept.
      </p>
      <label className="nb-field">
        <span className="nb-label">Type <strong>{nb.name}</strong> to confirm</span>
        <input
          className="search-input"
          autoFocus
          value={typed}
          onChange={e => setTyped(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") del(); }}
          aria-label="Type the notebook name to confirm"
          data-testid="delete-notebook-typed"
        />
      </label>
      {error && <div className="nb-field-error" role="alert">{error}</div>}
      <div className="nb-modal-actions">
        <button className="btn btn-sm" onClick={onCancel}>Cancel</button>
        <button className="btn btn-sm btn-danger" disabled={typed !== nb.name} onClick={del} data-testid="delete-notebook-go">
          Delete notebook
        </button>
      </div>
    </div>
  );
}

/** "Manage notebooks…": rename, delete (not the open one), locate, move to a folder. */
export function ManageNotebooksDialog({ notebooks, session, onClose, onMove, onLocate }: {
  notebooks: api.NotebookInfo[];
  session: api.NotebookSession;
  onClose: () => void;
  onMove: () => void;
  onLocate: (nb: api.NotebookInfo) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [deleting, setDeleting] = useState<api.NotebookInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const caps = useCapabilities();

  const startRename = (nb: api.NotebookInfo) => {
    setRenaming(nb.key);
    setNewName(nb.name);
    setError(null);
    setTimeout(() => renameRef.current?.select(), 0);
  };
  const commitRename = async (nb: api.NotebookInfo) => {
    const n = newName.trim();
    if (!n || n === nb.name) { setRenaming(null); return; }
    const problem = nameProblem(n, notebooks.filter(x => x.key !== nb.key).map(x => x.name));
    if (problem) { setError(problem); return; }
    try {
      await api.renameNotebook(nb.key, n);
      setRenaming(null);
      notebooksChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const forget = async (nb: api.NotebookInfo) => {
    try {
      await api.forgetNotebook(nb.key);
      notebooksChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Modal title="Manage notebooks" onClose={onClose} wide testId="manage-notebooks-dialog">
      {deleting ? (
        <DeleteConfirm nb={deleting} onCancel={() => setDeleting(null)} onDeleted={() => { setDeleting(null); notebooksChanged(); }} />
      ) : (
        <>
          <ul className="nb-manage-list">
            {notebooks.map(nb => {
              const current = nb.key === session.key;
              return (
                <li key={nb.key} className={`nb-manage-row${nb.available ? "" : " unavailable"}`} data-notebook-key={nb.key}>
                  <div className="nb-manage-main">
                    {renaming === nb.key ? (
                      <input
                        ref={renameRef}
                        className="search-input nb-rename-input"
                        value={newName}
                        onChange={e => setNewName(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === "Enter") commitRename(nb);
                          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setRenaming(null); }
                        }}
                        onBlur={() => commitRename(nb)}
                        aria-label={`New name for ${nb.name}`}
                      />
                    ) : (
                      <span className="nb-manage-name">
                        {nb.name}
                        {current && <span className="nb-badge">open</span>}
                        {!nb.available && <span className="nb-badge warn">unavailable</span>}
                      </span>
                    )}
                    <span className="nb-manage-meta">
                      {caps.app_storage ? "On this device" : nb.kind === "folder" ? prettyPath(nb.path) : `${prettyPath(nb.path)} (app data folder)`}
                      {nb.available && <> · {formatSize(nb.size_bytes)} · opened {timeAgo(nb.last_opened)}</>}
                    </span>
                  </div>
                  <div className="nb-manage-actions">
                    {nb.available ? (
                      <>
                        <button className="btn btn-sm" onClick={() => startRename(nb)}>Rename</button>
                        {caps.notebook_zip && (
                          <button
                            className="btn btn-sm"
                            onClick={() => exportNotebook(nb)}
                            title={`Save “${nb.name}” as one .zip file`}
                            data-testid="export-notebook"
                          >
                            Export…
                          </button>
                        )}
                        {current && nb.kind === "legacy" && caps.move_to_folder && (
                          <button className="btn btn-sm" onClick={onMove} data-testid="move-notebook-open">Move to a folder…</button>
                        )}
                        <button
                          className="btn btn-sm btn-danger"
                          disabled={current}
                          title={current ? "This notebook is open — switch to another notebook first" : `Delete ${nb.name}`}
                          onClick={() => { setError(null); setDeleting(nb); }}
                          data-testid="delete-notebook"
                        >
                          Delete…
                        </button>
                      </>
                    ) : (
                      <>
                        {caps.open_folder && <button className="btn btn-sm" onClick={() => onLocate(nb)}>Locate…</button>}
                        <button className="btn btn-sm" onClick={() => forget(nb)} title="Remove from this list; no files are touched">
                          Remove from list
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {error && <div className="nb-field-error" role="alert">{error}</div>}
          {caps.notebook_zip && (
            <div className="nb-modal-actions" style={{ justifyContent: "flex-start" }}>
              <button
                className="btn btn-sm"
                onClick={async () => { if (await importNotebookFromZip()) onClose(); }}
                title="Add a notebook from a MiNotes .zip as a new notebook (nothing existing is replaced)"
                data-testid="import-notebook-zip"
              >
                Import notebook (.zip)…
              </button>
            </div>
          )}
          <div className="nb-hint">
            {caps.app_storage
              ? "Notebooks are kept in MiNotes' own storage on this device. Export… saves a .zip copy anywhere you choose."
              : "Renaming changes the name shown here; the folder keeps its name. Deleting keeps the markdown copy."}
          </div>
        </>
      )}
    </Modal>
  );
}

/** "Move notebook to a folder…": convert the open ~/.minotes notebook. */
export function MoveNotebookDialog({ session, onClose }: { session: api.NotebookSession; onClose: () => void }) {
  const [parent, setParent] = useState<string | null>(null);
  const [defaultLoc, setDefaultLoc] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.defaultNotebookLocation(session.name).then(setDefaultLoc).catch(() => {});
  }, [session.name]);

  const folderName = session.name.replace(/[/\\:*?"<>|]/g, "_");
  const location = parent ? `${parent.replace(/[/\\]+$/, "")}/${folderName}` : defaultLoc;
  const cloud = cloudName(location);

  const move = async () => {
    setBusy(true);
    setError(null);
    try {
      // The database is copied, then the old one deleted: a save landing in
      // between would be lost, so flush first (same barrier as a switch).
      await flushPendingEdits();
      const s = await api.moveNotebookToFolder(location);
      notebooksChanged();
      showToast(`“${s.name}” now lives in ${prettyPath(s.path)}`);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (session.kind !== "legacy") {
    return (
      <Modal title="Move notebook" onClose={onClose}>
        <p>This notebook already lives in its own folder: <code>{prettyPath(session.path)}</code>.</p>
      </Modal>
    );
  }
  return (
    <Modal title={`Move “${session.name}” to a folder`} onClose={onClose} testId="move-notebook-dialog">
      <p className="nb-hint">
        MiNotes copies the database into the new folder, checks the copy (integrity and row counts),
        moves the markdown copy along (with its git history), and only then removes the old files.
        If anything fails, nothing changes.
      </p>
      <div className="nb-field">
        <span className="nb-label">New location</span>
        <div className="nb-location-row">
          <code className="nb-location" title={location}>{prettyPath(location)}</code>
          <button className="btn btn-sm" onClick={async () => { const p = await pickFolder("Choose where to put the notebook"); if (p) setParent(p); }}>
            Choose…
          </button>
        </div>
      </div>
      {cloud && <CloudWarning service={cloud} />}
      {error && <div className="nb-field-error" role="alert">{error}</div>}
      <div className="nb-modal-actions">
        <button className="btn btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-sm btn-primary" onClick={move} disabled={busy || !location} data-testid="move-notebook-go">
          {busy ? "Moving…" : "Move notebook"}
        </button>
      </div>
    </Modal>
  );
}
