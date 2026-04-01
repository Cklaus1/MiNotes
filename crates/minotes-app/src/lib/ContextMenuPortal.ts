import { createPortal } from "react-dom";
import { createElement, useEffect, useRef, type ReactNode } from "react";

/**
 * Renders a context menu as a portal attached to document.body.
 * Positioned at (x, y) with auto-adjustment to stay within viewport.
 * Not a .tsx file — returns createElement calls to respect React Fast Refresh rules.
 */
export function ContextMenuPortal({
  x, y, children, onClose,
}: {
  x: number;
  y: number;
  children: ReactNode;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay to avoid the opening click from immediately closing
    const timer = setTimeout(() => window.addEventListener("mousedown", handler), 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Adjust position to stay within viewport
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rect.right > vw) {
      menuRef.current.style.left = `${Math.max(4, x - rect.width)}px`;
    }
    if (rect.bottom > vh) {
      menuRef.current.style.top = `${Math.max(4, y - rect.height)}px`;
    }
  });

  const menu = createElement(
    "div",
    {
      ref: menuRef,
      className: "sidebar-context-menu",
      style: { position: "fixed", top: y, left: x, zIndex: 99999 },
      onClick: (e: any) => e.stopPropagation(),
    },
    children
  );

  return createPortal(menu, document.body);
}
