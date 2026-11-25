import { useEffect, useState } from "react";
import Modal from "./Modal";
import ShortcutsList from "./ShortcutsList";
import { OPEN_SHORTCUTS_EVENT } from "../lib/shortcuts";

/**
 * Ctrl+/ (anywhere, also while editing) or the palette's "Keyboard Shortcuts":
 * the full shortcut list in a dialog, so it isn't buried at the bottom of
 * Settings. Ctrl+/ again or Esc closes it.
 */
export default function ShortcutsOverlay() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "/" || e.code === "Slash") && !e.defaultPrevented) {
        e.preventDefault();
        setOpen(v => !v);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
    };
  }, []);
  if (!open) return null;
  return (
    <Modal title="Keyboard shortcuts" onClose={() => setOpen(false)} wide testId="shortcuts-overlay">
      <div className="shortcuts-overlay-body">
        <ShortcutsList />
      </div>
    </Modal>
  );
}
