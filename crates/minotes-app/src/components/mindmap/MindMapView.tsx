import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  MiniMap,
  Background,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { Block } from "../../lib/api";
import * as api from "../../lib/api";
import { showToast, showUndoToast } from "../../lib/toast";
import { blocksToFlow, extractLabel, type LayoutDirection, type MindMapNodeData } from "./blocksToFlow";
import { loadCollapsed, saveCollapsed } from "./collapseStore";
import { buildMindMapSvg, svgToPng } from "./exportImage";
import MindMapNode from "./MindMapNode";

const nodeTypes = { mindmapNode: MindMapNode };

interface Props {
  pageId: string;
  pageTitle: string;
  isJournal?: boolean;
  journalDate?: string;
  blocks: Block[];
  onClose: () => void;
  onRefreshPage: () => void;
  onRenameTitle?: (newTitle: string) => void;
}

// ── Markdown outline export ──

function blocksToOutline(blocks: Block[], parentId: string | null, depth: number): string {
  const children = blocks
    .filter((b) => (b.parent_id ?? null) === parentId)
    .sort((a, b) => a.position - b.position);
  let result = "";
  for (const block of children) {
    const indent = "  ".repeat(depth);
    const label = extractLabel(block.content);
    result += `${indent}- ${label}\n`;
    result += blocksToOutline(blocks, block.id, depth + 1);
  }
  return result;
}

// ── Context menu ──

interface ContextMenuState {
  x: number;
  y: number;
  nodeId: string;
  blockId: string;
}

// ── Auto-collapse threshold ──
const AUTO_COLLAPSE_THRESHOLD = 50;
const AUTO_COLLAPSE_DEPTH = 3;

const ROOT_NODE_ID = "__page_root__";
/** Fit everything, but don't blow a 1–3 node map up to 3× zoom. */
const FIT_VIEW = { padding: 0.2, maxZoom: 1.25 };

/** Phase 7: on large pages, start with branches deeper than level 3 collapsed. */
function autoCollapsed(blocks: Block[]): Set<string> {
  if (blocks.length <= AUTO_COLLAPSE_THRESHOLD) return new Set();
  const parentMap = new Map<string, string | null>();
  const hasKids = new Set<string>();
  for (const b of blocks) {
    parentMap.set(b.id, b.parent_id ?? null);
    if (b.parent_id) hasKids.add(b.parent_id);
  }
  const depthOf = (id: string): number => {
    let d = 0, cur = parentMap.get(id);
    while (cur && d < 100) { d++; cur = parentMap.get(cur); }
    return d;
  };
  return new Set(blocks.filter((b) => hasKids.has(b.id) && depthOf(b.id) >= AUTO_COLLAPSE_DEPTH).map((b) => b.id));
}

/** Save a file: browser download, or (desktop) PNG to Downloads / text to the clipboard. */
async function deliverExport(filename: string, data: Blob, kind: string): Promise<void> {
  if (api.isTauri) {
    // The desktop webview has no download manager: ask where to save.
    const bytes = Array.from(new Uint8Array(await data.arrayBuffer()));
    const path = await api.saveExportFile(filename, bytes);
    if (path) showToast(`${kind} exported → ${path}`);
    return;
  }
  const url = URL.createObjectURL(data);
  const link = document.createElement("a");
  link.download = filename;
  link.href = url;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`Exported ${filename}`);
}

const exportName = (title: string, ext: string) =>
  `mindmap-${title.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "page"}.${ext}`;

function MindMapInner({ pageId, pageTitle, isJournal, journalDate, blocks, onClose, onRefreshPage, onRenameTitle }: Props) {
  // Collapsed branches are shared with the outline and persisted (collapseStore).
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(
    () => loadCollapsed(pageId, blocks) ?? autoCollapsed(blocks),
  );
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const loadedPageRef = useRef(pageId);
  useEffect(() => {
    if (loadedPageRef.current === pageId) return;
    loadedPageRef.current = pageId;
    setCollapsedIds(loadCollapsed(pageId, blocksRef.current) ?? autoCollapsed(blocksRef.current));
  }, [pageId]);
  const toggleCollapse = useCallback((blockId: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(blockId)) next.delete(blockId);
      else next.add(blockId);
      saveCollapsed(pageId, next, blocksRef.current);
      return next;
    });
  }, [pageId]);
  const [direction, setDirection] = useState<LayoutDirection>("LR");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [focusSubtreeRoot, setFocusSubtreeRoot] = useState<string | null>(null);
  const [autoEditNodeId, setAutoEditNodeId] = useState<string | null>(null);
  const [showLayoutMenu, setShowLayoutMenu] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showMinimap, setShowMinimap] = useState(false);
  const reactFlow = useReactFlow();
  const prevNodesRef = useRef<Node[]>([]);

  // Blocks filtered by focus mode
  const visibleBlocks = useMemo(() => {
    if (!focusSubtreeRoot) return blocks;
    // Show only the subtree rooted at focusSubtreeRoot
    const ids = new Set<string>();
    const collect = (parentId: string) => {
      ids.add(parentId);
      for (const b of blocks) {
        if (b.parent_id === parentId) collect(b.id);
      }
    };
    collect(focusSubtreeRoot);
    return blocks.filter((b) => ids.has(b.id));
  }, [blocks, focusSubtreeRoot]);

  const focusTitle = useMemo(() => {
    if (!focusSubtreeRoot) return pageTitle;
    const block = blocks.find((b) => b.id === focusSubtreeRoot);
    return block ? extractLabel(block.content) : pageTitle;
  }, [focusSubtreeRoot, blocks, pageTitle]);

  // Convert blocks to ReactFlow nodes/edges
  // Node callbacks go through a ref so they always see current state, and are
  // attached to every layout (a re-layout replaces node data wholesale — doing
  // this in a separate effect lost onSave after any edit that kept the count).
  const handlersRef = useRef({
    save: (_blockId: string, _text: string) => {},
    editEnd: (_blockId: string, _text: string) => {},
    toggle: (_blockId: string) => {},
  });
  const renameRef = useRef(onRenameTitle);
  renameRef.current = onRenameTitle;
  const canRename = !!onRenameTitle;
  const { nodes: layoutNodes, edges: layoutEdges } = useMemo(() => {
    const flow = blocksToFlow(visibleBlocks, focusTitle, collapsedIds, direction, autoEditNodeId);
    const nodes = flow.nodes.map((node) => {
      const d = node.data as unknown as MindMapNodeData;
      const id = d.blockId;
      return {
        ...node,
        data: {
          ...node.data,
          autoEdit: autoEditNodeId !== null && id === autoEditNodeId,
          onSave: id ? (text: string) => handlersRef.current.save(id, text) : undefined,
          onEditEnd: id ? (text: string) => handlersRef.current.editEnd(id, text) : undefined,
          onToggleCollapse: id ? () => handlersRef.current.toggle(id) : undefined,
          onRenameTitle: d.isRoot && canRename ? (t: string) => renameRef.current?.(t) : undefined,
          isJournal: d.isRoot ? isJournal : undefined,
          journalDate: d.isRoot ? journalDate : undefined,
        },
      };
    });
    return { nodes, edges: flow.edges };
  }, [visibleBlocks, focusTitle, collapsedIds, direction, autoEditNodeId, canRename, isJournal, journalDate]);

  const [nodes, setNodes, onNodesChange] = useNodesState(layoutNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layoutEdges);

  // Animate layout transitions + entrance animation for new nodes
  useEffect(() => {
    const oldPositions = new Map(prevNodesRef.current.map((n) => [n.id, { ...n.position }]));
    const oldNodeIds = new Set(prevNodesRef.current.map((n) => n.id));
    prevNodesRef.current = layoutNodes;

    // Mark new nodes for entrance animation
    const markedNodes = layoutNodes.map((node) => {
      if (!oldNodeIds.has(node.id) && oldNodeIds.size > 0) {
        return { ...node, data: { ...node.data, isNew: true } };
      }
      return node;
    });

    // Clear isNew flag after animation completes
    let isNewTimer: ReturnType<typeof setTimeout> | null = null;
    if (markedNodes.some((n) => (n.data as unknown as MindMapNodeData).isNew)) {
      isNewTimer = setTimeout(() => {
        setNodes((nds) =>
          nds.map((n) => {
            const d = n.data as unknown as MindMapNodeData;
            if (d.isNew) return { ...n, data: { ...n.data, isNew: false } };
            return n;
          })
        );
      }, 300);
    }

    if (oldPositions.size === 0) {
      setNodes(markedNodes);
      setEdges(layoutEdges);
      return () => { if (isNewTimer) clearTimeout(isNewTimer); };
    }

    const duration = 300;
    const start = performance.now();

    function tick(now: number) {
      const t = Math.min((now - start) / duration, 1);
      const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;

      setNodes(
        markedNodes.map((node) => {
          const old = oldPositions.get(node.id);
          if (!old) return node;
          return {
            ...node,
            position: {
              x: old.x + (node.position.x - old.x) * ease,
              y: old.y + (node.position.y - old.y) * ease,
            },
          };
        })
      );

      if (t < 1) rafId = requestAnimationFrame(tick);
      else { clearTimeout(settleTimer); setEdges(layoutEdges); }
    }

    // Tracked so a newer layout (or unmount) cancels this loop instead of
    // letting two animation loops fight over node positions.
    let rafId = requestAnimationFrame(tick);
    // rAF doesn't fire in a hidden tab or a frameless (headless/GPU-less)
    // renderer; make sure the new layout still lands once the animation is due.
    const settleTimer = setTimeout(() => {
      cancelAnimationFrame(rafId);
      setNodes(layoutNodes);
      setEdges(layoutEdges);
    }, duration + 150);
    setEdges(layoutEdges);
    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(settleTimer);
      if (isNewTimer) clearTimeout(isNewTimer);
    };
  }, [layoutNodes, layoutEdges, setNodes, setEdges]);

  // Phase 7: Edge highlighting — highlight path from root to selected node
  useEffect(() => {
    if (!selectedNodeId) {
      setEdges((eds) => eds.map((e) => ({ ...e, style: undefined, animated: false })));
      return;
    }
    // Build path from selected → root
    const pathEdgeIds = new Set<string>();
    let current = selectedNodeId;
    while (current) {
      const edge = edges.find((e) => e.target === current);
      if (edge) {
        pathEdgeIds.add(edge.id);
        current = edge.source;
      } else {
        break;
      }
    }
    setEdges((eds) =>
      eds.map((e) => ({
        ...e,
        style: pathEdgeIds.has(e.id)
          ? { stroke: "#89b4fa", strokeWidth: 2.5 }
          : { stroke: "rgba(166, 173, 200, 0.15)", strokeWidth: 1 },
        animated: pathEdgeIds.has(e.id),
      }))
    );
  }, [selectedNodeId]);

  // Minimap: show on bottom-right hover or M key hold
  const minimapHoverRef = useRef<HTMLDivElement>(null);
  const onViewportChange = useCallback(() => {}, []);

  // Fit view on mount
  useEffect(() => {
    setTimeout(() => reactFlow.fitView(FIT_VIEW), 100);
  }, []);

  // Refit when focus mode changes
  useEffect(() => {
    setTimeout(() => reactFlow.fitView(FIT_VIEW), 350);
  }, [focusSubtreeRoot]);

  // Phase 7: Arrow key navigation
  const navigateToNode = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
    const node = nodes.find((n) => n.id === nodeId);
    if (node) {
      reactFlow.setCenter(node.position.x + 80, node.position.y + 20, { zoom: reactFlow.getZoom(), duration: 200 });
    }
  }, [nodes, reactFlow]);

  // Create block and auto-enter edit mode on the new node. The new (empty)
  // block stays visible while it is being edited; see editEnd.
  const createAndEdit = useCallback((parentId?: string) => {
    api.createBlock(pageId, "", parentId).then((newBlock) => {
      setAutoEditNodeId(newBlock.id);
      onRefreshPage();
    }).catch((e) => showToast(`Couldn't add a node: ${e}`));
  }, [pageId, onRefreshPage]);

  // First node of an empty map: reuse a lone empty top-level block (a fresh
  // page has one) rather than piling up invisible empty blocks.
  const addFirstNode = useCallback(() => {
    const reusable = blocks.find((b) => !b.parent_id && b.content.trim() === "" && !blocks.some((c) => c.parent_id === b.id));
    if (reusable) setAutoEditNodeId(reusable.id);
    else createAndEdit(undefined);
  }, [blocks, createAndEdit]);

  // After an auto-edited (new) node is saved, keep it pinned until the refreshed
  // blocks carry its content, so it doesn't blink out while it is still empty.
  const pendingAutoEditDone = useRef<string | null>(null);
  useEffect(() => {
    const id = pendingAutoEditDone.current;
    if (!id) return;
    const b = blocks.find((x) => x.id === id);
    if (!b || b.content.trim() !== "") {
      pendingAutoEditDone.current = null;
      setAutoEditNodeId((cur) => (cur === id ? null : cur));
    }
  }, [blocks]);

  handlersRef.current = {
    save: (blockId, text) => {
      api.updateBlock(blockId, text).then(onRefreshPage).catch((e) => showToast(`Couldn't save: ${e}`));
    },
    editEnd: (blockId, text) => {
      if (blockId !== autoEditNodeId) return;
      if (text.trim() === "") {
        // A new node left empty is abandoned: remove its block.
        setAutoEditNodeId(null);
        const b = blocks.find((x) => x.id === blockId);
        if (b && b.content.trim() === "" && !blocks.some((c) => c.parent_id === blockId)) {
          api.deleteBlock(blockId).then(onRefreshPage).catch(() => {});
        }
      } else {
        pendingAutoEditDone.current = blockId;
        setTimeout(() => setAutoEditNodeId((cur) => (cur === blockId ? null : cur)), 3000);
      }
    },
    toggle: toggleCollapse,
  };

  // Delete a node and its branch, with an Undo toast that restores the whole
  // subtree under its original ids (like Kanban cards and the outline).
  const deleteNode = useCallback(async (blockId: string) => {
    const block = blocks.find((b) => b.id === blockId);
    if (!block) return;
    const snapshot = await api.snapshotSubtrees([blockId], blocks).catch(() => null);
    const label = extractLabel(block.content, 40);
    const descendants = snapshot ? snapshot.length - 1 : 0;
    try {
      await api.deleteBlock(blockId);
    } catch (e) {
      showToast(`Couldn't delete: ${e}`);
      return;
    }
    setSelectedNodeId(null);
    onRefreshPage();
    const msg = descendants > 0
      ? `Deleted "${label}" and ${descendants} child node${descendants === 1 ? "" : "s"}`
      : `Deleted "${label}"`;
    if (snapshot) {
      showUndoToast(msg, () => {
        api.restoreBlocks(snapshot).then(onRefreshPage).catch((e) => showToast(`Couldn't undo: ${e}`));
      }, 8000);
    } else {
      showToast(msg);
    }
  }, [blocks, onRefreshPage]);

  const hasBlockNodes = layoutNodes.length > 1;

  // M key hold: show minimap while held
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "m" && !e.ctrlKey && !e.metaKey && document.activeElement?.tagName !== "INPUT") {
        setShowMinimap(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "m") setShowMinimap(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (contextMenu) { setContextMenu(null); return; }
        if (focusSubtreeRoot) { setFocusSubtreeRoot(null); return; }
        onClose();
        return;
      }

      const typing = document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA";
      // Empty map, or the page (root) node selected: Tab / Enter adds a
      // top-level node — the only way to start a map from scratch.
      if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && !typing && !e.ctrlKey && !e.metaKey && !e.altKey
          && !focusSubtreeRoot && (selectedNodeId === ROOT_NODE_ID || (!selectedNodeId && !hasBlockNodes))) {
        e.preventDefault();
        if (hasBlockNodes) createAndEdit(undefined);
        else addFirstNode();
        return;
      }

      if (!selectedNodeId) return;
      const nodeData = nodes.find((n) => n.id === selectedNodeId)?.data as unknown as MindMapNodeData | undefined;

      if (e.key === "ArrowRight" && selectedNodeId === ROOT_NODE_ID) {
        e.preventDefault();
        const first = layoutEdges.find((edge) => edge.source === ROOT_NODE_ID);
        if (first) navigateToNode(first.target);
        return;
      }

      // Arrow key navigation
      if (e.key === "ArrowRight" && nodeData?.blockId) {
        e.preventDefault();
        // Go to first child
        const child = blocks.find((b) => b.parent_id === nodeData.blockId);
        if (child && !collapsedIds.has(nodeData.blockId!)) navigateToNode(child.id);
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (nodeData?.blockId) {
          // Go to parent
          const block = blocks.find((b) => b.id === nodeData.blockId);
          if (block?.parent_id) navigateToNode(block.parent_id);
          else navigateToNode(ROOT_NODE_ID);
        }
        return;
      }
      if (e.key === "ArrowDown" && nodeData?.blockId) {
        e.preventDefault();
        // Next sibling
        const block = blocks.find((b) => b.id === nodeData.blockId);
        if (block) {
          const siblings = blocks
            .filter((b) => (b.parent_id ?? null) === (block.parent_id ?? null))
            .sort((a, b) => a.position - b.position);
          const idx = siblings.findIndex((s) => s.id === block.id);
          if (idx < siblings.length - 1) navigateToNode(siblings[idx + 1].id);
        }
        return;
      }
      if (e.key === "ArrowUp" && nodeData?.blockId) {
        e.preventDefault();
        // Previous sibling
        const block = blocks.find((b) => b.id === nodeData.blockId);
        if (block) {
          const siblings = blocks
            .filter((b) => (b.parent_id ?? null) === (block.parent_id ?? null))
            .sort((a, b) => a.position - b.position);
          const idx = siblings.findIndex((s) => s.id === block.id);
          if (idx > 0) navigateToNode(siblings[idx - 1].id);
        }
        return;
      }

      if (!nodeData?.blockId) return;

      if (e.key === "Tab") {
        e.preventDefault();
        createAndEdit(nodeData.blockId ?? undefined);
      }
      if (e.key === "Enter" && !e.shiftKey) {
        if (document.activeElement?.tagName === "INPUT") return;
        e.preventDefault();
        if (direction === "radial") {
          createAndEdit(nodeData.blockId ?? undefined);
        } else {
          const block = blocks.find((b) => b.id === nodeData.blockId);
          if (block) {
            createAndEdit(block.parent_id ?? undefined);
          }
        }
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (typing) return;
        e.preventDefault();
        deleteNode(nodeData.blockId!);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedNodeId, nodes, blocks, pageId, onClose, onRefreshPage, collapsedIds, contextMenu, focusSubtreeRoot,
      navigateToNode, createAndEdit, addFirstNode, deleteNode, hasBlockNodes, layoutEdges, direction]);

  // Track selection
  const onSelectionChange = useCallback(({ nodes: selected }: { nodes: Node[] }) => {
    setSelectedNodeId(selected[0]?.id ?? null);
  }, []);

  // Phase 4: Drag-to-rearrange — on node drag stop, find closest node and reparent
  const onNodeDragStop = useCallback(
    (_event: React.MouseEvent, draggedNode: Node) => {
      const d = draggedNode.data as unknown as MindMapNodeData;
      if (!d.blockId || d.isRoot) return;

      // Parent map built once per drag (was an O(n) find per ancestor step).
      const parentOf = new Map<string, string | null>();
      for (const b of blocks) parentOf.set(b.id, b.parent_id ?? null);

      // Find the closest other node to the dropped position
      let closestId: string | null = null;
      let closestDist = Infinity;
      for (const node of nodes) {
        if (node.id === draggedNode.id || node.id === ROOT_NODE_ID) continue;
        const nd = node.data as unknown as MindMapNodeData;
        if (!nd.blockId) continue;
        // Don't drop onto own descendants
        let isDescendant = false;
        let cur: string | null = nd.blockId;
        while (cur) {
          if (cur === d.blockId) { isDescendant = true; break; }
          cur = parentOf.get(cur) ?? null;
        }
        if (isDescendant) continue;

        const dx = node.position.x - draggedNode.position.x;
        const dy = node.position.y - draggedNode.position.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < closestDist && dist < 150) {
          closestDist = dist;
          closestId = nd.blockId;
        }
      }

      if (closestId && closestId !== d.blockId) {
        const draggedBlock = blocks.find((b) => b.id === d.blockId);
        if (draggedBlock && (draggedBlock.parent_id ?? null) !== closestId) {
          api.reorderBlock(d.blockId!, closestId, draggedBlock.position).then(onRefreshPage);
        }
      } else {
        // Snap back — recompute layout
        onRefreshPage();
      }
    },
    [nodes, blocks, onRefreshPage]
  );

  // Right-click context menu
  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault();
      const d = node.data as unknown as MindMapNodeData;
      if (!d.blockId) return;
      setContextMenu({ x: event.clientX, y: event.clientY, nodeId: node.id, blockId: d.blockId });
    },
    []
  );

  // Context menu actions
  const handleAddChild = useCallback(() => {
    if (!contextMenu) return;
    createAndEdit(contextMenu.blockId);
    setContextMenu(null);
  }, [contextMenu, createAndEdit]);

  const handleAddSibling = useCallback(() => {
    if (!contextMenu) return;
    if (direction === "radial") {
      createAndEdit(contextMenu.blockId);
    } else {
      const block = blocks.find((b) => b.id === contextMenu.blockId);
      createAndEdit(block?.parent_id ?? undefined);
    }
    setContextMenu(null);
  }, [contextMenu, blocks, createAndEdit, direction]);

  const handleDeleteNode = useCallback(() => {
    if (!contextMenu) return;
    deleteNode(contextMenu.blockId);
    setContextMenu(null);
  }, [contextMenu, deleteNode]);

  const handleCopyBranch = useCallback(() => {
    if (!contextMenu) return;
    const block = blocks.find((b) => b.id === contextMenu.blockId);
    if (!block) return;
    const label = extractLabel(block.content);
    const childrenText = blocksToOutline(blocks, block.id, 1);
    const text = `- ${label}\n${childrenText}`;
    navigator.clipboard.writeText(text);
    setContextMenu(null);
  }, [contextMenu, blocks]);

  const handleFocusSubtree = useCallback(() => {
    if (!contextMenu) return;
    setFocusSubtreeRoot(contextMenu.blockId);
    setContextMenu(null);
  }, [contextMenu]);

  // Export: a standalone SVG rebuilt from the layout (labels included), see exportImage.ts.
  const overlayRef = useRef<HTMLDivElement>(null);

  // Bring a newly added node into view (it may land outside the viewport).
  useEffect(() => {
    if (!autoEditNodeId) return;
    const t = setTimeout(() => {
      const n = reactFlow.getNode(autoEditNodeId);
      const rect = overlayRef.current?.getBoundingClientRect();
      if (!n || !rect) return;
      const { x, y, zoom } = reactFlow.getViewport();
      const w = n.measured?.width ?? 180, h = n.measured?.height ?? 40;
      const sx = n.position.x * zoom + x, sy = n.position.y * zoom + y;
      if (sx < 0 || sy < 0 || sx + w * zoom > rect.width || sy + h * zoom > rect.height - 40) {
        reactFlow.setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom: Math.min(zoom, 1.25), duration: 200 });
      }
    }, 400);
    return () => clearTimeout(t);
  }, [autoEditNodeId, layoutNodes, reactFlow]);
  const renderSvg = useCallback(() => {
    if (!overlayRef.current) return null;
    const out = buildMindMapSvg(reactFlow.getNodes(), overlayRef.current);
    return out.svg ? out : null;
  }, [reactFlow]);

  const handleExportPng = useCallback(async () => {
    const out = renderSvg();
    if (!out) return;
    try {
      const png = await svgToPng(out.svg, out.width, out.height);
      await deliverExport(exportName(pageTitle, "png"), png, "PNG");
    } catch (e) {
      showToast(`Export failed: ${e}`);
    }
  }, [pageTitle, renderSvg]);

  const handleExportSvg = useCallback(async () => {
    const out = renderSvg();
    if (!out) return;
    try {
      await deliverExport(exportName(pageTitle, "svg"), new Blob([out.svg], { type: "image/svg+xml" }), "SVG");
    } catch (e) {
      showToast(`Export failed: ${e}`);
    }
  }, [pageTitle, renderSvg]);

  const handleExportMd = useCallback(async () => {
    const outline = `# ${pageTitle}\n\n${blocksToOutline(blocks, null, 0)}`;
    try {
      await deliverExport(exportName(pageTitle, "md"), new Blob([outline], { type: "text/markdown" }), "Markdown outline");
    } catch (e) {
      showToast(`Export failed: ${e}`);
    }
  }, [pageTitle, blocks]);

  // Breadcrumb for focus mode
  const breadcrumbs = useMemo(() => {
    if (!focusSubtreeRoot) return [];
    const crumbs: Array<{ id: string; label: string }> = [];
    let cur = focusSubtreeRoot;
    while (cur) {
      const block = blocks.find((b) => b.id === cur);
      if (block) {
        crumbs.unshift({ id: block.id, label: extractLabel(block.content) });
        cur = block.parent_id ?? "";
      } else {
        break;
      }
    }
    return crumbs;
  }, [focusSubtreeRoot, blocks]);

  return (
    <div className="mindmap-overlay" ref={overlayRef} onClick={() => contextMenu && setContextMenu(null)}>
      <div className="mindmap-toolbar">
        {/* Breadcrumb in focus mode */}
        {focusSubtreeRoot && (
          <div className="mindmap-toolbar-group mindmap-breadcrumb">
            <span className="mindmap-breadcrumb-item" onClick={() => setFocusSubtreeRoot(null)}>
              {pageTitle}
            </span>
            {breadcrumbs.map((crumb) => (
              <span key={crumb.id}>
                <span className="mindmap-breadcrumb-sep"> › </span>
                <span
                  className="mindmap-breadcrumb-item"
                  onClick={() => setFocusSubtreeRoot(crumb.id === focusSubtreeRoot ? null : crumb.id)}
                >
                  {crumb.label}
                </span>
              </span>
            ))}
          </div>
        )}

        <div className="mindmap-toolbar-group">
          <button className="btn btn-sm" onClick={() => reactFlow.fitView(FIT_VIEW)} title="Fit all nodes">
            Fit
          </button>
          <button className="btn btn-sm" onClick={() => reactFlow.zoomIn()} title="Zoom in">+</button>
          <button className="btn btn-sm" onClick={() => reactFlow.zoomOut()} title="Zoom out">−</button>
        </div>
        <div className="mindmap-toolbar-group" style={{ position: "relative" }}>
          <button
            className="btn btn-sm"
            onClick={() => { setShowLayoutMenu((v) => !v); setShowExportMenu(false); }}
          >
            Layout ▾
          </button>
          {showLayoutMenu && (
            <div className="mindmap-dropdown" onClick={() => setShowLayoutMenu(false)}>
              <button
                className={direction === "LR" ? "active" : ""}
                onClick={() => { setDirection("LR"); setTimeout(() => reactFlow.fitView(FIT_VIEW), 350); }}
              >
                ↔ Horizontal
              </button>
              <button
                className={direction === "TB" ? "active" : ""}
                onClick={() => { setDirection("TB"); setTimeout(() => reactFlow.fitView(FIT_VIEW), 350); }}
              >
                ↕ Vertical
              </button>
              <button
                className={direction === "radial" ? "active" : ""}
                onClick={() => { setDirection("radial"); setTimeout(() => reactFlow.fitView(FIT_VIEW), 350); }}
              >
                ◎ Radial
              </button>
            </div>
          )}
        </div>
        <div className="mindmap-toolbar-group" style={{ position: "relative" }}>
          <button
            className="btn btn-sm"
            onClick={() => { setShowExportMenu((v) => !v); setShowLayoutMenu(false); }}
          >
            Export ▾
          </button>
          {showExportMenu && (
            <div className="mindmap-dropdown" onClick={() => setShowExportMenu(false)}>
              <button onClick={handleExportPng}>PNG Image</button>
              <button onClick={handleExportSvg}>SVG Vector</button>
              <button onClick={handleExportMd}>Markdown (.md)</button>
            </div>
          )}
        </div>
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onSelectionChange={onSelectionChange}
        onNodeDragStop={onNodeDragStop}
        onNodeContextMenu={onNodeContextMenu}
        onPaneClick={() => { setContextMenu(null); setSelectedNodeId(null); setShowLayoutMenu(false); setShowExportMenu(false); }}
        onViewportChange={onViewportChange}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={FIT_VIEW}
        minZoom={0.1}
        maxZoom={3}
        nodesDraggable
        defaultEdgeOptions={{ type: "smoothstep", animated: false }}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} color="rgba(255,255,255,0.03)" />
        {showMinimap && (
          <MiniMap
            nodeColor={(node) => {
              const d = node.data as unknown as MindMapNodeData;
              if (d.isRoot) return "#89b4fa";
              if (d.todoState === "done") return "#a6e3a1";
              if (d.todoState === "todo") return "#f9e2af";
              return "#585b70";
            }}
            maskColor="rgba(0,0,0,0.2)"
            className="mm-minimap-fade"
            zoomable
            pannable
          />
        )}
      </ReactFlow>

      {/* Empty map: the page node has nothing to hang off it yet. */}
      {!hasBlockNodes && !focusSubtreeRoot && autoEditNodeId === null && (
        <div
          className="mm-empty-hint"
          role="note"
          style={{
            position: "absolute", left: "50%", bottom: "18%", transform: "translateX(-50%)",
            display: "flex", flexDirection: "column", alignItems: "center", gap: 8,
            color: "var(--text-secondary)", fontSize: 13, textAlign: "center", zIndex: 5,
          }}
        >
          <span>This page has no content yet.</span>
          <button className="btn btn-sm btn-primary" onClick={(e) => { e.stopPropagation(); addFirstNode(); }}>
            + Add first node
          </button>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            or select the page node and press Tab
          </span>
        </div>
      )}

      {/* Bottom-right hover zone to trigger minimap */}
      <div
        className={showMinimap ? "mm-minimap-hover-area" : "mm-minimap-trigger"}
        ref={minimapHoverRef}
        onMouseEnter={() => setShowMinimap(true)}
        onMouseLeave={() => setShowMinimap(false)}
      />

      {/* Context menu */}
      {contextMenu && (
        <div
          className="mindmap-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button onClick={handleAddChild}>Add child</button>
          <button onClick={handleAddSibling}>{direction === "radial" ? "Add outward" : "Add sibling"}</button>
          <button onClick={handleFocusSubtree}>Focus subtree</button>
          <button onClick={handleCopyBranch}>Copy branch</button>
          <div className="mindmap-context-sep" />
          <button onClick={handleDeleteNode} className="danger">Delete</button>
        </div>
      )}
    </div>
  );
}

export default function MindMapView(props: Props) {
  return (
    <ReactFlowProvider>
      <MindMapInner {...props} />
    </ReactFlowProvider>
  );
}
