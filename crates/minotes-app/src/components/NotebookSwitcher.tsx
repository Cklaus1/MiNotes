import { useCallback, useEffect, useRef, useState } from "react";
import { openImport } from "../lib/importPicks";
import * as api from "../lib/api";
import { showToast } from "../lib/toast";
import { errorMessage } from "../lib/errors";
import {
  NOTEBOOKS_CHANGED, NOTEBOOK_SWITCHED, notebooksChanged, pickFolder, prettyPath, switchNotebook,
} from "../lib/notebooks";
import { NewNotebookDialog, ManageNotebooksDialog, MoveNotebookDialog } from "./NotebookDialogs";
import "./notebooks.css";

/** Event other views fire to open a notebook dialog (detail: "new" | "manage" | "move"). */
const OPEN_DIALOG = "minotes-open-notebook-dialog";

type Dialog = null | "new" | "manage" | "move";

/**
 * The notebook switcher in the sidebar header: the open notebook's name next to
 * "MiNotes"; its menu lists the notebooks (the open one checked), and offers
 * New / Open / Manage. Switching lands on that notebook's journal for today.
 */
export default function NotebookSwitcher() {
  const [notebooks, setNotebooks] = useState<api.NotebookInfo[]>([]);
  const [session, setSession] = useState<api.NotebookSession | null>(null);
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const [list, s] = await Promise.all([api.listNotebooks(), api.getNotebookSession()]);
      setNotebooks(list ?? []);
      setSession(s ?? null);
    } catch (e) {
      console.error("Failed to load notebooks:", e);
    }
  }, []);

  useEffect(() => {
    load();
    const reload = () => { load(); };
    const openDialog = (e: Event) => {
      const d = (e as CustomEvent<Dialog>).detail;
      if (d) { setOpen(false); setDialog(d); }
    };
    window.addEventListener(NOTEBOOKS_CHANGED, reload);
    window.addEventListener(NOTEBOOK_SWITCHED, reload);
    window.addEventListener(OPEN_DIALOG, openDialog);
    return () => {
      window.removeEventListener(NOTEBOOKS_CHANGED, reload);
      window.removeEventListener(NOTEBOOK_SWITCHED, reload);
      window.removeEventListener(OPEN_DIALOG, openDialog);
    };
  }, [load]);

  // Close the menu on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = async (nb: api.NotebookInfo) => {
    setOpen(false);
    if (nb.key === session?.key) return;
    if (!nb.available) return;
    setBusy(true);
    try {
      await switchNotebook(nb.key);
      showToast(`Opened notebook “${nb.name}”`);
    } catch (e) {
      showToast(`Couldn't open “${nb.name}”: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const openFolder = async () => {
    setOpen(false);
    const path = await pickFolder("Open a notebook folder");
    if (!path) return;
    try {
      const nb = await api.openNotebookFolder(path);
      await switchNotebook(nb.key);
      notebooksChanged();
      showToast(`Opened notebook “${nb.name}”`);
    } catch (e) {
      showToast(`Couldn't open that folder: ${errorMessage(e)}`);
    }
  };

  const locate = async (nb: api.NotebookInfo) => {
    setOpen(false);
    const path = await pickFolder(`Locate “${nb.name}”`);
    if (!path) return;
    try {
      await api.locateNotebook(nb.key, path);
      await switchNotebook(nb.key);
      notebooksChanged();
      showToast(`Found “${nb.name}”`);
    } catch (e) {
      showToast(`Couldn't use that folder: ${errorMessage(e)}`);
    }
  };

  const name = session?.name ?? "…";

  return (
    <div className="nb-switcher" ref={rootRef}>
      <button
        className="nb-switcher-btn"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={session ? `Notebook: ${session.name}\n${prettyPath(session.path)}\nClick to switch notebooks` : "Switch notebook"}
        disabled={busy}
        data-testid="notebook-switcher"
      >
        <span className="nb-switcher-name">{name}</span>
        {session?.read_only && <span className="nb-badge" title="Open read-only">read-only</span>}
        <span className="nb-switcher-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="nb-menu" role="menu" aria-label="Notebooks">
          <div className="nb-menu-title">Notebooks</div>
          <div className="nb-menu-list">
            {notebooks.map(nb => {
              const current = nb.key === session?.key;
              return (
                <div key={nb.key} className={`nb-menu-row${nb.available ? "" : " unavailable"}`}>
                  <button
                    role="menuitemradio"
                    aria-checked={current}
                    className={`nb-menu-item${current ? " current" : ""}`}
                    onClick={() => choose(nb)}
                    disabled={!nb.available}
                    title={nb.available ? prettyPath(nb.path) : `Unavailable — ${prettyPath(nb.path)} was not found`}
                    data-notebook-key={nb.key}
                  >
                    <span className="nb-check" aria-hidden>{current ? "✓" : ""}</span>
                    <span className="nb-item-text">
                      <span className="nb-item-name">{nb.name}</span>
                      <span className="nb-item-path">
                        {nb.available ? prettyPath(nb.kind === "folder" ? nb.path : nb.mirror_dir) : "unavailable"}
                      </span>
                    </span>
                  </button>
                  {!nb.available && (
                    <button className="btn btn-sm nb-locate" onClick={() => locate(nb)}>Locate…</button>
                  )}
                </div>
              );
            })}
          </div>
          <div className="nb-menu-sep" />
          <button role="menuitem" className="nb-menu-action" onClick={() => { setOpen(false); setDialog("new"); }}>
            New notebook…
          </button>
          <button role="menuitem" className="nb-menu-action" onClick={openFolder}>
            Open notebook…
          </button>
          <button role="menuitem" className="nb-menu-action" onClick={() => { setOpen(false); setDialog("manage"); }}>
            Manage notebooks…
          </button>
          {/* ── Import ── */}
          <div className="nb-menu-sep" />
          <button role="menuitem" className="nb-menu-action" onClick={() => { setOpen(false); openImport(); }} data-testid="menu-import">
            Import…
          </button>
          {/* ── End import ── */}
        </div>
      )}
      {dialog === "new" && (
        <NewNotebookDialog
          existingNames={notebooks.map(n => n.name)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "manage" && session && (
        <ManageNotebooksDialog
          notebooks={notebooks}
          session={session}
          onClose={() => setDialog(null)}
          onMove={() => setDialog("move")}
          onLocate={locate}
        />
      )}
      {dialog === "move" && session && (
        <MoveNotebookDialog session={session} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
