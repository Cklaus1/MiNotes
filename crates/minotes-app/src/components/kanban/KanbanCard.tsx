import React, { useRef, useEffect, useState, useCallback } from "react";
import { draggable, dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { attachClosestEdge, extractClosestEdge, type Edge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import type { Block } from "../../lib/api";
import * as api from "../../lib/api";
import { extractLabel, detectTodoState } from "../mindmap/blocksToFlow";

interface Props {
  block: Block;
  subBlockCount: number;
  columns: Block[];
  columnColor: string | null;
  isFocused: boolean;
  onFocus: (id: string) => void;
  onOpenSidePanel: (blockId: string) => void;
  onDelete: (block: Block) => void;
  onRefresh: () => void;
}

function KanbanCard({ block, subBlockCount, columns, columnColor, isFocused, onFocus, onOpenSidePanel, onDelete, onRefresh }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [closestEdge, setClosestEdge] = useState<Edge | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const label = extractLabel(block.content);
  const todoState = detectTodoState(block.content);

  const wikiLinks: string[] = [];
  const re = /\[\[(.+?)\]\]/g;
  let m;
  while ((m = re.exec(block.content)) !== null) wikiLinks.push(m[1]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const dragCleanup = draggable({
      element: el,
      getInitialData: () => ({ cardId: block.id, sourceColumnId: block.parent_id }),
      onDragStart: () => setIsDragging(true),
      onDrop: () => setIsDragging(false),
    });
    const dropCleanup = dropTargetForElements({
      element: el,
      getData: ({ input, element }) =>
        attachClosestEdge({ cardId: block.id, columnId: block.parent_id }, { input, element, allowedEdges: ["top", "bottom"] }),
      canDrop: ({ source }) => source.data.cardId !== block.id,
      onDrag: ({ self }) => setClosestEdge(extractClosestEdge(self.data)),
      onDragLeave: () => setClosestEdge(null),
      onDrop: () => setClosestEdge(null),
    });
    return () => { dragCleanup(); dropCleanup(); };
  }, [block.id, block.parent_id]);

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

  const handleMoveTo = useCallback((columnId: string) => {
    api.moveBlock(block.id, columnId, 999).then(onRefresh).catch(() => {});
    setContextMenu(null);
  }, [block.id, onRefresh]);

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
              if (e.key === "Escape") setEditing(false);
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
                {wikiLinks.map((page, i) => (
                  <span key={i} className="kanban-wiki-link" onClick={(e) => { e.stopPropagation(); onOpenSidePanel(block.id); }}>
                    [[{page}]]
                  </span>
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
            {columns.filter((c) => c.id !== block.parent_id).length > 0 && (
              <>
                <div className="kanban-ctx-divider" />
                <span className="kanban-ctx-label">Move to...</span>
                {columns.filter((c) => c.id !== block.parent_id).map((c) => (
                  <button key={c.id} onClick={() => handleMoveTo(c.id)}>{extractLabel(c.content)}</button>
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
