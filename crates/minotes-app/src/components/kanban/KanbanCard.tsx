import React, { useRef, useEffect, useState, useCallback } from "react";
import { draggable, dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { attachClosestEdge, extractClosestEdge, type Edge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import type { Block } from "../../lib/api";
import * as api from "../../lib/api";
import { extractTaskLabel, detectTodoState } from "../mindmap/blocksToFlow";
import { useEscapeToClose } from "../../lib/escapeStack";

interface Props {
  block: Block;
  subBlockCount: number;
  /** Column this card is shown in (a section block id, or the "No section" id). */
  columnId: string;
  columns: { id: string; title: string }[];
  onMoveTo: (block: Block, toColumnId: string) => void;
  columnColor: string | null;
  isFocused: boolean;
  onFocus: (id: string) => void;
  onOpenSidePanel: (blockId: string) => void;
  /** Open a [[wiki link]]'s page (closes the board). */
  onOpenPage: (title: string) => void;
  onDelete: (block: Block) => void;
  onRefresh: () => void;
}

function KanbanCard({ block, subBlockCount, columnId, columns, onMoveTo, columnColor, isFocused, onFocus, onOpenSidePanel, onOpenPage, onDelete, onRefresh }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [closestEdge, setClosestEdge] = useState<Edge | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // The badge shows the TODO/DOING/DONE state, so the keyword is stripped from
  // the displayed text (the stored content keeps it).
  const label = extractTaskLabel(block.content, 240);
  const todoState = detectTodoState(block.content);

  // [[Page]] / [[Page|label]] chips; a cross-notebook [[Notebook::Page]] is shown
  // but opens the card (the board can't switch notebooks).
  const wikiLinks: { target: string; label: string }[] = [];
  const re = /\[\[(.+?)\]\]/g;
  let m;
  while ((m = re.exec(block.content)) !== null) {
    const [target, label] = m[1].split("|");
    wikiLinks.push({ target: target.trim(), label: (label ?? target).trim() });
  }

  // Escape closes only the context menu, not the board.
  useEscapeToClose(!!contextMenu, () => setContextMenu(null), "menu");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const dragCleanup = draggable({
      element: el,
      getInitialData: () => ({ cardId: block.id, sourceColumnId: columnId }),
      onDragStart: () => setIsDragging(true),
      onDrop: () => setIsDragging(false),
    });
    const dropCleanup = dropTargetForElements({
      element: el,
      getData: ({ input, element }) =>
        attachClosestEdge({ cardId: block.id, columnId }, { input, element, allowedEdges: ["top", "bottom"] }),
      canDrop: ({ source }) => source.data.cardId !== block.id,
      onDrag: ({ self }) => setClosestEdge(extractClosestEdge(self.data)),
      onDragLeave: () => setClosestEdge(null),
      onDrop: () => setClosestEdge(null),
    });
    return () => { dragCleanup(); dropCleanup(); };
  }, [block.id, columnId]);

  useEffect(() => {
    if (isFocused && ref.current && !editing) ref.current.focus();
  }, [isFocused, editing]);

  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => setContextMenu(null);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => { window.removeEventListener("scroll", dismiss, true); window.removeEventListener("resize", dismiss); };
  }, [contextMenu]);

  const startEdit = useCallback(() => {
    setEditText(block.content);
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [block.content]);

  const finishEdit = useCallback(() => {
    const trimmed = editText.trim();
    if (trimmed !== block.content.trim()) {
      api.updateBlock(block.id, trimmed).then(onRefresh).catch(() => {});
    }
    setEditing(false);
  }, [editText, block.id, block.content, onRefresh]);

  const handleTodoCycle = useCallback(() => {
    let c = block.content;
    if (c.startsWith("DONE ")) c = c.slice(5);
    else if (c.startsWith("DOING ")) c = "DONE " + c.slice(6);
    else if (c.startsWith("TODO ")) c = "DOING " + c.slice(5);
    else c = "TODO " + c;
    api.updateBlock(block.id, c).then(onRefresh).catch(() => {});
    setContextMenu(null);
  }, [block.id, block.content, onRefresh]);

  const handleMoveTo = useCallback((toColumnId: string) => {
    onMoveTo(block, toColumnId);
    setContextMenu(null);
  }, [block, onMoveTo]);

  return (
    <div className="kanban-card-wrapper">
      {closestEdge === "top" && <div className="kanban-drop-indicator" />}
      <div
        ref={ref}
        className={`kanban-card${isDragging ? " dragging" : ""}${isFocused ? " focused" : ""}`}
        data-todo={todoState?.toUpperCase() ?? undefined}
        style={!todoState && columnColor ? { borderLeftColor: columnColor, borderLeftWidth: 3 } : undefined}
        tabIndex={0}
        role="listitem"
        aria-label={label}
        onClick={() => onFocus(block.id)}
        onDoubleClick={startEdit}
        onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY }); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !editing) { e.preventDefault(); startEdit(); }
          if ((e.key === "Delete" || e.key === "Backspace") && !editing) { e.preventDefault(); onDelete(block); }
        }}
      >
        {editing ? (
          <textarea
            ref={inputRef}
            className="kanban-card-editor"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onBlur={finishEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finishEdit(); }
              if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
              e.stopPropagation();
            }}
            aria-label="Edit card"
          />
        ) : (
          <>
            {todoState && (
              <span className={`kanban-todo-badge kanban-todo-${todoState}`}>
                {todoState.toUpperCase()}
              </span>
            )}
            <span className="kanban-card-text">{label}</span>
            {wikiLinks.length > 0 && (
              <div className="kanban-card-links">
                {wikiLinks.map((l, i) => (
                  <button
                    key={i}
                    type="button"
                    className="kanban-wiki-link"
                    title={l.target.includes("::") ? "Open the card" : `Open “${l.target}”`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (l.target.includes("::")) onOpenSidePanel(block.id);
                      else onOpenPage(l.target);
                    }}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            )}
            {subBlockCount > 0 && (
              <span className="kanban-sub-count">{subBlockCount} sub-block{subBlockCount !== 1 ? "s" : ""}</span>
            )}
            {/* Edit hint — pencil icon on hover */}
            <button className="kanban-card-edit-btn" onClick={(e) => { e.stopPropagation(); startEdit(); }} title="Edit card">✎</button>
          </>
        )}
      </div>
      {closestEdge === "bottom" && <div className="kanban-drop-indicator" />}

      {contextMenu && (
        <>
          <div className="kanban-ctx-backdrop" onClick={() => setContextMenu(null)} />
          <div className="kanban-ctx-menu" style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y }}>
            <button onClick={() => { onOpenSidePanel(block.id); setContextMenu(null); }}>Open</button>
            <button onClick={() => { startEdit(); setContextMenu(null); }}>Edit</button>
            <button onClick={handleTodoCycle}>
              {todoState === "done" ? "Remove DONE" : todoState === "doing" ? "Mark DONE" : todoState === "todo" ? "Mark DOING" : "Add TODO"}
            </button>
            <button onClick={() => { onDelete(block); setContextMenu(null); }}>Delete</button>
            {columns.filter((c) => c.id !== columnId).length > 0 && (
              <>
                <div className="kanban-ctx-divider" />
                <span className="kanban-ctx-label">Move to...</span>
                {columns.filter((c) => c.id !== columnId).map((c) => (
                  <button key={c.id} title={c.title} onClick={() => handleMoveTo(c.id)}>{c.title}</button>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default React.memo(KanbanCard);
