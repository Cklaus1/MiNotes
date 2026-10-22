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
import { onThemeChange, themeColor } from "../lib/theme";
import NotebookLabel from "./NotebookLabel";
import { useLayer } from "../lib/layers";
import Icon from "./Icon";
import {
  adjacency, categories, NO_PROJECT, OTHER, stepTo, titleMatches, visibleNodes,
  type ArrowKey, type ColorBy, type GraphFilters,
} from "../lib/graphModel";
import "./views.css";

interface Props {
  onPageClick: (id: string) => void;
  onClose: () => void;
  /** The page the graph was opened from ("you are here", local graph centre). */
  currentPageId?: string | null;
}

interface SimNode extends SimulationNodeDatum {
  id: string;
  title: string;
  block_count: number;
  link_count: number;
  radius: number;
  /** Visible edges touching this node (label priority). */
  degree: number;
  /** Colour category (graphModel.categories), or "" when not colouring. */
  category: string;
}

interface SimEdge extends SimulationLinkDatum<SimNode> {
  weight: number;
}

/** Canvas colours, read from the theme's CSS variables (light theme → light canvas). */
interface GraphColors {
  bg: string; node: string; nodeHover: string; edge: string; label: string; labelHover: string;
  here: string; match: string; muted: string; cats: string[];
}
function readColors(): GraphColors {
  return {
    bg: themeColor("--bg-primary", "#1e1e2e"),
    node: themeColor("--accent", "#89b4fa"),
    nodeHover: themeColor("--accent-hover", "#74c7ec"),
    edge: themeColor("--border", "#45475a"),
    label: themeColor("--text-secondary", "#a6adc8"),
    labelHover: themeColor("--text-primary", "#cdd6f4"),
    here: themeColor("--text-primary", "#cdd6f4"),
    match: themeColor("--warning", "#f9e2af"),
    muted: themeColor("--text-muted", "#9399b2"),
    cats: [1, 2, 3, 4, 5, 6, 7].map((i) => themeColor(`--cat-${i}`, "#89b4fa")),
  };
}

/** A label drawn on screen (screen px) — kept for collision tests and tooling. */
interface PlacedLabel { id: string; x: number; y: number; w: number; h: number }

const LABEL_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
// Fit-to-view reserves room for labels from this zoom up; below it the labels
// that fit are still drawn (collision culling decides), the fit just ignores them.
const LABEL_MIN_ZOOM = 0.6;
const LABEL_GAP = 3;
const LABEL_PAD = 3; // screen px kept free around every drawn label
// A press that moves less than this is a click (opens the page); more is a drag.
const DRAG_THRESHOLD_PX = 4;
const FIT_PADDING = 32; // screen px kept free around the fitted graph
const FIT_MAX_ZOOM = 1.5;
const HIDE_UNLINKED_KEY = "minotes-graph-hide-unlinked";
const LOCAL_KEY = "minotes-graph-local";
const COLOR_KEY = "minotes-graph-color-by";

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

function readPref<T>(key: string, parse: (v: string) => T | null): T | null {
  try {
    const v = localStorage.getItem(key);
    return v == null ? null : parse(v);
  } catch { return null; }
}
function writePref(key: string, v: string) {
  try { localStorage.setItem(key, v); } catch { /* best effort */ }
}

export default function GraphView({ onPageClick, onClose, currentPageId = null }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);
  const [data, setData] = useState<api.GraphData | null>(null);
  // null = no saved choice yet: decided from the data once it loads.
  const [hidePref, setHidePref] = useState<boolean | null>(() => readPref(HIDE_UNLINKED_KEY, (v) => v === "1" ? true : v === "0" ? false : null));
  // Local graph: 0 = whole notebook, 1–3 = links away from the current page.
  const [localDepth, setLocalDepth] = useState<number>(() => readPref(LOCAL_KEY, (v) => (/^[0-3]$/.test(v) ? Number(v) : null)) ?? 0);
  const [colorBy, setColorBy] = useState<ColorBy>(() => readPref(COLOR_KEY, (v) => (v === "project" || v === "tag" || v === "none" ? v : null)) ?? "none");
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [orphansOnly, setOrphansOnly] = useState(false);
  const [folderNames, setFolderNames] = useState<Map<string, string>>(new Map());
  const [counts, setCounts] = useState({ nodes: 0, edges: 0 });
  const [selectedTitle, setSelectedTitle] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  // True once the user pans/zooms by hand — a window resize then keeps their view.
  const userMovedRef = useRef(false);

  // Mutable refs for simulation state
  const nodesRef = useRef<SimNode[]>([]);
  const edgesRef = useRef<SimEdge[]>([]);
  const simRef = useRef<ReturnType<typeof forceSimulation<SimNode>> | null>(null);
  const transformRef = useRef({ x: 0, y: 0, k: 1 });
  const hoveredRef = useRef<SimNode | null>(null);
  /** The keyboard's node (arrow keys move it, Enter opens it). */
  const selectedRef = useRef<SimNode | null>(null);
  const matchesRef = useRef<Set<string> | null>(null);
  const currentRef = useRef<string | null>(currentPageId);
  currentRef.current = currentPageId;
  const catColorRef = useRef<Map<string, string>>(new Map());
  const colorsRef = useRef<GraphColors>(readColors());
  // Neighbours of every node, and the nodes by degree (most linked first).
  const neighboursRef = useRef<Map<SimNode, Set<SimNode>>>(new Map());
  const byDegreeRef = useRef<SimNode[]>([]);
  const labelsRef = useRef<PlacedLabel[]>([]);
  const layoutMsRef = useRef(0);

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

    const C = colorsRef.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);

    const { x: tx, y: ty, k } = transformRef.current;
    ctx.save();
    ctx.translate(tx + w / 2, ty + h / 2);
    ctx.scale(k, k);

    const nodes = nodesRef.current;
    const edges = edgesRef.current;
    // Hovering (or the keyboard's node) highlights it and its neighbours; the rest fades.
    const hovered = hoveredRef.current ?? selectedRef.current;
    const matches = matchesRef.current;
    const focus = hovered ? neighboursRef.current.get(hovered) ?? new Set<SimNode>() : null;
    const inFocus = (n: SimNode) => (!focus || n === hovered || focus.has(n)) && (!matches || matches.has(n.id));
    const fillOf = (n: SimNode) => (n.category ? catColorRef.current.get(n.category) ?? C.muted : C.node);

    // Draw edges
    for (const edge of edges) {
      const s = edge.source as SimNode;
      const t = edge.target as SimNode;
      if (s.x == null || s.y == null || t.x == null || t.y == null) continue;
      const hot = !!hovered && (s === hovered || t === hovered);
      ctx.globalAlpha = (focus && !hot) || (matches && !(matches.has(s.id) && matches.has(t.id))) ? 0.2 : 1;
      ctx.strokeStyle = hot ? C.nodeHover : C.edge;
      ctx.lineWidth = (hot ? 2 : 1) / k;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
      ctx.stroke();
    }

    // Draw nodes
    const current = currentRef.current;
    for (const node of nodes) {
      if (node.x == null || node.y == null) continue;
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      ctx.fillStyle = node === hovered && !node.category ? C.nodeHover : fillOf(node);
      ctx.globalAlpha = inFocus(node) ? 0.9 : node.id === current ? 0.6 : matches ? 0.12 : 0.3;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (matches?.has(node.id)) {
        ctx.strokeStyle = C.match;
        ctx.lineWidth = 2.5 / k;
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius + 3 / k, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (node.id === current) {
        // "You are here": a double ring in the text colour.
        ctx.strokeStyle = C.here;
        ctx.lineWidth = 2.5 / k;
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius + 4 / k, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 1 / k;
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius + 8 / k, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (node === selectedRef.current) {
        ctx.strokeStyle = C.nodeHover;
        ctx.lineWidth = 2 / k;
        ctx.setLineDash([4 / k, 3 / k]);
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius + (node.id === current ? 12 : 6) / k, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // Labels, in screen space. Priority: the current page, the hovered/keyboard
    // node, search matches, its neighbours, then the most linked nodes. A label
    // is drawn only where it overlaps no label already placed, so zooming out
    // thins them out instead of piling them up.
    const fontPx = labelFontSize(k) * k;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const lineH = Math.ceil(fontPx * 1.25);
    const placed: PlacedLabel[] = [];
    const CELL = 64;
    const grid = new Map<string, PlacedLabel[]>();
    const cells = (r: PlacedLabel) => {
      const out: string[] = [];
      for (let gx = Math.floor((r.x - LABEL_PAD) / CELL); gx <= Math.floor((r.x + r.w + LABEL_PAD) / CELL); gx++)
        for (let gy = Math.floor((r.y - LABEL_PAD) / CELL); gy <= Math.floor((r.y + r.h + LABEL_PAD) / CELL); gy++) out.push(gx + ":" + gy);
      return out;
    };
    const collides = (r: PlacedLabel) => cells(r).some((c) => (grid.get(c) ?? []).some((o) =>
      r.x < o.x + o.w + LABEL_PAD && o.x < r.x + r.w + LABEL_PAD && r.y < o.y + o.h + LABEL_PAD && o.y < r.y + r.h + LABEL_PAD));
    const ordered: SimNode[] = [];
    const seen = new Set<SimNode>();
    const push = (n: SimNode) => { if (!seen.has(n)) { seen.add(n); ordered.push(n); } };
    const currentNode = current ? nodes.find((n) => n.id === current) : undefined;
    if (currentNode) push(currentNode);
    if (hovered) push(hovered);
    if (matches) for (const n of byDegreeRef.current) if (matches.has(n.id)) push(n);
    if (hovered) for (const n of [...(focus ?? [])].sort((a, b) => b.degree - a.degree)) push(n);
    for (const n of byDegreeRef.current) push(n);
    for (const node of ordered) {
      if (node.x == null || node.y == null) continue;
      const sx = tx + w / 2 + node.x * k;
      const sy = ty + h / 2 + node.y * k;
      const rr = node.radius * k;
      if (sx + rr < 0 || sx - rr > w || sy + rr < 0 || sy - rr > h) continue; // off screen
      const isHere = node.id === current;
      ctx.font = `${isHere ? "600 " : ""}${fontPx}px ${LABEL_FONT}`;
      const label = nodeLabel(node);
      const lw = ctx.measureText(label).width;
      // Nudge a label that would poke out past the canvas edge back in.
      const lx = Math.min(Math.max(sx - lw / 2, 4), Math.max(4, w - 4 - lw));
      const rect: PlacedLabel = { id: node.id, x: lx, y: sy + rr + LABEL_GAP + (isHere ? 8 : 0), w: lw, h: lineH };
      const forced = node === hovered || isHere;
      if (!forced && collides(rect)) continue;
      placed.push(rect);
      for (const c of cells(rect)) { const l = grid.get(c); if (l) l.push(rect); else grid.set(c, [rect]); }
      const hot = node === hovered || isHere || (focus?.has(node) ?? false) || (matches?.has(node.id) ?? false);
      // A halo in the background colour keeps labels readable over edges.
      ctx.lineWidth = 3;
      ctx.strokeStyle = C.bg;
      ctx.globalAlpha = inFocus(node) || isHere ? 1 : 0.45;
      ctx.strokeText(label, rect.x, rect.y);
      ctx.fillStyle = hot ? C.labelHover : C.label;
      ctx.fillText(label, rect.x, rect.y);
    }
    ctx.globalAlpha = 1;
    labelsRef.current = placed;
  }, []);

  // Follow the app theme (light theme → light canvas).
  const [themeTick, setThemeTick] = useState(0);
  useEffect(() => onThemeChange(() => { colorsRef.current = readColors(); setThemeTick((t) => t + 1); }), []);

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
    canvas.dataset.layoutMs = String(Math.round(layoutMsRef.current));
    canvas.dataset.selected = selectedRef.current?.id ?? "";
    canvas.dataset.current = nodesRef.current.some((n) => n.id === currentRef.current) ? currentRef.current ?? "" : "";
    canvas.dataset.matches = matchesRef.current ? String(matchesRef.current.size) : "";
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

  /** Pan (not zoom) so `node` is on screen with a margin. */
  const revealNode = useCallback((node: SimNode) => {
    const canvas = canvasRef.current;
    if (!canvas || node.x == null || node.y == null) return;
    const t = transformRef.current;
    const w = canvas.clientWidth, h = canvas.clientHeight, m = 60;
    const sx = t.x + w / 2 + node.x * t.k, sy = t.y + h / 2 + node.y * t.k;
    if (sx < m) t.x += m - sx; else if (sx > w - m) t.x -= sx - (w - m);
    if (sy < m) t.y += m - sy; else if (sy > h - m) t.y -= sy - (h - m);
  }, []);

  const select = useCallback((node: SimNode | null, reveal = true) => {
    selectedRef.current = node;
    setSelectedTitle(node?.title ?? "");
    if (node && reveal) revealNode(node);
    draw();
    publishStats();
  }, [draw, publishStats, revealNode]);

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

  // Load the graph once (and the project names, for filters and the legend)
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
    api.getFolderTree().then((t) => {
      if (cancelled) return;
      const names = new Map<string, string>();
      const walk = (fs: api.FolderTree[], prefix: string) => {
        for (const f of fs) {
          names.set(f.id, prefix + f.name);
          walk(f.children ?? [], prefix + f.name + " / ");
        }
      };
      walk(t.folders, "");
      setFolderNames(names);
    }).catch(() => { /* names are cosmetic */ });
    return () => { cancelled = true; };
  }, []);

  const adj = useMemo(() => (data ? adjacency(data) : new Map<string, Set<string>>()), [data]);
  const linkedCount = useMemo(() => [...adj.values()].filter((s) => s.size > 0).length, [adj]);
  const totalCount = data?.nodes.length ?? 0;
  const unlinkedCount = totalCount - linkedCount;
  // Default: hide the orphans when they would drown out the linked pages.
  const hideUnlinked = hidePref ?? (linkedCount > 0 && unlinkedCount > totalCount / 2);
  const currentKnown = !!currentPageId && adj.has(currentPageId);
  const localActive = localDepth > 0 && currentKnown;

  const toggleHideUnlinked = useCallback((next: boolean) => {
    writePref(HIDE_UNLINKED_KEY, next ? "1" : "0");
    setHidePref(next);
  }, []);
  const changeLocal = useCallback((depth: number) => {
    writePref(LOCAL_KEY, String(depth));
    setLocalDepth(depth);
  }, []);
  const changeColorBy = useCallback((v: ColorBy) => {
    writePref(COLOR_KEY, v);
    setColorBy(v);
  }, []);

  const filters: GraphFilters = useMemo(() => ({
    local: localActive ? { centerId: currentPageId!, depth: localDepth } : null,
    project: projectFilter,
    tag: tagFilter,
    orphansOnly,
    hideUnlinked,
  }), [localActive, currentPageId, localDepth, projectFilter, tagFilter, orphansOnly, hideUnlinked]);

  const shown = useMemo(() => (data ? visibleNodes(data, adj, filters) : []), [data, adj, filters]);
  const projectName = useCallback((id: string) => folderNames.get(id) ?? "Project", [folderNames]);
  const cats = useMemo(() => categories(shown, colorBy, projectName), [shown, colorBy, projectName]);
  const legend = useMemo(() => {
    const C = colorsRef.current;
    const map = new Map<string, string>();
    let i = 0;
    for (const c of cats.list) {
      map.set(c.key, c.key === OTHER || c.key === NO_PROJECT ? C.muted : C.cats[i++ % C.cats.length]);
    }
    return map;
    // themeTick: re-read the palette after a theme change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cats, themeTick]);
  catColorRef.current = legend;

  // Filter choices, from the whole notebook (not just what is shown).
  const projectChoices = useMemo(() => {
    const ids = new Set<string>();
    for (const n of data?.nodes ?? []) if (n.folder_id) ids.add(n.folder_id);
    return [...ids].map((id) => ({ id, name: projectName(id) })).sort((a, b) => a.name.localeCompare(b.name));
  }, [data, projectName]);
  const tagChoices = useMemo(() => {
    const c = new Map<string, number>();
    for (const n of data?.nodes ?? []) for (const t of n.tags ?? []) c.set(t, (c.get(t) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([t]) => t);
  }, [data]);

  // Build the simulation for the visible nodes, settle it, then fit to view.
  useEffect(() => {
    if (!data) return;
    const t0 = performance.now();

    const nodes: SimNode[] = shown.map((n) => ({
      id: n.id,
      title: n.title,
      block_count: n.block_count,
      link_count: n.link_count,
      radius: nodeRadius(n.block_count),
      degree: 0,
      category: cats.categoryOf.get(n.id) ?? "",
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

    const neighbours = new Map<SimNode, Set<SimNode>>(nodes.map((n) => [n, new Set<SimNode>()]));
    for (const e of edges) {
      const s = e.source as SimNode, t = e.target as SimNode;
      if (s === t) continue;
      neighbours.get(s)!.add(t);
      neighbours.get(t)!.add(s);
    }
    for (const n of nodes) n.degree = neighbours.get(n)!.size;
    neighboursRef.current = neighbours;
    byDegreeRef.current = [...nodes].sort((a, b) => b.degree - a.degree || b.block_count - a.block_count);

    nodesRef.current = nodes;
    edgesRef.current = edges;
    hoveredRef.current = null;
    const prevSel = selectedRef.current?.id;
    selectedRef.current = prevSel ? nodeMap.get(prevSel) ?? null : null;
    setSelectedTitle(selectedRef.current?.title ?? "");
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
    // A local graph centres on the current page.
    const here = nodeMap.get(currentRef.current ?? "");
    if (here && localActive) { here.fx = 0; here.fy = 0; }
    sim.tick(nodes.length > 1500 ? 80 : 300);
    if (here) { here.fx = null; here.fy = null; }
    sim.on("tick", () => { draw(); });
    simRef.current = sim;
    fitToView();
    layoutMsRef.current = performance.now() - t0;
    publishStats();

    return () => {
      sim.stop();
    };
    // cats.categoryOf is rebuilt with `shown`; colour-only changes go through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, shown, draw, fitToView, publishStats]);

  // Colour changes recolour in place (no new layout).
  useEffect(() => {
    for (const n of nodesRef.current) n.category = cats.categoryOf.get(n.id) ?? "";
    draw();
  }, [cats, legend, draw]);

  // Search: matching titles stand out, the rest fades (null = no search).
  useEffect(() => {
    const q = query.trim();
    matchesRef.current = q ? new Set(nodesRef.current.filter((n) => titleMatches(n.title, q)).map((n) => n.id)) : null;
    draw();
    publishStats();
  }, [query, counts, draw, publishStats]);
  const matchCount = query.trim() ? nodesRef.current.filter((n) => titleMatches(n.title, query)).length : 0;

  /** Enter in the search box: the best match becomes the keyboard's node. */
  const jumpToMatch = useCallback(() => {
    const m = matchesRef.current;
    if (!m || m.size === 0) return;
    const best = byDegreeRef.current.find((n) => m.has(n.id));
    if (best) {
      select(best);
      canvasRef.current?.focus({ preventScroll: true });
    }
  }, [select]);

  const onCanvasKeyDown = useCallback((e: React.KeyboardEvent<HTMLCanvasElement>) => {
    const nodes = nodesRef.current;
    if (nodes.length === 0) return;
    const sel = selectedRef.current;
    if (e.key === "Enter") {
      if (sel) { e.preventDefault(); onPageClick(sel.id); }
      return;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      if (!sel) {
        select(nodes.find((n) => n.id === currentRef.current) ?? byDegreeRef.current[0] ?? null);
        return;
      }
      const pt = (n: SimNode) => ({ id: n.id, x: n.x ?? 0, y: n.y ?? 0 });
      const nb = [...(neighboursRef.current.get(sel) ?? [])].map(pt);
      const next = stepTo(pt(sel), e.key as ArrowKey, nb, nodes.map(pt));
      if (next) select(nodes.find((n) => n.id === next) ?? null);
    }
  }, [onPageClick, select]);

  const onCanvasFocus = useCallback(() => {
    if (selectedRef.current) return;
    const nodes = nodesRef.current;
    select(nodes.find((n) => n.id === currentRef.current) ?? byDegreeRef.current[0] ?? null, false);
  }, [select]);

  // Mouse interactions
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // One press = a click (opens the page) or, once it moves more than
    // DRAG_THRESHOLD_PX, a drag (moves the node, or pans the view) — never both.
    let press: { x: number; y: number; node: SimNode | null; moved: boolean; panX: number; panY: number } | null = null;

    const toSim = (e: MouseEvent) => {
      const { x: tx, y: ty, k } = transformRef.current;
      const rect = canvas.getBoundingClientRect();
      return { x: (e.clientX - rect.left - tx - canvas.clientWidth / 2) / k, y: (e.clientY - rect.top - ty - canvas.clientHeight / 2) / k };
    };

    const onPressMove = (e: MouseEvent) => {
      if (!press) return;
      if (!press.moved) {
        if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_THRESHOLD_PX) return;
        press.moved = true;
        if (press.node) {
          press.node.fx = press.node.x;
          press.node.fy = press.node.y;
          simRef.current?.alphaTarget(0.3).restart();
        }
      }
      if (press.node) {
        const p = toSim(e);
        press.node.fx = p.x;
        press.node.fy = p.y;
        return;
      }
      transformRef.current.x = press.panX + (e.clientX - press.x);
      transformRef.current.y = press.panY + (e.clientY - press.y);
      userMovedRef.current = true;
      draw();
      publishStats();
    };

    const onPressUp = () => {
      window.removeEventListener("mousemove", onPressMove);
      window.removeEventListener("mouseup", onPressUp);
      const p = press;
      press = null;
      if (!p) return;
      if (p.node && p.moved) {
        p.node.fx = null;
        p.node.fy = null;
        simRef.current?.alphaTarget(0);
      } else if (p.node && !p.moved) {
        onPageClick(p.node.id);
      }
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault(); // no text selection while dragging
      canvas.focus({ preventScroll: true });
      press = {
        x: e.clientX, y: e.clientY, node: hitTest(e.clientX, e.clientY), moved: false,
        panX: transformRef.current.x, panY: transformRef.current.y,
      };
      window.addEventListener("mousemove", onPressMove);
      window.addEventListener("mouseup", onPressUp);
    };

    // Hover detection (not while a press is in progress).
    const onMouseMove = (e: MouseEvent) => {
      if (press) return;
      const node = hitTest(e.clientX, e.clientY);
      if (node !== hoveredRef.current) {
        hoveredRef.current = node;
        canvas.style.cursor = node ? "pointer" : "default";
        draw();
      }
    };
    const onMouseLeave = () => {
      if (press || !hoveredRef.current) return;
      hoveredRef.current = null;
      draw();
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const t = transformRef.current;
      // Screen = t + size/2 + sim * k. Keep the sim point under the cursor fixed:
      // t' = c - (c - t) * k'/k, with c the cursor relative to the canvas centre.
      const cx = e.clientX - rect.left - canvas.clientWidth / 2;
      const cy = e.clientY - rect.top - canvas.clientHeight / 2;
      const zoom = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const newK = Math.max(0.1, Math.min(5, t.k * zoom));
      const ratio = newK / t.k;
      t.x = cx - (cx - t.x) * ratio;
      t.y = cy - (cy - t.y) * ratio;
      t.k = newK;
      userMovedRef.current = true;
      draw();
      publishStats();
    };

    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mouseleave", onMouseLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    // For tests and tooling: where each node and label is on screen (client px).
    (canvas as unknown as { __minotesGraph?: unknown }).__minotesGraph = {
      nodes: () => {
        const rect = canvas.getBoundingClientRect();
        const { x: tx, y: ty, k } = transformRef.current;
        return nodesRef.current.filter((n) => n.x != null && n.y != null).map((n) => ({
          id: n.id, title: n.title, degree: n.degree, r: n.radius * k,
          x: rect.left + tx + canvas.clientWidth / 2 + n.x! * k,
          y: rect.top + ty + canvas.clientHeight / 2 + n.y! * k,
          color: n.category ? catColorRef.current.get(n.category) ?? null : null,
          match: matchesRef.current?.has(n.id) ?? false,
          current: n.id === currentRef.current,
        }));
      },
      labels: () => labelsRef.current.map((l) => ({ ...l })),
      colors: () => ({ ...colorsRef.current }),
      selected: () => selectedRef.current?.id ?? null,
      layoutMs: () => layoutMsRef.current,
    };

    return () => {
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mouseleave", onMouseLeave);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("mousemove", onPressMove);
      window.removeEventListener("mouseup", onPressUp);
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

  // Esc closes the graph when nothing above it is open (lib/layers.ts).
  useLayer(true, "canvas", onClose);

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

  const filtered = projectFilter !== null || tagFilter !== null || orphansOnly;
  const localReason = !currentPageId ? "Open a page first: the local graph is centred on it" : !currentKnown ? "This page isn't in the graph" : "";

  return (
    <div className="graph-view">
      <div className="graph-toolbar">
        <NotebookLabel />
        <span className="graph-toolbar-stats">
          {counts.nodes} pages · {counts.edges} links
          {!orphansOnly && hideUnlinked && unlinkedCount > 0 && !localActive && (
            <span className="graph-hidden-count" title="Pages with no links are hidden (Which pages)"> · {unlinkedCount} unlinked hidden</span>
          )}
        </span>
        <div className="graph-search">
          <Icon name="search" size={14} />
          <input
            type="search"
            className="graph-search-input"
            placeholder="Find a page…"
            aria-label="Find a page in the graph"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); jumpToMatch(); }
              if (e.key === "Escape" && query) { e.preventDefault(); setQuery(""); }
            }}
          />
          {query.trim() && <span className="graph-search-count" aria-live="polite">{matchCount} match{matchCount === 1 ? "" : "es"}</span>}
        </div>
        <div className="graph-segmented" role="group" aria-label="Graph scope">
          <button className={`btn btn-sm${!localActive ? " active" : ""}`} aria-pressed={!localActive} onClick={() => changeLocal(0)} title="Every page in the notebook">All</button>
          <button
            className={`btn btn-sm graph-local-btn${localActive ? " active" : ""}`}
            aria-pressed={localActive}
            disabled={!!localReason}
            onClick={() => changeLocal(localDepth || 1)}
            title={localReason || "Only the pages near this one"}
          >
            <Icon name="target" size={13} /> Local
          </button>
        </div>
        {localActive && (
          <select className="graph-local-depth" aria-label="Local graph depth" value={localDepth} onChange={(e) => changeLocal(Number(e.target.value))}>
            <option value={1}>1 link away</option>
            <option value={2}>2 links away</option>
            <option value={3}>3 links away</option>
          </select>
        )}
        <select
          className="graph-show"
          aria-label="Which pages"
          value={orphansOnly ? "orphans" : hideUnlinked ? "linked" : "all"}
          onChange={(e) => {
            const v = e.target.value;
            setOrphansOnly(v === "orphans");
            if (v !== "orphans") toggleHideUnlinked(v === "linked");
          }}
          title={unlinkedCount === 0 ? "Every page is linked" : `${unlinkedCount} page${unlinkedCount === 1 ? " has" : "s have"} no links to or from other pages`}
        >
          <option value="all">All pages</option>
          <option value="linked">Linked pages</option>
          <option value="orphans">Orphans only</option>
        </select>
        <select className="graph-filter-project" aria-label="Show project" value={projectFilter ?? ""} onChange={(e) => setProjectFilter(e.target.value || null)}>
          <option value="">All projects</option>
          {projectChoices.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          <option value={NO_PROJECT}>No project</option>
        </select>
        <select className="graph-filter-tag" aria-label="Show tag" value={tagFilter ?? ""} onChange={(e) => setTagFilter(e.target.value || null)} disabled={tagChoices.length === 0} title={tagChoices.length === 0 ? "No page uses a #tag yet" : undefined}>
          <option value="">All tags</option>
          {tagChoices.map((t) => <option key={t} value={t}>#{t}</option>)}
        </select>
        <select className="graph-color-by" aria-label="Colour nodes by" value={colorBy} onChange={(e) => changeColorBy(e.target.value as ColorBy)}>
          <option value="none">One colour</option>
          <option value="project">Colour: project</option>
          <option value="tag">Colour: tag</option>
        </select>
        <button className="btn btn-sm graph-fit-btn" onClick={fitToView} title="Fit all nodes in view">
          Fit
        </button>
        <button className="btn btn-sm graph-close-btn" onClick={onClose} title="Close the graph (Esc)" aria-label="Close the graph">
          <Icon name="x" size={14} />
        </button>
      </div>
      <div ref={wrapRef} className="graph-canvas-wrap">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          role="application"
          aria-label="Page graph. Arrow keys move between linked pages, Enter opens one."
          onKeyDown={onCanvasKeyDown}
          onFocus={onCanvasFocus}
        />
        <div className="graph-sr-status" aria-live="polite">{selectedTitle}</div>
        {cats.list.length > 0 && (
          <div className="graph-legend" data-testid="graph-legend">
            {cats.list.map((c) => (
              <div key={c.key} className="graph-legend-row" data-key={c.key}>
                <span className="graph-legend-dot" style={{ background: legend.get(c.key) }} />
                <span className="graph-legend-label">{c.label}</span>
                <span className="graph-legend-count">{c.count}</span>
              </div>
            ))}
          </div>
        )}
        {counts.nodes === 0 && (
          <div className="graph-canvas-note">
            {filtered || localActive ? (
              <>
                <span>No page matches these filters.</span>
                <button className="btn btn-sm" onClick={() => { setProjectFilter(null); setTagFilter(null); setOrphansOnly(false); changeLocal(0); }}>Show all pages</button>
              </>
            ) : (
              <>
                <span>None of the {totalCount} pages link to each other yet.</span>
                <button className="btn btn-sm" onClick={() => toggleHideUnlinked(false)}>Show unlinked pages</button>
              </>
            )}
          </div>
        )}
        {localActive && counts.nodes > 0 && (
          <div className="graph-here-note">Local graph · {localDepth} link{localDepth > 1 ? "s" : ""} from this page</div>
        )}
      </div>
    </div>
  );
}
