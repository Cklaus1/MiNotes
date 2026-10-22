import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../lib/api";
import { useEscapeToClose } from "../lib/escapeStack";
import { confirmDialog, plural } from "../lib/confirm";
import { showToast } from "../lib/toast";
import { errorMessage } from "../lib/errors";
import { blockPlainText } from "../lib/plainText";
import Icon from "./Icon";
import "./navigation.css";

type Kind = "trash" | "archive";
interface Item { id: string; title: string; item_type: "page" | "folder"; page_count: number; at: string }

function displayTitle(title: string): string {
  if (!title.startsWith("Journal/")) return title;
  const [y, m, d] = title.slice(8).split("-").map(Number);
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1);
  return isNaN(dt.getTime()) ? title : dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function when(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** "3 pages and 1 project (5 pages in it)" for a confirmation. */
function describe(items: Item[]): string {
  const pages = items.filter(i => i.item_type === "page").length;
  const projects = items.filter(i => i.item_type === "folder");
  const inside = projects.reduce((n, p) => n + p.page_count, 0);
  const parts = [
    pages ? plural(pages, "page") : "",
    projects.length ? `${plural(projects.length, "project")}${inside ? ` (${plural(inside, "page")} in ${projects.length === 1 ? "it" : "them"})` : ""}` : "",
  ].filter(Boolean);
  return parts.join(" and ");
}

/**
 * The Trash and the Archive as a view in the main pane (UX Wave 4): every
 * item with when it went there, a preview of the selected page, and
 * multi-select Restore / Delete permanently (Trash) or Unarchive (Archive).
 * Permanent deletes ask first, with the counts.
 */
export default function TrashView({ kind, onOpenPage, onClose, onChanged }: {
  kind: Kind;
  onOpenPage: (id: string) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const isTrash = kind === "trash";
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; tree: api.PageTree | null; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Reloads can overlap (an outside-write refresh): an answer older than the
  // one shown is dropped.
  const loadSeq = useRef(0);
  const shownSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const list: Item[] = isTrash
        ? (await api.listTrash()).map(t => ({ ...t, at: t.deleted_at }))
        : (await api.listArchived()).map(a => ({ ...a, at: a.archived_at }));
      if (seq < shownSeq.current) return;
      shownSeq.current = seq;
      setItems(list);
      setError(null);
      setSelected(prev => new Set([...prev].filter(id => list.some(i => i.id === id))));
      setFocusId(prev => (prev && list.some(i => i.id === prev) ? prev : list[0]?.id ?? null));
    } catch (e) {
      setError(`Couldn't load the ${kind}: ${errorMessage(e)}`);
    }
  }, [isTrash, kind]);

  useEffect(() => {
    setItems(null);
    setSelected(new Set());
    setFocusId(null);
    load();
    const reload = () => { load(); };
    window.addEventListener("minotes-sidebar-refresh", reload);
    return () => window.removeEventListener("minotes-sidebar-refresh", reload);
  }, [load]);

  useEscapeToClose(true, onClose, "canvas");

  const focused = items?.find(i => i.id === focusId) ?? null;

  // Preview of the focused page (a project shows its page count).
  useEffect(() => {
    if (!focused || focused.item_type !== "page") { setPreview(null); return; }
    let live = true;
    setPreview({ id: focused.id, tree: null });
    api.getPageTree(focused.id).then(
      tree => { if (live) setPreview({ id: focused.id, tree }); },
      e => { if (live) setPreview({ id: focused.id, tree: null, error: errorMessage(e) }); },
    );
    return () => { live = false; };
  }, [focused?.id, focused?.item_type]); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = useMemo(() => (items ?? []).filter(i => selected.has(i.id)), [items, selected]);
  // Actions work on the ticked items, else the focused one.
  const targets = chosen.length ? chosen : focused ? [focused] : [];

  const toggle = (id: string, range: boolean) => {
    if (!items) return;
    setSelected(prev => {
      const next = new Set(prev);
      if (range && anchor) {
        const a = items.findIndex(i => i.id === anchor);
        const b = items.findIndex(i => i.id === id);
        const [lo, hi] = a < b ? [a, b] : [b, a];
        for (let k = lo; k <= hi; k++) next.add(items[k].id);
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setAnchor(id);
    setFocusId(id);
  };

  const allChecked = !!items?.length && selected.size === items.length;
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set((items ?? []).map(i => i.id)));

  const restore = async (list: Item[]) => {
    if (!list.length || busy) return;
    setBusy(true);
    let ok = 0;
    const failed: string[] = [];
    for (const it of list) {
      try {
        if (isTrash) await api.restoreFromTrash(it.id, it.item_type);
        else if (it.item_type === "folder") await api.unarchiveFolder(it.id);
        else await api.unarchivePage(it.id);
        ok++;
      } catch (e) {
        failed.push(`“${displayTitle(it.title)}” (${errorMessage(e)})`);
      }
    }
    setBusy(false);
    setSelected(new Set());
    await load();
    onChanged();
    if (ok) showToast(isTrash ? `Restored ${describe(list.slice(0, ok))}` : `Unarchived ${describe(list.slice(0, ok))}`);
    if (failed.length) showToast(`Couldn't ${isTrash ? "restore" : "unarchive"} ${failed.join(", ")}`, 8000);
  };

  const deleteForever = async (list: Item[]) => {
    if (!isTrash || !list.length || busy) return;
    const one = list.length === 1 ? list[0] : null;
    if (!(await confirmDialog({
      title: one ? `Delete “${displayTitle(one.title)}” permanently?` : `Delete ${plural(list.length, "item")} permanently?`,
      message: `${describe(list)} ${list.length === 1 && !(one && one.item_type === "folder" && one.page_count) ? "is" : "are"} deleted for good, with every block. This can't be undone.`,
      confirmLabel: one ? "Delete permanently" : `Delete ${plural(list.length, "item")}`,
      danger: true,
    }))) return;
    setBusy(true);
    const failed: string[] = [];
    for (const it of list) {
      try { await api.permanentlyDelete(it.id, it.item_type); } catch (e) { failed.push(`“${displayTitle(it.title)}” (${errorMessage(e)})`); }
    }
    setBusy(false);
    setSelected(new Set());
    await load();
    onChanged();
    if (failed.length) showToast(`Couldn't delete ${failed.join(", ")}`, 8000);
    else showToast(`Deleted ${plural(list.length, "item")} permanently`);
  };

  const emptyTrash = async () => {
    if (!items?.length || busy) return;
    const pages = items.reduce((n, t) => n + (t.item_type === "folder" ? t.page_count : 1), 0);
    const projects = items.filter(t => t.item_type === "folder").length;
    const parts = [plural(pages, "page"), projects ? plural(projects, "project") : ""].filter(Boolean).join(" and ");
    if (!(await confirmDialog({
      title: "Empty the trash?",
      message: `${parts} in the trash ${pages + projects === 1 ? "is" : "are"} deleted for good. This can't be undone.`,
      confirmLabel: `Delete ${plural(items.length, "item")}`,
      danger: true,
    }))) return;
    setBusy(true);
    try {
      await api.emptyTrash();
      showToast("The trash is empty");
    } catch (e) {
      showToast(`Couldn't empty the trash: ${errorMessage(e)}`);
    }
    setBusy(false);
    setSelected(new Set());
    await load();
    onChanged();
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (!items?.length) return;
    const i = Math.max(0, items.findIndex(x => x.id === focusId));
    const move = (to: number) => {
      const t = items[Math.max(0, Math.min(items.length - 1, to))];
      setFocusId(t.id);
      if (e.shiftKey) toggle(t.id, true);
      requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-item-id="${t.id}"]`)?.focus());
    };
    if (e.key === "ArrowDown") { e.preventDefault(); move(i + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(i - 1); }
    else if (e.key === "Home") { e.preventDefault(); move(0); }
    else if (e.key === "End") { e.preventDefault(); move(items.length - 1); }
    else if (e.key === " ") { e.preventDefault(); if (focusId) toggle(focusId, false); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); toggleAll(); }
    else if (e.key === "Delete" && isTrash) { e.preventDefault(); void deleteForever(targets); }
  };

  const title = isTrash ? "Trash" : "Archive";
  const verb = isTrash ? "Restore" : "Unarchive";

  return (
    <div className="system-view" data-testid={isTrash ? "trash-view" : "archive-view"} role="region" aria-label={title}>
      <div className="system-view-header">
        <h2><Icon name={isTrash ? "trash" : "archive"} size={18} /> {title}</h2>
        <span className="system-view-count">{items ? plural(items.length, "item") : ""}</span>
        <div className="system-view-actions">
          <button
            className="btn btn-sm"
            disabled={!targets.length || busy}
            onClick={() => void restore(targets)}
            title={targets.length ? undefined : `Select something to ${verb.toLowerCase()}`}
            data-testid="trash-restore-selected"
          >
            <Icon name="rotate-ccw" size={14} /> {verb}{chosen.length > 1 ? ` ${chosen.length}` : ""}
          </button>
          {isTrash && (
            <button
              className="btn btn-sm btn-danger"
              disabled={!targets.length || busy}
              onClick={() => void deleteForever(targets)}
              title={targets.length ? "Delete for good (Del)" : "Select something to delete"}
              data-testid="trash-delete-selected"
            >
              <Icon name="x" size={14} /> Delete permanently{chosen.length > 1 ? ` ${chosen.length}` : ""}
            </button>
          )}
          {isTrash && (
            <button
              className="btn btn-sm"
              disabled={!items?.length || busy}
              onClick={() => void emptyTrash()}
              title={items?.length ? "Delete everything in the trash for good" : "The trash is empty"}
              data-testid="empty-trash"
            >
              Empty trash
            </button>
          )}
          <button className="btn btn-sm tasks-close" onClick={onClose} title="Close (Esc)" aria-label={`Close ${title.toLowerCase()}`}><Icon name="x" size={14} /></button>
        </div>
      </div>
      {error && <div className="nb-field-error" role="alert">{error}</div>}
      <div className="system-view-body">
        <div className="system-view-list" ref={listRef} role="listbox" aria-multiselectable="true" aria-label={`${title} items`} onKeyDown={onListKey}>
          {items && items.length > 0 && (
            <label className="system-view-selectall">
              <input type="checkbox" checked={allChecked} onChange={toggleAll} data-testid="trash-select-all" aria-label="Select all" />
              {selected.size ? `${selected.size} of ${items.length} selected` : "Select all"}
            </label>
          )}
          {items === null && !error && <div className="tasks-empty">Loading…</div>}
          {items && items.length === 0 && (
            <div className="tasks-empty" data-testid="trash-empty-state">
              {isTrash ? "The trash is empty. Deleted pages and projects wait here until you restore them or delete them for good." : "Nothing is archived. Archive a page or project to hide it without deleting it."}
            </div>
          )}
          {items?.map(it => (
            <div
              key={it.id}
              className={`system-view-row${it.id === focusId ? " focused" : ""}${selected.has(it.id) ? " checked" : ""}`}
              role="option"
              aria-selected={selected.has(it.id)}
              tabIndex={it.id === focusId ? 0 : -1}
              data-item-id={it.id}
              data-testid="trash-item"
              onClick={e => { setFocusId(it.id); if (e.shiftKey || e.ctrlKey || e.metaKey) toggle(it.id, e.shiftKey); }}
              onDoubleClick={() => { if (!isTrash && it.item_type === "page") onOpenPage(it.id); }}
            >
              <input
                type="checkbox"
                checked={selected.has(it.id)}
                onClick={e => e.stopPropagation()}
                onChange={e => toggle(it.id, (e.nativeEvent as MouseEvent).shiftKey)}
                aria-label={`Select ${displayTitle(it.title)}`}
                data-testid="trash-check"
              />
              <span className="system-view-title" title={displayTitle(it.title)}>
                <Icon name={it.item_type === "folder" ? "folder" : "page"} size={14} /> {displayTitle(it.title)}
                {it.item_type === "folder" && <span className="system-view-meta"> · project, {plural(it.page_count, "page")}</span>}
              </span>
              <span className="system-view-date" data-testid="trash-date">{isTrash ? "Deleted" : "Archived"} {when(it.at)}</span>
              <span className="system-view-row-actions">
                <button
                  className="sidebar-trash-action-btn"
                  title={verb}
                  aria-label={`${verb} ${displayTitle(it.title)}`}
                  data-testid="trash-restore"
                  onClick={e => { e.stopPropagation(); void restore([it]); }}
                ><Icon name="rotate-ccw" size={13} /></button>
                {isTrash && (
                  <button
                    className="sidebar-trash-action-btn danger"
                    title="Delete permanently"
                    aria-label={`Delete ${displayTitle(it.title)} permanently`}
                    data-testid="trash-delete"
                    onClick={e => { e.stopPropagation(); void deleteForever([it]); }}
                  ><Icon name="x" size={13} /></button>
                )}
              </span>
            </div>
          ))}
        </div>
        <aside className="system-view-preview" aria-label="Preview" data-testid="trash-preview">
          {!focused && <div className="tasks-empty">Select an item to see it here.</div>}
          {focused && (
            <>
              <h3>{displayTitle(focused.title)}</h3>
              <div className="system-view-preview-meta">
                {isTrash ? "Deleted" : "Archived"} {when(focused.at)}
                {focused.item_type === "folder" && <> · a project with {plural(focused.page_count, "page")}</>}
              </div>
              <div className="system-view-preview-actions">
                <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void restore([focused])} data-testid="trash-preview-restore">
                  <Icon name="rotate-ccw" size={14} /> {verb}
                </button>
                {focused.item_type === "page" && !isTrash && (
                  <button className="btn btn-sm" onClick={() => onOpenPage(focused.id)}>Open</button>
                )}
              </div>
              {focused.item_type === "page" && preview?.id === focused.id && (
                preview.error ? <div className="tasks-empty">Couldn't load the page: {preview.error}</div>
                : !preview.tree ? <div className="tasks-empty">Loading…</div>
                : <PagePreview tree={preview.tree} />
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

/** Read-only outline of a page: plain text, indented by depth (first 200 blocks). */
function PagePreview({ tree }: { tree: api.PageTree }) {
  const depth = new Map<string, number>();
  const rows = tree.blocks.slice(0, 200).map(b => {
    const d = b.parent_id ? (depth.get(b.parent_id) ?? 0) + 1 : 0;
    depth.set(b.id, d);
    const plain = blockPlainText(b.content);
    return { id: b.id, d, text: plain.text, state: plain.state };
  });
  if (!rows.some(r => r.text.trim())) return <div className="tasks-empty">This page is empty.</div>;
  return (
    <ul className="system-view-outline" data-testid="trash-preview-blocks">
      {rows.map(r => (
        <li key={r.id} style={{ paddingLeft: r.d * 16 }}>
          {r.state && <span className={`tasks-state tasks-state-${r.state.toLowerCase()}`}>{r.state}</span>} {r.text || " "}
        </li>
      ))}
      {tree.blocks.length > 200 && <li className="system-view-meta">… {tree.blocks.length - 200} more blocks</li>}
    </ul>
  );
}
