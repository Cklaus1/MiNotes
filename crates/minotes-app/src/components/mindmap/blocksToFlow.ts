import { type Node, type Edge, Position } from "@xyflow/react";
import dagre from "dagre";
import type { Block } from "../../lib/api";
import { inlineSegments, segmentsText } from "../../lib/richText";

export interface MindMapNodeData {
  label: string;
  fullContent: string;
  blockId: string | null;
  isRoot: boolean;
  depth: number;
  todoState: "todo" | "doing" | "done" | null;
  collapsed: boolean;
  childCount: number;
  color: string | null; // from block property "color:: blue"
  isNew?: boolean; // entrance animation flag
  /** Radial layout: the node is drawn narrower (.mm-node-radial). */
  radial?: boolean;
  /** Search: true = matches, false = dimmed, undefined = no search. */
  match?: boolean;
  /** Ctrl+click on a [[link]] in the label opens that page. */
  onOpenLink?: (title: string) => void;
  onSave?: (text: string) => void;
  onToggleCollapse?: () => void;
}

const COLOR_MAP: Record<string, string> = {
  blue: "#89b4fa",
  green: "#a6e3a1",
  red: "#f38ba8",
  yellow: "#f9e2af",
  purple: "#cba6f7",
  orange: "#fab387",
  pink: "#f5c2e7",
  teal: "#94e2d5",
};

function extractColor(content: string): string | null {
  // Match "color:: value" anywhere in block content
  const match = content.match(/color::\s*(\w+)/);
  if (match && COLOR_MAP[match[1].toLowerCase()]) {
    return COLOR_MAP[match[1].toLowerCase()];
  }
  return null;
}

/** Strip markdown formatting to get a clean label */
export function extractLabel(content: string, maxLen = 60): string {
  let text = content.trim();
  // Strip heading markers
  text = text.replace(/^#{1,4}\s+/, "");
  // Strip bold/italic
  text = text.replace(/\*\*(.+?)\*\*/g, "$1");
  text = text.replace(/\*(.+?)\*/g, "$1");
  text = text.replace(/__(.+?)__/g, "$1");
  text = text.replace(/_(.+?)_/g, "$1");
  // Strip strikethrough
  text = text.replace(/~~(.+?)~~/g, "$1");
  // Strip inline code
  text = text.replace(/`(.+?)`/g, "$1");
  // Strip wiki links
  text = text.replace(/\[\[(.+?)\]\]/g, "$1");
  // Replace whiteboard embeds with label
  text = text.replace(/\{\{whiteboard:[^}]+\}\}/g, WHITEBOARD_LABEL);
  // Strip checkbox markers
  text = text.replace(/^- \[[ x]\]\s*/, "");
  // Strip list markers
  text = text.replace(/^[-*+]\s+/, "");
  // First line only
  text = text.split("\n")[0];
  // Truncate
  if (text.length > maxLen) text = text.slice(0, maxLen - 1).trimEnd() + "…";
  return text || "(empty)";
}

/** Label shown in place of a `{{whiteboard:<id>}}` embed. */
export const WHITEBOARD_LABEL = "[Whiteboard]";

/**
 * Remove the leading TODO/DOING/DONE keyword — for views that already show the
 * state as a badge or icon. Only strips what detectTodoState() recognises.
 */
export function stripTodoKeyword(content: string): string {
  return content.replace(/^(TODO|DOING|DONE) /, "");
}

/** Label for a task-aware view: markdown and the state keyword stripped. */
export function extractTaskLabel(content: string, maxLen = 60): string {
  return extractLabel(stripTodoKeyword(content), maxLen);
}

/** True when a block is an H1 that just repeats the page title ("# Title"). */
export function isTitleHeading(content: string, pageTitle: string): boolean {
  const m = content.trim().match(/^#\s+(.+)$/);
  if (!m) return false;
  return extractLabel(m[1], Infinity).toLowerCase() === pageTitle.trim().toLowerCase();
}

export function detectTodoState(content: string): "todo" | "doing" | "done" | null {
  if (content.startsWith("DONE ") || content.includes("- [x]")) return "done";
  if (content.startsWith("DOING ")) return "doing";
  if (content.startsWith("TODO ") || content.includes("- [ ]")) return "todo";
  return null;
}

function getDepth(blockId: string, parentMap: Map<string, string | null>): number {
  let depth = 0;
  let current = parentMap.get(blockId);
  const seen = new Set<string>([blockId]);
  while (current) {
    if (seen.has(current)) break; // cycle guard
    seen.add(current);
    depth++;
    if (depth > 100) break; // hard cap
    current = parentMap.get(current);
  }
  return depth;
}

function countDescendants(
  blockId: string,
  childrenMap: Map<string, string[]>,
  seen: Set<string> = new Set(),
): number {
  if (seen.has(blockId)) return 0; // cycle guard
  seen.add(blockId);
  const children = childrenMap.get(blockId) ?? [];
  let count = children.length;
  for (const child of children) {
    count += countDescendants(child, childrenMap, seen);
  }
  return count;
}

// Node box metrics — keep in sync with .mm-node / .mm-label in styles.css.
// A label that doesn't fit on one line wraps to a second, then ellipsizes.
const NODE_MAX_WIDTH = 220;
const NODE_CHAR_WIDTH = 7.5;
const NODE_LINE_HEIGHT = 40;
const NODE_TWO_LINE_HEIGHT = 58;
/** Longest label kept in the DOM; CSS clamps what is actually visible. */
const NODE_LABEL_MAX = 120;

/** Radial maps are dense: narrower nodes that may wrap to a third line
 *  (keep in sync with .mm-node-radial in components/views.css). */
export const RADIAL_NODE_MAX_WIDTH = 150;
const NODE_THREE_LINE_HEIGHT = 76;

function nodeBox(label: string, extra: number, minWidth: number, radial = false): { width: number; height: number } {
  const natural = label.length * NODE_CHAR_WIDTH + 32 + extra;
  const max = radial ? RADIAL_NODE_MAX_WIDTH : NODE_MAX_WIDTH;
  const lines = natural <= max ? 1 : !radial || natural <= max * 2 - 40 ? 2 : 3;
  return {
    width: Math.min(max, Math.max(Math.min(minWidth, max), natural)),
    height: lines === 1 ? NODE_LINE_HEIGHT : lines === 2 ? NODE_TWO_LINE_HEIGHT : NODE_THREE_LINE_HEIGHT,
  };
}

export type LayoutDirection = "LR" | "TB" | "radial";

/** Free space kept between node boxes in the radial layout (also absorbs the
 *  difference between the estimated and the rendered node size). */
const RADIAL_GAP = 28;

/**
 * Radial (sunburst) layout: the root in the centre, depth d on ring d.
 * Every subtree gets an angular wedge proportional to its leaf count, and a node
 * sits in the middle of its wedge — so children stay next to their parent and
 * edges never cross. Each ring's radius is the smallest that keeps
 *  - neighbours on the ring apart: the chord between two centres must clear
 *    both boxes along that chord (exact box/box separation), and
 *  - consecutive rings apart: the ring gap is at least the sum of the two
 *    rings' largest half-diagonals (circumradii), so no box can touch a box on
 *    another ring.
 * Returns each node's centre.
 */
export function radialLayout(
  rootId: string,
  edges: { source: string; target: string }[],
  size: (id: string) => { width: number; height: number },
): Map<string, { x: number; y: number }> {
  const kids = new Map<string, string[]>();
  for (const e of edges) {
    const l = kids.get(e.source);
    if (l) l.push(e.target); else kids.set(e.source, [e.target]);
  }
  const leaves = new Map<string, number>();
  const countLeaves = (id: string, guard: Set<string>): number => {
    if (guard.has(id)) return 1;
    guard.add(id);
    const ch = kids.get(id) ?? [];
    const n = ch.length === 0 ? 1 : ch.reduce((s, c) => s + countLeaves(c, guard), 0);
    leaves.set(id, n);
    return n;
  };
  countLeaves(rootId, new Set());

  // Angles (wedge middles) and depths, starting at the top, clockwise.
  const angle = new Map<string, number>();
  const depth = new Map<string, number>();
  const assign = (id: string, a0: number, a1: number, d: number, guard: Set<string>) => {
    if (guard.has(id)) return;
    guard.add(id);
    angle.set(id, (a0 + a1) / 2);
    depth.set(id, d);
    const ch = kids.get(id) ?? [];
    const total = ch.reduce((s, c) => s + (leaves.get(c) ?? 1), 0) || 1;
    let a = a0;
    for (const c of ch) {
      const span = ((a1 - a0) * (leaves.get(c) ?? 1)) / total;
      assign(c, a, a + span, d + 1, guard);
      a += span;
    }
  };
  assign(rootId, -Math.PI / 2, (3 * Math.PI) / 2, 0, new Set());

  const rings: string[][] = [];
  for (const [id, d] of depth) {
    if (d === 0) continue;
    (rings[d - 1] ??= []).push(id);
  }
  // Half the box's extent along the radius through its centre.
  const radialHalf = (id: string) => {
    const s = size(id), a = angle.get(id) ?? 0;
    return (Math.abs(s.width * Math.cos(a)) + Math.abs(s.height * Math.sin(a))) / 2;
  };

  const radius: number[] = [];
  let prevRadius = 0;
  let prevHalf = Math.max(size(rootId).width, size(rootId).height) / 2;
  for (let i = 0; i < rings.length; i++) {
    const ring = (rings[i] ?? []).sort((a, b) => angle.get(a)! - angle.get(b)!);
    const maxHalf = Math.max(...ring.map(radialHalf));
    let r = prevRadius + prevHalf + maxHalf + RADIAL_GAP;
    if (ring.length > 1) {
      for (let j = 0; j < ring.length; j++) {
        const a = ring[j], b = ring[(j + 1) % ring.length];
        let delta = angle.get(b)! - angle.get(a)!;
        if (j === ring.length - 1) delta += 2 * Math.PI; // wrap-around pair
        if (delta <= 1e-6) continue;
        const sa = size(a), sb = size(b);
        // Direction of the chord between the two centres.
        const phi = (angle.get(a)! + angle.get(b)! + (j === ring.length - 1 ? 2 * Math.PI : 0)) / 2 + Math.PI / 2;
        const cos = Math.abs(Math.cos(phi)), sin = Math.abs(Math.sin(phi));
        const needX = cos > 1e-6 ? ((sa.width + sb.width) / 2 + RADIAL_GAP) / cos : Infinity;
        const needY = sin > 1e-6 ? ((sa.height + sb.height) / 2 + RADIAL_GAP) / sin : Infinity;
        const chord = Math.min(needX, needY);
        const sinHalf = Math.sin(Math.min(delta, Math.PI) / 2);
        r = Math.max(r, chord / (2 * sinHalf));
      }
    }
    radius[i] = r;
    prevRadius = r;
    prevHalf = maxHalf;
  }

  // The ring rules are tight, not exhaustive (two boxes on neighbouring rings at
  // different angles can still touch): check every pair, and push the outer of
  // two touching rings — and everything beyond it — outward until none do.
  const ids = [...depth.keys()];
  const place = (id: string) => {
    const d = depth.get(id)!;
    if (d === 0) return { x: 0, y: 0 };
    const r = radius[d - 1], a = angle.get(id)!;
    return { x: r * Math.cos(a), y: r * Math.sin(a) };
  };
  if (ids.length <= 1500) {
    for (let iter = 0; iter < 40; iter++) {
      const boxes = ids.map((id) => ({ id, d: depth.get(id)!, c: place(id), s: size(id) }));
      let worst = -1;
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i], b = boxes[j];
          if (Math.abs(a.c.x - b.c.x) < (a.s.width + b.s.width) / 2 + RADIAL_GAP / 2 &&
              Math.abs(a.c.y - b.c.y) < (a.s.height + b.s.height) / 2 + RADIAL_GAP / 2) {
            worst = worst === -1 ? Math.max(a.d, b.d) : Math.min(worst, Math.max(a.d, b.d));
          }
        }
      }
      if (worst < 1) break;
      for (let d = worst; d <= radius.length; d++) radius[d - 1] *= 1.12;
    }
  }

  const out = new Map<string, { x: number; y: number }>();
  out.set(rootId, { x: 0, y: 0 });
  for (const [id, d] of depth) {
    if (d === 0) continue;
    const r = radius[d - 1], a = angle.get(id)!;
    out.set(id, { x: r * Math.cos(a), y: r * Math.sin(a) });
  }
  return out;
}

export function blocksToFlow(
  blocks: Block[],
  pageTitle: string,
  collapsedIds: Set<string>,
  direction: LayoutDirection = "LR",
  editingNodeId: string | null = null,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const isRadial = direction === "radial";
  const dagreDir = isRadial ? "TB" : direction;

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: dagreDir,
    nodesep: isRadial ? 40 : 24,
    ranksep: isRadial ? 120 : 100,
    marginx: 20,
    marginy: 20,
  });

  // Build parent/children maps
  const parentMap = new Map<string, string | null>();
  const childrenMap = new Map<string, string[]>();
  for (const block of blocks) {
    parentMap.set(block.id, block.parent_id ?? null);
    const parentKey = block.parent_id ?? "__root__";
    if (!childrenMap.has(parentKey)) childrenMap.set(parentKey, []);
    childrenMap.get(parentKey)!.push(block.id);
  }

  // Root node = page title
  const rootId = "__page_root__";
  const rootBox = nodeBox(pageTitle, pageTitle.length * 1.5 + 16, 120);
  g.setNode(rootId, { width: Math.min(240, rootBox.width + 20), height: rootBox.height + 4 });
  nodes.push({
    id: rootId,
    type: "mindmapNode",
    data: {
      label: pageTitle,
      fullContent: pageTitle,
      blockId: null,
      isRoot: true,
      depth: 0,
      todoState: null,
      collapsed: false,
      childCount: 0,
      color: null,
    } satisfies MindMapNodeData,
    position: { x: 0, y: 0 },
  });

  const sourcePos = direction === "LR" ? Position.Right : Position.Bottom;
  const targetPos = direction === "LR" ? Position.Left : Position.Top;

  // Check if block content is effectively empty
  // Whitespace-only and formatting-only (e.g. "- ", "* ", "+ ", "- [ ] ") count as empty
  const isBlockEmpty = (content: string): boolean => {
    const stripped = content
      .replace(/^[-*+]\s*(\[[ x]\]\s*)?/, "") // strip list markers and checkboxes
      .replace(/^#{1,4}\s*$/, "")              // strip heading markers with no text
      .trim();
    return stripped.length === 0;
  };

  // Cycle detection: track visited block IDs to prevent infinite recursion
  // on malformed data (e.g., block whose parent_id points back to a descendant)
  const visited = new Set<string>();

  // Recursively add blocks — skip empty blocks (collapse empty chains)
  // parentNodeId: the visual parent in the mind map (may skip empty ancestors)
  const addBlock = (block: Block, parentNodeId: string) => {
    if (visited.has(block.id)) return; // cycle guard
    visited.add(block.id);

    const isBeingEdited = block.id === editingNodeId;
    // A top-level "# Page title" block duplicates the root node: don't render
    // it, and hang its children off the root (same pass-through as empty blocks).
    const isEmpty = isBlockEmpty(block.content)
      || (!block.parent_id && isTitleHeading(block.content, pageTitle));

    if (isEmpty && !isBeingEdited) {
      // Skip this empty node but still process its children
      // Children connect to this block's parent — collapsing the empty chain
      if (!collapsedIds.has(block.id)) {
        const children = blocks
          .filter((b) => b.parent_id === block.id)
          .sort((a, b) => a.position - b.position);
        for (const child of children) {
          addBlock(child, parentNodeId); // pass through parent's visual node
        }
      }
      return;
    }

    const isCollapsed = collapsedIds.has(block.id);
    const todoState = detectTodoState(block.content);
    // The status icon already says TODO/DOING/DONE — don't repeat it in the text.
    const label = segmentsText(inlineSegments(block.content, { maxLen: NODE_LABEL_MAX })) || "(empty)";
    const hasChildren = (childrenMap.get(block.id)?.length ?? 0) > 0;
    const box = nodeBox(label, (todoState ? 18 : 0) + (hasChildren ? 26 : 0), 100, isRadial);

    g.setNode(block.id, box);
    g.setEdge(parentNodeId, block.id);

    const depth = getDepth(block.id, parentMap) + 1; // +1 because root is depth 0

    nodes.push({
      id: block.id,
      type: "mindmapNode",
      data: {
        label,
        fullContent: block.content,
        blockId: block.id,
        isRoot: false,
        depth,
        todoState,
        collapsed: isCollapsed,
        childCount: countDescendants(block.id, childrenMap),
        color: extractColor(block.content),
        radial: isRadial || undefined,
      } satisfies MindMapNodeData,
      position: { x: 0, y: 0 },
      sourcePosition: sourcePos,
      targetPosition: targetPos,
    });

    edges.push({
      id: `e-${parentNodeId}-${block.id}`,
      source: parentNodeId,
      target: block.id,
      type: isRadial ? "straight" : "smoothstep",
      animated: false,
    });

    // Add children unless collapsed
    if (!isCollapsed) {
      const children = blocks
        .filter((b) => b.parent_id === block.id)
        .sort((a, b) => a.position - b.position);
      for (const child of children) {
        addBlock(child, block.id);
      }
    }
  };

  const rootBlocks = blocks
    .filter((b) => !b.parent_id)
    .sort((a, b) => a.position - b.position);
  for (const block of rootBlocks) {
    addBlock(block, rootId);
  }

  if (isRadial) {
    const size = (id: string) => {
      const n = g.node(id);
      return { width: n?.width ?? 150, height: n?.height ?? NODE_LINE_HEIGHT };
    };
    const centres = radialLayout(rootId, edges, size);
    for (const node of nodes) {
      const c = centres.get(node.id) ?? { x: 0, y: 0 };
      const { width, height } = size(node.id);
      node.position = { x: c.x - width / 2, y: c.y - height / 2 };
    }
    const cx = 0, cy = 0;

    // Handles: an edge enters a node on the side facing the centre and leaves
    // on the side facing outward.
    for (const node of nodes) {
      if (node.id === rootId) {
        // Root: source handles on all sides — use Bottom as default
        node.sourcePosition = Position.Bottom;
        node.targetPosition = Position.Top;
        continue;
      }
      const c = centres.get(node.id) ?? { x: 0, y: 0 };
      const angle = Math.atan2(c.y - cy, c.x - cx);

      // Target handle faces toward center, source faces away
      if (angle > -Math.PI / 4 && angle <= Math.PI / 4) {
        // Node is to the right of center
        node.targetPosition = Position.Left;
        node.sourcePosition = Position.Right;
      } else if (angle > Math.PI / 4 && angle <= (3 * Math.PI) / 4) {
        // Node is below center
        node.targetPosition = Position.Top;
        node.sourcePosition = Position.Bottom;
      } else if (angle > (-3 * Math.PI) / 4 && angle <= -Math.PI / 4) {
        // Node is above center
        node.targetPosition = Position.Bottom;
        node.sourcePosition = Position.Top;
      } else {
        // Node is to the left of center
        node.targetPosition = Position.Right;
        node.sourcePosition = Position.Left;
      }
    }
  } else {
    dagre.layout(g);
    // Apply computed positions (linear layout)
    for (const node of nodes) {
      const pos = g.node(node.id);
      if (pos) {
        node.position = { x: pos.x - (pos.width ?? 0) / 2, y: pos.y - (pos.height ?? 0) / 2 };
      }
      node.sourcePosition = sourcePos;
      node.targetPosition = targetPos;
    }
  }

  return { nodes, edges };
}
