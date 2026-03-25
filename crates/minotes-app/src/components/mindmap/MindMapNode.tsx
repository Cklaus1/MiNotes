import { memo, useState, useCallback } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { MindMapNodeData } from "./blocksToFlow";

function MindMapNodeInner(props: NodeProps) {
  const data = props.data as unknown as MindMapNodeData;
  const selected = props.selected;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(data.label);

  const handleSave = useCallback(() => {
    if (text.trim() !== data.label && data.onSave) {
      data.onSave(text.trim());
    }
    setEditing(false);
  }, [text, data]);

  if (editing) {
    return (
      <div className="mm-node mm-node-editing">
        <Handle type="target" position={Position.Left} />
        <input
          autoFocus
          className="mm-node-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={handleSave}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave();
            if (e.key === "Escape") { setText(data.label); setEditing(false); }
            e.stopPropagation();
          }}
        />
        <Handle type="source" position={Position.Right} />
      </div>
    );
  }

  return (
    <div
      className={`mm-node ${data.isRoot ? "mm-root" : ""} ${selected ? "mm-selected" : ""} ${data.isNew ? "mm-node-enter" : ""}`}
      data-depth={data.depth}
      data-todo={data.todoState ?? undefined}
      style={data.color && !data.isRoot ? { borderColor: data.color, borderLeftWidth: 3 } : undefined}
      onDoubleClick={() => {
        if (data.blockId) {
          setText(data.label);
          setEditing(true);
        }
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div className="mm-node-content">
        {data.todoState === "done" && <span className="mm-check done">✓</span>}
        {data.todoState === "doing" && <span className="mm-check doing">◉</span>}
        {data.todoState === "todo" && <span className="mm-check todo">☐</span>}
        <span className={data.todoState === "done" ? "mm-strikethrough" : ""}>
          {data.label}
        </span>
        {/* Collapse/expand badge */}
        {data.childCount > 0 && (
          <span
            className={`mm-collapse-badge ${data.collapsed ? "" : "mm-expanded"}`}
            onClick={(e) => {
              e.stopPropagation();
              data.onToggleCollapse?.();
            }}
            title={data.collapsed ? "Expand branch" : "Collapse branch"}
          >
            {data.collapsed ? `+${data.childCount}` : "−"}
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export default memo(MindMapNodeInner);
