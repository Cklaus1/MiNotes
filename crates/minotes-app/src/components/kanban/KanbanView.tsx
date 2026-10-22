import { useEffect, useMemo, useCallback, useState, useRef } from "react";
import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { autoScrollForElements } from "@atlaskit/pragmatic-drag-and-drop-auto-scroll/element";
import { extractClosestEdge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import type { Block } from "../../lib/api";
import * as api from "../../lib/api";
import { confirmDialog } from "../../lib/confirm";
import { extractLabel, extractTaskLabel } from "../mindmap/blocksToFlow";
import KanbanColumn from "./KanbanColumn";
import CardPanel from "./CardPanel";
import {
  buildKanbanModel, buildStatusModel, statusOfColumn, withStatus, STATUS_COLUMNS, UNSORTED_ID, UNSORTED_TITLE,
} from "./kanbanModel";
import { useEscapeToClose } from "../../lib/escapeStack";
import { coveredAbove } from "../../lib/layers";
import { cardBadges, inlineSegments, segmentsText, type Badge } from "../../lib/richText";
import { localDateKey } from "../../lib/dates";
import { KANBAN_GROUP_KEY, pageViewProps, setPageViewProp, VIEW_KEY } from "../../lib/pageView";
import { showToast as appToast } from "../../lib/toast";
import "../views.css";

type GroupBy = "section" | "status";

/** Block property holding a column's colour (on the column's section block). */
const KANBAN_COLOR_PROP = "kanban-color";
const isColour = (v: string) => /^#[0-9a-fA-F]{6}$/.test(v.trim());

const COLUMN_COLORS = ["#89b4fa", "#a6e3a1", "#f9e2af", "#f38ba8", "#cba6f7", "#89dceb", "#fab387"];

interface Props {
  pageId: string;
  pageTitle: string;
  blocks: Block[];
  onRefreshPage: () => void;
  /** Open a page by title ([[wiki link]] chips on cards). */
  onOpenPage: (title: string) => void;
}

interface UndoEntry {
  label: string;
  undo: () => Promise<unknown>;
}

export default function KanbanView({ pageId, pageTitle, blocks, onRefreshPage, onOpenPage }: Props) {
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

  // Blocks the board has shown as columns stay columns (see buildKanbanModel).
  const [stickyColumnIds, setStickyColumnIds] = useState<Set<string>>(() => {
    try {
      return new Set<string>(JSON.parse(localStorage.getItem(`kanban-columns-${pageId}`) ?? "[]"));
    } catch { return new Set<string>(); }
  });

  // Remembered per page (page properties, written only when the user changes them).
  const [groupBy, setGroupByState] = useState<GroupBy>("section");
  const [opensAsBoard, setOpensAsBoard] = useState(false);
  useEffect(() => {
    let cancelled = false;
    pageViewProps(pageId, true).then((m) => {
      if (cancelled) return;
      setGroupByState(m.get(KANBAN_GROUP_KEY) === "status" ? "status" : "section");
      setOpensAsBoard(m.get(VIEW_KEY) === "kanban");
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [pageId]);
  const setGroupBy = useCallback((g: GroupBy) => {
    setGroupByState(g);
    setPageViewProp(pageId, KANBAN_GROUP_KEY, g === "status" ? "status" : null)
      .catch((e) => appToast(`Couldn't remember the grouping: ${e}`));
  }, [pageId]);
  const toggleOpensAsBoard = useCallback((on: boolean) => {
    setOpensAsBoard(on);
    setPageViewProp(pageId, VIEW_KEY, on ? "kanban" : null)
      .then(() => appToast(on ? `“${pageTitle}” now opens as a board` : `“${pageTitle}” opens as a page again`))
      .catch((e) => appToast(`Couldn't save: ${e}`));
  }, [pageId, pageTitle]);
  const byStatus = groupBy === "status";

  const sectionModel = useMemo(
    () => buildKanbanModel(blocks, pageTitle, stickyColumnIds),
    [blocks, pageTitle, stickyColumnIds],
  );
  const statusModel = useMemo(() => buildStatusModel(blocks), [blocks]);
  const { columns, unsorted } = sectionModel;
  const { cardsByColumn, columnOfCard } = byStatus ? statusModel : sectionModel;

  useEffect(() => {
    if (columns.every((c) => stickyColumnIds.has(c.id))) return;
    const next = new Set(columns.map((c) => c.id));
    try { localStorage.setItem(`kanban-columns-${pageId}`, JSON.stringify([...next])); } catch { /* best effort */ }
    setStickyColumnIds(next);
  }, [columns, stickyColumnIds, pageId]);

  // What the board renders: the virtual "No section" column (only when it has
  // cards) followed by the real section columns.
  const boardColumns = useMemo(() => {
    if (byStatus) return STATUS_COLUMNS.map((c) => ({ id: c.id, block: null as Block | null, title: c.title }));
    const list: { id: string; block: Block | null; title: string }[] = [];
    if (unsorted.length > 0) list.push({ id: UNSORTED_ID, block: null, title: UNSORTED_TITLE });
    for (const c of columns) list.push({ id: c.id, block: c, title: extractLabel(c.content, 200) });
    return list;
  }, [columns, unsorted, byStatus]);

  /** Status board: a card dropped on (or moved to) a column takes its state. */
  const setCardStatus = useCallback((cardId: string, toColumnId: string) => {
    const status = statusOfColumn(toColumnId);
    const card = blocks.find((b) => b.id === cardId);
    if (!status || !card) return;
    const next = withStatus(card.content, status);
    if (next === card.content) return;
    api.updateBlock(cardId, next).then(onRefreshPage).catch((e) => { appToast(`Couldn't change the status: ${e}`); onRefreshPage(); });
  }, [blocks, onRefreshPage]);

  // Badges: tags, due dates and properties of every card (one batched call).
  const cardIdsKey = useMemo(() => [...columnOfCard.keys()].join(","), [columnOfCard]);
  const [cardProps, setCardProps] = useState<Record<string, api.Property[]>>({});
  useEffect(() => {
    let cancelled = false;
    const ids = cardIdsKey ? cardIdsKey.split(",") : [];
    if (ids.length === 0) { setCardProps({}); return; }
    api.getPropertiesBatch(ids).then((p) => { if (!cancelled) setCardProps(p); }).catch(() => {});
    return () => { cancelled = true; };
  }, [cardIdsKey, blocks]);
  const badgesByCard = useMemo(() => {
    const today = localDateKey();
    const m = new Map<string, Badge[]>();
    for (const cards of cardsByColumn.values()) {
      for (const c of cards) {
        const b = cardBadges(c.content, cardProps[c.id] ?? [], today);
        if (b.length) m.set(c.id, b);
      }
    }
    return m;
  }, [cardsByColumn, cardProps]);

  const columnRefs = useMemo(() => boardColumns.map(({ id, title }) => ({ id, title })), [boardColumns]);

  /** Put a card into a column; the "No section" column means the page's top level. */
  const placeCard = useCallback((cardId: string, fromColumnId: string | null, toColumnId: string, position: number) => {
    const op = toColumnId === UNSORTED_ID
      ? api.reorderBlock(cardId, undefined, position)
      : fromColumnId === toColumnId
        ? api.reorderBlock(cardId, toColumnId, position)
        : api.moveBlock(cardId, toColumnId, position);
    op.then(onRefreshPage).catch(() => onRefreshPage());
  }, [onRefreshPage]);

  const handleMoveCardTo = useCallback((block: Block, toColumnId: string) => {
    if (statusOfColumn(toColumnId)) { setCardStatus(block.id, toColumnId); return; }
    const cards = cardsByColumn.get(toColumnId) ?? [];
    const maxPos = cards.reduce((max, c) => Math.max(max, c.position), 0);
    placeCard(block.id, columnOfCard.get(block.id) ?? null, toColumnId, maxPos + 1);
  }, [cardsByColumn, columnOfCard, placeCard, setCardStatus]);

  const subBlockCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const b of blocks) {
      if (b.parent_id) counts.set(b.parent_id, (counts.get(b.parent_id) ?? 0) + 1);
    }
    return counts;
  }, [blocks]);

  // Column colours travel with the board: a `kanban-color` property on the
  // column's section block (synced like any block property). Only the virtual
  // "No section" column, which has no block, keeps its colour in this device's
  // localStorage — as every column did before (migrated on first open).
  const legacyKey = `kanban-colors-${pageId}`;
  const readLegacy = useCallback((): Record<string, string> => {
    try { return JSON.parse(localStorage.getItem(legacyKey) ?? "{}"); } catch { return {}; }
  }, [legacyKey]);
  const writeLegacy = useCallback((m: Record<string, string>) => {
    try {
      if (Object.keys(m).length) localStorage.setItem(legacyKey, JSON.stringify(m));
      else localStorage.removeItem(legacyKey);
    } catch { /* best effort */ }
  }, [legacyKey]);
  const [columnColors, setColumnColors] = useState<Record<string, string>>(() => readLegacy());

  const columnIdsKey = columns.map((c) => c.id).join(",");
  useEffect(() => {
    let cancelled = false;
    const ids = columnIdsKey ? columnIdsKey.split(",") : [];
    (ids.length ? api.getPropertiesBatch(ids) : Promise.resolve({} as Record<string, api.Property[]>)).then((props) => {
      if (cancelled) return;
      const legacy = readLegacy();
      const next: Record<string, string> = {};
      if (legacy[UNSORTED_ID]) next[UNSORTED_ID] = legacy[UNSORTED_ID];
      for (const id of ids) {
        const stored = props[id]?.find((p) => p.key === KANBAN_COLOR_PROP)?.value ?? null;
        if (stored && isColour(stored)) next[id] = stored;
        else if (legacy[id] && isColour(legacy[id])) {
          next[id] = legacy[id];
          api.setProperty(id, "block", KANBAN_COLOR_PROP, legacy[id]).then(() => {
            const l = readLegacy(); delete l[id]; writeLegacy(l);
          }).catch(() => {});
        }
      }
      setColumnColors(next);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [columnIdsKey, readLegacy, writeLegacy]);

  const setColumnColor = useCallback((colId: string, color: string | null) => {
    setColumnColors((prev) => {
      const next = { ...prev };
      if (color) next[colId] = color; else delete next[colId];
      return next;
    });
    if (colId === UNSORTED_ID) {
      const l = readLegacy();
      if (color) l[colId] = color; else delete l[colId];
      writeLegacy(l);
      return;
    }
    const op = color ? api.setProperty(colId, "block", KANBAN_COLOR_PROP, color) : api.deleteProperty(colId, KANBAN_COLOR_PROP);
    op.catch((e) => showToast(`Couldn't save the column colour: ${e}`));
  }, [readLegacy, writeLegacy, showToast]);

  // Escape closes the card side panel only (topmost), never the board under it.
  useEscapeToClose(!!sidePanelBlockId, () => setSidePanelBlockId(null));

  // While a card or column is dragged nothing on the board gets text-selected.
  const [dragging, setDragging] = useState(false);
  useEffect(() => monitorForElements({
    onDragStart: () => { window.getSelection()?.removeAllRanges(); setDragging(true); },
    onDrop: () => setDragging(false),
  }), []);

  const filteredCardIdsByColumn = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const [colId, cards] of cardsByColumn) {
      const filtered = searchQuery
        ? cards.filter((c) => c.content.toLowerCase().includes(searchQuery.toLowerCase()))
        : cards;
      map.set(colId, filtered.map((c) => c.id));
    }
    return map;
  }, [cardsByColumn, searchQuery]);

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
        // Status board: the column is the state; the outline order stays as it is.
        if (statusOfColumn(targetColumnId)) {
          if (targetColumnId !== sourceColumnId) setCardStatus(cardId, targetColumnId);
          return;
        }

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

        placeCard(cardId, sourceColumnId, targetColumnId, newPosition);
      },
    });
  }, [cardsByColumn, columns, onRefreshPage, placeCard, setCardStatus]);

  // Delete with undo toast
  // Undo recreates the whole card subtree with its ORIGINAL ids, parents,
  // positions and properties (api.restoreBlocks), so backlinks and
  // ((block refs)) to the card keep resolving.
  const handleDeleteCard = useCallback(async (block: Block) => {
    const snapshot = await api.snapshotSubtrees([block.id], blocks).catch(() => null);
    const content = block.content;
    api.deleteBlock(block.id).then(() => {
      onRefreshPage();
      showToast(
        `Deleted "${extractTaskLabel(content)}"`,
        snapshot ? () => api.restoreBlocks(snapshot) : undefined,
      );
    }).catch(() => {});
  }, [blocks, onRefreshPage, showToast]);

  const handleDeleteColumn = useCallback(async (column: Block, cardCount: number) => {
    const title = extractLabel(column.content);
    const msg = cardCount > 0
      ? `Delete column "${title}" and its ${cardCount} card${cardCount !== 1 ? "s" : ""}?`
      : `Delete empty column "${title}"?`;
    if (!(await confirmDialog({ message: msg, confirmLabel: "Delete", danger: true }))) return;
    api.deleteBlock(column.id).then(() => {
      onRefreshPage();
      showToast(`Deleted column "${title}"`);
    }).catch(() => {});
  }, [onRefreshPage, showToast]);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement || (e.target as HTMLElement | null)?.isContentEditable) return;

      if ((e.key === "f" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && !focusedCardId)) {
        e.preventDefault();
        (document.querySelector(".kanban-search-input") as HTMLInputElement)?.focus();
        return;
      }

      if (!focusedCardId) return;
      const card = blocks.find((b) => b.id === focusedCardId);
      if (!card) return;
      const cardColumnId = columnOfCard.get(card.id);
      const colIdx = boardColumns.findIndex((c) => c.id === cardColumnId);

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (colIdx === -1) return;
        const colCards = filteredCardIdsByColumn.get(boardColumns[colIdx].id) ?? [];
        const idx = colCards.indexOf(focusedCardId);
        const next = e.key === "ArrowDown" ? idx + 1 : idx - 1;
        if (next >= 0 && next < colCards.length) setFocusedCardId(colCards[next]);
      }

      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        if (colIdx === -1) return;
        const nextColIdx = e.key === "ArrowRight" ? colIdx + 1 : colIdx - 1;
        if (nextColIdx < 0 || nextColIdx >= boardColumns.length) return;
        const nextColCards = filteredCardIdsByColumn.get(boardColumns[nextColIdx].id) ?? [];
        if (nextColCards.length === 0) return;
        const currentCards = filteredCardIdsByColumn.get(boardColumns[colIdx].id) ?? [];
        const cardIdx = currentCards.indexOf(focusedCardId);
        setFocusedCardId(nextColCards[Math.min(Math.max(cardIdx, 0), nextColCards.length - 1)]);
      }

      if (e.key === "n" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        if (byStatus) api.createBlock(pageId, "TODO ").then(onRefreshPage).catch(() => {});
        else if (card.parent_id) api.createBlock(pageId, "", card.parent_id).then(onRefreshPage).catch(() => {});
      }

      if (e.key === "Escape" && !coveredAbove("panel")) {
        // Drops card focus — the board itself only closes on an Escape nothing
        // else used; the side panel and anything above it are layers of their own.
        e.preventDefault();
        if (sidePanelBlockId) setSidePanelBlockId(null);
        else setFocusedCardId(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [focusedCardId, sidePanelBlockId, blocks, boardColumns, columnOfCard, filteredCardIdsByColumn, pageId, onRefreshPage, byStatus]);

  const handleAddColumn = useCallback(async () => {
    try {
      // A heading, so the new (still empty) block is a column and not a card.
      await api.createBlock(pageId, "## New Column");
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
    md += "| " + boardColumns.map((c) => esc(c.title)).join(" | ") + " |\n";
    md += "| " + boardColumns.map(() => "---").join(" | ") + " |\n";
    const maxCards = Math.max(...boardColumns.map((c) => (cardsByColumn.get(c.id) ?? []).length), 1);
    for (let i = 0; i < maxCards; i++) {
      const row = boardColumns.map((c) => {
        const cards = cardsByColumn.get(c.id) ?? [];
        return i < cards.length ? esc(segmentsText(inlineSegments(cards[i].content))) : "";
      });
      md += "| " + row.join(" | ") + " |\n";
    }
    navigator.clipboard.writeText(md).then(() => showToast("Copied board as markdown table")).catch(() => {});
  }, [pageTitle, boardColumns, cardsByColumn, showToast]);

  const sidePanelBlock = sidePanelBlockId ? blocks.find((b) => b.id === sidePanelBlockId) : null;

  if (boardColumns.length === 0) {
    return (
      <div className="kanban-empty">
        <p>This page is empty.</p>
        <p>Add your first column to start a kanban board.</p>
        <button className="btn btn-primary" onClick={handleAddColumn}>+ Add Column</button>
        <button className="btn" onClick={() => setGroupBy("status")} title="Columns TODO / DOING / DONE for the page's tasks">Group by status</button>
      </div>
    );
  }

  const taskCount = statusModel.columnOfCard.size;

  return (
    <div className={`kanban-container${dragging ? " is-dragging" : ""}${byStatus ? " kanban-by-status" : ""}`}>
      <div className="kanban-toolbar">
        <input
          className="kanban-search-input"
          type="text"
          placeholder="Filter cards... (Ctrl+F)"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <div className="graph-segmented kanban-group-by" role="group" aria-label="Columns">
          <button className={`btn btn-sm${!byStatus ? " active" : ""}`} aria-pressed={!byStatus} onClick={() => setGroupBy("section")} title="A column per heading (or block with sub-items)">Sections</button>
          <button className={`btn btn-sm${byStatus ? " active" : ""}`} aria-pressed={byStatus} onClick={() => setGroupBy("status")} title="TODO / DOING / DONE columns for every task on the page; dragging a card changes its state" data-testid="kanban-group-status">Status</button>
        </div>
        {byStatus && <span className="kanban-toolbar-note">{taskCount} task{taskCount === 1 ? "" : "s"} on this page</span>}
        <label className="graph-toggle kanban-open-as-board" title="Open this page as a board from now on (a view:: kanban page property)">
          <input type="checkbox" checked={opensAsBoard} onChange={(e) => toggleOpensAsBoard(e.target.checked)} />
          Open as board
        </label>
        <button className="kanban-toolbar-btn" onClick={handleExport} title="Copy board as markdown table">
          Copy as Table
        </button>
      </div>

      <div className="kanban-board" ref={boardRef} role="region" aria-label="Kanban board">
        {boardColumns.map((col) => (
          <KanbanColumn
            key={col.id}
            columnId={col.id}
            column={col.block}
            title={col.title}
            cards={cardsByColumn.get(col.id) ?? []}
            allColumns={columnRefs}
            onMoveCard={handleMoveCardTo}
            subBlockCounts={subBlockCounts}
            pageId={pageId}
            focusedCardId={focusedCardId}
            searchQuery={searchQuery}
            isCollapsed={collapsedColumns.has(col.id)}
            columnColor={byStatus ? null : columnColors[col.id] ?? null}
            columnColors={COLUMN_COLORS}
            onSetColumnColor={setColumnColor}
            onToggleCollapse={toggleCollapse}
            onFocusCard={setFocusedCardId}
            onOpenSidePanel={setSidePanelBlockId}
            onOpenPage={onOpenPage}
            onDeleteCard={handleDeleteCard}
            onDeleteColumn={handleDeleteColumn}
            onRefresh={onRefreshPage}
            status={statusOfColumn(col.id)}
            badgesByCard={badgesByCard}
          />
        ))}
        {!byStatus && (
          <button className="kanban-add-column" onClick={handleAddColumn} aria-label="Add column">
            <span>+</span>
            Add column
          </button>
        )}
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
        <CardPanel
          key={sidePanelBlock.id}
          block={sidePanelBlock}
          pageId={pageId}
          blocks={blocks}
          onClose={() => setSidePanelBlockId(null)}
          onRefresh={onRefreshPage}
          onOpenPage={onOpenPage}
        />
      )}
    </div>
  );
}
