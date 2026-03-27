import React, { useEffect, useState, useRef, useCallback, lazy, Suspense, forwardRef, useImperativeHandle } from "react";
import { EditorContent } from "@tiptap/react";
import type { Block, Property, OgMetadata } from "../lib/api";
import * as api from "../lib/api";
import { useBlockEditor } from "../editor";
import { getSettings } from "../lib/settings";
import BlockContextMenu from "./BlockContextMenu";
import { WHITEBOARD_REGEX, hasWhiteboardData } from "../lib/whiteboardUtils";
import WhiteboardThumbnail from "./WhiteboardThumbnail";
import BubbleToolbar from "../editor/BubbleToolbar";
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
  onOpenWhiteboard?: (whiteboardId: string) => void;
  onDragReorder?: (draggedBlockId: string, targetBlockId: string, position: "above" | "below") => void;
}

const BlockItem = forwardRef<BlockItemHandle, Props>(({
  block, depth = 0, hasChildren = false, isLastSibling = false, isOnActivePath = false, onFocusBlock, onBlurBlock, dataBlockId, selected = false, onUpdate, onDelete, onPageLinkClick,
  onBlockRefClick, onEnter, onBackspaceAtStart, onArrowUp, onArrowDown, onPasteMultiline,
  onIndent, onOutdent, onDuplicate, onToggleCollapse, onZoomIn, onShiftClick, onOpenWhiteboard, onDragReorder,
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
  const [dropPosition, setDropPosition] = useState<"above" | "below" | null>(null);

  // Feature 8: Link Preview state
  const [ogMeta, setOgMeta] = useState<OgMetadata | null>(null);
  const linkPreviewMatch = block.content.match(/^\{\{link-preview:(https?:\/\/[^}]+)\}\}$/);
  const linkPreviewUrl = linkPreviewMatch ? linkPreviewMatch[1] : null;

  // Feature 9: Block Transclusion state
  const [transcludedBlocks, setTranscludedBlocks] = useState<Map<string, Block>>(new Map());
  const blockRefPattern = /\(\(([0-9a-fA-F-]{8,36})\)\)/g;
  const blockRefIds: string[] = [];
  let refMatch: RegExpExecArray | null;
  const contentForRefs = block.content;
  const refRegex = new RegExp(blockRefPattern.source, "g");
  while ((refMatch = refRegex.exec(contentForRefs)) !== null) {
    blockRefIds.push(refMatch[1]);
  }

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
      // Save to backend + update local state (triggers re-render → setContent)
      onUpdate(block.id, newMarkdown);
      // Re-focus inside the content after re-render
      setTimeout(() => {
        if (editorRef.current) {
          editorRef.current.commands.focus();
          // For lists/tasks, cursor may land outside the item — move to first text position
          try {
            const doc = editorRef.current.state.doc;
            // Find the first text node position
            let textPos = 1;
            doc.descendants((node, pos) => {
              if (node.isText && textPos === 1) {
                textPos = pos + node.nodeSize;
                return false;
              }
            });
            editorRef.current.commands.setTextSelection(textPos);
          } catch {}
        }
      }, 150);
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
  // NOTE: The primary sync effect is in useBlockEditor.ts (with skipSyncRef protection).
  // This effect handles editorMode changes only.
  useEffect(() => {
    if (!tiptapEditor || editorMode !== "minotes") return;
    // Only sync when switching editor modes, not on every content change
    // (useBlockEditor.ts handles content sync with skipSyncRef to avoid corrupting complex nodes)
  }, [tiptapEditor, editorMode]);

  // MouseDown on block → ensure TipTap editor gets focus (WebKitGTK fix)
  // WebKitGTK doesn't always focus contenteditable on first click. Pre-focus on mousedown.
  const handleBlockMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.block-drag-handle') || target.closest('.block-collapse') ||
        target.closest('.block-properties') || target.closest('.prop-add-btn') ||
        target.closest('.whiteboard-indicator') || target.closest('.editor-mode-toggle') ||
        (target.tagName === 'INPUT' && (target as unknown as HTMLInputElement).type === 'checkbox') ||
        target.closest('label')) {
      return;
    }
    if (editorRef.current && !editorRef.current.isFocused) {
      editorRef.current.commands.focus();
    }
  }, []);

  // Load properties
  useEffect(() => {
    api.getProperties(block.id).then(setProperties).catch(() => {});
  }, [block.id]);

  // Feature 8: Fetch OG metadata for link preview blocks
  useEffect(() => {
    if (!linkPreviewUrl) { setOgMeta(null); return; }
    api.fetchOgMetadata(linkPreviewUrl).then(setOgMeta).catch(() => setOgMeta(null));
  }, [linkPreviewUrl]);

  // Feature 9: Fetch transcluded block content
  useEffect(() => {
    if (blockRefIds.length === 0) { setTranscludedBlocks(new Map()); return; }
    const fetchAll = async () => {
      const entries = new Map<string, Block>();
      for (const bid of blockRefIds) {
        try {
          const b = await api.getBlock(bid);
          if (b) entries.set(bid, b);
        } catch {}
      }
      setTranscludedBlocks(entries);
    };
    fetchAll();
  }, [block.content]);

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
      className={`block${selected ? " selected" : ""}${dropPosition === "above" ? " drop-above" : ""}${dropPosition === "below" ? " drop-below" : ""}`}
      data-depth={depth > 0 ? String(depth) : undefined}
      data-tree-last={isLastSibling ? "true" : undefined}
      data-active-path={isOnActivePath ? "true" : undefined}
      data-block-id={dataBlockId ?? block.id}
      onFocusCapture={() => onFocusBlock?.(block.id)}
      onBlurCapture={() => onBlurBlock?.()}
      onContextMenu={handleContextMenu}
      onMouseDownCapture={handleBlockMouseDown}
      onClick={(e) => {
        if (e.shiftKey && onShiftClick) {
          e.preventDefault();
          onShiftClick(block.id);
        }
      }}
      onDragOver={(e) => {
        if (!onDragReorder) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        setDropPosition(e.clientY < rect.top + rect.height / 2 ? "above" : "below");
      }}
      onDragLeave={() => setDropPosition(null)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const draggedId = e.dataTransfer.getData("text/block-id");
        if (draggedId && draggedId !== block.id && dropPosition && onDragReorder) {
          onDragReorder(draggedId, block.id, dropPosition);
        }
        setDropPosition(null);
      }}
    >
      {/* Drag handle — visible on hover */}
      {onDragReorder && (
        <div
          className="block-drag-handle"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("text/block-id", block.id);
            e.dataTransfer.effectAllowed = "move";
            (e.currentTarget.closest(".block") as HTMLElement)?.classList.add("dragging");
          }}
          onDragEnd={(e) => {
            (e.currentTarget.closest(".block") as HTMLElement)?.classList.remove("dragging");
          }}
          title="Drag to reorder"
        >
          ⠿
        </div>
      )}
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

      {/* TODO/DOING/DONE badge */}
      {block.content.startsWith("TODO ") && (
        <span className="todo-badge todo-badge-todo" onClick={handleToggleTodo} title="Click to cycle: TODO → DOING → DONE">TODO</span>
      )}
      {block.content.startsWith("DOING ") && (
        <span className="todo-badge todo-badge-doing" onClick={handleToggleTodo} title="Click to cycle: DOING → DONE">DOING</span>
      )}
      {block.content.startsWith("DONE ") && (
        <span className="todo-badge todo-badge-done" onClick={handleToggleTodo} title="Click to remove DONE state">DONE</span>
      )}

      {/* Editor content — whiteboard blocks render as clickable cards, link previews as cards */}
      {(() => {
        const wbMatch = block.content.match(WHITEBOARD_REGEX);
        if (wbMatch) {
          const wbId = wbMatch[1];
          const hasSaved = hasWhiteboardData(wbId);
          return (
            <div
              className="whiteboard-indicator"
              onClick={() => onOpenWhiteboard?.(wbId)}
            >
              <WhiteboardThumbnail whiteboardId={wbId} />
              <span className="whiteboard-indicator-label">
                {hasSaved ? "Whiteboard" : "Whiteboard (empty)"} — click to open
              </span>
            </div>
          );
        }
        // Feature 8: Link Preview Card
        if (linkPreviewUrl) {
          return (
            <a
              className="link-preview-card"
              href={linkPreviewUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {ogMeta?.image && (
                <img
                  className="link-preview-image"
                  src={ogMeta.image}
                  alt=""
                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
              )}
              <div className="link-preview-body">
                <div className="link-preview-title">
                  {ogMeta?.title || linkPreviewUrl}
                </div>
                {ogMeta?.description && (
                  <div className="link-preview-description">{ogMeta.description}</div>
                )}
                <div className="link-preview-url">{linkPreviewUrl}</div>
              </div>
            </a>
          );
        }
        return editorMode === "minotes" ? (
          <>
            {tiptapEditor && <BubbleToolbar editor={tiptapEditor} />}
            <EditorContent editor={tiptapEditor} className="block-content" />
          </>
        ) : (
          <Suspense fallback={<div className="block-content" style={{ color: "var(--text-muted)" }}>Loading source editor...</div>}>
            <CM6BlockEditor content={block.content} onSave={handleCM6Save} />
          </Suspense>
        );
      })()}

      {/* Feature 9: Block Transclusion — show referenced blocks inline */}
      {blockRefIds.length > 0 && transcludedBlocks.size > 0 && (
        <div className="block-transclusions">
          {blockRefIds.map((bid) => {
            const tb = transcludedBlocks.get(bid);
            if (!tb) return null;
            return (
              <div key={bid} className="block-transclusion" onClick={() => onBlockRefClick?.(bid)}>
                <span className="block-transclusion-label">Transcluded block</span>
                <div className="block-transclusion-content">{tb.content}</div>
              </div>
            );
          })}
        </div>
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
                  if (e.key === "Escape") { setAddingProp(false); setNewKey(""); setNewValue(""); }
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
                    if (e.key === "Escape") { setAddingProp(false); setNewKey(""); setNewValue(""); }
                  }}
                />
              </span>
              <span className="prop-delete" onClick={() => { setAddingProp(false); setNewKey(""); setNewValue(""); }}>×</span>
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

// Memo: only re-render when block data or selection state actually changes
// Prevents focus-stealing re-renders when sibling blocks change activePathIds
export default React.memo(BlockItem, (prev, next) => {
  return (
    prev.block.id === next.block.id &&
    prev.block.content === next.block.content &&
    prev.block.collapsed === next.block.collapsed &&
    prev.depth === next.depth &&
    prev.selected === next.selected &&
    prev.hasChildren === next.hasChildren &&
    prev.isLastSibling === next.isLastSibling &&
    !!prev.onDragReorder === !!next.onDragReorder
  );
});
