import { useCallback, useEffect, useState, type ReactElement } from "react";
import * as api from "../lib/api";
import { showToast } from "../lib/toast";
import { errorMessage } from "../lib/errors";
import { NOTEBOOKS_CHANGED, NOTEBOOK_SWITCHED } from "../lib/notebooks";
import { OUTSIDE_EDITS } from "../lib/outsideEdits";
import "./notebooks.css";

interface Props {
  /** Deletions from another device that git sync held back (from the last sync). */
  heldDeletions: api.HeldDeletions | null;
  onResolveHeld: (action: "trash" | "keep") => void;
  /** Open a page (the "(edited outside)" copy of a conflict). */
  onOpenPage?: (id: string) => void;
  /** Git sync is on for this folder, but it was set up on another computer. */
  syncNeedsConfirm?: boolean;
  onConfirmSync?: () => void;
  onDeclineSync?: () => void;
}

/** A notice about edits made to the markdown copy in another app. */
interface OutsideNotice {
  key: string;
  kind: "conflict" | "kept" | "rejected" | "error";
  text: string;
  openId?: string;
}

let noticeSeq = 0;

function outsideNotices(r: api.OutsideReport): OutsideNotice[] {
  const out: OutsideNotice[] = [];
  const key = () => `outside-${++noticeSeq}`;
  for (const c of r.conflicts) {
    out.push({
      key: key(),
      kind: "conflict",
      text: c.page_id
        ? `“${c.title}” was changed both here and in another app (${c.path}). Both are kept: the other version is now the page “${c.copy_title}”.`
        : `${c.path} was edited in another app, but its page is gone here. The edited version was kept as “${c.copy_title}”.`,
      openId: c.copy_id,
    });
  }
  if (r.kept.length) {
    const n = r.kept.length;
    out.push({
      key: key(),
      kind: "kept",
      text: `${n} files were deleted from the markdown copy at once. That is a lot, so MiNotes kept the pages and wrote their files again — delete the pages here if you meant it.`,
    });
  }
  for (const x of r.rejected) {
    out.push({ key: key(), kind: "rejected", text: `${x.path} in the markdown copy can't be read (${x.reason}). It was left untouched and is not updated from here until it is fixed or deleted.` });
  }
  for (const e of r.errors) out.push({ key: key(), kind: "error", text: `Couldn't import an edit made in another app: ${e}` });
  return out;
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
export default function NotebookBanner({ heldDeletions, onResolveHeld, onOpenPage, syncNeedsConfirm, onConfirmSync, onDeclineSync }: Props) {
  const [session, setSession] = useState<api.NotebookSession | null>(null);
  const [notices, setNotices] = useState<OutsideNotice[]>([]);
  const [, force] = useState(0);
  const [review, setReview] = useState(false);

  const load = useCallback(() => {
    api.getNotebookSession().then(s => setSession(s ?? null)).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const onSwitch = () => { setNotices([]); load(); };
    const onOutside = (e: Event) => {
      const r = (e as CustomEvent<api.OutsideReport>).detail;
      if (r) setNotices(prev => [...prev, ...outsideNotices(r)].slice(-6));
    };
    window.addEventListener(NOTEBOOKS_CHANGED, load);
    window.addEventListener(NOTEBOOK_SWITCHED, onSwitch);
    window.addEventListener(OUTSIDE_EDITS, onOutside);
    return () => {
      window.removeEventListener(NOTEBOOKS_CHANGED, load);
      window.removeEventListener(NOTEBOOK_SWITCHED, onSwitch);
      window.removeEventListener(OUTSIDE_EDITS, onOutside);
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
  if (syncNeedsConfirm && !session.read_only) {
    banners.push(
      <div key="sync-confirm" className="nb-banner warn" role="alert" data-testid="sync-confirm-banner">
        <span>
          <strong>Git sync is on for this notebook folder, but it was set up on another computer.</strong>{" "}
          MiNotes won't sync it here until you say so. Only continue if you trust where this folder came from:
          syncing pushes your notes to the folder's remote.
        </span>
        <div className="nb-banner-actions">
          <button className="btn btn-sm" onClick={onConfirmSync} data-testid="sync-confirm">Sync it here</button>
          <button className="btn btn-sm" onClick={onDeclineSync} data-testid="sync-decline">Not now</button>
        </div>
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
  for (const n of notices) {
    banners.push(
      <div key={n.key} className={`nb-banner ${n.kind === "conflict" ? "info" : "warn"}`} role="status" data-testid={`outside-${n.kind}-banner`}>
        <span>{n.text}</span>
        <div className="nb-banner-actions">
          {n.openId && onOpenPage && (
            <button className="btn btn-sm" onClick={() => onOpenPage(n.openId!)} data-testid="outside-open-copy">Open it</button>
          )}
          <button className="btn btn-sm" onClick={() => setNotices(prev => prev.filter(x => x.key !== n.key))}>Dismiss</button>
        </div>
      </div>,
    );
  }
  if (banners.length === 0) return null;
  return <div className="nb-banners">{banners}</div>;
}
