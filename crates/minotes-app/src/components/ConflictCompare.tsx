import { useEffect, useState } from "react";
import * as api from "../lib/api";
import { resolveConflict } from "../lib/conflicts";
import { errorMessage } from "../lib/errors";
import { blockPlainText } from "../lib/plainText";
import Modal from "./Modal";
import "./conflicts.css";

type Choice = api.ConflictChoiceKind;

const CHOICES: { value: Choice; label: string; hint: string }[] = [
  { value: "mine", label: "Keep mine", hint: "Keep this device's version" },
  { value: "theirs", label: "Keep theirs", hint: "Use the other device's version" },
  { value: "both", label: "Keep both", hint: "Keep yours and add theirs right after it" },
];

/** One version's text: readable, unless only the markup differs (then as written). */
function Version({ side, other, missing }: { side: api.ConflictSide | null; other: api.ConflictSide | null; missing: string }) {
  if (!side) return <div className="conflict-version missing">{missing}</div>;
  const plain = blockPlainText(side.content).text;
  const samePlain = !!other && blockPlainText(other.content).text === plain;
  const text = samePlain || !plain ? side.content : plain;
  return (
    <div className="conflict-version" style={{ paddingLeft: 10 + side.depth * 14 }} title={side.content}>
      {text}
    </div>
  );
}

/**
 * Compare a sync conflict copy with its page: only the blocks that differ,
 * side by side (this device's page on the left, the other device's version on
 * the right), a choice per block, and Resolve — applied in one step (Ctrl+Z
 * undoes it) that also moves the copy to the Trash.
 */
export default function ConflictCompare({ copyId, onClose, onResolved }: {
  copyId: string;
  onClose: () => void;
  /** After Resolve: the page the copy was merged into. */
  onResolved: (pageId: string) => void;
}) {
  const [cmp, setCmp] = useState<api.ConflictCompare | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.conflictCompare(copyId)
      .then(c => { if (!cancelled) setCmp(c); })
      .catch(e => { if (!cancelled) setError(errorMessage(e).replace(/^Invalid input: /, "")); });
    return () => { cancelled = true; };
  }, [copyId]);

  const rows = cmp?.rows ?? [];
  const left = rows.filter(r => !choices[r.key]).length;
  const setAll = (c: Choice) => setChoices(Object.fromEntries(rows.map(r => [r.key, c])));
  const pageTitle = cmp?.page_title ?? "the page";

  const resolve = async () => {
    if (!cmp?.page_id || left > 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await resolveConflict(copyId, rows.map(r => ({ key: r.key, choice: choices[r.key] })), pageTitle);
      onResolved(r.page_id);
      onClose();
    } catch (e) {
      setError(errorMessage(e).replace(/^Invalid input: /, ""));
    } finally {
      setBusy(false);
    }
  };

  const title = cmp ? `Compare “${pageTitle}” with ${cmp.device}'s version` : "Compare versions";
  return (
    <Modal title={title} onClose={onClose} testId="conflict-compare" wide>
      {!cmp && !error && <p className="nb-hint">Comparing…</p>}
      {cmp && !cmp.page_id && (
        <p className="nb-hint" data-testid="conflict-no-page">
          The page this copy is a version of is gone (deleted for good or renamed beyond recognition). The copy is
          the only place these notes are — keep it, or rename it to make it a normal page.
        </p>
      )}
      {cmp && cmp.page_id && (
        <>
          <p className="nb-hint">
            Both devices changed {rows.length === 1 ? "this block" : `these ${rows.length} blocks`} of “{pageTitle}”.
            Everything else was merged already. Choose a version for each; <strong>Resolve</strong> applies them to
            “{pageTitle}” and moves this copy to the Trash. Ctrl+Z undoes it.
            {cmp.page_trashed && " (“" + pageTitle + "” is in the Trash — restore it to see the result.)"}
          </p>
          {rows.length === 0 ? (
            <p className="nb-hint" data-testid="conflict-nothing">Nothing differs any more: “{pageTitle}” already has everything in this copy.</p>
          ) : (
            <>
              <div className="conflict-bulk" role="group" aria-label="Choose for every block">
                <span className="nb-hint">For every block:</span>
                {CHOICES.map(c => (
                  <button key={c.value} type="button" className="btn btn-sm" onClick={() => setAll(c.value)} data-testid={`conflict-all-${c.value}`}>
                    {c.label}
                  </button>
                ))}
              </div>
              <div className="conflict-head" aria-hidden="true">
                <span>Mine — on this device</span>
                <span>Theirs — from {cmp.device}</span>
              </div>
              <ol className="conflict-rows" data-testid="conflict-rows">
                {rows.map((r, i) => (
                  <li key={r.key} className={`conflict-row${choices[r.key] ? ` chose-${choices[r.key]}` : ""}`} data-testid={`conflict-row-${i}`}>
                    <div className="conflict-pair">
                      <Version side={r.mine} other={r.theirs} missing="(not on this page — new there, or deleted here)" />
                      <Version side={r.theirs} other={r.mine} missing="(not in their version)" />
                    </div>
                    <div className="conflict-choices" role="radiogroup" aria-label={`Block ${i + 1}`}>
                      {CHOICES.map(c => (
                        <button
                          key={c.value}
                          type="button"
                          role="radio"
                          aria-checked={choices[r.key] === c.value}
                          className={`btn btn-sm conflict-choice${choices[r.key] === c.value ? " selected" : ""}`}
                          title={c.hint}
                          onClick={() => setChoices(prev => ({ ...prev, [r.key]: c.value }))}
                          data-testid={`conflict-choice-${i}-${c.value}`}
                        >
                          {c.label}
                        </button>
                      ))}
                    </div>
                  </li>
                ))}
              </ol>
            </>
          )}
        </>
      )}
      {error && <div className="nb-field-error" role="alert" data-testid="conflict-error">{error}</div>}
      <div className="nb-modal-actions">
        {cmp?.page_id && left > 0 && !busy && (
          <span className="disabled-reason" aria-live="polite">Choose a version for {left === 1 ? "1 more block" : `${left} more blocks`}.</span>
        )}
        <button type="button" className="btn btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
        {cmp?.page_id && (
          <button type="button" className="btn btn-sm btn-primary" onClick={resolve} disabled={busy || left > 0} data-testid="conflict-resolve">
            {busy ? "Resolving…" : rows.length === 0 ? "Move the copy to Trash" : "Resolve"}
          </button>
        )}
      </div>
    </Modal>
  );
}
