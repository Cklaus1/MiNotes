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
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { Block } from "../../lib/api";
import * as api from "../../lib/api";
import { blocksToFlow, type LayoutDirection, type MindMapNodeData } from "./blocksToFlow";
import MindMapNode from "./MindMapNode";

const nodeTypes = { mindmapNode: MindMapNode };

interface Props {
  pageId: string;
  pageTitle: string;
  blocks: Block[];
  onClose: () => void;
  onRefreshPage: () => void;
}

function MindMapInner({ pageId, pageTitle, blocks, onClose, onRefreshPage }: Props) {
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [direction, setDirection] = useState<LayoutDirection>("LR");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const reactFlow = useReactFlow();
  const prevNodesRef = useRef<Node[]>([]);

  // Convert blocks to ReactFlow nodes/edges
  const { nodes: layoutNodes, edges: layoutEdges } = useMemo(() => {
    return blocksToFlow(blocks, pageTitle, collapsedIds, direction);
  }, [blocks, pageTitle, collapsedIds, direction]);

  const [nodes, setNodes, onNodesChange] = useNodesState(layoutNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layoutEdges);

  // Animate layout transitions
  useEffect(() => {
    const oldPositions = new Map(prevNodesRef.current.map((n) => [n.id, { ...n.position }]));
    prevNodesRef.current = layoutNodes;

    // If first render or no old positions, just set directly
    if (oldPositions.size === 0) {
      setNodes(layoutNodes);
      setEdges(layoutEdges);
      return;
    }

    // Animate from old positions to new
    const duration = 300;
    const start = performance.now();

    function tick(now: number) {
      const t = Math.min((now - start) / duration, 1);
      const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;

      setNodes(
        layoutNodes.map((node) => {
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
              ? (text: string) => {
                  api.updateBlock(d.blockId!, text).then(onRefreshPage);
                }
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

  // Fit view on mount
  useEffect(() => {
    setTimeout(() => reactFlow.fitView({ padding: 0.2 }), 100);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }

      if (!selectedNodeId) return;
      const nodeData = nodes.find((n) => n.id === selectedNodeId)?.data as unknown as MindMapNodeData | undefined;
      if (!nodeData?.blockId) return;

      if (e.key === "Tab") {
        e.preventDefault();
        // Add child
        api.createBlock(pageId, "", nodeData.blockId ?? undefined).then(onRefreshPage);
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        // Add sibling — find parent of selected
        const block = blocks.find((b) => b.id === nodeData.blockId);
        if (block) {
          api.createBlock(pageId, "", block.parent_id ?? undefined).then(onRefreshPage);
        }
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (document.activeElement?.tagName === "INPUT") return;
        e.preventDefault();
        const childCount = (nodeData as MindMapNodeData).childCount;
        if (childCount > 0) {
          if (!confirm(`Delete this node and its ${childCount} children?`)) return;
        }
        api.deleteBlock(nodeData.blockId!).then(onRefreshPage);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedNodeId, nodes, blocks, pageId, onClose, onRefreshPage]);

  // Track selection
  const onSelectionChange = useCallback(({ nodes: selected }: { nodes: Node[] }) => {
    setSelectedNodeId(selected[0]?.id ?? null);
  }, []);

  // Export PNG
  const handleExportPng = useCallback(() => {
    const svg = document.querySelector(".react-flow__viewport");
    if (!svg) return;
    // Use the ReactFlow viewport for export
    const svgEl = document.querySelector(".react-flow svg") as SVGSVGElement | null;
    if (!svgEl) return;
    const svgData = new XMLSerializer().serializeToString(svgEl);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
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

  return (
    <div className="mindmap-overlay">
      <div className="mindmap-toolbar">
        <div className="mindmap-toolbar-group">
          <button className="btn btn-sm" onClick={onClose} title="Close (Esc)">
            ← Blocks
          </button>
        </div>
        <div className="mindmap-toolbar-group">
          <button className="btn btn-sm" onClick={() => reactFlow.fitView({ padding: 0.2 })} title="Fit all nodes">
            Fit All
          </button>
          <button className="btn btn-sm" onClick={() => reactFlow.zoomIn()} title="Zoom in">+</button>
          <button className="btn btn-sm" onClick={() => reactFlow.zoomOut()} title="Zoom out">−</button>
        </div>
        <div className="mindmap-toolbar-group">
          <span className="mindmap-toolbar-label">Layout:</span>
          <button
            className={`btn btn-sm ${direction === "LR" ? "btn-primary" : ""}`}
            onClick={() => setDirection("LR")}
          >
            Horizontal
          </button>
          <button
            className={`btn btn-sm ${direction === "TB" ? "btn-primary" : ""}`}
            onClick={() => setDirection("TB")}
          >
            Vertical
          </button>
        </div>
        <div className="mindmap-toolbar-group">
          <button className="btn btn-sm" onClick={handleExportPng} title="Export as PNG">
            Export PNG
          </button>
        </div>
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onSelectionChange={onSelectionChange}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.1}
        maxZoom={3}
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
    </div>
  );
}

// Wrap in ReactFlowProvider
export default function MindMapView(props: Props) {
  return (
    <ReactFlowProvider>
      <MindMapInner {...props} />
    </ReactFlowProvider>
  );
}
