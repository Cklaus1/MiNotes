import { memo, useState, useCallback, useEffect } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { MindMapNodeData } from "./blocksToFlow";

interface ExtendedData extends MindMapNodeData {
  autoEdit?: boolean;
  isJournal?: boolean;
  journalDate?: string; // formatted date string for display
  displayTitle?: string; // journal display title (separate from system name)
  onClearAutoEdit?: () => void;
  onRenameTitle?: (newTitle: string) => void;
}

function MindMapNodeInner(props: NodeProps) {
  const data = props.data as unknown as ExtendedData;
  const selected = props.selected;
  const sourcePos = (props.sourcePosition as Position) ?? Position.Right;
  const targetPos = (props.targetPosition as Position) ?? Position.Left;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(data.label);

  // Auto-enter edit mode when flagged (after creating a new node)
  useEffect(() => {
    if (data.autoEdit && !editing) {
      setText(data.fullContent.trim() || "");
      setEditing(true);
      data.onClearAutoEdit?.();
    }
  }, [data.autoEdit]);

  const handleSave = useCallback(() => {
    const trimmed = text.trim();
    if (data.isRoot) {
      if (data.isJournal) {
        // Journal: save as display title (property), don't rename system title
        if (trimmed !== (data.displayTitle ?? "") && data.onRenameTitle) {
          data.onRenameTitle(trimmed);
        }
      } else {
        // Regular page: rename actual title
        if (trimmed && trimmed !== data.label && data.onRenameTitle) {
          data.onRenameTitle(trimmed);
        }
      }
    } else {
      if (trimmed !== data.fullContent.trim() && data.onSave) {
        data.onSave(trimmed);
      }
    }
    setEditing(false);
  }, [text, data]);

  const startEditing = useCallback(() => {
    if (data.isRoot) {
      if (data.isJournal) {
        setText(data.displayTitle ?? "");
      } else {
        setText(data.label);
      }
    } else {
      setText(data.fullContent.trim() || "");
    }
    setEditing(true);
  }, [data]);

  if (editing) {
    return (
      <div className={`mm-node mm-node-editing ${data.isRoot ? "mm-root" : ""}`}>
        <Handle type="target" position={targetPos} />
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
          style={data.isRoot ? { fontWeight: 600, fontSize: 14 } : undefined}
          placeholder={data.isJournal ? "Add a title..." : undefined}
        />
        {data.isRoot && (
          <span className="mm-root-edit-hint">
            {data.isJournal ? `Journal: ${data.journalDate}` : "Editing page title"}
          </span>
        )}
        <Handle type="source" position={sourcePos} />
      </div>
    );
  }

  return (
    <div
      className={`mm-node ${data.isRoot ? "mm-root" : ""} ${selected ? "mm-selected" : ""} ${data.isNew ? "mm-node-enter" : ""}`}
      data-depth={data.depth}
      data-todo={data.todoState ?? undefined}
      style={data.color && !data.isRoot ? { borderColor: data.color, borderLeftWidth: 3 } : undefined}
      onDoubleClick={startEditing}
      title={data.isRoot ? "Double-click to edit page title" : undefined}
    >
      <Handle type="target" position={targetPos} />
      <div className="mm-node-content">
        {data.isRoot && <span className="mm-root-icon">◉</span>}
        {!data.isRoot && data.todoState === "done" && <span className="mm-check done">✓</span>}
        {!data.isRoot && data.todoState === "doing" && <span className="mm-check doing">◉</span>}
        {!data.isRoot && data.todoState === "todo" && <span className="mm-check todo">☐</span>}
        {data.isRoot && data.isJournal ? (
          <span className="mm-root-title-group">
            <span className="mm-root-date">{data.journalDate}</span>
            {data.displayTitle && <span className="mm-root-display-title">{data.displayTitle}</span>}
          </span>
        ) : (
          <span className={data.todoState === "done" ? "mm-strikethrough" : ""}>
            {data.label}
          </span>
        )}
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
      <Handle type="source" position={sourcePos} />
    </div>
  );
}

export default memo(MindMapNodeInner);
