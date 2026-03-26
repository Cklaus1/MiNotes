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
  columnColor: string | null;
  columnColors: string[];
  onSetColumnColor: (colId: string, color: string | null) => void;
  onToggleCollapse: (colId: string) => void;
  onFocusCard: (id: string) => void;
  onOpenSidePanel: (blockId: string) => void;
  onDeleteCard: (block: Block) => void;
  onDeleteColumn: (column: Block, cardCount: number) => void;
  onRefresh: () => void;
}

function KanbanColumn({
  column, cards, allColumns, subBlockCounts, pageId,
  focusedCardId, searchQuery, isCollapsed, columnColor, columnColors,
  onSetColumnColor, onToggleCollapse, onFocusCard, onOpenSidePanel,
  onDeleteCard, onDeleteColumn, onRefresh,
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
  const [showColorPicker, setShowColorPicker] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const newCardRef = useRef<HTMLTextAreaElement>(null);

  // Don't uppercase — show the label as-is (stripped of markdown but preserving case)
  const title = extractLabel(column.content);

  const filteredCards = searchQuery
    ? cards.filter((c) => c.content.toLowerCase().includes(searchQuery.toLowerCase()))
    : cards;

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

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    return autoScrollForElements({ element: el });
  }, []);

  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    return draggable({
      element: el,
      getInitialData: () => ({ columnDragId: column.id }),
    });
  }, [column.id]);

  useEffect(() => {
    const el = colRef.current;
    if (!el) return;
    return dropTargetForElements({
      element: el,
      getData: ({ input, element }) =>
        attachClosestEdge({ columnDropId: column.id }, { input, element, allowedEdges: ["left", "right"] }),
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
    if (text) api.createBlock(pageId, text, column.id).then(onRefresh).catch(() => {});
  }, [newCardText, pageId, column.id, onRefresh]);

  return (
    <>
      {closestEdge === "left" && <div className="kanban-column-drop-indicator" />}
      <div ref={colRef} className={`kanban-column${isCollapsed ? " collapsed" : ""}`} role="group" aria-label={`Column: ${title}`}>
        {/* Color accent bar */}
        {columnColor && <div className="kanban-color-bar" style={{ background: columnColor }} />}

        <div ref={headerRef} className="kanban-column-header">
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
            <button className="kanban-col-btn" onClick={() => setShowColorPicker(!showColorPicker)} title="Column color">●</button>
            <button className="kanban-col-btn" onClick={() => onToggleCollapse(column.id)} title={isCollapsed ? "Expand" : "Collapse"}>
              {isCollapsed ? "+" : "-"}
            </button>
            <button className="kanban-col-btn" onClick={() => onDeleteColumn(column, cards.length)} title="Delete column">x</button>
          </div>

          {/* Color picker popover */}
          {showColorPicker && (
            <>
              <div className="kanban-ctx-backdrop" onClick={() => setShowColorPicker(false)} />
              <div className="kanban-color-picker">
                {columnColors.map((c) => (
                  <button
                    key={c}
                    className={`kanban-color-swatch${columnColor === c ? " active" : ""}`}
                    style={{ background: c }}
                    onClick={() => { onSetColumnColor(column.id, columnColor === c ? null : c); setShowColorPicker(false); }}
                  />
                ))}
                {columnColor && (
                  <button className="kanban-color-clear" onClick={() => { onSetColumnColor(column.id, null); setShowColorPicker(false); }}>
                    Clear
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        {!isCollapsed && (
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
                columnColor={columnColor}
                isFocused={focusedCardId === card.id}
                onFocus={onFocusCard}
                onOpenSidePanel={onOpenSidePanel}
                onDelete={onDeleteCard}
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
