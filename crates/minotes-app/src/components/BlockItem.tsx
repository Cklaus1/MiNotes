import React, { useEffect, useLayoutEffect, useState, useRef, lazy, Suspense, forwardRef, useImperativeHandle } from "react";
import { attachmentHash, openAttachment } from "../lib/attachments";
import { flushSync } from "react-dom";
import { EditorContent, type Editor } from "@tiptap/react";
import { Selection, TextSelection } from "@tiptap/pm/state";
import type { Block, Property, OgMetadata } from "../lib/api";
import * as api from "../lib/api";
import { useBlockEditor } from "../editor";
import { getSettingsCached } from "../lib/cachedSettings";
import { loadBlockProperties } from "../lib/blockProperties";
import { claimEditor, forgetEditor, requestEditorSweep, type EditorOwner } from "../lib/editorActivation";
import { renderBlockStatic, staticRootClass } from "../editor/staticRender";
import { followNotebookLinkElement, hydrateNotebookLinks } from "../lib/crossNotebook";
import BlockContextMenu from "./BlockContextMenu";
import { WHITEBOARD_REGEX, hasWhiteboardData } from "../lib/whiteboardUtils";
import WhiteboardThumbnail from "./WhiteboardThumbnail";
import BubbleToolbar from "../editor/BubbleToolbar";
import TableToolbar from "../editor/TableToolbar";
import { runTableAction, isInTable, type TableAction } from "../editor/tables";
import { useIsFlashcard, makeFlashcard, removeFlashcard, FLASHCARD_HINT } from "../lib/cards";
import { showToast } from "../lib/toast";
import "../editor/editor.css";

// Lazy-load CM6 editor — only downloaded when obsidianEditorEnabled
const CM6BlockEditor = lazy(() => import("../editor/CM6BlockEditor"));

/** Where to put the caret: start/end of the block, or a ProseMirror doc position. */
export type FocusPosition = "start" | "end" | "keep" | number;

export interface BlockItemHandle {
  /** Focus the editor NOW (synchronously, so the very next keystroke lands here). */
  focus: (position?: FocusPosition) => void;
  /** Caret position (ProseMirror doc pos) while focused, else null. */
  getCaret: () => number | null;
  /** Leave editing: blur the editor (pending edits are saved by the blur handler). */
  blur: () => void;
  /** Live editor markdown (may be ahead of the block.content prop while typing). */
  getMarkdown: () => string;
  /** True when the editor holds edits not yet saved. */
  isDirty: () => boolean;
  /** Place the cursor at a text offset and split there: the Enter-key code path. */
  splitAt: (offset: number) => boolean;
  /** Merge into the previous block: the Backspace-at-start code path. */
  mergeWithPrevious: () => boolean;
  /** Cycle TODO state: the Ctrl+Enter code path. */
  toggleTodo: () => void;
  /** Table structure command at the cursor (toolbar / context-menu path), then save. */
  tableAction: (action: TableAction) => boolean;
  /** Make / remove this block's flashcard (context-menu path). */
  setFlashcard: (on: boolean) => Promise<boolean>;
  /** Mount this block's editor (blocks render statically until edited). True when it is live. */
  ensureEditor: () => boolean;
}

type BlockEditorApi = ReturnType<typeof useBlockEditor>;
type EditorBridge = { editor: Editor | null; api: BlockEditorApi } | null;
type BlockEditorOptions = Parameters<typeof useBlockEditor>[0];

/**
 * The live TipTap editor of a block — mounted only while the block is being edited
 * (see lib/editorActivation.ts). Reports its editor to the BlockItem via `bridge`.
 */
function ActiveBlockEditor({ bridge, options, onTableAction }: {
  bridge: React.MutableRefObject<EditorBridge>;
  options: BlockEditorOptions;
  onTableAction: (action: TableAction) => boolean;
}) {
  const blockEditor = useBlockEditor(options);
  const editor = blockEditor.editor;
  bridge.current = { editor, api: blockEditor };
  // Set again on mount: StrictMode (dev) runs mount -> cleanup -> mount.
  useLayoutEffect(() => {
    bridge.current = { editor, api: blockEditor };
    return () => { bridge.current = null; };
  });
  return (
    <>
      {editor && <BubbleToolbar editor={editor} />}
      {editor && <TableToolbar editor={editor} onAction={onTableAction} />}
      <EditorContent editor={editor} className="block-content" />
    </>
  );
}

const propError = (e: unknown) => String((e as any)?.message ?? e);

const TASK_CHECKBOX = 'li[data-type="taskItem"] > label > input[type="checkbox"]';

/**
 * A block that is not being edited: the DOM its editor would render (same
 * classes, so the same CSS), built by editor/staticRender.ts. Links, refs and
 * task checkboxes stay clickable.
 */
function StaticBlockContent({ content, onPageLinkClick, onBlockRefClick, onToggleTask }: {
  content: string;
  onPageLinkClick: (title: string, shiftKey?: boolean) => void;
  onBlockRefClick?: (blockId: string) => void;
  onToggleTask: (index: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.replaceChildren(renderBlockStatic(content));
    if (content.includes("::")) hydrateNotebookLinks(ref.current);
  }, [content]);
  const handleClick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    const xnb = t.closest(".xnb-link") as HTMLElement | null;
    if (xnb) {
      e.preventDefault();
      e.stopPropagation();
      followNotebookLinkElement(xnb);
      return;
    }
    const wiki = t.closest(".wiki-link") as HTMLElement | null;
    if (wiki) {
      const name = wiki.getAttribute("data-page-id") || wiki.getAttribute("data-page-name") || wiki.textContent;
      if (name) { e.preventDefault(); e.stopPropagation(); onPageLinkClick(name, e.shiftKey); }
      return;
    }
    const bref = t.closest(".block-ref") as HTMLElement | null;
    if (bref) {
      const id = bref.getAttribute("data-block-id");
      if (id) { e.preventDefault(); e.stopPropagation(); onBlockRefClick?.(id); }
      return;
    }
    if (e.shiftKey) return; // the block's shift-click (range selection)
    const box = t.closest('li[data-type="taskItem"] > label') as HTMLElement | null;
    if (box && ref.current) {
      e.preventDefault();
      e.stopPropagation();
      const input = box.querySelector('input[type="checkbox"]');
      onToggleTask([...ref.current.querySelectorAll(TASK_CHECKBOX)].indexOf(input as Element));
      return;
    }
    const link = t.closest("a[href]") as HTMLAnchorElement | null;
    if (link && e.button === 0) {
      e.preventDefault();
      // ── Import / attachments: stored files open with the OS ──
      const hash = attachmentHash(link.getAttribute("href"));
      if (hash) { e.stopPropagation(); openAttachment(hash).catch(() => {}); return; }
      // ── End import ──
      window.open(link.href, link.target || undefined);
    }
  };
  return (
    <div className="block-content">
      <div ref={ref} className={`${staticRootClass()} block-static`} translate="no" onClick={handleClick} />
    </div>
  );
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
  canEnter?: () => boolean;
  onBackspaceAtStart?: (blockId: string, content: string) => void;
  onArrowUp?: (blockId: string) => void;
  onArrowDown?: (blockId: string) => void;
  onPasteMultiline?: (blockId: string, lines: string[]) => void;
  onIndent?: (blockId: string) => void;
  onOutdent?: (blockId: string) => void;
  onEscape?: (blockId: string) => void;
  onDuplicate?: (blockId: string) => void;
  onToggleCollapse?: (blockId: string) => void;
  onZoomIn?: () => void;
  onShiftClick?: (blockId: string) => void;
  onOpenWhiteboard?: (whiteboardId: string) => void;
  onDragReorder?: (draggedBlockId: string, targetBlockId: string, position: "above" | "below") => void;
}

const BlockItem = forwardRef<BlockItemHandle, Props>(({
  block, depth = 0, hasChildren = false, isLastSibling = false, isOnActivePath = false, onFocusBlock, onBlurBlock, dataBlockId, selected = false, onUpdate, onDelete, onPageLinkClick,
  onBlockRefClick, onEnter, canEnter, onBackspaceAtStart, onArrowUp, onArrowDown, onPasteMultiline,
  onIndent, onOutdent, onEscape, onDuplicate, onToggleCollapse, onZoomIn, onShiftClick, onOpenWhiteboard, onDragReorder,
}, ref) => {
  const settings = getSettingsCached();
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
  const isCard = useIsFlashcard(block.id);
  // Set when the context menu was opened on a table cell (shows table items).
  const [menuInTable, setMenuInTable] = useState(false);

  const setFlashcard = async (on: boolean): Promise<boolean> => {
    try {
      if (on) {
        await makeFlashcard(block.id);
        showToast(hasChildren
          ? "Flashcard created: this block is the question, its children the answer"
          : "Flashcard created: add child blocks under it as the answer");
      } else {
        await removeFlashcard(block.id);
        showToast("Flashcard removed");
      }
      return true;
    } catch (e) {
      showToast(`Could not ${on ? "create" : "remove"} flashcard: ${e}`);
      return false;
    }
  };

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

  // Live-markdown reader, filled in once the editor hook has run (below). Ctrl+Enter
  // must cycle based on what the user sees NOW, not the last-saved block.content prop
  // (which lags behind typing until blur) — otherwise it overwrites just-typed text.
  const liveMarkdownRef = useRef<() => string | null>(() => null);

  const handleToggleTodo = () => {
    const live = liveMarkdownRef.current();
    // Live markdown is trimmed: a bare "TODO" is the "TODO " prefix with no text yet.
    const raw = live ?? block.content;
    const content = /^(TODO|DOING|DONE)$/.test(raw) ? raw + " " : raw;
    let newContent: string;
    if (content === "{{todo:done}}" || content.startsWith("DONE ")) {
      newContent = content === "{{todo:done}}" ? "{{todo:pending}}" : content.slice(5);
    } else if (content === "{{todo:doing}}" || content.startsWith("DOING ")) {
      newContent = content === "{{todo:doing}}" ? "{{todo:done}}" : "DONE " + content.slice(6);
    } else if (content === "{{todo:pending}}" || content.startsWith("TODO ")) {
      newContent = content === "{{todo:pending}}" ? "{{todo:doing}}" : "DOING " + content.slice(5);
    } else {
      newContent = "TODO " + content;
    }
    onUpdate(block.id, newContent);
  };

  // ── Live editor (only while editing) vs static rendering ──
  const [active, setActive] = useState(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const bridgeRef = useRef<EditorBridge>(null);
  const getEd = (): Editor | null => {
    const ed = bridgeRef.current?.editor ?? null;
    return ed && !ed.isDestroyed ? ed : null;
  };
  const rootRef = useRef<HTMLDivElement>(null);
  const contextMenuOpenRef = useRef(false);
  const releaseRef = useRef<() => boolean>(() => true);
  releaseRef.current = () => {
    if (!activeRef.current) return true;
    if (contextMenuOpenRef.current) return false;
    const root = rootRef.current;
    if (root && document.activeElement && root.contains(document.activeElement)) return false;
    if (getEd()?.view.hasFocus()) return false;
    setActive(false);
    return true;
  };
  const ownerRef = useRef<EditorOwner>({ release: () => releaseRef.current() });
  useEffect(() => () => forgetEditor(ownerRef.current), []);

  const linkPreviewOrWhiteboard = !!linkPreviewUrl || WHITEBOARD_REGEX.test(block.content);
  /** Mount the editor now (synchronously when called from an event/timer). */
  const activate = (): boolean => {
    if (editorMode !== "minotes" || linkPreviewOrWhiteboard) return false;
    claimEditor(ownerRef.current);
    if (!activeRef.current) flushSync(() => setActive(true));
    const ed = getEd();
    return !!ed && ed.view.dom.isConnected;
  };

  const editorOptions: BlockEditorOptions = {
    content: block.content,
    onSave: (markdown) => {
      if (markdown !== block.content.trim()) {
        onUpdate(block.id, markdown);
      }
    },
    onPageLinkClick,
    onBlockRefClick,
    onEnter: onEnter ? (contentAfterCursor, savedContent) => onEnter(block.id, contentAfterCursor, savedContent) : undefined,
    canEnter,
    onBackspaceAtStart: onBackspaceAtStart ? (content) => onBackspaceAtStart(block.id, content) : undefined,
    onArrowUp: onArrowUp ? () => onArrowUp(block.id) : undefined,
    onArrowDown: onArrowDown ? () => onArrowDown(block.id) : undefined,
    onToggleTodo: () => handleToggleTodo(),
    onPasteMultiline: onPasteMultiline ? (lines) => onPasteMultiline(block.id, lines) : undefined,
    onIndent: onIndent ? () => onIndent(block.id) : undefined,
    onOutdent: onOutdent ? () => onOutdent(block.id) : undefined,
    onEscape: onEscape ? () => onEscape(block.id) : undefined,
    onMakeFlashcard: () => { void setFlashcard(true); },
    onSlashCommand: (newMarkdown: string) => {
      // Save to backend + update local state (triggers re-render → setContent)
      onUpdate(block.id, newMarkdown);
      // Re-focus inside the content after re-render
      setTimeout(() => {
        const ed = getEd();
        if (ed) {
          ed.commands.focus();
          // For lists/tasks, cursor may land outside the item — move to first text position
          try {
            const doc = ed.state.doc;
            // Find the first text node position
            let textPos = 1;
            let firstTextblock = -1;
            doc.descendants((node, pos) => {
              if (node.isTextblock && firstTextblock < 0) firstTextblock = pos + 1;
              if (node.isText && textPos === 1) {
                textPos = pos + node.nodeSize;
                return false;
              }
            });
            // No text yet (e.g. a fresh /table): go to the first textblock (first cell).
            if (textPos === 1 && firstTextblock > 0) textPos = firstTextblock;
            ed.commands.setTextSelection(textPos);
          } catch {}
        }
      }, 150);
    },
  };

  liveMarkdownRef.current = () =>
    editorMode === "minotes" && getEd() && bridgeRef.current
      ? bridgeRef.current.api.getMarkdown()
      : null;

  const focusGenRef = useRef(0);
  const focusBlock = (position: FocusPosition) => {
    const tryFocus = (): boolean => {
      const ed = getEd();
      if (!ed || !ed.view.dom.isConnected) return false;
      // Not commands.focus(): it focuses the DOM a frame later (requestAnimationFrame),
      // so keys typed in that frame went to the previously focused block, and a
      // blur in between (Escape) was undone by the late focus. Set the selection
      // and focus the view synchronously instead.
      try {
        const { doc } = ed.state;
        // "keep": the selection the editor already holds (ProseMirror keeps it on blur).
        const sel = position === "keep" ? ed.state.selection
          : position === "start" ? Selection.atStart(doc)
          : position === "end" ? Selection.atEnd(doc)
          : TextSelection.near(doc.resolve(Math.max(0, Math.min(position, doc.content.size))));
        if (!sel.eq(ed.state.selection)) ed.view.dispatch(ed.state.tr.setSelection(sel));
        ed.view.focus();
        ed.view.dispatch(ed.state.tr.scrollIntoView());
      } catch {
        return false;
      }
      return ed.view.hasFocus();
    };
    const gen = ++focusGenRef.current;
    activate();
    if (tryFocus()) return;
    // Not mounted yet: retry, but never once it has focus — a late retry would
    // move the caret under the user's typing (start-of-block after a split).
    const retry = () => {
      if (gen !== focusGenRef.current) return;
      activate();
      const ed = getEd();
      if (ed && !ed.view.hasFocus()) tryFocus();
    };
    setTimeout(retry, 50);
    setTimeout(retry, 150);
  };

  useImperativeHandle(ref, () => ({
    focus: (position: FocusPosition = "end") => focusBlock(position),
    getCaret: () => {
      const ed = getEd();
      if (!ed || !ed.view.hasFocus()) return null;
      return ed.state.selection.from;
    },
    blur: () => {
      const ed = getEd();
      focusGenRef.current++; // cancel pending focus retries
      if (!ed) return;
      (ed.view.dom as HTMLElement).blur();
    },
    getMarkdown: () => liveMarkdownRef.current() ?? block.content,
    isDirty: () => editorMode === "minotes" && !!getEd() && !!bridgeRef.current?.api.isDirty(),
    splitAt: (offset: number) => {
      if (!activate()) return false;
      const ed = getEd();
      if (!ed || !bridgeRef.current) return false;
      // Text offset -> doc position (1 = start of the first textblock).
      const pos = Math.max(1, Math.min(offset + 1, ed.state.doc.content.size - 1));
      ed.commands.setTextSelection(pos);
      return bridgeRef.current.api.splitAtCursor();
    },
    mergeWithPrevious: () => {
      if (getEd() && bridgeRef.current) return bridgeRef.current.api.mergeWithPrevious();
      // Static block: nothing typed, the stored content is what merges.
      if (!onBackspaceAtStart) return false;
      onBackspaceAtStart(block.id, block.content);
      return true;
    },
    toggleTodo: () => handleToggleTodoRef.current(),
    tableAction: (action: TableAction) => { activate(); return tableActionRef.current(action); },
    setFlashcard: (on: boolean) => setFlashcardRef.current(on),
    ensureEditor: () => activate(),
  }), [block.content, editorMode, active]);

  const handleTableAction = (action: TableAction): boolean => {
    const ed = getEd();
    if (!ed || !bridgeRef.current) return false;
    const ok = runTableAction(ed, action);
    // Structure changes persist immediately rather than waiting for blur.
    if (ok) bridgeRef.current.api.saveNow();
    return ok;
  };
  const tableActionRef = useRef(handleTableAction);
  tableActionRef.current = handleTableAction;
  const setFlashcardRef = useRef(setFlashcard);
  setFlashcardRef.current = setFlashcard;

  const handleToggleTodoRef = useRef(handleToggleTodo);
  handleToggleTodoRef.current = handleToggleTodo;

  // NOTE: the ONLY content sync (setContent) lives in useBlockEditor.ts.

  // MouseDown on block → ensure TipTap editor gets focus (WebKitGTK fix)
  // WebKitGTK doesn't always focus contenteditable on first click. Pre-focus on mousedown.
  // A static block mounts its editor here and puts the caret where the click landed.
  const handleBlockMouseDown = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const inStatic = !activeRef.current && !!target.closest('.block-static');
    if (target.closest('.block-drag-handle') || target.closest('.block-collapse') ||
        target.closest('.block-properties') || target.closest('.prop-add-btn') ||
        target.closest('.whiteboard-indicator') || target.closest('.editor-mode-toggle') ||
        (target.tagName === 'INPUT' && (target as unknown as HTMLInputElement).type === 'checkbox') ||
        target.closest('label')) {
      // A static task checkbox is toggled by its click (through the editor).
      if (inStatic && (target.tagName === 'INPUT' || target.closest('label'))) e.preventDefault();
      return;
    }
    if (activeRef.current) {
      const ed = getEd();
      if (ed && !ed.isFocused) ed.commands.focus();
      return;
    }
    if (e.button !== 0 || editorMode !== "minotes" || linkPreviewOrWhiteboard) return;
    if (!inStatic) {
      // Block chrome (bullet, padding): start editing, caret where it would be.
      if (target.closest('.block-content') || target === e.currentTarget) {
        e.preventDefault();
        focusBlock("keep");
      }
      return;
    }
    // Links/refs act on click; shift-click extends the block selection.
    e.preventDefault();
    if (e.shiftKey || target.closest('.wiki-link, .xnb-link, .block-ref, a[href]')) return;
    const x = e.clientX, y = e.clientY;
    if (!activate()) return;
    const ed = getEd();
    const hit = ed && (x || y) ? ed.view.posAtCoords({ left: x, top: y }) : null;
    focusBlock(hit ? hit.pos : "end");
  };

  // A static task checkbox was clicked: toggle it in the editor (same code path as
  // a click on the editor's own checkbox), which also starts editing the block.
  const handleStaticToggleTask = (index: number) => {
    if (index < 0 || !activate()) return;
    const ed = getEd();
    const box = ed?.view.dom.querySelectorAll(TASK_CHECKBOX)[index] as HTMLInputElement | undefined;
    box?.click();
  };

  // Load properties (batched with every other block: lib/blockProperties.ts)
  useEffect(() => {
    let cancelled = false;
    loadBlockProperties(block.id).then((p) => { if (!cancelled && p.length) setProperties(p); }).catch(() => {});
    return () => { cancelled = true; };
  }, [block.id]);

  // Feature 8: Fetch OG metadata for link preview blocks
  useEffect(() => {
    if (!linkPreviewUrl) { setOgMeta(null); return; }
    api.fetchOgMetadata(linkPreviewUrl).then(setOgMeta).catch(() => setOgMeta(null));
  }, [linkPreviewUrl]);

  // Feature 9: Fetch transcluded block content
  const blockRefKey = blockRefIds.join(",");
  useEffect(() => {
    if (blockRefIds.length === 0) { setTranscludedBlocks(new Map()); return; }
    let cancelled = false;
    const fetchAll = async () => {
      const entries = new Map<string, Block>();
      try {
        // One call for every referenced block (unknown ids are skipped).
        for (const b of await api.getBlocks(blockRefIds)) entries.set(b.id, b);
      } catch {}
      // Drop stale results: the content changed (or we unmounted) mid-fetch.
      if (!cancelled) setTranscludedBlocks(entries);
    };
    fetchAll();
    return () => { cancelled = true; };
  }, [blockRefKey]);

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
    try {
      await api.setProperty(block.id, "block", k, v);
    } catch (e) {
      // Refused by the backend (invalid key/value): say why, add nothing.
      showToast(`Property not saved: ${propError(e)}`);
      return;
    }
    const props = await api.getProperties(block.id).catch(() => null);
    if (props) setProperties(props);
    setNewKey("");
    setNewValue("");
    setAddingProp(false);
  };

  const savingPropRef = useRef<string | null>(null);
  const handleUpdateProperty = async (key: string) => {
    // Enter saves and closes the input; the blur that may follow must not save again.
    if (savingPropRef.current === key) return;
    savingPropRef.current = key;
    setTimeout(() => { savingPropRef.current = null; }, 0);
    setEditingProp(null);
    try {
      await api.setProperty(block.id, "block", key, editValue.trim());
    } catch (e) {
      // Refused: the chip keeps its old value.
      showToast(`Property not saved: ${propError(e)}`);
      return;
    }
    const props = await api.getProperties(block.id).catch(() => null);
    if (props) setProperties(props);
  };

  const handleDeleteProperty = async (key: string) => {
    try {
      await api.deleteProperty(block.id, key);
      setProperties(prev => prev.filter(p => p.key !== key));
    } catch (e) {
      showToast(`Property not deleted: ${propError(e)}`);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    // Right-click in a table cell: put the cursor in that cell so the table items
    // in the menu act on it.
    let inTable = false;
    const onTable = !!(e.target as HTMLElement).closest?.(".ProseMirror table");
    if (onTable && !activeRef.current) activate();
    const ed = getEd();
    if (ed && onTable) {
      const hit = ed.view.posAtCoords({ left: e.clientX, top: e.clientY });
      if (hit) {
        try { ed.commands.setTextSelection(hit.pos); } catch {}
        inTable = isInTable(ed.state);
      }
    }
    setMenuInTable(inTable);
    contextMenuOpenRef.current = true;
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  return (
    <div
      ref={rootRef}
      className={`block${selected ? " selected" : ""}${isCard ? " is-flashcard" : ""}${dropPosition === "above" ? " drop-above" : ""}${dropPosition === "below" ? " drop-below" : ""}`}
      data-depth={depth > 0 ? String(depth) : undefined}
      style={depth > 0 ? ({ "--depth": depth } as React.CSSProperties) : undefined}
      data-tree-last={isLastSibling ? "true" : undefined}
      data-active-path={isOnActivePath ? "true" : undefined}
      data-block-id={dataBlockId ?? block.id}
      onFocusCapture={() => onFocusBlock?.(block.id)}
      onBlurCapture={() => { onBlurBlock?.(); requestEditorSweep(); }}
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
        <span className="todo-badge todo-badge-todo todo-badge-cover" onClick={handleToggleTodo} title="Click to cycle: TODO → DOING → DONE"><span className="todo-badge-sizer" aria-hidden="true">TODO</span><span className="todo-badge-label">TODO</span></span>
      )}
      {block.content.startsWith("DOING ") && (
        <span className="todo-badge todo-badge-doing todo-badge-cover" onClick={handleToggleTodo} title="Click to cycle: DOING → DONE"><span className="todo-badge-sizer" aria-hidden="true">DOING</span><span className="todo-badge-label">DOING</span></span>
      )}
      {block.content.startsWith("DONE ") && (
        <span className="todo-badge todo-badge-done todo-badge-cover" onClick={handleToggleTodo} title="Click to remove DONE state"><span className="todo-badge-sizer" aria-hidden="true">DONE</span><span className="todo-badge-label">DONE</span></span>
      )}
      {/* {{todo:pending}} badge */}
      {block.content === "{{todo:pending}}" && (
        <span className="todo-badge todo-badge-todo" onClick={handleToggleTodo} title="Click to cycle: TODO → DOING → DONE">TODO</span>
      )}
      {block.content === "{{todo:doing}}" && (
        <span className="todo-badge todo-badge-doing" onClick={handleToggleTodo} title="Click to cycle: DOING → DONE">DOING</span>
      )}
      {block.content === "{{todo:done}}" && (
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
          active ? (
            <ActiveBlockEditor bridge={bridgeRef} options={editorOptions} onTableAction={handleTableAction} />
          ) : (
            <StaticBlockContent
              content={block.content}
              onPageLinkClick={onPageLinkClick}
              onBlockRefClick={onBlockRefClick}
              onToggleTask={handleStaticToggleTask}
            />
          )
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
      {isCard && (
        <span className="flashcard-indicator" title={FLASHCARD_HINT + " (right-click to remove)"} aria-label="Flashcard" role="img">
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="1.5" y="3.5" width="11" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <path d="M4.5 1.5h8.5a1.5 1.5 0 0 1 1.5 1.5v7" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            <path d="M4.5 7h5M4.5 9.5h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </span>
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
          onClose={() => { contextMenuOpenRef.current = false; setContextMenu(null); requestEditorSweep(); }}
          onDelete={onDelete}
          onDuplicate={onDuplicate ?? (() => {})}
          onCopyRef={() => {}}
          onToggleTodo={() => handleToggleTodo()}
          isFlashcard={isCard}
          onToggleFlashcard={() => { void setFlashcard(!isCard); }}
          onTableAction={menuInTable ? (action) => { handleTableAction(action); } : undefined}
        />
      )}
    </div>
  );
});

BlockItem.displayName = "BlockItem";

// Memo: only re-render when block data or selection state actually changes
// Prevents focus-stealing re-renders when sibling blocks change activePathIds.
// The block is compared by identity: PageView keeps an unchanged block's object
// and replaces a changed one, and a backend layer that shares (and mutates) its
// block objects (the mock) must not make an edit look like "no change".
export default React.memo(BlockItem, (prev, next) => {
  return (
    prev.block === next.block &&
    prev.depth === next.depth &&
    prev.selected === next.selected &&
    prev.hasChildren === next.hasChildren &&
    prev.isLastSibling === next.isLastSibling &&
    !!prev.onDragReorder === !!next.onDragReorder
  );
});
