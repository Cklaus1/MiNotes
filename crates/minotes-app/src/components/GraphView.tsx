import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
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

const LABEL_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const LABEL_MIN_ZOOM = 0.6; // labels are hidden below this zoom (except on hover)
const LABEL_GAP = 3;
const FIT_PADDING = 32; // screen px kept free around the fitted graph
const FIT_MAX_ZOOM = 1.5;
const HIDE_UNLINKED_KEY = "minotes-graph-hide-unlinked";

function nodeRadius(blockCount: number): number {
  return Math.max(6, Math.min(24, 6 + Math.sqrt(blockCount) * 3));
}

function nodeLabel(node: SimNode): string {
  return node.title.length > 24 ? node.title.slice(0, 22) + "..." : node.title;
}

/** Label font size in simulation units: 12 screen px until zoomed past 1.2x, then it scales. */
function labelFontSize(k: number): number {
  return Math.max(10, 12 / k);
}

function readHidePref(): boolean | null {
  try {
    const v = localStorage.getItem(HIDE_UNLINKED_KEY);
    return v === "1" ? true : v === "0" ? false : null;
  } catch { return null; }
}

export default function GraphView({ onPageClick, onClose, onGraphSwitch }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);
  const [data, setData] = useState<api.GraphData | null>(null);
  // null = no saved choice yet: decided from the data once it loads.
  const [hidePref, setHidePref] = useState<boolean | null>(readHidePref);
  const [counts, setCounts] = useState({ nodes: 0, edges: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);
  // True once the user pans/zooms by hand — a window resize then keeps their view.
  const userMovedRef = useRef(false);

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
    const fontSize = labelFontSize(k);
    ctx.font = `${fontSize}px ${LABEL_FONT}`;
    // Visible sim-space rectangle: a label that would poke out past the canvas
    // edge is nudged back in instead of being cut off.
    const viewLeft = (-w / 2 - tx) / k + 4 / k;
    const viewRight = (w / 2 - tx) / k - 4 / k;

    for (const node of nodes) {
      if (node.x == null || node.y == null) continue;
      const showLabel = k >= LABEL_MIN_ZOOM || node === hovered;
      if (!showLabel) continue;
      const label = nodeLabel(node);
      const half = ctx.measureText(label).width / 2;
      let lx = node.x;
      const nodeOnScreen = node.x + node.radius > viewLeft && node.x - node.radius < viewRight;
      if (nodeOnScreen && half * 2 < viewRight - viewLeft) {
        lx = Math.min(Math.max(lx, viewLeft + half), viewRight - half);
      }
      ctx.fillStyle = node === hovered ? NODE_HOVER_COLOR : LABEL_COLOR;
      ctx.fillText(label, lx, node.y + node.radius + LABEL_GAP);
    }

    ctx.restore();
  }, []);

  // Bounding box (sim units) of every node plus its label at zoom k.
  const graphBounds = useCallback((k: number) => {
    const ctx = canvasRef.current?.getContext("2d");
    const withLabels = k >= LABEL_MIN_ZOOM;
    const fontSize = labelFontSize(k);
    if (ctx) ctx.font = `${fontSize}px ${LABEL_FONT}`;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
    for (const node of nodesRef.current) {
      if (node.x == null || node.y == null) continue;
      n++;
      const half = withLabels && ctx ? ctx.measureText(nodeLabel(node)).width / 2 : 0;
      const ext = Math.max(node.radius, half);
      minX = Math.min(minX, node.x - ext);
      maxX = Math.max(maxX, node.x + ext);
      minY = Math.min(minY, node.y - node.radius);
      maxY = Math.max(maxY, node.y + node.radius + (withLabels ? LABEL_GAP + fontSize * 1.3 : 0));
    }
    return n === 0 ? null : { minX, minY, maxX, maxY };
  }, []);

  // Publish what is on screen as data-* attributes on the canvas (the graph is
  // pixels, so this is the only way tests and tooling can inspect it).
  const publishStats = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { x: tx, y: ty, k } = transformRef.current;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const ctx = canvas.getContext("2d");
    const withLabels = k >= LABEL_MIN_ZOOM;
    const fontSize = labelFontSize(k);
    if (ctx) ctx.font = `${fontSize}px ${LABEL_FONT}`;
    let inView = 0;
    for (const node of nodesRef.current) {
      if (node.x == null || node.y == null) continue;
      const half = withLabels && ctx ? ctx.measureText(nodeLabel(node)).width / 2 : 0;
      const ext = Math.max(node.radius, half);
      const left = tx + w / 2 + (node.x - ext) * k;
      const right = tx + w / 2 + (node.x + ext) * k;
      const top = ty + h / 2 + (node.y - node.radius) * k;
      const bottom = ty + h / 2 + (node.y + node.radius + (withLabels ? LABEL_GAP + fontSize * 1.3 : 0)) * k;
      if (left >= 0 && top >= 0 && right <= w && bottom <= h) inView++;
    }
    canvas.dataset.nodes = String(nodesRef.current.length);
    canvas.dataset.edges = String(edgesRef.current.length);
    canvas.dataset.inView = String(inView);
    canvas.dataset.zoom = k.toFixed(3);
  }, []);

  // Zoom/pan so every node (and its label) sits inside the canvas with padding.
  const fitToView = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const availW = Math.max(40, w - FIT_PADDING * 2);
    const availH = Math.max(40, h - FIT_PADDING * 2);
    // Label size in sim units depends on the zoom, so iterate to a fixed point.
    let k = 1;
    let bounds = graphBounds(k);
    if (!bounds) { draw(); publishStats(); return; }
    for (let i = 0; i < 6; i++) {
      const bw = Math.max(1, bounds.maxX - bounds.minX);
      const bh = Math.max(1, bounds.maxY - bounds.minY);
      const next = Math.max(0.1, Math.min(FIT_MAX_ZOOM, availW / bw, availH / bh));
      const settled = Math.abs(next - k) < 0.001;
      k = next;
      bounds = graphBounds(k)!;
      if (settled) break;
    }
    // The last bounds may be slightly larger than the ones k was derived from.
    k = Math.max(0.1, Math.min(k, availW / Math.max(1, bounds.maxX - bounds.minX), availH / Math.max(1, bounds.maxY - bounds.minY)));
    bounds = graphBounds(k)!;
    transformRef.current = {
      k,
      x: -k * (bounds.minX + bounds.maxX) / 2,
      y: -k * (bounds.minY + bounds.maxY) / 2,
    };
    userMovedRef.current = false;
    draw();
    publishStats();
  }, [draw, graphBounds, publishStats]);

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

  // Load the graph once
  useEffect(() => {
    let cancelled = false;
    api.getGraphData().then((d) => {
      if (cancelled) return;
      if (d.nodes.length === 0) setEmpty(true);
      else setData(d);
      setLoading(false);
    }).catch((e) => {
      if (cancelled) return;
      setError(String(e));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  // Pages with no link in either direction.
  const linkedIds = useMemo(() => {
    const ids = new Set<string>();
    if (!data) return ids;
    const known = new Set(data.nodes.map((n) => n.id));
    for (const e of data.edges) {
      if (e.source === e.target || !known.has(e.source) || !known.has(e.target)) continue;
      ids.add(e.source);
      ids.add(e.target);
    }
    return ids;
  }, [data]);
  const totalCount = data?.nodes.length ?? 0;
  const unlinkedCount = totalCount - linkedIds.size;
  // Default: hide the orphans when they would drown out the linked pages.
  const hideUnlinked = hidePref ?? (linkedIds.size > 0 && unlinkedCount > totalCount / 2);

  const toggleHideUnlinked = useCallback((next: boolean) => {
    try { localStorage.setItem(HIDE_UNLINKED_KEY, next ? "1" : "0"); } catch { /* best effort */ }
    setHidePref(next);
  }, []);

  // Build the simulation for the visible nodes, settle it, then fit to view.
  useEffect(() => {
    if (!data) return;

    const nodes: SimNode[] = data.nodes
      .filter((n) => !hideUnlinked || linkedIds.has(n.id))
      .map((n) => ({
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
    hoveredRef.current = null;
    setCounts({ nodes: nodes.length, edges: edges.length });

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
      // Unlinked nodes have nothing pulling them in: a weak gravity keeps them
      // from drifting far away from the rest.
      .force("x", forceX<SimNode>(0).strength(0.04))
      .force("y", forceY<SimNode>(0).strength(0.04))
      .force(
        "collide",
        forceCollide<SimNode>().radius((d) => d.radius + 12)
      )
      .alphaDecay(0.02)
      .stop();

    // Settle the layout up front (no seconds-long drift), then fit it. The
    // simulation only runs again while a node is being dragged.
    sim.tick(nodes.length > 1500 ? 80 : 300);
    sim.on("tick", () => { draw(); });
    simRef.current = sim;
    fitToView();

    return () => {
      sim.stop();
    };
  }, [data, hideUnlinked, linkedIds, draw, fitToView]);

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
        userMovedRef.current = true;
        draw();
        publishStats();
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
      userMovedRef.current = true;
      draw();
      publishStats();
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
  }, [hitTest, draw, publishStats, onPageClick, data]);

  // Handle resize: refit, unless the user has set their own view.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !data) return;
    const onResize = () => {
      if (userMovedRef.current) { draw(); publishStats(); }
      else fitToView();
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [draw, fitToView, publishStats, data]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
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
        <span className="graph-toolbar-stats">
          {counts.nodes} nodes · {counts.edges} edges
          {hideUnlinked && unlinkedCount > 0 && (
            <span className="graph-hidden-count"> · {unlinkedCount} unlinked hidden</span>
          )}
        </span>
        <label
          className="graph-toggle"
          title={unlinkedCount === 0 ? "Every page is linked" : "Hide pages with no links to or from other pages"}
        >
          <input
            type="checkbox"
            className="graph-hide-unlinked"
            checked={hideUnlinked}
            disabled={unlinkedCount === 0}
            onChange={(e) => toggleHideUnlinked(e.target.checked)}
          />
          Hide unlinked
        </label>
        <button className="btn btn-sm graph-fit-btn" onClick={fitToView} title="Fit all nodes in view">
          Fit
        </button>
        <button className="btn btn-sm" onClick={onClose}>
          Close (Esc)
        </button>
      </div>
      <div ref={wrapRef} className="graph-canvas-wrap">
        <canvas ref={canvasRef} />
        {counts.nodes === 0 && (
          <div className="graph-canvas-note">
            <span>None of the {totalCount} pages link to each other yet.</span>
            <button className="btn btn-sm" onClick={() => toggleHideUnlinked(false)}>Show unlinked pages</button>
          </div>
        )}
      </div>
    </div>
  );
}
