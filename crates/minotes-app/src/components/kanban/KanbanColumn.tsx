import React, { useRef, useEffect, useState, useCallback } from "react";
import { draggable, dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { attachClosestEdge, extractClosestEdge, type Edge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { autoScrollForElements } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element";
import type { Block } from "../../lib/api";
import * as api from "../../lib/api";
import KanbanCard from "./KanbanCard";
import { splitHeading, withStatus, type CardStatus } from "./kanbanModel";
import type { Badge } from "../../lib/richText";
import { useEscapeToClose } from "../../lib/escapeStack";

interface Props {
  columnId: string;
  /** The section block behind this column; null for the virtual "No section" column. */
  column: Block | null;
  title: string;
  cards: Block[];
  allColumns: { id: string; title: string }[];
  onMoveCard: (block: Block, toColumnId: string) => void;
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
  onOpenPage: (title: string) => void;
  onDeleteCard: (block: Block) => void;
  onDeleteColumn: (column: Block, cardCount: number) => void;
  onRefresh: () => void;
  /** Group-by-status board: this column is a task state (no block behind it). */
  status?: CardStatus | null;
  badgesByCard?: Map<string, Badge[]>;
}

function KanbanColumn({
  columnId, column, title, cards, allColumns, onMoveCard, subBlockCounts, pageId,
  focusedCardId, searchQuery, isCollapsed, columnColor, columnColors,
  onSetColumnColor, onToggleCollapse, onFocusCard, onOpenSidePanel, onOpenPage,
  onDeleteCard, onDeleteColumn, onRefresh, status = null, badgesByCard,
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

  const isUnsorted = column === null;

  const filteredCards = searchQuery
    ? cards.filter((c) => c.content.toLowerCase().includes(searchQuery.toLowerCase()))
    : cards;

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    return autoScrollForElements({ element: el });
  }, []);

  useEffect(() => {
    // The virtual "No section" column always leads: it can't be dragged or displaced.
    const el = headerRef.current;
    if (!el || isUnsorted) return;
    return draggable({
      element: el,
      getInitialData: () => ({ columnDragId: columnId }),
    });
  }, [columnId, isUnsorted]);

  // The WHOLE column (header, cards, empty area, footer — collapsed too) is one
  // drop target: a card lands at the end of it (or next to the card under the
  // pointer, which is its own target); another column lands left or right of it.
  useEffect(() => {
    const el = colRef.current;
    if (!el) return;
    return dropTargetForElements({
      element: el,
      getData: ({ input, element, source }) =>
        source.data.columnDragId
          ? attachClosestEdge({ columnDropId: columnId }, { input, element, allowedEdges: ["left", "right"] })
          : { columnId },
      canDrop: ({ source }) =>
        !!source.data.cardId ||
        (!isUnsorted && !!source.data.columnDragId && source.data.columnDragId !== columnId),
      onDragEnter: ({ source }) => { if (source.data.cardId) setIsDragOver(true); },
      onDrag: ({ self, source }) => { if (source.data.columnDragId) setClosestEdge(extractClosestEdge(self.data)); },
      onDragLeave: () => { setIsDragOver(false); setClosestEdge(null); },
      onDrop: () => { setIsDragOver(false); setClosestEdge(null); },
    });
  }, [columnId, isUnsorted]);

  // Escape closes only the colour picker (topmost), never the board under it.
  useEscapeToClose(showColorPicker, () => setShowColorPicker(false), "popover");

  // Edit the title text only; the heading marker ("## ") that makes the block a
  // column is kept and re-applied on save.
  const startEditTitle = useCallback(() => {
    if (!column) return;
    setTitleText(splitHeading(column.content).title);
    setEditingTitle(true);
    setTimeout(() => titleInputRef.current?.focus(), 0);
  }, [column]);

  const finishEditTitle = useCallback(() => {
    setEditingTitle(false);
    if (!column) return;
    const trimmed = titleText.trim();
    const { prefix, rest } = splitHeading(column.content);
    const next = prefix + trimmed + rest;
    if (trimmed && next.trim() !== column.content.trim()) {
      api.updateBlock(column.id, next).then(onRefresh).catch(() => {});
    }
  }, [titleText, column, onRefresh]);

  const handleAddCard = useCallback(() => {
    setAddingCard(true);
    setNewCardText("");
    setTimeout(() => newCardRef.current?.focus(), 0);
  }, []);

  const submitNewCard = useCallback(() => {
    const text = newCardText.trim();
    setAddingCard(false);
    setNewCardText("");
    // A status column's new card is a task in that state, at the end of the page.
    if (text) api.createBlock(pageId, status ? withStatus(text, status) : text, column?.id).then(onRefresh).catch(() => {});
  }, [newCardText, pageId, column, onRefresh, status]);

  return (
    <>
      {closestEdge === "left" && <div className="kanban-column-drop-indicator" />}
      <div ref={colRef} className={`kanban-column${isCollapsed ? " collapsed" : ""}${isUnsorted && !status ? " kanban-column-unsorted" : ""}${status ? " kanban-column-status" : ""}${isDragOver ? " drag-over" : ""}`} data-column-id={columnId} data-status={status ?? undefined} role="group" aria-label={`Column: ${title}`}>
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
                if (e.key === "Escape") { e.preventDefault(); setEditingTitle(false); }
                e.stopPropagation();
              }}
              aria-label="Column title"
            />
          ) : (
            <span
              className="kanban-column-title"
              title={status ? `Tasks marked ${title} anywhere on the page — drop a card here to mark it ${title}` : isUnsorted ? "Top-level blocks that are not under a section heading" : title}
              onDoubleClick={startEditTitle}
            >
              {title}
            </span>
          )}
          <div className="kanban-column-actions">
            <span className="kanban-column-count">{cards.length}</span>
            {!status && <button
              className="kanban-col-btn kanban-color-btn"
              onClick={() => setShowColorPicker(!showColorPicker)}
              // No native tooltip while the picker is open: it covered the swatches.
              title={showColorPicker ? undefined : "Column colour"}
              aria-label="Column colour"
              aria-expanded={showColorPicker}
              style={columnColor ? { color: columnColor } : undefined}
            >●</button>}
            <button className="kanban-col-btn" onClick={() => onToggleCollapse(columnId)} title={isCollapsed ? "Expand" : "Collapse"}>
              {isCollapsed ? "+" : "-"}
            </button>
            {column && (
              <button className="kanban-col-btn" onClick={() => onDeleteColumn(column, cards.length)} title="Delete column">x</button>
            )}
          </div>

          {/* Color picker popover */}
          {showColorPicker && (
            <>
              <div className="kanban-ctx-backdrop" onClick={() => setShowColorPicker(false)} />
              <div className="kanban-color-picker" role="menu" aria-label="Column colour">
                {columnColors.map((c) => (
                  <button
                    key={c}
                    aria-label={`Colour ${c}`}
                    data-color={c}
                    className={`kanban-color-swatch${columnColor === c ? " active" : ""}`}
                    style={{ background: c }}
                    onClick={() => { onSetColumnColor(columnId, columnColor === c ? null : c); setShowColorPicker(false); }}
                  />
                ))}
                {columnColor && (
                  <button className="kanban-color-clear" onClick={() => { onSetColumnColor(columnId, null); setShowColorPicker(false); }}>
                    Clear
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        {!isCollapsed && (
          <div ref={bodyRef} className="kanban-column-body">
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
                columnId={columnId}
                columns={allColumns}
                onMoveTo={onMoveCard}
                columnColor={columnColor}
                isFocused={focusedCardId === card.id}
                onFocus={onFocusCard}
                onOpenSidePanel={onOpenSidePanel}
                onOpenPage={onOpenPage}
                onDelete={onDeleteCard}
                onRefresh={onRefresh}
                badges={badgesByCard?.get(card.id)}
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
                    if (e.key === "Escape") { e.preventDefault(); setAddingCard(false); setNewCardText(""); }
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
