import { useEffect, type ReactNode, useRef } from "react";
import "./notebooks.css";
import { useLayer } from "../lib/layers";
import { useDialogFocus } from "../lib/dialogFocus";

/**
 * The notebook / encryption dialogs' modal: Escape and a click outside close it —
 * unless `dismissable` is false (a screen that must not be lost by a stray key,
 * like a recovery key shown only once): then only its × (onClose) closes it.
 */
export default function Modal({ title, onClose, children, wide, testId, dismissable = true }: {
  title: string; onClose: () => void; children: ReactNode; wide?: boolean; testId?: string; dismissable?: boolean;
}) {
  // Esc closes the dialog when it is the topmost layer (lib/layers.ts); a field
  // marked data-escape-local (an inline rename) keeps its own Escape. A
  // non-dismissable dialog still swallows Esc, so nothing underneath closes.
  useLayer(true, "dialog", dismissable ? onClose : null);
  // Focus moves in, Tab stays in, and goes back to the opener on close.
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, true);
  return (
    <div className="nb-modal-backdrop" onMouseDown={e => { if (dismissable && e.target === e.currentTarget) onClose(); }}>
      <div ref={dialogRef} className={`nb-modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} data-testid={testId}>
        <div className="nb-modal-header">
          <span className="nb-modal-title">{title}</span>
          <button className="settings-close-btn" onClick={onClose} aria-label="Close" title="Close (Esc)">×</button>
        </div>
        <div className="nb-modal-body">{children}</div>
      </div>
    </div>
  );
}
