import React, { useRef, useEffect, useState, useCallback } from "react";
import { draggable, dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { attachClosestEdge, extractClosestEdge, type Edge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { autoScrollForElements } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element";
import type { Block } from "../../lib/api";
import * as api from "../../lib/api";
import { extractLabel } from "../mindmap/blocksToFlow";
import KanbanCard from "./KanbanCard";

interface Props {
  column: Block;
  cards: Block[];
  allColumns: Block[];
  subBlockCounts: Map<string, number>;
  pageId: string;
  focusedCardId: string | null;
  searchQuery: string;
  isCollapsed: boolean;
  onToggleCollapse: (colId: string) => void;
  onFocusCard: (id: string) => void;
  onOpenSidePanel: (blockId: string) => void;
  onRefresh: () => void;
}

function KanbanColumn({
  column, cards, allColumns, subBlockCounts, pageId,
  focusedCardId, searchQuery, isCollapsed, onToggleCollapse,
  onFocusCard, onOpenSidePanel, onRefresh,
}: Props) {
  const colRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [closestEdge, setClosestEdge] = useState<Edge | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleText, setTitleText] = useState("");
  const [addingCard, setAddingCard] = useState(false);
  const [newCardText, setNewCardText] = useState("");
  const titleInputRef = useRef<HTMLInputElement>(null);
  const newCardRef = useRef<HTMLTextAreaElement>(null);

  const title = extractLabel(column.content);

  const filteredCards = searchQuery
    ? cards.filter((c) => c.content.toLowerCase().includes(searchQuery.toLowerCase()))
    : cards;

  // Single drop target on column body for card drops
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;

    return dropTargetForElements({
      element: el,
      getData: () => ({ columnId: column.id }),
      canDrop: ({ source }) => !!source.data.cardId,
      onDragEnter: () => setIsDragOver(true),
      onDragLeave: () => setIsDragOver(false),
      onDrop: () => setIsDragOver(false),
    });
  }, [column.id]);

  // Auto-scroll card list during drag
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    return autoScrollForElements({ element: el });
  }, []);

  // Column header drag for reorder
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    return draggable({
      element: el,
      getInitialData: () => ({ columnDragId: column.id }),
    });
  }, [column.id]);

  // Column-level drop target for column reorder (on the outer div, separate from card drops)
  useEffect(() => {
    const el = colRef.current;
    if (!el) return;

    return dropTargetForElements({
      element: el,
      getData: ({ input, element }) =>
        attachClosestEdge(
          { columnDropId: column.id },
          { input, element, allowedEdges: ["left", "right"] },
        ),
      canDrop: ({ source }) => !!source.data.columnDragId && source.data.columnDragId !== column.id,
      onDrag: ({ self }) => setClosestEdge(extractClosestEdge(self.data)),
      onDragLeave: () => setClosestEdge(null),
      onDrop: () => setClosestEdge(null),
    });
  }, [column.id]);

  const startEditTitle = useCallback(() => {
    setTitleText(column.content);
    setEditingTitle(true);
    setTimeout(() => titleInputRef.current?.focus(), 0);
  }, [column.content]);

  const finishEditTitle = useCallback(() => {
    const trimmed = titleText.trim();
    if (trimmed && trimmed !== column.content.trim()) {
      api.updateBlock(column.id, trimmed).then(onRefresh).catch(() => {});
    }
    setEditingTitle(false);
  }, [titleText, column.id, column.content, onRefresh]);

  const handleAddCard = useCallback(() => {
    setAddingCard(true);
    setNewCardText("");
    setTimeout(() => newCardRef.current?.focus(), 0);
  }, []);

  const submitNewCard = useCallback(() => {
    const text = newCardText.trim();
    setAddingCard(false);
    setNewCardText("");
    if (text) {
      api.createBlock(pageId, text, column.id).then(onRefresh).catch(() => {});
    }
  }, [newCardText, pageId, column.id, onRefresh]);

  const handleDeleteColumn = useCallback(() => {
    const count = cards.length;
    const msg = count > 0
      ? `Delete column "${title}" and its ${count} card${count !== 1 ? "s" : ""}?`
      : `Delete empty column "${title}"?`;
    if (confirm(msg)) {
      api.deleteBlock(column.id).then(onRefresh).catch(() => {});
    }
  }, [column.id, cards.length, title, onRefresh]);

  return (
    <>
      {closestEdge === "left" && <div className="kanban-column-drop-indicator" />}
      <div ref={colRef} className={`kanban-column${isCollapsed ? " collapsed" : ""}`} role="group" aria-label={`Column: ${title}`}>
        <div ref={headerRef} className="kanban-column-header" style={{ cursor: "grab" }}>
          {editingTitle ? (
            <input
              ref={titleInputRef}
              className="kanban-title-editor"
              value={titleText}
              onChange={(e) => setTitleText(e.target.value)}
              onBlur={finishEditTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") finishEditTitle();
                if (e.key === "Escape") setEditingTitle(false);
                e.stopPropagation();
              }}
              aria-label="Column title"
            />
          ) : (
            <span className="kanban-column-title" onDoubleClick={startEditTitle}>{title}</span>
          )}
          <div className="kanban-column-actions">
            <span className="kanban-column-count">{cards.length}</span>
            <button
              className="kanban-col-btn"
              onClick={() => onToggleCollapse(column.id)}
              title={isCollapsed ? "Expand" : "Collapse"}
              aria-label={isCollapsed ? "Expand column" : "Collapse column"}
            >
              {isCollapsed ? "+" : "-"}
            </button>
            <button className="kanban-col-btn" onClick={handleDeleteColumn} title="Delete column" aria-label="Delete column">x</button>
          </div>
        </div>
        {!isCollapsed && (
          <>
            <div ref={bodyRef} className={`kanban-column-body${isDragOver ? " drag-over" : ""}`}>
              {filteredCards.length === 0 && isDragOver && (
                <div className="kanban-drop-placeholder">Drop here</div>
              )}
              {filteredCards.length === 0 && !isDragOver && !addingCard && (
                <div className="kanban-empty-col" onClick={handleAddCard}>
                  {searchQuery ? "No matches" : "+ Add your first card"}
                </div>
              )}
              {filteredCards.map((card) => (
                <KanbanCard
                  key={card.id}
                  block={card}
                  subBlockCount={subBlockCounts.get(card.id) ?? 0}
                  columns={allColumns}
                  isFocused={focusedCardId === card.id}
                  onFocus={onFocusCard}
                  onOpenSidePanel={onOpenSidePanel}
                  onRefresh={onRefresh}
                />
              ))}
              {addingCard && (
                <div className="kanban-card new-card">
                  <textarea
                    ref={newCardRef}
                    className="kanban-card-editor"
                    value={newCardText}
                    onChange={(e) => setNewCardText(e.target.value)}
                    placeholder="Card text..."
                    onBlur={submitNewCard}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitNewCard(); }
                      if (e.key === "Escape") { setAddingCard(false); setNewCardText(""); }
                      e.stopPropagation();
                    }}
                    aria-label="New card text"
                  />
                </div>
              )}
            </div>
          </>
        )}
        {!isCollapsed && cards.length > 0 && (
          <button className="kanban-add-card" onClick={handleAddCard} aria-label="Add card">+ Add card</button>
        )}
      </div>
      {closestEdge === "right" && <div className="kanban-column-drop-indicator" />}
    </>
  );
}

export default React.memo(KanbanColumn);
