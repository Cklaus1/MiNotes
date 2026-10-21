import { useEffect, type ReactNode } from "react";
import "./notebooks.css";

/**
 * The notebook / encryption dialogs' modal: Escape and a click outside close it —
 * unless `dismissable` is false (a screen that must not be lost by a stray key,
 * like a recovery key shown only once): then only its × (onClose) closes it.
 */
export default function Modal({ title, onClose, children, wide, testId, dismissable = true }: {
  title: string; onClose: () => void; children: ReactNode; wide?: boolean; testId?: string; dismissable?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (dismissable) onClose(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, dismissable]);
  return (
    <div className="nb-modal-backdrop" onMouseDown={e => { if (dismissable && e.target === e.currentTarget) onClose(); }}>
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
