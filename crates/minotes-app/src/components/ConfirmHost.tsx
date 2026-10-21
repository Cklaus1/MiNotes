import { useEffect, useRef, useState } from "react";
import { answerConfirm, subscribeConfirm, type PendingConfirm } from "../lib/confirm";

/**
 * Renders the dialog `confirmDialog()` / `promptDialog()` (lib/confirm.ts) asks
 * for. Mounted once, outside the lock gate, so it also works on the unlock
 * screen. Keys (Escape, Tab, Enter) are handled in lib/confirm.ts; in a confirm
 * Cancel has the focus, so a stray Enter never confirms a destructive action; in
 * a prompt the field has it and Enter answers.
 */
export default function ConfirmHost() {
  const [current, setCurrent] = useState<PendingConfirm | null>(null);
  const [value, setValue] = useState("");
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  useEffect(() => subscribeConfirm(setCurrent), []);

  useEffect(() => {
    if (!current) return;
    restoreFocus.current = document.activeElement as HTMLElement | null;
    setValue(current.input?.value ?? "");
    if (current.input) {
      requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
    } else {
      cancelRef.current?.focus();
    }
    return () => {
      const el = restoreFocus.current;
      if (el && el.isConnected && typeof el.focus === "function") el.focus();
    };
  }, [current?.id]);

  if (!current) return null;
  const answer = (ok: boolean) => answerConfirm(current.id, ok);
  const empty = !!current.input && !value.trim();
  return (
    <>
      <div className="confirm-backdrop" onMouseDown={() => answer(false)} data-testid="confirm-backdrop" />
      <div
        className="confirm-dialog"
        role={current.input ? "dialog" : "alertdialog"}
        aria-modal="true"
        aria-labelledby={current.title ? "confirm-dialog-title" : undefined}
        aria-describedby={current.message ? "confirm-dialog-text" : undefined}
        data-confirm-dialog=""
        data-testid={current.input ? "prompt-dialog" : "confirm-dialog"}
      >
        {current.title && <div className="confirm-dialog-title" id="confirm-dialog-title">{current.title}</div>}
        {current.message && <p className="confirm-dialog-text" id="confirm-dialog-text">{current.message}</p>}
        {current.input && (
          <label className="confirm-dialog-field">
            <span>{current.input.label}</span>
            <input
              ref={inputRef}
              className="search-input"
              value={value}
              placeholder={current.input.placeholder}
              onChange={e => setValue(e.target.value)}
              data-confirm-input=""
              data-testid="prompt-input"
            />
          </label>
        )}
        <div className="confirm-dialog-actions">
          <button ref={cancelRef} type="button" className="btn btn-sm" onClick={() => answer(false)} data-testid="confirm-cancel">
            {current.cancelLabel ?? "Cancel"}
          </button>
          <button
            type="button"
            className={`btn btn-sm ${current.danger ? "btn-danger" : "btn-primary"}`}
            onClick={() => answer(true)}
            disabled={empty}
            data-testid="confirm-ok"
          >
            {current.confirmLabel ?? "OK"}
          </button>
        </div>
      </div>
    </>
  );
}
