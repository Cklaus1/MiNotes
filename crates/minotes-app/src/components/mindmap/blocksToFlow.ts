import { type Node, type Edge, Position } from "@xyflow/react";
import dagre from "dagre";
import type { Block } from "../../lib/api";

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
export function extractLabel(content: string): string {
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
  // Strip checkbox markers
  text = text.replace(/^- \[[ x]\]\s*/, "");
  // Strip list markers
  text = text.replace(/^[-*+]\s+/, "");
  // First line only
  text = text.split("\n")[0];
  // Truncate
  if (text.length > 60) text = text.slice(0, 57) + "...";
  return text || "(empty)";
}

function detectTodoState(content: string): "todo" | "doing" | "done" | null {
  if (content.startsWith("DONE ") || content.includes("- [x]")) return "done";
  if (content.startsWith("DOING ")) return "doing";
  if (content.startsWith("TODO ") || content.includes("- [ ]")) return "todo";
  return null;
}

function getDepth(blockId: string, parentMap: Map<string, string | null>): number {
  let depth = 0;
  let current = parentMap.get(blockId);
  while (current) {
    depth++;
    current = parentMap.get(current);
  }
  return depth;
}

function countDescendants(blockId: string, childrenMap: Map<string, string[]>): number {
  const children = childrenMap.get(blockId) ?? [];
  let count = children.length;
  for (const child of children) {
    count += countDescendants(child, childrenMap);
  }
  return count;
}

export type LayoutDirection = "LR" | "TB" | "radial";

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
  const rootWidth = Math.min(220, Math.max(120, pageTitle.length * 9 + 32));
  g.setNode(rootId, { width: rootWidth, height: 44 });
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

  // Recursively add blocks (skip empty blocks unless being edited)
  const addBlock = (block: Block, parentNodeId: string) => {
    const isEmpty = !block.content.trim();
    const isBeingEdited = block.id === editingNodeId;
    if (isEmpty && !isBeingEdited) return; // Hide empty blocks

    const isCollapsed = collapsedIds.has(block.id);
    const label = extractLabel(block.content);
    const width = Math.min(200, Math.max(100, label.length * 7.5 + 32));

    g.setNode(block.id, { width, height: 40 });
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
        todoState: detectTodoState(block.content),
        collapsed: isCollapsed,
        childCount: countDescendants(block.id, childrenMap),
        color: extractColor(block.content),
      } satisfies MindMapNodeData,
      position: { x: 0, y: 0 },
      sourcePosition: sourcePos,
      targetPosition: targetPos,
    });

    edges.push({
      id: `e-${parentNodeId}-${block.id}`,
      source: parentNodeId,
      target: block.id,
      type: isRadial ? "default" : "smoothstep",
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

  // Compute layout
  dagre.layout(g);

  if (isRadial) {
    // Transform dagre's TB layout to radial (polar) coordinates
    // Root stays at center; each rank becomes a ring
    const rootPos = g.node(rootId);
    const cx = rootPos?.x ?? 0;
    const cy = rootPos?.y ?? 0;

    // Group nodes by their dagre Y (rank), excluding root
    const rankMap = new Map<number, string[]>();
    for (const node of nodes) {
      if (node.id === rootId) continue;
      const pos = g.node(node.id);
      if (!pos) continue;
      const rank = Math.round(pos.y);
      if (!rankMap.has(rank)) rankMap.set(rank, []);
      rankMap.get(rank)!.push(node.id);
    }

    // Sort ranks by Y value (distance from root)
    const sortedRanks = Array.from(rankMap.keys()).sort((a, b) => a - b);

    // Assign radial positions
    for (let ri = 0; ri < sortedRanks.length; ri++) {
      const rank = sortedRanks[ri];
      const nodeIds = rankMap.get(rank)!;
      const radius = (ri + 1) * 160; // ring spacing
      const angleStep = (2 * Math.PI) / nodeIds.length;
      const angleOffset = -Math.PI / 2; // start from top

      for (let ni = 0; ni < nodeIds.length; ni++) {
        const nodeId = nodeIds[ni];
        const angle = angleOffset + ni * angleStep;
        const node = nodes.find((n) => n.id === nodeId)!;
        const pos = g.node(nodeId);
        const w = pos?.width ?? 150;
        const h = pos?.height ?? 40;
        node.position = {
          x: cx + radius * Math.cos(angle) - w / 2,
          y: cy + radius * Math.sin(angle) - h / 2,
        };
      }
    }

    // Center root node
    const rn = nodes.find((n) => n.id === rootId)!;
    const rp = g.node(rootId);
    if (rn && rp) {
      rn.position = { x: cx - (rp.width ?? 0) / 2, y: cy - (rp.height ?? 0) / 2 };
    }

    // Radial: compute handle positions per node based on angle from center
    // Edges should enter from the side facing the center, exit from the side facing outward
    for (const node of nodes) {
      if (node.id === rootId) {
        // Root: source handles on all sides — use Bottom as default
        node.sourcePosition = Position.Bottom;
        node.targetPosition = Position.Top;
        continue;
      }
      const pos = node.position;
      const nodeCx = pos.x + 75; // approximate node center
      const nodeCy = pos.y + 20;
      const dx = nodeCx - cx;
      const dy = nodeCy - cy;
      const angle = Math.atan2(dy, dx);

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
