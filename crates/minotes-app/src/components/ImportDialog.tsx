import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../lib/api";
import { errorMessage } from "../lib/errors";
import { formatSize, pickFolder, prettyPath, switchNotebook } from "../lib/notebooks";
import { showToast } from "../lib/toast";
import { takeNextImportPick } from "../lib/importPicks";
import "./import.css";

type Step = "source" | "scanning" | "preview" | "importing" | "report" | "undone";

interface Props {
  initialKind?: api.ImportSourceKind;
  onClose: () => void;
  onOpenPage: (titleOrId: string) => unknown;
  onRefresh: () => unknown;
}

const DEFAULT_OPTIONS: api.ImportOptions = {
  split: "outline",
  daily_notes: true,
  unlinked_files: true,
  collisions: "keep_both",
  parent_project: null,
};

const SOURCES: { kind: api.ImportSourceKind; title: string; hint: string; pick: string }[] = [
  { kind: "obsidian", title: "Obsidian vault", hint: "A vault folder — notes, folders, links, attachments, daily notes", pick: "Choose vault folder…" },
  { kind: "evernote", title: "Evernote", hint: "One or more .enex exports (right-click a notebook → Export)", pick: "Choose .enex files…" },
  { kind: "markdown", title: "Markdown folder", hint: "Any folder of .md files; subfolders become Projects", pick: "Choose folder…" },
];

function Progress({ p, label }: { p: api.ImportProgress | null; label: string }) {
  const pct = p && p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : null;
  return (
    <div className="imp-progress" data-testid="import-progress">
      <div className="imp-progress-label">
        <span>{label}</span>
        {pct !== null && <span className="imp-progress-pct">{pct}%</span>}
      </div>
      <div className={`imp-progress-track${pct === null ? " indeterminate" : ""}`}>
        <div className="imp-progress-bar" style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
      {p?.current && <div className="imp-progress-current" title={p.current}>{p.current}</div>}
    </div>
  );
}

function Tree({ node, depth = 0 }: { node: api.ImportTreeNode; depth?: number }) {
  const [open, setOpen] = useState(depth < 2);
  const isProject = node.kind === "project";
  return (
    <li className={`imp-tree-${node.kind}`}>
      <div className="imp-tree-row" onClick={() => isProject && setOpen(o => !o)}>
        <span className="imp-tree-icon" aria-hidden>{isProject ? (open ? "▾" : "▸") : node.kind === "journal" ? "◷" : "·"}</span>
        <span className="imp-tree-name">{node.name}</span>
        {isProject && <span className="imp-tree-count">{countPages(node)}</span>}
      </div>
      {isProject && open && (
        <ul>
          {node.children.map((c, i) => <Tree key={`${c.kind}:${c.name}:${i}`} node={c} depth={depth + 1} />)}
          {node.more > 0 && <li className="imp-tree-more">… and {node.more} more</li>}
        </ul>
      )}
    </li>
  );
}

function countPages(n: api.ImportTreeNode): number {
  return n.children.reduce((s, c) => s + (c.kind === "project" ? countPages(c) : 1), 0) + n.more;
}

function Samples({ samples }: { samples: api.ImportSample[] }) {
  const [i, setI] = useState(0);
  if (!samples.length) return <p className="imp-muted">No notes to show.</p>;
  const s = samples[Math.min(i, samples.length - 1)];
  return (
    <div className="imp-samples" data-testid="import-samples">
      <div className="imp-tabs" role="tablist">
        {samples.map((x, k) => (
          <button key={k} role="tab" aria-selected={k === i} className={`imp-tab${k === i ? " active" : ""}`} onClick={() => setI(k)} title={x.source_path}>
            {x.title}
          </button>
        ))}
      </div>
      <div className="imp-side">
        <div className="imp-pane">
          <div className="imp-pane-title">Source · <span className="imp-mono">{s.source_path}</span></div>
          <pre className="imp-source">{s.source}</pre>
        </div>
        <div className="imp-pane">
          <div className="imp-pane-title">In MiNotes · {s.blocks.length} block{s.blocks.length === 1 ? "" : "s"}</div>
          <ul className="imp-blocks">
            {s.blocks.slice(0, 200).map((b, k) => (
              <li key={k} style={{ paddingLeft: `${b.depth * 16}px` }}>
                <span className="imp-bullet" aria-hidden>•</span>
                <span className="imp-block-text">{b.content}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function Warnings({ warnings, onPage }: { warnings: (api.ImportWarning | api.ImportReportWarning)[]; onPage?: (t: string) => void }) {
  if (!warnings.length) return <p className="imp-ok">Everything converts cleanly.</p>;
  return (
    <ul className="imp-warnings" data-testid="import-warnings">
      {warnings.map(w => {
        const pages: [string, string | null][] = "pages" in w ? w.pages : w.notes.map(n => [n, null]);
        return (
          <li key={w.category}>
            <details>
              <summary><span className="imp-warn-count">{w.count}</span> {w.label}</summary>
              <div className="imp-warn-detail">
                {pages.slice(0, 30).map(([t, id], k) =>
                  id && onPage
                    ? <button key={k} className="imp-link" onClick={() => onPage(id)}>{t}</button>
                    : <span key={k} className="imp-chip">{t}</span>)}
                {pages.length === 0 && w.examples.map((x, k) => <span key={k} className="imp-chip imp-mono">{x}</span>)}
              </div>
            </details>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Import… (PRD-import §3): choose a source → scan → preview (tree, samples
 * beside their source, warnings) → destination + options → import with
 * progress and Cancel → report, saved as a page, with "Undo import".
 */
export default function ImportDialog({ initialKind, onClose, onOpenPage, onRefresh }: Props) {
  const [step, setStep] = useState<Step>("source");
  const [kind, setKind] = useState<api.ImportSourceKind>(initialKind ?? "obsidian");
  const [paths, setPaths] = useState<string[]>([]);
  const [detectNote, setDetectNote] = useState<string | null>(null);
  const [preview, setPreview] = useState<api.ImportPreview | null>(null);
  const [options, setOptions] = useState<api.ImportOptions>(DEFAULT_OPTIONS);
  const [dest, setDest] = useState<"new_notebook" | "current">("new_notebook");
  const [nbName, setNbName] = useState("");
  const [progress, setProgress] = useState<api.ImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<api.ImportResult | null>(null);
  const [undo, setUndo] = useState<api.ImportUndoReport | null>(null);
  const [runs, setRuns] = useState<api.ImportRun[]>([]);
  const [busy, setBusy] = useState(false);
  const stepRef = useRef(step);
  stepRef.current = step;

  useEffect(() => {
    let off: (() => void) | null = null;
    let dead = false;
    api.onImportProgress(p => setProgress(p)).then(u => { if (dead) u(); else off = u; });
    api.importRuns().then(r => setRuns((r ?? []).filter(x => x.status === "done"))).catch(() => {});
    return () => { dead = true; off?.(); };
  }, []);

  const close = useCallback(() => {
    if (stepRef.current === "scanning" || stepRef.current === "importing") {
      api.importCancel().catch(() => {});
      return;
    }
    api.importDiscard().catch(() => {});
    onClose();
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close]);

  const destination = useMemo<api.ImportDestination>(
    () => dest === "current" ? { kind: "current" } : { kind: "new_notebook", name: nbName.trim() || null },
    [dest, nbName],
  );

  // ── Source → scan ──
  const choose = async (k: api.ImportSourceKind) => {
    setError(null);
    setKind(k);
    let picked: string[] = [];
    const hooked = takeNextImportPick();
    if (hooked !== undefined) {
      picked = hooked ?? [];
    } else if (k === "evernote") {
      if (api.isTauri) {
        const r = await api.pickEnexFilesNative("Choose Evernote .enex files");
        picked = Array.isArray(r) ? r : r ? [r] : [];
      } else {
        const r = window.prompt("Path of the .enex file(s), separated by ;", "");
        picked = (r ?? "").split(";").map(s => s.trim()).filter(Boolean);
      }
    } else {
      const r = await pickFolder(k === "obsidian" ? "Choose your Obsidian vault folder" : "Choose a folder of markdown files");
      picked = r ? [r] : [];
    }
    if (!picked.length) return;
    let scanKind = k;
    setDetectNote(null);
    if (k !== "evernote") {
      try {
        const d = await api.importDetect(picked[0]);
        if (d.kind !== k && d.kind !== "evernote") {
          scanKind = d.kind;
          setKind(d.kind);
          setDetectNote(d.kind === "obsidian" ? "This folder has an .obsidian/ directory — importing it as an Obsidian vault." : "No .obsidian/ directory — importing it as a plain markdown folder.");
        }
      } catch { /* keep the user's choice */ }
    }
    setPaths(picked);
    await scan(scanKind, picked, options);
  };

  const scan = async (k: api.ImportSourceKind, p: string[], o: api.ImportOptions) => {
    setStep("scanning");
    setProgress(null);
    try {
      const pv = await api.importScan(k, p, o);
      setPreview(pv);
      setNbName(pv.source_name.replace(/[/\\.]+/g, " ").trim() || "Imported");
      setStep("preview");
    } catch (e) {
      setError(errorMessage(e).includes("cancelled") ? "Scan cancelled." : errorMessage(e));
      setStep("source");
    }
  };

  // Options / destination changed: refresh the preview (samples, titles in use).
  useEffect(() => {
    if (stepRef.current !== "preview") return;
    let dead = false;
    api.importPreview(options, destination).then(pv => { if (!dead) setPreview(pv); }).catch(e => setError(errorMessage(e)));
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.split, options.collisions, options.unlinked_files, dest]);

  const setOpt = <K extends keyof api.ImportOptions>(k: K, v: api.ImportOptions[K]) => {
    const next = { ...options, [k]: v };
    setOptions(next);
    // Daily notes / grouping change what the reader produces: scan again.
    if (k === "daily_notes" || k === "parent_project") scan(kind, paths, next);
  };

  // ── Import ──
  const runImport = async () => {
    setError(null);
    setStep("importing");
    setProgress(null);
    try {
      const r = await api.importRun(destination, options);
      setResult(r);
      if (r.notebook_key) {
        await switchNotebook(r.notebook_key);
      } else {
        await onRefresh();
      }
      setStep("report");
      showToast(`Imported ${r.pages_created} pages`);
    } catch (e) {
      const msg = errorMessage(e);
      setError(msg.includes("cancelled") ? "Import cancelled — nothing was kept." : msg);
      setStep("preview");
    }
  };

  const doUndo = async (runId: string, keepEdited = false) => {
    setBusy(true);
    try {
      const r = await api.importUndo(runId, keepEdited);
      setUndo(r);
      if (r.undone) {
        setStep("undone");
        await onRefresh();
        showToast(`Import undone — ${r.pages_deleted} pages removed`);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const openPage = (id: string) => { onOpenPage(id); onClose(); };

  const c = preview?.counts;
  return (
    <div className="nb-modal-backdrop imp-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && step !== "importing") close(); }}>
      <div className="nb-modal imp-modal" role="dialog" aria-modal="true" aria-label="Import" data-testid="import-dialog" data-step={step}>
        <div className="nb-modal-header">
          <span className="nb-modal-title">
            {step === "report" ? "Import complete" : step === "undone" ? "Import undone" : preview && step !== "source" ? `Import ${preview.source_label} “${preview.source_name}”` : "Import"}
          </span>
          <button className="settings-close-btn" onClick={close} aria-label="Close" title="Close (Esc)">×</button>
        </div>
        <div className="nb-modal-body imp-body">
          {error && <div className="nb-warning imp-error" role="alert" data-testid="import-error">{error}</div>}

          {step === "source" && (
            <>
              <p className="imp-lead">Bring notes in from another app. You'll see a preview before anything is written, and the import goes into a new notebook unless you choose otherwise.</p>
              <div className="imp-sources">
                {SOURCES.map(s => (
                  <button key={s.kind} className={`imp-source-card${s.kind === kind ? " selected" : ""}`} onClick={() => choose(s.kind)} data-import-source={s.kind}>
                    <span className={`imp-source-glyph imp-glyph-${s.kind}`} aria-hidden>{s.kind === "obsidian" ? "◆" : s.kind === "evernote" ? "❦" : "#"}</span>
                    <span className="imp-source-text">
                      <span className="imp-source-title">{s.title}</span>
                      <span className="imp-source-hint">{s.hint}</span>
                      <span className="imp-source-pick">{s.pick}</span>
                    </span>
                  </button>
                ))}
              </div>
              {runs.length > 0 && (
                <div className="imp-runs">
                  <div className="imp-section-title">Earlier imports into this notebook</div>
                  {runs.slice(0, 5).map(r => (
                    <div key={r.id} className="imp-run-row">
                      <span className="imp-run-text">{r.source} · {r.pages} pages · {new Date(r.started_at).toLocaleString()}</span>
                      <button className="btn btn-sm" disabled={busy} onClick={() => doUndo(r.id)} data-testid="import-run-undo">Undo import</button>
                    </div>
                  ))}
                </div>
              )}
              {undo && !undo.undone && <EditedList undo={undo} busy={busy} onRest={() => doUndo(undo.run_id, true)} />}
            </>
          )}

          {step === "scanning" && (
            <>
              <Progress p={progress} label={`Reading ${paths.length > 1 ? `${paths.length} files` : prettyPath(paths[0] ?? "")}…`} />
              <p className="imp-muted">Nothing is written while scanning.</p>
              <div className="nb-modal-actions"><button className="btn" onClick={() => api.importCancel()}>Cancel</button></div>
            </>
          )}

          {step === "preview" && preview && c && (
            <>
              {detectNote && <p className="imp-detect">{detectNote}</p>}
              <div className="imp-stats" data-testid="import-counts">
                <div><strong>{c.pages}</strong><span>pages</span></div>
                <div><strong>{c.folders}</strong><span>Projects</span></div>
                <div><strong>{c.journals}</strong><span>journal days</span></div>
                <div><strong>{c.attachments}</strong><span>attachments · {formatSize(c.attachment_bytes)}</span></div>
                {c.skipped > 0 && <div><strong>{c.skipped}</strong><span>skipped</span></div>}
                {c.reimport > 0 && <div><strong>{c.reimport}</strong><span>already imported</span></div>}
              </div>
              <div className="imp-grid">
                <div className="imp-col">
                  <div className="imp-section-title">Will create</div>
                  <ul className="imp-tree">{preview.tree.map((n, i) => <Tree key={i} node={n} />)}</ul>
                </div>
                <div className="imp-col imp-col-wide">
                  <div className="imp-section-title">Sample notes</div>
                  <Samples samples={preview.samples} />
                </div>
              </div>
              <div className="imp-section-title">Didn't convert cleanly <span className="imp-muted">— kept as text, listed in the report</span></div>
              <Warnings warnings={preview.warnings} />

              <fieldset className="imp-dest" data-testid="import-destination">
                <legend className="imp-section-title">Destination</legend>
                <label className="imp-radio">
                  <input type="radio" name="imp-dest" checked={dest === "new_notebook"} onChange={() => setDest("new_notebook")} />
                  <span>A new notebook named</span>
                  <input className="search-input imp-name" value={nbName} onChange={e => setNbName(e.target.value)} disabled={dest !== "new_notebook"} aria-label="New notebook name" />
                  <span className="imp-muted">(recommended — delete the notebook to discard the import)</span>
                </label>
                <label className="imp-radio">
                  <input type="radio" name="imp-dest" checked={dest === "current"} onChange={() => setDest("current")} />
                  <span>A new Project “Imported from {preview.source_name}” in this notebook</span>
                </label>
              </fieldset>

              <details className="imp-options">
                <summary>Options</summary>
                <label>Split notes into blocks
                  <select value={options.split} onChange={e => setOpt("split", e.target.value as api.SplitMode)} data-testid="import-split">
                    <option value="outline">Outline — headings and lists become nested blocks</option>
                    <option value="paragraph">One block per paragraph</option>
                    <option value="note">One block per note (lossless)</option>
                  </select>
                </label>
                {preview.source === "obsidian" && (
                  <label className="imp-check"><input type="checkbox" checked={options.daily_notes} onChange={e => setOpt("daily_notes", e.target.checked)} /> Daily notes become journal pages</label>
                )}
                {preview.source !== "evernote" && (
                  <label className="imp-check"><input type="checkbox" checked={options.unlinked_files} onChange={e => setOpt("unlinked_files", e.target.checked)} /> Files no note links to go on an “Unlinked files” page</label>
                )}
                <label>Titles already in use
                  <select value={options.collisions} onChange={e => setOpt("collisions", e.target.value as api.ImportOptions["collisions"])}>
                    <option value="keep_both">Keep both (add a number)</option>
                    <option value="skip">Skip the imported note</option>
                  </select>
                </label>
                {preview.source === "evernote" && (
                  <label>Group the notebooks under a Project
                    <input className="search-input" placeholder="(none)" defaultValue={options.parent_project ?? ""} onBlur={e => setOpt("parent_project", e.target.value.trim() || null)} />
                  </label>
                )}
              </details>

              <div className="nb-modal-actions">
                <button className="btn" onClick={() => { setStep("source"); setPreview(null); }}>Back</button>
                <button className="btn btn-primary" onClick={runImport} data-testid="import-start" disabled={c.pages === 0 || (dest === "new_notebook" && !nbName.trim())}>
                  Import {c.pages} pages
                </button>
              </div>
            </>
          )}

          {step === "importing" && (
            <>
              <Progress p={progress} label="Importing…" />
              <p className="imp-muted">Cancel rolls everything back.</p>
              <div className="nb-modal-actions"><button className="btn" onClick={() => api.importCancel()} data-testid="import-cancel">Cancel</button></div>
            </>
          )}

          {step === "report" && result && (
            <>
              <div className="imp-stats" data-testid="import-report">
                <div><strong>{result.pages_created}</strong><span>pages</span></div>
                <div><strong>{result.folders_created}</strong><span>Projects</span></div>
                <div><strong>{result.journals_created}</strong><span>journal days</span></div>
                <div><strong>{result.attachments_created}</strong><span>attachments · {formatSize(result.attachment_bytes)}</span></div>
                {result.pages_updated + result.pages_unchanged > 0 && <div><strong>{result.pages_updated}/{result.pages_unchanged}</strong><span>updated / unchanged</span></div>}
              </div>
              {result.notebook_name && <p>Imported into the new notebook <strong>{result.notebook_name}</strong>, which is now open.</p>}
              <Warnings warnings={result.warnings} onPage={openPage} />
              {undo && !undo.undone && <EditedList undo={undo} busy={busy} onRest={() => doUndo(undo.run_id, true)} />}
              <div className="nb-modal-actions">
                <button className="btn" disabled={busy} onClick={() => doUndo(result.run_id)} data-testid="import-undo">Undo import</button>
                {result.report_page_id && <button className="btn" onClick={() => openPage(result.report_page_id!)} data-testid="import-open-report">Open report page</button>}
                <button className="btn btn-primary" onClick={onClose}>Done</button>
              </div>
            </>
          )}

          {step === "undone" && undo && (
            <>
              <p data-testid="import-undone">Removed {undo.pages_deleted} pages, {undo.folders_deleted} Projects and {undo.attachments_deleted} attachments.
                {undo.edited.length > 0 && ` Kept ${undo.edited.length} page${undo.edited.length === 1 ? "" : "s"} you had edited.`}</p>
              <div className="nb-modal-actions"><button className="btn btn-primary" onClick={onClose}>Done</button></div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function EditedList({ undo, busy, onRest }: { undo: api.ImportUndoReport; busy: boolean; onRest: () => void }) {
  return (
    <div className="nb-warning" role="alert" data-testid="import-undo-refused">
      <strong>Not undone:</strong> {undo.edited.length} imported page{undo.edited.length === 1 ? " was" : "s were"} edited since the import:
      <div className="imp-warn-detail">{undo.edited.map(e => <span key={e.id} className="imp-chip">{e.title}</span>)}</div>
      <div className="nb-modal-actions"><button className="btn btn-sm" disabled={busy} onClick={onRest}>Undo the rest, keep these</button></div>
    </div>
  );
}
