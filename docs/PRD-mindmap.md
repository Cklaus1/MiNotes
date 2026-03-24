# MiNotes Mind Map PRD

## Overview

A mind map view for any MiNotes page. Every page's block tree is already a hierarchical structure — the mind map is a visual representation of that same data. Toggle between Block View and Mind Map View with one click. Edits in either view are reflected in the other.

Built with **ReactFlow + dagre** for full editing capability from day one — inline text editing, drag-to-rearrange, custom React node components, and a built-in minimap. No read-only phase that requires a rewrite.

## Problem Statement

Outliner-style block views are great for writing but poor for spatial thinking. Users brainstorming, planning projects, or exploring connections between ideas need to see the full structure at once — not a vertical list they scroll through. The #26 Obsidian plugin (785K downloads) plus #88 enhancing-mindmap (218K) show strong demand.

MiNotes already has the data: blocks with parent/child relationships form a tree. The missing piece is the visualization.

## Goals

1. Any page can be viewed as a mind map — no special page type needed
2. Same data, different view — edits in blocks or mind map stay in sync
3. Interactive: zoom, pan, expand/collapse branches, click to navigate
4. Editable: add nodes, rename nodes, rearrange branches from the map
5. Performant: handle pages with 100+ blocks smoothly
6. Exportable: save mind map as PNG or SVG

## Non-Goals

- Freeform spatial canvas (that's the Whiteboard feature)
- Standalone mind map pages disconnected from blocks (future)
- Real-time collaborative mind mapping (future)
- Custom node shapes (circles, diamonds, etc.) — v1 uses text nodes only

## Library Choice: ReactFlow + dagre

### Why ReactFlow Over Markmap

Markmap is purpose-built for rendering markdown as a mind map and gets a polished read-only view in 50 lines of code. But MiNotes is an editor — users need to create, edit, and rearrange nodes directly on the map. Markmap hits a wall there and would require a rewrite for editing features.

| Capability | Markmap | ReactFlow + dagre |
|-----------|---------|-------------------|
| Auto tree layout | Built-in | dagre computes, ReactFlow renders |
| Pan / zoom | Built-in | Built-in |
| Expand / collapse | Built-in | Custom (toggle children visibility) |
| Inline node editing | Not supported — need overlay hacks | Native — each node is a React component |
| Drag to rearrange | Not supported | Built-in core feature |
| Custom node rendering | Limited (HTML in SVG) | Any React component — TipTap editors, checkboxes, icons |
| Minimap | Not available | Built-in component |
| Multi-select | Not available | Built-in |
| Keyboard navigation | Not available | Custom handlers on React components |
| Connection animations | Built-in curves | Configurable (bezier, smoothstep, straight) |
| React integration | Wrapper needed (imperative API) | Native React (declarative, hooks) |
| Community / ecosystem | Smaller | Large — many examples, plugins, active development |

**Trade-off**: ReactFlow requires ~1 extra day upfront to wire dagre for auto-layout. After that, every editing feature is additive — no rewrites. Markmap would save that day but cost a full rewrite at Phase 3.

### dagre

dagre is a directed graph layout engine that computes x/y positions for nodes in a tree:

```typescript
import dagre from 'dagre';

const g = new dagre.graphlib.Graph();
g.setDefaultEdgeLabel(() => ({}));
g.setGraph({ rankdir: 'LR', nodesep: 30, ranksep: 80 }); // LR = left-to-right tree

// Add nodes with dimensions
g.setNode('root', { width: 150, height: 40 });
g.setNode('child1', { width: 120, height: 40 });

// Add edges
g.setEdge('root', 'child1');

dagre.layout(g);

// Read computed positions
const rootPos = g.node('root'); // { x: 75, y: 20 }
```

- `rankdir: 'LR'` gives horizontal mind map layout (root on left, branches to right)
- `rankdir: 'TB'` gives vertical org-chart layout (option in settings)
- ~8KB gzipped, MIT license, stable and widely used

## Data Model

No new data structures needed. Mind map reads from the existing block tree:

```
Page "Project Alpha"
├── Block: "Architecture"          → Center node's first branch
│   ├── Block: "Frontend"          → Child node
│   │   ├── Block: "React 19"     → Grandchild
│   │   └── Block: "TipTap"
│   └── Block: "Backend"
│       ├── Block: "Rust"
│       └── Block: "SQLite"
├── Block: "Timeline"              → Second branch
│   ├── Block: "Q1: Foundation"
│   └── Block: "Q2: Launch"
└── Block: "Team"                  → Third branch
    ├── Block: "Alice — Frontend"
    └── Block: "Bob — Backend"
```

Renders as:

```
                    ┌─ React 19
          ┌─ Frontend ─┤
          │            └─ TipTap
 Architecture ─┤
          │            ┌─ Rust
          └─ Backend ──┤
                       └─ SQLite
                                        ┌─ Q1: Foundation
Project Alpha ─── Timeline ─────────────┤
                                        └─ Q2: Launch
                    ┌─ Alice — Frontend
          Team ─────┤
                    └─ Bob — Backend
```

### Block-to-Node Mapping

| Block Field | ReactFlow Node |
|-------------|---------------|
| `content` | `data.label` (first line, stripped of markdown) |
| `content` (full) | `data.fullContent` (for inline editing) |
| `parent_id` | Edge `source` → `target` |
| `position` | Sibling order (dagre respects insertion order) |
| `collapsed` | `data.collapsed` — hide children, show `+N` badge |
| `id` | `node.id` (block UUID) |
| Page `title` | Root node `data.label` with `id = "root"` |
| Block properties | `data.color`, `data.icon`, `data.todoState` |
| `parent_id === null` | Edge from root node to this node |

### Node Label Extraction

Block content is markdown. The mind map node shows a clean text label:

| Block Content | Node Label |
|--------------|------------|
| `# Architecture` | Architecture |
| `**Frontend** — React based` | Frontend — React based |
| `- [ ] Ship by Friday` | Ship by Friday (with checkbox icon) |
| `- [x] Done task` | Done task (checked icon + strikethrough) |
| `[[Project Alpha]] dependency` | Project Alpha dependency |
| `A very long block that goes on...` | A very long block that go... (truncated at 60 chars) |

### Blocks → ReactFlow Conversion

```typescript
import { type Node, type Edge } from '@xyflow/react';
import dagre from 'dagre';

function blocksToFlow(blocks: Block[], pageTitle: string): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 24, ranksep: 100 });

  // Root node = page title
  const rootId = 'root';
  g.setNode(rootId, { width: 180, height: 44 });
  nodes.push({
    id: rootId,
    type: 'mindmapNode',
    data: { label: pageTitle, isRoot: true, blockId: null },
    position: { x: 0, y: 0 },
  });

  // Block nodes
  const rootBlocks = blocks.filter(b => !b.parent_id).sort((a, b) => a.position - b.position);
  const addBlock = (block: Block, parentNodeId: string) => {
    const label = extractLabel(block.content);
    const width = Math.min(200, Math.max(100, label.length * 8 + 32));
    g.setNode(block.id, { width, height: 40 });
    g.setEdge(parentNodeId, block.id);
    nodes.push({
      id: block.id,
      type: 'mindmapNode',
      data: {
        label,
        fullContent: block.content,
        blockId: block.id,
        collapsed: block.collapsed,
        todoState: detectTodoState(block.content),
        depth: getDepth(block, blocks),
      },
      position: { x: 0, y: 0 }, // dagre will compute
    });
    edges.push({
      id: `e-${parentNodeId}-${block.id}`,
      source: parentNodeId,
      target: block.id,
      type: 'smoothstep',
    });

    if (!block.collapsed) {
      const children = blocks.filter(b => b.parent_id === block.id).sort((a, b) => a.position - b.position);
      for (const child of children) {
        addBlock(child, block.id);
      }
    }
  };

  for (const block of rootBlocks) {
    addBlock(block, rootId);
  }

  // Compute layout
  dagre.layout(g);

  // Apply computed positions
  for (const node of nodes) {
    const pos = g.node(node.id);
    if (pos) {
      node.position = { x: pos.x - pos.width / 2, y: pos.y - pos.height / 2 };
    }
  }

  return { nodes, edges };
}
```

## UX Design

### View Toggle

Added to the page header, next to existing controls:

```
📐 Project Alpha
[Blocks] [Mind Map] [Kanban]          3 blocks · Updated 2m ago
```

- Default view: Blocks (current behavior)
- View preference stored per page as a property (`view:: mindmap`)
- Keyboard shortcut: Ctrl+M to toggle mind map

### Mind Map View

```
┌──────────────────────────────────────────────────────────────┐
│  [← Blocks]  [Fit]  [Zoom +]  [Zoom −]  [Export]            │
│                                                               │
│                        ┌─ React 19                           │
│              ┌─ Frontend ─┤                                   │
│              │            └─ TipTap                           │
│   Architecture ─┤                                             │
│              │            ┌─ Rust                             │
│              └─ Backend ──┤                                   │
│                           └─ SQLite                           │
│                                                               │
│  ● Project Alpha ──── Timeline ──┬─ Q1: Foundation            │
│    (center)                      └─ Q2: Launch               │
│                                                               │
│              ┌─ Alice — Frontend                             │
│     Team ────┤                                                │
│              └─ Bob — Backend                                │
│                                                 ┌─────────┐  │
│  Scroll to zoom · Drag to pan · Click to select │ minimap │  │
│  Double-click to edit · Right-click for options └─────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### Custom Node Component (MindMapNode)

Each node is a React component rendered by ReactFlow:

```tsx
function MindMapNode({ data, selected }: NodeProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(data.label);

  if (editing) {
    return (
      <div className="mm-node mm-node-editing">
        <input
          autoFocus
          value={text}
          onChange={e => setText(e.target.value)}
          onBlur={() => { data.onSave(text); setEditing(false); }}
          onKeyDown={e => {
            if (e.key === 'Enter') { data.onSave(text); setEditing(false); }
            if (e.key === 'Escape') { setText(data.label); setEditing(false); }
          }}
        />
      </div>
    );
  }

  return (
    <div
      className={`mm-node ${data.isRoot ? 'mm-root' : ''} ${selected ? 'mm-selected' : ''}`}
      data-depth={data.depth}
      data-todo={data.todoState}
      onDoubleClick={() => setEditing(true)}
    >
      {data.todoState === 'done' && <span className="mm-check">✓</span>}
      {data.todoState === 'todo' && <span className="mm-check">☐</span>}
      <span className={data.todoState === 'done' ? 'mm-strikethrough' : ''}>
        {data.label}
      </span>
      {data.collapsed && data.childCount > 0 && (
        <span className="mm-collapse-badge">+{data.childCount}</span>
      )}
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
```

### Node Interactions

| Action | Behavior |
|--------|----------|
| **Click node** | Select node, highlight in accent color |
| **Double-click node** | Inline edit — input replaces label, save on Enter/blur |
| **Right-click node** | Context menu: Add child, Add sibling, Delete, Collapse/Expand, Copy text |
| **Click collapse badge (+N)** | Toggle branch expand/collapse |
| **Drag node** | Reparent — drop on target node to change parent |
| **Scroll wheel** | Zoom in/out (ReactFlow built-in) |
| **Click + drag background** | Pan the view (ReactFlow built-in) |
| **Enter (with node selected)** | Create sibling block below |
| **Tab (with node selected)** | Create child block |
| **Delete/Backspace (with node selected)** | Delete block (confirm if has children) |
| **Escape** | Deselect, exit edit mode |
| **Ctrl+click [[link]] in node** | Navigate to linked page |

### Drag-to-Rearrange

ReactFlow's built-in drag system, customized for mind map reparenting:

```
1. User starts dragging "Frontend" node
2. Ghost node follows cursor
3. Hovering over "Timeline" node highlights it as potential new parent
4. Drop on "Timeline" → calls reparentBlock("frontend-id", "timeline-id")
5. dagre recomputes layout
6. Animated transition to new positions
```

**Drop validation:**
- Cannot drop a node onto itself
- Cannot drop a node onto one of its own descendants (would create cycle)
- Cannot drop root node

### Node Styling

Nodes styled based on content, using custom CSS classes:

| Content Pattern | Style |
|----------------|-------|
| Root (page title) | Accent blue background, larger font, bold |
| `# Heading` | Bold, slightly larger |
| `## Subheading` | Bold |
| Regular text | Normal |
| `- [ ] Todo` | Checkbox icon + text, orange left border |
| `- [x] Done` | Check icon + strikethrough, green left border |
| `TODO text` | Orange left border |
| `DONE text` | Green left border |
| Collapsed branch | `+N` badge showing hidden child count |
| Has `{{whiteboard:*}}` | Canvas icon prefix |
| Selected | Accent border, subtle glow |

### Node Colors

Default: nodes colored by depth level (matching existing tree mode depth fading):

| Depth | Color |
|-------|-------|
| Root (page title) | Accent blue bg, white text |
| Level 1 | `var(--bg-secondary)` bg, full text color |
| Level 2 | Slightly muted bg, 85% text opacity |
| Level 3 | More muted bg, 70% text opacity |
| Level 4+ | Most muted bg, 55% text opacity |

Optional: user can set color via block property `color:: blue` — applies to that node.

### Edge Styling

- **Type**: `smoothstep` (rounded right-angle connections) — cleaner than bezier for tree layouts
- **Color**: Subtle, matches node depth (fading with depth)
- **Animated**: Edges animate when layout changes (nodes added, rearranged, collapsed)
- **Selected path**: When a node is selected, the path from root to that node highlights in accent color

### Toolbar

```
[← Blocks]  [Fit All]  [+]  [−]  [Layout ▾]  [Export ▾]
                                   ├─ Horizontal (LR)     ├─ PNG
                                   ├─ Vertical (TB)       ├─ SVG
                                   └─ Radial              └─ Markdown Outline
```

- **← Blocks**: Switch back to block view
- **Fit All**: `reactFlowInstance.fitView()` — zoom to fit entire map
- **+/−**: Zoom in/out
- **Layout**: Switch between horizontal (default), vertical, and radial layouts
- **Export**: Save as image or text outline

### Layout Options

dagre supports multiple layout directions:

| Layout | dagre `rankdir` | Best For |
|--------|----------------|----------|
| Horizontal | `LR` (left-to-right) | Default mind map, wide screens |
| Vertical | `TB` (top-to-bottom) | Org charts, narrow screens |
| Radial | Custom (polar transform of TB) | Brainstorming, visual appeal |

### Minimap

ReactFlow's built-in `<MiniMap>` component — shows in bottom-right corner:

```tsx
import { MiniMap } from '@xyflow/react';

<MiniMap
  nodeColor={(node) => node.data.isRoot ? 'var(--accent)' : 'var(--text-muted)'}
  maskColor="rgba(0,0,0,0.5)"
/>
```

### Empty State

When a page has no blocks (or only one empty block):

```
┌──────────────────────────────────────┐
│                                       │
│         ● Page Title                  │
│                                       │
│    Press Tab to add your first idea   │
│                                       │
└──────────────────────────────────────┘
```

## Technical Architecture

### Component Architecture

```
MindMapView (main component)
├── MindMapToolbar            — layout, zoom, fit, export buttons
├── ReactFlowProvider
│   └── ReactFlow             — canvas with pan/zoom
│       ├── MindMapNode[]     — custom node components (React)
│       ├── MindMapEdge[]     — smoothstep connection lines
│       ├── MiniMap           — built-in overview
│       └── Controls          — built-in zoom buttons (optional)
├── MindMapContextMenu        — right-click menu (portal)
└── MindMapNodeEditor         — inline input (rendered inside MindMapNode)
```

### Data Flow

```
                    ┌───────────┐
                    │  blocks[] │  (source of truth)
                    └─────┬─────┘
                          │
                  blocksToFlow()
                   + dagre layout
                          │
              ┌───────────▼───────────┐
              │  ReactFlow nodes[]    │
              │  ReactFlow edges[]    │
              └───────────┬───────────┘
                          │
                  ReactFlow renders
                          │
                   User interactions
                          │
        ┌─────────┬───────┼────────┬──────────┐
        │         │       │        │          │
   Edit node  Rearrange  Add    Delete    Collapse
        │         │       │        │          │
   updateBlock  reparent  create  delete   toggle
        │       Block     Block   Block    collapsed
        │         │       │        │          │
        └─────────┴───────┴────────┴──────────┘
                          │
                   blocks[] updated
                          │
              blocksToFlow() recomputes
                          │
              ReactFlow re-renders with
              animated position transitions
```

### State Management

```typescript
function MindMapView({ blocks, pageTitle, onUpdateBlock, onCreateBlock,
                       onDeleteBlock, onReparentBlock, onToggleCollapse }: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const reactFlowInstance = useReactFlow();

  // Recompute layout when blocks change
  useEffect(() => {
    const { nodes: newNodes, edges: newEdges } = blocksToFlow(blocks, pageTitle);
    setNodes(newNodes);
    setEdges(newEdges);
  }, [blocks, pageTitle]);

  // Handle node drag (reparenting)
  const onNodeDragStop = useCallback((event, node) => {
    // Find closest node at drop position
    const target = findClosestNode(node, nodes);
    if (target && target.id !== node.id) {
      onReparentBlock(node.data.blockId, target.data.blockId);
    }
  }, [nodes, onReparentBlock]);

  // Handle keyboard
  const onKeyDown = useCallback((e: KeyboardEvent) => {
    if (!selectedNode) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      onCreateBlock(selectedNode, 'child'); // Add child
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      onCreateBlock(selectedNode, 'sibling'); // Add sibling
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      onDeleteBlock(selectedNode);
    }
  }, [selectedNode]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeDragStop={onNodeDragStop}
      onSelectionChange={({ nodes }) => setSelectedNode(nodes[0]?.id ?? null)}
      nodeTypes={{ mindmapNode: MindMapNode }}
      fitView
    >
      <MiniMap />
      <Background gap={20} />
    </ReactFlow>
  );
}
```

### Performance

| Page Size | Blocks | Expected Performance |
|-----------|--------|---------------------|
| Small | 1-20 | Instant render, smooth interactions |
| Medium | 20-100 | Fast render (<100ms), smooth |
| Large | 100-500 | Acceptable render (<500ms), may need viewport culling |
| Very large | 500+ | Auto-collapse deep branches, progressive rendering |

**Optimizations for large maps:**
- Auto-collapse branches deeper than level 3 on initial render
- ReactFlow's built-in viewport culling (only renders visible nodes)
- Debounce dagre layout recomputation on rapid edits (100ms)
- `React.memo` on MindMapNode to avoid unnecessary re-renders
- `requestAnimationFrame` for animated layout transitions

## Integration Points

### With Existing Features

| Feature | Integration |
|---------|-----------|
| **Block collapse** | Collapsed blocks = collapsed mind map branches, `+N` badge |
| **Block properties** | `color::` property sets node color |
| **Wiki links** | `[[Page]]` in node shows link icon, Ctrl+click opens page |
| **TODO states** | TODO/DOING/DONE shown as colored left borders + icons |
| **Whiteboard blocks** | `{{whiteboard:id}}` nodes show canvas icon |
| **Search** | Search highlights matching nodes in mind map |
| **Full Tree Mode** | Mind map is an alternative to tree mode, not additive |
| **Keyboard shortcuts** | Tab (add child), Enter (add sibling), Delete, Esc work in both views |
| **Undo/Redo** | All mind map edits go through the same block API, undo works |
| **Bubble toolbar** | Not shown in mind map (editing is inline text, not rich text) |

### With Encrypted Folders

Mind map view works on unlocked encrypted folders — decrypted content rendered as nodes. Locked folders show "Unlock to view mind map."

### With Git Sync

No special handling — mind map is a view of blocks, and blocks sync normally. The `view:: mindmap` property syncs as part of the page.

## Export Formats

### PNG Export
- Use `reactflow-to-image` helper or manual SVG → canvas → blob pipeline
- Same WSL-aware download logic as whiteboard export
- Background: dark theme bg or transparent (user choice)

### SVG Export
- Serialize ReactFlow's SVG container
- Preserves vector quality at any size
- Includes embedded fonts and styles

### Markdown Outline Export
- Convert mind map back to indented markdown list
- Useful for pasting into other tools
```markdown
- Project Alpha
  - Architecture
    - Frontend
      - React 19
      - TipTap
    - Backend
      - Rust
      - SQLite
  - Timeline
    - Q1: Foundation
    - Q2: Launch
  - Team
    - Alice — Frontend
    - Bob — Backend
```

### Copy as Text
- Copy selected branch as indented plain text to clipboard
- Right-click node → "Copy branch"

## Implementation Plan

### Phase 1: Core Mind Map View

1. Install `@xyflow/react` and `dagre` packages
2. Create `blocksToFlow.ts`:
   - Convert blocks array to ReactFlow nodes + edges
   - dagre layout computation
   - Label extraction from markdown content
   - Depth/color/todo state detection
3. Create `MindMapNode.tsx`:
   - Custom ReactFlow node component
   - Styled by depth, todo state, selection
   - Target + source handles for edges
   - Collapse badge for hidden children
4. Create `MindMapView.tsx`:
   - ReactFlow canvas with nodes and edges
   - MiniMap, Background components
   - Fit view on mount
5. Add view toggle to `PageView.tsx`:
   - `[Blocks] [Mind Map]` buttons in page header
   - Keyboard shortcut: Ctrl+M
6. Create `MindMapToolbar.tsx`:
   - Fit All, Zoom +/−, Layout direction, Export
   - Back to Blocks button
7. CSS styling:
   - Node styles matching MiNotes theme (dark/light)
   - Edge styles with depth-based opacity
   - Selection glow, hover effects
   - Smooth transitions

### Phase 2: Inline Editing

8. Double-click node → inline input replaces label
9. Enter/blur → call `updateBlock` with new content
10. dagre recomputes layout, ReactFlow re-renders
11. Escape cancels edit, restores original text
12. Rich text preview: headings bold, todos with icons

### Phase 3: Node Creation & Deletion

13. Tab on selected node → `createBlock` (new child), auto-select new node
14. Enter on selected node → `createBlock` (new sibling)
15. Delete/Backspace → `deleteBlock` with confirmation for nodes with children
16. Right-click context menu: Add child, Add sibling, Delete, Copy text

### Phase 4: Drag-to-Rearrange

17. Drag node from current position
18. Ghost node follows cursor, potential drop targets highlight
19. Drop validation: no self-drop, no ancestor-drop
20. Drop → `reparentBlock(draggedId, newParentId)`
21. Animated transition to new layout positions

### Phase 5: Expand/Collapse

22. Click collapse badge (`+N`) to expand/collapse branch
23. Collapse → hide children, update dagre layout
24. Expand → show children, recompute layout
25. Persist collapse state via existing block `collapsed` field

### Phase 6: Layout Options & Export

26. Layout direction toggle: Horizontal (LR), Vertical (TB)
27. Export PNG via SVG → canvas → blob pipeline
28. Export SVG via DOM serialization
29. Export Markdown outline (tree → indented list)
30. Copy branch as text (right-click → "Copy branch")

### Phase 7: Polish & Advanced

**Animated layout transitions** (the key thing Markmap does that ReactFlow doesn't out of the box):

31. **Smooth node position transitions**: When dagre recomputes layout (expand/collapse, add/delete/rearrange), interpolate each node from old position → new position over 300ms with eased timing. Without this, nodes jump and the map feels mechanical.

```typescript
function animateLayout(oldNodes: Node[], newNodes: Node[], setNodes: Function) {
  const duration = 300;
  const start = performance.now();
  const oldPositions = new Map(oldNodes.map(n => [n.id, { ...n.position }]));

  function tick(now: number) {
    const t = Math.min((now - start) / duration, 1);
    const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // easeInOutQuad

    setNodes(newNodes.map(node => {
      const old = oldPositions.get(node.id) ?? node.position;
      return {
        ...node,
        position: {
          x: old.x + (node.position.x - old.x) * ease,
          y: old.y + (node.position.y - old.y) * ease,
        },
      };
    }));

    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
```

32. **New node entrance animation**: Nodes created via Tab/Enter fade in + scale from 0.8 → 1.0 over 200ms. Gives visual feedback that something was added.

33. **Deleted node exit animation**: Node shrinks + fades out before removal (200ms). Remaining nodes then animate to new positions.

34. **Edge path highlighting**: When a node is selected, the full path from root → selected node highlights in accent color. Other edges fade to 30% opacity. Clicking background resets.

35. **Node colors from block properties**: `color:: blue` on a block → blue-tinted node background. Supported colors: blue, green, red, yellow, purple, orange (mapped to Catppuccin palette).

36. **Hover effects**: Node slightly scales up (1.02x) and gets a subtle shadow on hover. Edge connected to hovered node brightens.

37. **Connection animation on expand**: When expanding a collapsed branch, edges draw in from parent → children (SVG stroke-dashoffset animation, 200ms per depth level staggered).

38. **Persist view preference** as page property (`view:: mindmap`).

39. **Auto-collapse deep branches** on large pages (>50 visible nodes at depth 3+) to prevent initial overwhelm. User can expand manually.

40. **Focus mode**: Double-click a non-leaf node → zooms to fit that subtree, dims nodes outside the subtree. Click background or press Escape to exit focus mode. Useful for large maps where you want to concentrate on one branch.

41. **Keyboard navigation**: Arrow keys move selection between nodes (Up/Down = siblings, Left = parent, Right = first child). Matches how mind map power users expect to navigate.

42. **Breadcrumb on deep zoom**: When zoomed into a subtree, show breadcrumb path at top: `Project Alpha > Architecture > Frontend` — click any segment to zoom out to that level.

### Phase 8: Testing

43. Unit tests: `blocksToFlow` conversion (blocks → nodes + edges)
44. Unit tests: label extraction from markdown content
45. Unit tests: dagre layout produces valid positions
46. Unit tests: `animateLayout` interpolation correctness
47. Integration tests: render mind map, verify node count matches blocks
48. User journey tests:
    - Toggle to mind map view, verify nodes match blocks
    - Double-click node, edit text, verify block updated
    - Tab to create child, Enter to create sibling
    - Drag node to rearrange, verify reparent
    - Collapse/expand branch (verify animation plays)
    - Arrow key navigation between nodes
    - Focus mode: double-click subtree, verify zoom
    - Export PNG, verify file downloaded
    - Large page (100+ blocks) renders without freezing
    - Switch back to Blocks view, verify edits persisted

## Dependencies

### npm Packages

- `@xyflow/react` — ReactFlow v12+ (node graph editor with pan/zoom/drag)
- `dagre` — directed graph layout engine (computes node positions)
- `@types/dagre` — TypeScript types for dagre

### No Backend Changes

Mind map is purely a frontend view of existing block data. All mutations go through existing block API (`createBlock`, `updateBlock`, `deleteBlock`, `reparentBlock`). No new Tauri commands needed.

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|-----------|
| dagre layout looks cluttered for wide trees | Medium | Tune `nodesep`/`ranksep`, offer vertical layout option |
| Drag-to-rearrange UX feels imprecise | Medium | Clear drop target highlighting, snap-to-parent on drop |
| Performance with 500+ nodes | Low | ReactFlow has built-in viewport culling; auto-collapse deep branches |
| Users expect freeform positioning | Medium | Clarify: mind map = tree layout; Whiteboard = freeform canvas |
| ReactFlow bundle size concern | Low | ~40KB gzipped, acceptable for the functionality gained |
| Edge routing overlaps with nodes | Medium | `smoothstep` edges route around nodes; dagre spacing tuning |

## Success Metrics

- Users toggle to mind map view on >10% of page visits
- Average mind map session >30 seconds (not just peeking and leaving)
- Editing on mind map: >20% of mind map sessions include at least one edit
- Export feature used (indicates mind maps are shared/presented)
- Pages with `view:: mindmap` preference saved (indicates users prefer it as default for some pages)

## Future Enhancements

- **Standalone mind map pages**: Create mind maps that aren't derived from blocks — freeform node placement
- **Multi-page mind maps**: Visualize connections across pages (like graph view but hierarchical)
- **Presentation mode**: Step through mind map branches one at a time (for meetings)
- **Collaborative mind mapping**: Real-time multi-cursor editing with sync
- **AI-assisted**: "Expand this node" → AI generates child nodes from context
- **Templates**: Mind map templates (SWOT analysis, project planning, brainstorming)
- **Embed in blocks**: `{{mindmap}}` block type that renders an inline mini mind map of a subtree
- **Radial layout**: Polar coordinate transform of dagre output for circular mind maps
- **Custom edge labels**: Show relationship text on connections
- **Node images**: Drag-drop images into nodes as thumbnails
