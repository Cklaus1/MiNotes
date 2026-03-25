import { useEffect, useRef, useState, useCallback } from "react";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";
import * as api from "../lib/api";
import GraphSwitcher from "./GraphSwitcher";

interface Props {
  onPageClick: (id: string) => void;
  onClose: () => void;
  onGraphSwitch: () => void;
}

interface SimNode extends SimulationNodeDatum {
  id: string;
  title: string;
  block_count: number;
  link_count: number;
  radius: number;
}

interface SimEdge extends SimulationLinkDatum<SimNode> {
  weight: number;
}

const NODE_COLOR = "#89b4fa";
const NODE_HOVER_COLOR = "#74c7ec";
const EDGE_COLOR = "#45475a";
const LABEL_COLOR = "#a6adc8";
const BG_COLOR = "#1e1e2e";

function nodeRadius(blockCount: number): number {
  return Math.max(6, Math.min(24, 6 + Math.sqrt(blockCount) * 3));
}

export default function GraphView({ onPageClick, onClose, onGraphSwitch }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);

  // Mutable refs for simulation state
  const nodesRef = useRef<SimNode[]>([]);
  const edgesRef = useRef<SimEdge[]>([]);
  const simRef = useRef<ReturnType<typeof forceSimulation<SimNode>> | null>(null);
  const transformRef = useRef({ x: 0, y: 0, k: 1 });
  const hoveredRef = useRef<SimNode | null>(null);
  const dragRef = useRef<{
    node: SimNode | null;
    active: boolean;
  }>({ node: null, active: false });
  const animFrameRef = useRef<number>(0);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, w, h);

    const { x: tx, y: ty, k } = transformRef.current;
    ctx.save();
    ctx.translate(tx + w / 2, ty + h / 2);
    ctx.scale(k, k);

    const nodes = nodesRef.current;
    const edges = edgesRef.current;

    // Draw edges
    ctx.strokeStyle = EDGE_COLOR;
    ctx.lineWidth = 1 / k;
    for (const edge of edges) {
      const s = edge.source as SimNode;
      const t = edge.target as SimNode;
      if (s.x == null || s.y == null || t.x == null || t.y == null) continue;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
      ctx.stroke();
    }

    // Draw nodes
    const hovered = hoveredRef.current;
    for (const node of nodes) {
      if (node.x == null || node.y == null) continue;
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      ctx.fillStyle = node === hovered ? NODE_HOVER_COLOR : NODE_COLOR;
      ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Draw labels (only when zoomed in enough or for hovered node)
    ctx.fillStyle = LABEL_COLOR;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const fontSize = Math.max(10, 12 / k);
    ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;

    for (const node of nodes) {
      if (node.x == null || node.y == null) continue;
      const showLabel = k > 0.6 || node === hovered;
      if (!showLabel) continue;
      const label = node.title.length > 24 ? node.title.slice(0, 22) + "..." : node.title;
      ctx.fillStyle = node === hovered ? NODE_HOVER_COLOR : LABEL_COLOR;
      ctx.fillText(label, node.x, node.y + node.radius + 3);
    }

    ctx.restore();
  }, []);

  // Hit test: find node under screen coordinates
  const hitTest = useCallback((screenX: number, screenY: number): SimNode | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const { x: tx, y: ty, k } = transformRef.current;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    // Convert screen to simulation coordinates
    const simX = (screenX - rect.left - tx - w / 2) / k;
    const simY = (screenY - rect.top - ty - h / 2) / k;

    for (const node of nodesRef.current) {
      if (node.x == null || node.y == null) continue;
      const dx = node.x - simX;
      const dy = node.y - simY;
      if (dx * dx + dy * dy < (node.radius + 4) * (node.radius + 4)) {
        return node;
      }
    }
    return null;
  }, []);

  // Load data and set up simulation
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const data = await api.getGraphData();
        if (cancelled) return;

        if (data.nodes.length === 0) {
          setEmpty(true);
          setLoading(false);
          return;
        }

        const nodes: SimNode[] = data.nodes.map((n) => ({
          id: n.id,
          title: n.title,
          block_count: n.block_count,
          link_count: n.link_count,
          radius: nodeRadius(n.block_count),
          x: (Math.random() - 0.5) * 400,
          y: (Math.random() - 0.5) * 400,
        }));

        const nodeMap = new Map(nodes.map((n) => [n.id, n]));

        const edges: SimEdge[] = data.edges
          .filter((e) => nodeMap.has(e.source) && nodeMap.has(e.target))
          .map((e) => ({
            source: nodeMap.get(e.source)!,
            target: nodeMap.get(e.target)!,
            weight: e.weight,
          }));

        nodesRef.current = nodes;
        edgesRef.current = edges;

        const sim = forceSimulation<SimNode>(nodes)
          .force(
            "link",
            forceLink<SimNode, SimEdge>(edges)
              .id((d) => d.id)
              .distance(80)
              .strength(0.3)
          )
          .force("charge", forceManyBody<SimNode>().strength(-120))
          .force("center", forceCenter(0, 0).strength(0.05))
          .force(
            "collide",
            forceCollide<SimNode>().radius((d) => d.radius + 2)
          )
          .alphaDecay(0.02)
          .on("tick", () => {
            draw();
          });

        simRef.current = sim;
        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      simRef.current?.stop();
    };
  }, [draw]);

  // Mouse interactions
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let isPanning = false;
    let panStart = { x: 0, y: 0 };

    const onMouseDown = (e: MouseEvent) => {
      const node = hitTest(e.clientX, e.clientY);
      if (node) {
        dragRef.current = { node, active: true };
        node.fx = node.x;
        node.fy = node.y;
        simRef.current?.alphaTarget(0.3).restart();
      } else {
        isPanning = true;
        panStart = { x: e.clientX - transformRef.current.x, y: e.clientY - transformRef.current.y };
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      if (dragRef.current.active && dragRef.current.node) {
        const { x: tx, y: ty, k } = transformRef.current;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        const rect = canvas.getBoundingClientRect();
        dragRef.current.node.fx = (e.clientX - rect.left - tx - w / 2) / k;
        dragRef.current.node.fy = (e.clientY - rect.top - ty - h / 2) / k;
        return;
      }

      if (isPanning) {
        transformRef.current.x = e.clientX - panStart.x;
        transformRef.current.y = e.clientY - panStart.y;
        draw();
        return;
      }

      // Hover detection
      const node = hitTest(e.clientX, e.clientY);
      if (node !== hoveredRef.current) {
        hoveredRef.current = node;
        canvas.style.cursor = node ? "pointer" : "default";
        draw();
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      if (dragRef.current.active && dragRef.current.node) {
        // If the mouse barely moved, treat it as a click
        dragRef.current.node.fx = null;
        dragRef.current.node.fy = null;
        simRef.current?.alphaTarget(0);
        dragRef.current = { node: null, active: false };
        return;
      }
      isPanning = false;
    };

    const onClick = (e: MouseEvent) => {
      const node = hitTest(e.clientX, e.clientY);
      if (node) {
        onPageClick(node.id);
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const t = transformRef.current;
      const zoom = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const newK = Math.max(0.1, Math.min(5, t.k * zoom));
      const ratio = newK / t.k;
      // Zoom toward cursor
      t.x = mx - (mx - t.x) * ratio - canvas.clientWidth / 2 * (ratio - 1);
      t.y = my - (my - t.y) * ratio - canvas.clientHeight / 2 * (ratio - 1);
      t.k = newK;
      draw();
    };

    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [hitTest, draw, onPageClick]);

  // Handle resize
  useEffect(() => {
    const onResize = () => draw();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [draw]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  if (loading) {
    return (
      <div className="graph-view">
        <div className="empty-state">
          <span style={{ color: "var(--text-muted)" }}>Loading graph...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="graph-view">
        <div className="empty-state">
          <h3>Failed to load graph</h3>
          <span style={{ color: "var(--danger)", fontSize: 13 }}>{error}</span>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }

  if (empty) {
    return (
      <div className="graph-view">
        <div className="empty-state">
          <h3>No pages yet</h3>
          <span>Create some pages with links to see the graph.</span>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }

  return (
    <div className="graph-view">
      <div className="graph-toolbar">
        <GraphSwitcher onSwitch={onGraphSwitch} />
        <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
          {nodesRef.current.length} nodes · {edgesRef.current.length} edges
        </span>
        <button className="btn btn-sm" onClick={onClose} style={{ marginLeft: "auto" }}>
          Close (Esc)
        </button>
      </div>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
