import { useCallback, useEffect, useState, type ReactElement } from "react";
import * as api from "../lib/api";
import { showToast } from "../lib/toast";
import { errorMessage } from "../lib/errors";
import { NOTEBOOKS_CHANGED, NOTEBOOK_SWITCHED } from "../lib/notebooks";
import "./notebooks.css";

interface Props {
  /** Deletions from another device that git sync held back (from the last sync). */
  heldDeletions: api.HeldDeletions | null;
  onResolveHeld: (action: "trash" | "keep") => void;
}

const dismissKey = (kind: string, key: string) => `minotes-notebook-banner-${kind}@${key}`;

function isDismissed(kind: string, key: string): boolean {
  try { return localStorage.getItem(dismissKey(kind, key)) === "1"; } catch { return false; }
}

/**
 * Notices about the open notebook, above the page: read-only (another MiNotes
 * window has it open), a startup notice (the last notebook's folder is missing),
 * the cloud-folder warning, conflicted database copies made by a file-sync
 * service, and deletions from another device that sync is holding for the user.
 */
export default function NotebookBanner({ heldDeletions, onResolveHeld }: Props) {
  const [session, setSession] = useState<api.NotebookSession | null>(null);
  const [, force] = useState(0);
  const [review, setReview] = useState(false);

  const load = useCallback(() => {
    api.getNotebookSession().then(s => setSession(s ?? null)).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    window.addEventListener(NOTEBOOKS_CHANGED, load);
    window.addEventListener(NOTEBOOK_SWITCHED, load);
    return () => {
      window.removeEventListener(NOTEBOOKS_CHANGED, load);
      window.removeEventListener(NOTEBOOK_SWITCHED, load);
    };
  }, [load]);

  if (!session) return null;
  const dismiss = (kind: string) => {
    try { localStorage.setItem(dismissKey(kind, session.key), "1"); } catch { /* best effort */ }
    force(n => n + 1);
  };

  const takeOver = async () => {
    try {
      await api.takeOverNotebook();
      window.dispatchEvent(new CustomEvent(NOTEBOOK_SWITCHED, { detail: { key: session.key, from: session.key } }));
      showToast("You can edit this notebook here now. Close it in the other window.");
    } catch (e) {
      showToast(`Couldn't open it for editing: ${errorMessage(e)}`);
    }
  };

  const banners: ReactElement[] = [];
  if (session.read_only) {
    banners.push(
      <div key="ro" className="nb-banner warn" role="status" data-testid="readonly-banner">
        <span>
          <strong>Read-only:</strong> this notebook is open in another MiNotes window
          {session.held_by ? ` (${session.held_by})` : ""}. Changes made here would not be saved.
        </span>
        <button className="btn btn-sm" onClick={takeOver} title="Only if the other window is closed or crashed">
          Open for editing anyway
        </button>
      </div>,
    );
  }
  if (session.notice) {
    banners.push(
      <div key="notice" className="nb-banner warn" role="status" data-testid="notebook-notice">
        <span>{session.notice}</span>
        <button className="btn btn-sm" onClick={() => { api.dismissNotebookNotice().then(load).catch(() => {}); }}>
          Dismiss
        </button>
      </div>,
    );
  }
  if (session.cloud && !isDismissed("cloud", session.key)) {
    banners.push(
      <div key="cloud" className="nb-banner info" role="note" data-testid="cloud-banner">
        <span>
          This notebook is in a {session.cloud} folder. MiNotes saves the database cleanly when idle and on
          quit — don't open it on two computers at once; use Git sync for several devices.
        </span>
        <button className="btn btn-sm" onClick={() => dismiss("cloud")}>Got it</button>
      </div>,
    );
  }
  if (session.conflicted_copies.length > 0) {
    banners.push(
      <div key="conflict" className="nb-banner warn" role="status" data-testid="conflicted-copies-banner">
        <span>
          {session.cloud ?? "A file-sync service"} made a conflicted copy of this notebook's database
          ({session.conflicted_copies.join(", ")}). It was edited on two computers at once. This window uses
          <code> notebook.minotes</code>; open the copy as its own notebook to compare before deleting it.
        </span>
      </div>,
    );
  }
  if (heldDeletions && heldDeletions.pages + heldDeletions.folders > 0) {
    const n = heldDeletions.pages;
    banners.push(
      <div key="held" className="nb-banner warn held" role="alert" data-testid="held-deletions-banner">
        <div className="nb-banner-text">
          <span>
            <strong>Another device deleted {n} page{n === 1 ? "" : "s"}</strong>
            {heldDeletions.folders > 0 ? ` and ${heldDeletions.folders} folder${heldDeletions.folders === 1 ? "" : "s"}` : ""}
            {" "}(of {heldDeletions.total_pages}). That is a lot at once, so sync did not remove them here.
            Until you decide, they stay here and are not sent back.
          </span>
          {review && (
            <ul className="nb-held-list">
              {heldDeletions.titles.map(t => <li key={t}>{t}</li>)}
              {n + heldDeletions.folders > heldDeletions.titles.length && <li>…</li>}
            </ul>
          )}
        </div>
        <div className="nb-banner-actions">
          <button className="btn btn-sm" onClick={() => setReview(r => !r)}>{review ? "Hide" : "Review"}</button>
          <button className="btn btn-sm btn-danger" onClick={() => onResolveHeld("trash")} data-testid="held-trash">
            Move to trash
          </button>
          <button className="btn btn-sm" onClick={() => onResolveHeld("keep")} data-testid="held-keep">Keep them</button>
        </div>
      </div>,
    );
  }
  if (banners.length === 0) return null;
  return <div className="nb-banners">{banners}</div>;
}
