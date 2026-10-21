import { useEffect, useRef, useState } from "react";
import { answerConfirm, subscribeConfirm, type PendingConfirm } from "../lib/confirm";

/**
 * Renders the dialog `confirmDialog()` (lib/confirm.ts) asks for. Mounted once,
 * outside the lock gate, so it also works on the unlock screen. Keys (Escape,
 * Tab, Enter) are handled in lib/confirm.ts; Cancel has the focus, so a stray
 * Enter never confirms a destructive action.
 */
export default function ConfirmHost() {
  const [current, setCurrent] = useState<PendingConfirm | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  useEffect(() => subscribeConfirm(setCurrent), []);

  useEffect(() => {
    if (!current) return;
    restoreFocus.current = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => {
      const el = restoreFocus.current;
      if (el && el.isConnected && typeof el.focus === "function") el.focus();
    };
  }, [current?.id]);

  if (!current) return null;
  const answer = (ok: boolean) => answerConfirm(current.id, ok);
  return (
    <>
      <div className="confirm-backdrop" onMouseDown={() => answer(false)} data-testid="confirm-backdrop" />
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={current.title ? "confirm-dialog-title" : undefined}
        aria-describedby="confirm-dialog-text"
        data-confirm-dialog=""
        data-testid="confirm-dialog"
      >
        {current.title && <div className="confirm-dialog-title" id="confirm-dialog-title">{current.title}</div>}
        <p className="confirm-dialog-text" id="confirm-dialog-text">{current.message}</p>
        <div className="confirm-dialog-actions">
          <button ref={cancelRef} type="button" className="btn btn-sm" onClick={() => answer(false)} data-testid="confirm-cancel">
            {current.cancelLabel ?? "Cancel"}
          </button>
          <button
            type="button"
            className={`btn btn-sm ${current.danger ? "btn-danger" : "btn-primary"}`}
            onClick={() => answer(true)}
            data-testid="confirm-ok"
          >
            {current.confirmLabel ?? "OK"}
          </button>
        </div>
      </div>
    </>
  );
}
