import { useEffect, useMemo, useCallback, useState, useRef } from "react";
import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { autoScrollForElements } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element";
import { extractClosestEdge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import type { Block } from "../../lib/api";
import * as api from "../../lib/api";
import { extractLabel } from "../mindmap/blocksToFlow";
import KanbanColumn from "./KanbanColumn";

const COLUMN_COLORS = ["#89b4fa", "#a6e3a1", "#f9e2af", "#f38ba8", "#cba6f7", "#89dceb", "#fab387"];

interface Props {
  pageId: string;
  pageTitle: string;
  blocks: Block[];
  onRefreshPage: () => void;
}

interface UndoEntry {
  label: string;
  undo: () => Promise<unknown>;
}

export default function KanbanView({ pageId, pageTitle, blocks, onRefreshPage }: Props) {
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sidePanelBlockId, setSidePanelBlockId] = useState<string | null>(null);
  const [collapsedColumns, setCollapsedColumns] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ message: string; undo?: () => void } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);

  const showToast = useCallback((message: string, undoFn?: () => Promise<unknown>) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message, undo: undoFn ? () => { undoFn().then(onRefreshPage); setToast(null); } : undefined });
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, [onRefreshPage]);

  const columns = useMemo(
    () => blocks
      .filter((b) => !b.parent_id && b.content.trim() !== "---")
      .sort((a, b) => a.position - b.position),
    [blocks],
  );

  const cardsByColumn = useMemo(() => {
    const map = new Map<string, Block[]>();
    for (const col of columns) {
      map.set(
        col.id,
        blocks
          .filter((b) => b.parent_id === col.id && b.content.trim() !== "---")
          .sort((a, b) => a.position - b.position),
      );
    }
    return map;
  }, [blocks, columns]);

  const subBlockCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const b of blocks) {
      if (b.parent_id) counts.set(b.parent_id, (counts.get(b.parent_id) ?? 0) + 1);
    }
    return counts;
  }, [blocks]);

  // Column colors stored in localStorage
  const [columnColors, setColumnColors] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem(`kanban-colors-${pageId}`) ?? "{}");
    } catch { return {}; }
  });

  const setColumnColor = useCallback((colId: string, color: string | null) => {
    setColumnColors((prev) => {
      const next = { ...prev };
      if (color) next[colId] = color;
      else delete next[colId];
      localStorage.setItem(`kanban-colors-${pageId}`, JSON.stringify(next));
      return next;
    });
  }, [pageId]);

  const filteredCardIdsByColumn = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const col of columns) {
      const cards = cardsByColumn.get(col.id) ?? [];
      const filtered = searchQuery
        ? cards.filter((c) => c.content.toLowerCase().includes(searchQuery.toLowerCase()))
        : cards;
      map.set(col.id, filtered.map((c) => c.id));
    }
    return map;
  }, [columns, cardsByColumn, searchQuery]);

  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    return autoScrollForElements({ element: el });
  }, []);

  // Centralized drop handler
  useEffect(() => {
    return monitorForElements({
      onDrop: ({ source, location }) => {
        const dest = location.current.dropTargets[0];
        if (!dest) return;

        if (source.data.columnDragId) {
          const colTarget = location.current.dropTargets.find((t) => t.data.columnDropId);
          if (!colTarget) return;
          const draggedColId = source.data.columnDragId as string;
          const targetColId = colTarget.data.columnDropId as string;
          if (draggedColId === targetColId) return;

          const edge = extractClosestEdge(colTarget.data);
          const targetIndex = columns.findIndex((c) => c.id === targetColId);
          if (targetIndex === -1) return;

          let newPosition: number;
          if (edge === "left") {
            const prev = targetIndex > 0 ? columns[targetIndex - 1].position : 0;
            newPosition = (prev + columns[targetIndex].position) / 2;
          } else {
            const next = targetIndex < columns.length - 1 ? columns[targetIndex + 1].position : columns[targetIndex].position + 1;
            newPosition = (columns[targetIndex].position + next) / 2;
          }

          api.reorderBlock(draggedColId, undefined, newPosition)
            .then(onRefreshPage).catch(() => onRefreshPage());
          return;
        }

        if (!source.data.cardId) return;
        const cardId = source.data.cardId as string;
        const sourceColumnId = source.data.sourceColumnId as string | null;
        const cardTarget = location.current.dropTargets.find((t) => t.data.cardId);
        const colTarget = location.current.dropTargets.find((t) => t.data.columnId);
        const targetCardId = cardTarget?.data.cardId as string | undefined;
        const targetColumnId = (colTarget?.data.columnId as string) ?? sourceColumnId;
        if (!targetColumnId) return;

        const targetCards = cardsByColumn.get(targetColumnId) ?? [];
        let newPosition: number;

        if (targetCardId) {
          const edge = extractClosestEdge(cardTarget!.data);
          const targetIndex = targetCards.findIndex((c) => c.id === targetCardId);
          if (targetIndex === -1) { newPosition = targetCards.length; }
          else if (edge === "top") {
            const prev = targetIndex > 0 ? targetCards[targetIndex - 1].position : 0;
            newPosition = (prev + targetCards[targetIndex].position) / 2;
          } else {
            const next = targetIndex < targetCards.length - 1 ? targetCards[targetIndex + 1].position : targetCards[targetIndex].position + 1;
            newPosition = (targetCards[targetIndex].position + next) / 2;
          }
        } else {
          const maxPos = targetCards.reduce((max, c) => Math.max(max, c.position), 0);
          newPosition = maxPos + 1;
        }

        if (sourceColumnId === targetColumnId) {
          api.reorderBlock(cardId, targetColumnId, newPosition)
            .then(onRefreshPage).catch(() => onRefreshPage());
        } else {
          api.moveBlock(cardId, targetColumnId, newPosition)
            .then(onRefreshPage).catch(() => onRefreshPage());
        }
      },
    });
  }, [cardsByColumn, columns, onRefreshPage]);

  // Delete with undo toast
  const handleDeleteCard = useCallback((block: Block) => {
    const content = block.content;
    const parentId = block.parent_id;
    const position = block.position;
    api.deleteBlock(block.id).then(() => {
      onRefreshPage();
      showToast(`Deleted "${extractLabel(content)}"`, () =>
        api.createBlock(pageId, content, parentId ?? undefined)
      );
    }).catch(() => {});
  }, [pageId, onRefreshPage, showToast]);

  const handleDeleteColumn = useCallback((column: Block, cardCount: number) => {
    const title = extractLabel(column.content);
    const msg = cardCount > 0
      ? `Delete column "${title}" and its ${cardCount} card${cardCount !== 1 ? "s" : ""}?`
      : `Delete empty column "${title}"?`;
    if (!confirm(msg)) return;
    api.deleteBlock(column.id).then(() => {
      onRefreshPage();
      showToast(`Deleted column "${title}"`);
    }).catch(() => {});
  }, [onRefreshPage, showToast]);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;

      if ((e.key === "f" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && !focusedCardId)) {
        e.preventDefault();
        (document.querySelector(".kanban-search-input") as HTMLInputElement)?.focus();
        return;
      }

      if (!focusedCardId) return;
      const card = blocks.find((b) => b.id === focusedCardId);
      if (!card) return;
      const colIdx = columns.findIndex((c) => c.id === card.parent_id);

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (colIdx === -1) return;
        const colCards = filteredCardIdsByColumn.get(columns[colIdx].id) ?? [];
        const idx = colCards.indexOf(focusedCardId);
        const next = e.key === "ArrowDown" ? idx + 1 : idx - 1;
        if (next >= 0 && next < colCards.length) setFocusedCardId(colCards[next]);
      }

      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        if (colIdx === -1) return;
        const nextColIdx = e.key === "ArrowRight" ? colIdx + 1 : colIdx - 1;
        if (nextColIdx < 0 || nextColIdx >= columns.length) return;
        const nextColCards = filteredCardIdsByColumn.get(columns[nextColIdx].id) ?? [];
        if (nextColCards.length === 0) return;
        const currentCards = filteredCardIdsByColumn.get(columns[colIdx].id) ?? [];
        const cardIdx = currentCards.indexOf(focusedCardId);
        setFocusedCardId(nextColCards[Math.min(Math.max(cardIdx, 0), nextColCards.length - 1)]);
      }

      if (e.key === "n" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        if (card.parent_id) api.createBlock(pageId, "", card.parent_id).then(onRefreshPage).catch(() => {});
      }

      if (e.key === "Escape") {
        if (sidePanelBlockId) setSidePanelBlockId(null);
        else setFocusedCardId(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [focusedCardId, sidePanelBlockId, blocks, columns, filteredCardIdsByColumn, pageId, onRefreshPage]);

  const handleAddColumn = useCallback(async () => {
    try {
      await api.createBlock(pageId, "New Column");
      onRefreshPage();
      setTimeout(() => {
        boardRef.current?.querySelector(".kanban-add-column")
          ?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "end" });
      }, 150);
    } catch {}
  }, [pageId, onRefreshPage]);

  const toggleCollapse = useCallback((colId: string) => {
    setCollapsedColumns((prev) => {
      const next = new Set(prev);
      if (next.has(colId)) next.delete(colId); else next.add(colId);
      return next;
    });
  }, []);

  const handleExport = useCallback(() => {
    const esc = (s: string) => s.replace(/\|/g, "\\|");
    let md = `# ${esc(pageTitle)}\n\n`;
    md += "| " + columns.map((c) => esc(extractLabel(c.content))).join(" | ") + " |\n";
    md += "| " + columns.map(() => "---").join(" | ") + " |\n";
    const maxCards = Math.max(...columns.map((c) => (cardsByColumn.get(c.id) ?? []).length), 1);
    for (let i = 0; i < maxCards; i++) {
      const row = columns.map((c) => {
        const cards = cardsByColumn.get(c.id) ?? [];
        return i < cards.length ? esc(extractLabel(cards[i].content)) : "";
      });
      md += "| " + row.join(" | ") + " |\n";
    }
    navigator.clipboard.writeText(md).then(() => showToast("Copied board as markdown table")).catch(() => {});
  }, [pageTitle, columns, cardsByColumn, showToast]);

  const sidePanelBlock = sidePanelBlockId ? blocks.find((b) => b.id === sidePanelBlockId) : null;

  if (columns.length === 0) {
    return (
      <div className="kanban-empty">
        <p>This page is empty.</p>
        <p>Add your first column to start a kanban board.</p>
        <button className="btn btn-primary" onClick={handleAddColumn}>+ Add Column</button>
      </div>
    );
  }

  return (
    <div className="kanban-container">
      <div className="kanban-toolbar">
        <input
          className="kanban-search-input"
          type="text"
          placeholder="Filter cards... (Ctrl+F)"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <button className="kanban-toolbar-btn" onClick={handleExport} title="Copy board as markdown table">
          Copy as Table
        </button>
      </div>

      <div className="kanban-board" ref={boardRef} role="region" aria-label="Kanban board">
        {columns.map((col) => (
          <KanbanColumn
            key={col.id}
            column={col}
            cards={cardsByColumn.get(col.id) ?? []}
            allColumns={columns}
            subBlockCounts={subBlockCounts}
            pageId={pageId}
            focusedCardId={focusedCardId}
            searchQuery={searchQuery}
            isCollapsed={collapsedColumns.has(col.id)}
            columnColor={columnColors[col.id] ?? null}
            columnColors={COLUMN_COLORS}
            onSetColumnColor={setColumnColor}
            onToggleCollapse={toggleCollapse}
            onFocusCard={setFocusedCardId}
            onOpenSidePanel={setSidePanelBlockId}
            onDeleteCard={handleDeleteCard}
            onDeleteColumn={handleDeleteColumn}
            onRefresh={onRefreshPage}
          />
        ))}
        <button className="kanban-add-column" onClick={handleAddColumn} aria-label="Add column">
          <span>+</span>
          Add column
        </button>
      </div>

      {/* Undo toast */}
      {toast && (
        <div className="kanban-toast">
          <span>{toast.message}</span>
          {toast.undo && <button className="kanban-toast-undo" onClick={toast.undo}>Undo</button>}
          <button className="kanban-toast-close" onClick={() => setToast(null)}>x</button>
        </div>
      )}

      {sidePanelBlock && (
        <div className="kanban-side-panel" role="dialog" aria-label="Card details">
          <div className="kanban-side-header">
            <span className="kanban-side-title">{extractLabel(sidePanelBlock.content)}</span>
            <button className="kanban-side-close" onClick={() => setSidePanelBlockId(null)} aria-label="Close">x</button>
          </div>
          <div className="kanban-side-body">
            <label className="kanban-side-label">Content</label>
            <SidePanelEditor block={sidePanelBlock} onRefresh={onRefreshPage} />
            {blocks.filter((b) => b.parent_id === sidePanelBlock.id).length > 0 && (
              <>
                <label className="kanban-side-label">Sub-blocks</label>
                <ul className="kanban-side-subblocks">
                  {blocks
                    .filter((b) => b.parent_id === sidePanelBlock.id)
                    .sort((a, b) => a.position - b.position)
                    .map((sub) => (
                      <li key={sub.id}>{extractLabel(sub.content)}</li>
                    ))}
                </ul>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SidePanelEditor({ block, onRefresh }: { block: Block; onRefresh: () => void }) {
  const [text, setText] = useState(block.content);
  const savedRef = useRef(block.content);

  useEffect(() => { setText(block.content); savedRef.current = block.content; }, [block.content]);

  const save = useCallback(() => {
    const trimmed = text.trim();
    if (trimmed !== savedRef.current.trim()) {
      savedRef.current = trimmed;
      api.updateBlock(block.id, trimmed).then(onRefresh).catch(() => {});
    }
  }, [text, block.id, onRefresh]);

  return (
    <textarea className="kanban-side-editor" value={text} onChange={(e) => setText(e.target.value)} onBlur={save} rows={6} aria-label="Card content" />
  );
}
