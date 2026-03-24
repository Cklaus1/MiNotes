import { useEffect, useState, useRef, lazy, Suspense, forwardRef, useImperativeHandle } from "react";
import { EditorContent } from "@tiptap/react";
import type { Block, Property } from "../lib/api";
import * as api from "../lib/api";
import { useBlockEditor } from "../editor";
import { getSettings } from "../lib/settings";
import BlockContextMenu from "./BlockContextMenu";
import "../editor/editor.css";

// Lazy-load CM6 editor — only downloaded when obsidianEditorEnabled
const CM6BlockEditor = lazy(() => import("../editor/CM6BlockEditor"));

export interface BlockItemHandle {
  focus: (position?: "start" | "end") => void;
}

interface Props {
  block: Block;
  depth?: number;
  hasChildren?: boolean;
  isLastSibling?: boolean;
  isOnActivePath?: boolean;
  onFocusBlock?: (blockId: string) => void;
  onBlurBlock?: () => void;
  dataBlockId?: string;
  selected?: boolean;
  onUpdate: (id: string, content: string) => void;
  onDelete: (id: string) => void;
  onPageLinkClick: (title: string, shiftKey?: boolean) => void;
  onBlockRefClick?: (blockId: string) => void;
  onEnter?: (blockId: string, contentAfterCursor: string, savedContent?: string) => void;
  onBackspaceAtStart?: (blockId: string, content: string) => void;
  onArrowUp?: (blockId: string) => void;
  onArrowDown?: (blockId: string) => void;
  onPasteMultiline?: (blockId: string, lines: string[]) => void;
  onIndent?: (blockId: string) => void;
  onOutdent?: (blockId: string) => void;
  onDuplicate?: (blockId: string) => void;
  onToggleCollapse?: (blockId: string) => void;
  onZoomIn?: () => void;
  onShiftClick?: (blockId: string) => void;
}

const BlockItem = forwardRef<BlockItemHandle, Props>(({
  block, depth = 0, hasChildren = false, isLastSibling = false, isOnActivePath = false, onFocusBlock, onBlurBlock, dataBlockId, selected = false, onUpdate, onDelete, onPageLinkClick,
  onBlockRefClick, onEnter, onBackspaceAtStart, onArrowUp, onArrowDown, onPasteMultiline,
  onIndent, onOutdent, onDuplicate, onToggleCollapse, onZoomIn, onShiftClick,
}, ref) => {
  const settings = getSettings();
  const [editorMode, setEditorMode] = useState<"minotes" | "obsidian">(
    settings.obsidianEditorEnabled ? settings.defaultEditorMode : "minotes"
  );
  const [properties, setProperties] = useState<Property[]>([]);
  const [addingProp, setAddingProp] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [editingProp, setEditingProp] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const handleToggleTodo = () => {
    const content = block.content;
    let newContent: string;
    if (content.startsWith("DONE ")) {
      newContent = content.slice(5); // Remove DONE prefix
    } else if (content.startsWith("DOING ")) {
      newContent = "DONE " + content.slice(6);
    } else if (content.startsWith("TODO ")) {
      newContent = "DOING " + content.slice(5);
    } else {
      newContent = "TODO " + content;
    }
    onUpdate(block.id, newContent);
  };

  const tiptapEditor = useBlockEditor({
    content: block.content,
    onSave: (markdown) => {
      if (markdown !== block.content.trim()) {
        onUpdate(block.id, markdown);
      }
    },
    onPageLinkClick,
    onBlockRefClick,
    onEnter: onEnter ? (contentAfterCursor, savedContent) => onEnter(block.id, contentAfterCursor, savedContent) : undefined,
    onBackspaceAtStart: onBackspaceAtStart ? (content) => onBackspaceAtStart(block.id, content) : undefined,
    onArrowUp: onArrowUp ? () => onArrowUp(block.id) : undefined,
    onArrowDown: onArrowDown ? () => onArrowDown(block.id) : undefined,
    onToggleTodo: handleToggleTodo,
    onPasteMultiline: onPasteMultiline ? (lines) => onPasteMultiline(block.id, lines) : undefined,
    onIndent: onIndent ? () => onIndent(block.id) : undefined,
    onOutdent: onOutdent ? () => onOutdent(block.id) : undefined,
    onSlashCommand: (newMarkdown: string) => {
      // 1. Update the editor content immediately to render the formatting
      if (editorRef.current) {
        try {
          editorRef.current.commands.setContent(newMarkdown);
        } catch (e) {
          console.error("[slash] setContent failed:", e);
        }
      }
      // 2. Save to backend
      onUpdate(block.id, newMarkdown);
    },
  });

  const editorRef = useRef(tiptapEditor);
  editorRef.current = tiptapEditor;

  useImperativeHandle(ref, () => ({
    focus: (position: "start" | "end" = "end") => {
      const tryFocus = () => {
        if (editorRef.current) {
          editorRef.current.commands.focus(position);
        }
      };
      tryFocus();
      // Retry in case editor isn't ready yet
      setTimeout(tryFocus, 50);
      setTimeout(tryFocus, 150);
    },
  }), []);

  // Sync external content changes for TipTap
  useEffect(() => {
    if (!tiptapEditor || editorMode !== "minotes") return;
    const currentMarkdown = ((tiptapEditor.storage as any).markdown?.getMarkdown() ?? "").trim();
    if (block.content.trim() !== currentMarkdown) {
      tiptapEditor.commands.setContent(block.content);
    }
  }, [block.content, tiptapEditor, editorMode]);

  // Load properties
  useEffect(() => {
    api.getProperties(block.id).then(setProperties).catch(() => {});
  }, [block.id]);

  // Listen for settings changes
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail.obsidianEditorEnabled) {
        setEditorMode("minotes");
      }
    };
    window.addEventListener("minotes-settings-changed", handler);
    return () => window.removeEventListener("minotes-settings-changed", handler);
  }, []);

  const handleCM6Save = (content: string) => {
    if (content !== block.content.trim()) {
      onUpdate(block.id, content);
    }
  };

  const handleAddProperty = async () => {
    const k = newKey.trim();
    const v = newValue.trim();
    if (!k) return;
    await api.setProperty(block.id, "block", k, v);
    const props = await api.getProperties(block.id);
    setProperties(props);
    setNewKey("");
    setNewValue("");
    setAddingProp(false);
  };

  const handleUpdateProperty = async (key: string) => {
    await api.setProperty(block.id, "block", key, editValue.trim());
    const props = await api.getProperties(block.id);
    setProperties(props);
    setEditingProp(null);
  };

  const handleDeleteProperty = async (key: string) => {
    await api.deleteProperty(block.id, key);
    setProperties(prev => prev.filter(p => p.key !== key));
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  return (
    <div
      className={`block${selected ? " selected" : ""}`}
      data-depth={depth > 0 ? String(depth) : undefined}
      data-tree-last={isLastSibling ? "true" : undefined}
      data-active-path={isOnActivePath ? "true" : undefined}
      data-block-id={dataBlockId ?? block.id}
      onFocusCapture={() => onFocusBlock?.(block.id)}
      onBlurCapture={() => onBlurBlock?.()}
      onContextMenu={handleContextMenu}
      onClick={(e) => {
        if (e.shiftKey && onShiftClick) {
          e.preventDefault();
          onShiftClick(block.id);
        }
      }}
    >
      {/* Zoom trigger on bullet for blocks with children */}
      {hasChildren && onZoomIn && (
        <div
          className="block-zoom-trigger"
          onClick={onZoomIn}
          title="Zoom into this block"
        />
      )}
      {/* Collapse toggle for blocks with children */}
      {hasChildren && onToggleCollapse && (
        <button
          className="block-collapse"
          onClick={() => onToggleCollapse(block.id)}
          title={block.collapsed ? "Expand" : "Collapse"}
        >
          {block.collapsed ? "\u25B6" : "\u25BC"}
        </button>
      )}

      {/* Editor mode toggle — only shown when obsidian editor is enabled in settings */}
      {settings.obsidianEditorEnabled && (
        <div className="editor-mode-toggle">
          <button
            className={`editor-mode-btn ${editorMode === "minotes" ? "active" : ""}`}
            onClick={() => setEditorMode("minotes")}
            title="Rich text editor (TipTap)"
          >
            Mi
          </button>
          <button
            className={`editor-mode-btn ${editorMode === "obsidian" ? "active" : ""}`}
            onClick={() => setEditorMode("obsidian")}
            title="Source editor (CodeMirror 6)"
          >
            Ob
          </button>
        </div>
      )}

      {/* Editor content */}
      {editorMode === "minotes" ? (
        <EditorContent editor={tiptapEditor} className="block-content" />
      ) : (
        <Suspense fallback={<div className="block-content" style={{ color: "var(--text-muted)" }}>Loading source editor...</div>}>
          <CM6BlockEditor content={block.content} onSave={handleCM6Save} />
        </Suspense>
      )}

      {/* Properties */}
      {(properties.length > 0 || addingProp) && (
        <div className="block-properties">
          {properties.map(prop => (
            <span key={prop.key} className="prop-chip">
              <span className="prop-key">{prop.key}</span>
              {editingProp === prop.key ? (
                <input
                  className="prop-edit-input"
                  value={editValue}
                  onChange={e => setEditValue(e.target.value)}
                  onBlur={() => handleUpdateProperty(prop.key)}
                  onKeyDown={e => {
                    if (e.key === "Enter") handleUpdateProperty(prop.key);
                    if (e.key === "Escape") setEditingProp(null);
                  }}
                  autoFocus
                />
              ) : (
                <span
                  className="prop-value"
                  onClick={() => { setEditingProp(prop.key); setEditValue(prop.value ?? ""); }}
                >
                  {prop.value || "—"}
                </span>
              )}
              <span className="prop-delete" onClick={() => handleDeleteProperty(prop.key)}>×</span>
            </span>
          ))}
          {addingProp && (
            <span className="prop-chip prop-chip-new">
              <input
                className="prop-edit-input"
                placeholder="key"
                value={newKey}
                onChange={e => setNewKey(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter") {
                    (e.target as HTMLElement).nextElementSibling
                      ?.querySelector("input")
                      ?.focus();
                  }
                  if (e.key === "Escape") setAddingProp(false);
                }}
                autoFocus
              />
              <span>
                <input
                  className="prop-edit-input"
                  placeholder="value"
                  value={newValue}
                  onChange={e => setNewValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") handleAddProperty();
                    if (e.key === "Escape") setAddingProp(false);
                  }}
                />
              </span>
            </span>
          )}
        </div>
      )}
      <button
        className="prop-add-btn"
        onClick={() => setAddingProp(true)}
        title="Add property"
      >
        +
      </button>

      {/* Context menu */}
      {contextMenu && (
        <BlockContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          blockId={block.id}
          blockContent={block.content}
          onClose={() => setContextMenu(null)}
          onDelete={onDelete}
          onDuplicate={onDuplicate ?? (() => {})}
          onCopyRef={() => {}}
          onToggleTodo={() => handleToggleTodo()}
        />
      )}
    </div>
  );
});

BlockItem.displayName = "BlockItem";

export default BlockItem;
