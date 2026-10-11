import { useEffect, useRef } from "react";
import { TABLE_ACTIONS, type TableAction } from "../editor/tables";

interface Props {
  x: number;
  y: number;
  blockId: string;
  blockContent: string;
  onClose: () => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onCopyRef: (id: string) => void;
  onToggleTodo: (id: string) => void;
  isFlashcard?: boolean;
  onToggleFlashcard?: () => void;
  /** Present when the menu was opened on a table cell. */
  onTableAction?: (action: TableAction) => void;
}

export default function BlockContextMenu({
  x,
  y,
  blockId,
  blockContent,
  onClose,
  onDelete,
  onDuplicate,
  onCopyRef,
  onToggleTodo,
  isFlashcard = false,
  onToggleFlashcard,
  onTableAction,
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  // Adjust position to keep menu on screen
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const el = menuRef.current;
    if (rect.right > window.innerWidth) {
      el.style.left = `${window.innerWidth - rect.width - 8}px`;
    }
    if (rect.bottom > window.innerHeight) {
      el.style.top = `${window.innerHeight - rect.height - 8}px`;
    }
  }, [x, y]);

  const handleCopyRef = () => {
    navigator.clipboard.writeText(`((${blockId}))`);
    onCopyRef(blockId);
    onClose();
  };

  const handleCopyContent = () => {
    navigator.clipboard.writeText(blockContent);
    onClose();
  };

  const handleDuplicate = () => {
    onDuplicate(blockId);
    onClose();
  };

  const handleToggleTodo = () => {
    onToggleTodo(blockId);
    onClose();
  };

  const handleDelete = () => {
    onDelete(blockId);
    onClose();
  };

  return (
    <div
      ref={menuRef}
      className="block-context-menu"
      style={{ left: x, top: y }}
    >
      {onTableAction && (
        <>
          {TABLE_ACTIONS.map(({ action, label, danger }) => (
            <button
              key={action}
              className="block-context-menu-item"
              data-table-action={action}
              style={danger ? { color: "var(--danger)" } : undefined}
              onClick={() => { onTableAction(action); onClose(); }}
            >
              {label}
            </button>
          ))}
          <div className="block-context-menu-sep" />
        </>
      )}
      <button className="block-context-menu-item" onClick={handleCopyRef}>
        Copy block reference
      </button>
      <button className="block-context-menu-item" onClick={handleCopyContent}>
        Copy content
      </button>
      <div className="block-context-menu-sep" />
      <button className="block-context-menu-item" onClick={handleDuplicate}>
        Duplicate block
      </button>
      <button className="block-context-menu-item" onClick={handleToggleTodo}>
        Toggle TODO
      </button>
      {onToggleFlashcard && (
        <button
          className="block-context-menu-item"
          data-action="flashcard"
          title={isFlashcard ? undefined : "This block is the question; its child blocks are the answer"}
          onClick={() => { onToggleFlashcard(); onClose(); }}
        >
          {isFlashcard ? "Remove flashcard" : "Make flashcard"}
          {!isFlashcard && <span className="block-context-menu-hint">question = this block, answer = children</span>}
        </button>
      )}
      <div className="block-context-menu-sep" />
      <button
        className="block-context-menu-item"
        onClick={handleDelete}
        style={{ color: "var(--danger)" }}
      >
        Delete block
      </button>
    </div>
  );
}
