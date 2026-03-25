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
import { blocksToFlow, extractLabel, type LayoutDirection, type MindMapNodeData } from "./blocksToFlow";
import MindMapNode from "./MindMapNode";

const nodeTypes = { mindmapNode: MindMapNode };

interface Props {
  pageId: string;
  pageTitle: string;
  blocks: Block[];
  onClose: () => void;
  onRefreshPage: () => void;
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

function MindMapInner({ pageId, pageTitle, blocks, onClose, onRefreshPage }: Props) {
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => {
    // Phase 7: Auto-collapse deep branches on large pages
    if (blocks.length > AUTO_COLLAPSE_THRESHOLD) {
      const parentMap = new Map<string, string | null>();
      for (const b of blocks) parentMap.set(b.id, b.parent_id ?? null);
      const getDepth = (id: string): number => {
        let d = 0, cur = parentMap.get(id);
        while (cur) { d++; cur = parentMap.get(cur); }
        return d;
      };
      const autoCollapsed = new Set<string>();
      for (const b of blocks) {
        const depth = getDepth(b.id);
        if (depth >= AUTO_COLLAPSE_DEPTH && blocks.some((c) => c.parent_id === b.id)) {
          autoCollapsed.add(b.id);
        }
      }
      return autoCollapsed;
    }
    return new Set();
  });
  const [direction, setDirection] = useState<LayoutDirection>("LR");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [focusSubtreeRoot, setFocusSubtreeRoot] = useState<string | null>(null);
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
  const { nodes: layoutNodes, edges: layoutEdges } = useMemo(() => {
    return blocksToFlow(visibleBlocks, focusTitle, collapsedIds, direction);
  }, [visibleBlocks, focusTitle, collapsedIds, direction]);

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
    if (markedNodes.some((n) => (n.data as unknown as MindMapNodeData).isNew)) {
      setTimeout(() => {
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
      return;
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

      if (t < 1) requestAnimationFrame(tick);
      else setEdges(layoutEdges);
    }

    requestAnimationFrame(tick);
    setEdges(layoutEdges);
  }, [layoutNodes, layoutEdges, setNodes, setEdges]);

  // Inject callbacks into node data
  useEffect(() => {
    setNodes((nds) =>
      nds.map((node) => {
        const d = node.data as unknown as MindMapNodeData;
        return {
          ...node,
          data: {
            ...node.data,
            onSave: d.blockId
              ? (text: string) => { api.updateBlock(d.blockId!, text).then(onRefreshPage); }
              : undefined,
            onToggleCollapse: d.blockId
              ? () => {
                  setCollapsedIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(d.blockId!)) next.delete(d.blockId!);
                    else next.add(d.blockId!);
                    return next;
                  });
                }
              : undefined,
          },
        };
      })
    );
  }, [nodes.length, setNodes, onRefreshPage]);

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

  // Fit view on mount
  useEffect(() => {
    setTimeout(() => reactFlow.fitView({ padding: 0.2 }), 100);
  }, []);

  // Refit when focus mode changes
  useEffect(() => {
    setTimeout(() => reactFlow.fitView({ padding: 0.2 }), 350);
  }, [focusSubtreeRoot]);

  // Phase 7: Arrow key navigation
  const navigateToNode = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
    const node = nodes.find((n) => n.id === nodeId);
    if (node) {
      reactFlow.setCenter(node.position.x + 80, node.position.y + 20, { zoom: reactFlow.getZoom(), duration: 200 });
    }
  }, [nodes, reactFlow]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (contextMenu) { setContextMenu(null); return; }
        if (focusSubtreeRoot) { setFocusSubtreeRoot(null); return; }
        onClose();
        return;
      }

      if (!selectedNodeId) return;
      const nodeData = nodes.find((n) => n.id === selectedNodeId)?.data as unknown as MindMapNodeData | undefined;

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
          else navigateToNode("__page_root__");
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
        api.createBlock(pageId, "", nodeData.blockId ?? undefined).then(onRefreshPage);
      }
      if (e.key === "Enter" && !e.shiftKey) {
        if (document.activeElement?.tagName === "INPUT") return;
        e.preventDefault();
        if (direction === "radial") {
          // Radial: Enter = add child (outward from center)
          api.createBlock(pageId, "", nodeData.blockId ?? undefined).then(onRefreshPage);
        } else {
          // LR/TB: Enter = add sibling (same level)
          const block = blocks.find((b) => b.id === nodeData.blockId);
          if (block) {
            api.createBlock(pageId, "", block.parent_id ?? undefined).then(onRefreshPage);
          }
        }
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (document.activeElement?.tagName === "INPUT") return;
        e.preventDefault();
        if (nodeData.childCount > 0) {
          if (!confirm(`Delete this node and its ${nodeData.childCount} children?`)) return;
        }
        api.deleteBlock(nodeData.blockId!).then(onRefreshPage);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedNodeId, nodes, blocks, pageId, onClose, onRefreshPage, collapsedIds, contextMenu, focusSubtreeRoot, navigateToNode]);

  // Track selection
  const onSelectionChange = useCallback(({ nodes: selected }: { nodes: Node[] }) => {
    setSelectedNodeId(selected[0]?.id ?? null);
  }, []);

  // Phase 4: Drag-to-rearrange — on node drag stop, find closest node and reparent
  const onNodeDragStop = useCallback(
    (_event: React.MouseEvent, draggedNode: Node) => {
      const d = draggedNode.data as unknown as MindMapNodeData;
      if (!d.blockId || d.isRoot) return;

      // Find the closest other node to the dropped position
      let closestId: string | null = null;
      let closestDist = Infinity;
      for (const node of nodes) {
        if (node.id === draggedNode.id || node.id === "__page_root__") continue;
        const nd = node.data as unknown as MindMapNodeData;
        if (!nd.blockId) continue;
        // Don't drop onto own descendants
        let isDescendant = false;
        let cur: string | null = nd.blockId;
        while (cur) {
          if (cur === d.blockId) { isDescendant = true; break; }
          cur = blocks.find((b) => b.id === cur)?.parent_id ?? null;
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
    api.createBlock(pageId, "", contextMenu.blockId).then(onRefreshPage);
    setContextMenu(null);
  }, [contextMenu, pageId, onRefreshPage]);

  const handleAddSibling = useCallback(() => {
    if (!contextMenu) return;
    if (direction === "radial") {
      // Radial: "Add outward" = add child (next ring)
      api.createBlock(pageId, "", contextMenu.blockId).then(onRefreshPage);
    } else {
      const block = blocks.find((b) => b.id === contextMenu.blockId);
      api.createBlock(pageId, "", block?.parent_id ?? undefined).then(onRefreshPage);
    }
    setContextMenu(null);
  }, [contextMenu, blocks, pageId, onRefreshPage, direction]);

  const handleDeleteNode = useCallback(() => {
    if (!contextMenu) return;
    api.deleteBlock(contextMenu.blockId).then(onRefreshPage);
    setContextMenu(null);
  }, [contextMenu, onRefreshPage]);

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

  // Export PNG
  const handleExportPng = useCallback(() => {
    const svgEl = document.querySelector(".mindmap-overlay .react-flow svg") as SVGSVGElement | null;
    if (!svgEl) return;
    const svgData = new XMLSerializer().serializeToString(svgEl);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width || 1200;
      canvas.height = img.height || 800;
      ctx.fillStyle = "#1e1e2e";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.download = `mindmap-${pageTitle}.png`;
        link.href = url;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      });
    };
    img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svgData)));
  }, [pageTitle]);

  // Export SVG
  const handleExportSvg = useCallback(() => {
    const svgEl = document.querySelector(".mindmap-overlay .react-flow svg") as SVGSVGElement | null;
    if (!svgEl) return;
    const svgData = new XMLSerializer().serializeToString(svgEl);
    const blob = new Blob([svgData], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.download = `mindmap-${pageTitle}.svg`;
    link.href = url;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [pageTitle]);

  // Export Markdown outline
  const handleExportMd = useCallback(() => {
    const outline = `# ${pageTitle}\n\n${blocksToOutline(blocks, null, 0)}`;
    const blob = new Blob([outline], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.download = `mindmap-${pageTitle}.md`;
    link.href = url;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
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
    <div className="mindmap-overlay" onClick={() => contextMenu && setContextMenu(null)}>
      <div className="mindmap-toolbar">
        <div className="mindmap-toolbar-group">
          <button className="btn btn-sm" onClick={onClose} title="Close (Esc)">
            ← Close
          </button>
        </div>

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
          <button className="btn btn-sm" onClick={() => reactFlow.fitView({ padding: 0.2 })} title="Fit all nodes">
            Fit
          </button>
          <button className="btn btn-sm" onClick={() => reactFlow.zoomIn()} title="Zoom in">+</button>
          <button className="btn btn-sm" onClick={() => reactFlow.zoomOut()} title="Zoom out">−</button>
        </div>
        <div className="mindmap-toolbar-group">
          <button
            className={`btn btn-sm ${direction === "LR" ? "btn-primary" : ""}`}
            onClick={() => setDirection("LR")}
            title="Horizontal layout"
          >
            LR
          </button>
          <button
            className={`btn btn-sm ${direction === "TB" ? "btn-primary" : ""}`}
            onClick={() => setDirection("TB")}
            title="Vertical layout"
          >
            TB
          </button>
          <button
            className={`btn btn-sm ${direction === "radial" ? "btn-primary" : ""}`}
            onClick={() => setDirection("radial")}
            title="Radial / hub-spoke layout"
          >
            Radial
          </button>
        </div>
        <div className="mindmap-toolbar-group">
          <button className="btn btn-sm" onClick={handleExportPng} title="Export as PNG">PNG</button>
          <button className="btn btn-sm" onClick={handleExportSvg} title="Export as SVG">SVG</button>
          <button className="btn btn-sm" onClick={handleExportMd} title="Export as Markdown outline">MD</button>
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
        onPaneClick={() => { setContextMenu(null); setSelectedNodeId(null); }}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.1}
        maxZoom={3}
        nodesDraggable
        defaultEdgeOptions={{ type: "smoothstep", animated: false }}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} color="rgba(255,255,255,0.03)" />
        <MiniMap
          nodeColor={(node) => {
            const d = node.data as unknown as MindMapNodeData;
            if (d.isRoot) return "#89b4fa";
            if (d.todoState === "done") return "#a6e3a1";
            if (d.todoState === "todo") return "#f9e2af";
            return "#585b70";
          }}
          maskColor="rgba(0,0,0,0.6)"
          style={{ background: "#1e1e2e" }}
        />
      </ReactFlow>

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
