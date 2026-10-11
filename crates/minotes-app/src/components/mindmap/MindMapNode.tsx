import { memo, useState, useCallback, useEffect, useRef } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { MindMapNodeData } from "./blocksToFlow";

interface ExtendedData extends MindMapNodeData {
  autoEdit?: boolean;
  isJournal?: boolean;
  journalDate?: string; // formatted date string for display
  displayTitle?: string; // journal display title (separate from system name)
  /** Editing finished (saved or cancelled) with this text. */
  onEditEnd?: (text: string) => void;
  onRenameTitle?: (newTitle: string) => void;
}

function MindMapNodeInner(props: NodeProps) {
  const data = props.data as unknown as ExtendedData;
  const selected = props.selected;
  const sourcePos = (props.sourcePosition as Position) ?? Position.Right;
  const targetPos = (props.targetPosition as Position) ?? Position.Left;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(data.label);
  // Enter saves and unmounts the input, which can fire blur → a second save.
  const editOpenRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const openedAtRef = useRef(0);
  const mountedRef = useRef(true);
  const [focusNonce, setFocusNonce] = useState(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // autoFocus alone is not enough: the input mounts while a click/refresh is
  // still settling, and WebKitGTK leaves focus on <body> (or the outline's
  // editor behind the canvas), so typing went elsewhere. Focus it explicitly.
  useEffect(() => {
    if (!editing) return;
    const focus = () => {
      const el = inputRef.current;
      if (el && document.activeElement !== el) {
        el.focus();
        const end = el.value.length;
        el.setSelectionRange(end, end);
      }
    };
    // React Flow keeps a new node visibility:hidden until it has been
    // measured, and a hidden input can't take focus — retry for a moment.
    focus();
    let tries = 0;
    const timer = setInterval(() => {
      focus();
      if (++tries >= 25 || document.activeElement === inputRef.current) clearInterval(timer);
    }, 40);
    return () => clearInterval(timer);
  }, [editing, focusNonce]);

  // Auto-enter edit mode when flagged (after creating a new node)
  useEffect(() => {
    if (data.autoEdit && !editing) {
      setText(data.fullContent.trim() || "");
      editOpenRef.current = true;
      openedAtRef.current = performance.now();
      setEditing(true);
    }
  }, [data.autoEdit]);

  const finish = useCallback((finalText: string) => {
    editOpenRef.current = false;
    setEditing(false);
    data.onEditEnd?.(finalText);
  }, [data]);

  const handleSave = useCallback(() => {
    if (!editOpenRef.current) return;
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
    finish(trimmed);
  }, [text, data, finish]);

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
    editOpenRef.current = true;
    openedAtRef.current = performance.now();
    setEditing(true);
  }, [data]);

  // A blur is only a "done editing" when the user moved focus away: WebKitGTK
  // also fires blur when the input is removed (node re-mounted by a re-layout)
  // and while focus is still settling right after the input opens — treating
  // those as "done" closed a brand-new node at once and deleted its block.
  const handleBlur = useCallback(() => {
    setTimeout(() => {
      if (!mountedRef.current || !editOpenRef.current) return;
      const el = inputRef.current;
      if (el && document.activeElement === el) return;
      if (el && el.isConnected && performance.now() - openedAtRef.current < 600
          && (document.activeElement === document.body || document.activeElement === null)) {
        setFocusNonce((n) => n + 1); // focus was dropped, not moved: take it back
        return;
      }
      handleSave();
    }, 0);
  }, [handleSave]);

  if (editing) {
    return (
      <div className={`mm-node mm-node-editing ${data.isRoot ? "mm-root" : ""}`}>
        <Handle type="target" position={targetPos} />
        <input
          ref={inputRef}
          autoFocus
          className="mm-node-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave();
            if (e.key === "Escape") {
              setText(data.label);
              finish(data.isRoot ? data.label : data.fullContent.trim());
            }
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
      title={data.isRoot ? `${data.label} — double-click to edit page title` : data.label}
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
          <span className={`mm-label${data.todoState === "done" ? " mm-strikethrough" : ""}`}>
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
