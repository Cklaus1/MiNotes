import { useEffect, useRef } from "react";

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
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
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
