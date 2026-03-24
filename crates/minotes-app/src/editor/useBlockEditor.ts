import { useEditor } from "@tiptap/react";
import { useRef, useCallback, useEffect } from "react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Highlight from "@tiptap/extension-highlight";
import Typography from "@tiptap/extension-typography";
import Placeholder from "@tiptap/extension-placeholder";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { common, createLowlight } from "lowlight";
import { Markdown } from "tiptap-markdown";
import { WikiLinkNode } from "./WikiLinkNode";
import { BlockRefNode } from "./BlockRefNode";
import { SlashCommands } from "./slashCommands";
import { PageLinkSuggestion } from "./PageLinkSuggestion";
import { BlockRefSuggestion } from "./BlockRefSuggestion";

const lowlight = createLowlight(common);

interface UseBlockEditorOptions {
  content: string;
  onSave: (markdown: string) => void;
  onPageLinkClick: (title: string, shiftKey?: boolean) => void;
  onBlockRefClick?: (blockId: string) => void;
  onEnter?: (contentAfterCursor: string) => void;
  onBackspaceAtStart?: (content: string) => void;
  onArrowUp?: () => void;
  onArrowDown?: () => void;
  onToggleTodo?: () => void;
  onPasteMultiline?: (lines: string[]) => void;
  onIndent?: () => void;
  onOutdent?: () => void;
}

export function useBlockEditor({
  content,
  onSave,
  onPageLinkClick,
  onBlockRefClick,
  onEnter,
  onBackspaceAtStart,
  onArrowUp,
  onArrowDown,
  onToggleTodo,
  onPasteMultiline,
  onIndent,
  onOutdent,
}: UseBlockEditorOptions) {
  const onSaveRef = useRef(onSave);
  const contentRef = useRef(content);
  const onEnterRef = useRef(onEnter);
  const onBackspaceAtStartRef = useRef(onBackspaceAtStart);
  const onArrowUpRef = useRef(onArrowUp);
  const onArrowDownRef = useRef(onArrowDown);
  const onToggleTodoRef = useRef(onToggleTodo);
  const onPasteMultilineRef = useRef(onPasteMultiline);
  const onIndentRef = useRef(onIndent);
  const onOutdentRef = useRef(onOutdent);
  onSaveRef.current = onSave;
  contentRef.current = content;
  onEnterRef.current = onEnter;
  onBackspaceAtStartRef.current = onBackspaceAtStart;
  onArrowUpRef.current = onArrowUp;
  onArrowDownRef.current = onArrowDown;
  onToggleTodoRef.current = onToggleTodo;
  onPasteMultilineRef.current = onPasteMultiline;
  onIndentRef.current = onIndent;
  onOutdentRef.current = onOutdent;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4] },
        codeBlock: false, // replaced by CodeBlockLowlight
      }),
      CodeBlockLowlight.configure({ lowlight }),
      Table.configure({ resizable: true }),
      TableRow,
      TableCell,
      TableHeader,
      TaskList,
      TaskItem.configure({ nested: true }),
      Highlight,
      Typography,
      Placeholder.configure({
        placeholder: "Type something...",
      }),
      Markdown.configure({
        html: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
      WikiLinkNode.configure({ onPageLinkClick }),
      BlockRefNode.configure({ onBlockRefClick: onBlockRefClick ?? (() => {}) }),
      SlashCommands,
      PageLinkSuggestion,
      BlockRefSuggestion,
    ],
    content,
    editorProps: {
      attributes: {
        class: "block-editor-prosemirror",
      },
      handleKeyDown(view, event) {
        if (event.key === "Escape") {
          view.dom.blur();
          return true;
        }

        // Ctrl+Enter — cycle TODO state
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && onToggleTodoRef.current) {
          event.preventDefault();
          onToggleTodoRef.current();
          return true;
        }

        // Enter — split block (unless Shift, or inside list/code/table/blockquote)
        if (event.key === "Enter" && !event.shiftKey && onEnterRef.current) {
          const { state } = view;
          const { $from } = state.selection;
          const parentNode = $from.node($from.depth);
          const grandparent = $from.depth > 1 ? $from.node($from.depth - 1) : null;

          if (
            parentNode.type.name === "listItem" ||
            parentNode.type.name === "codeBlock" ||
            parentNode.type.name === "taskItem" ||
            grandparent?.type.name === "table" ||
            grandparent?.type.name === "blockquote"
          ) {
            return false;
          }

          event.preventDefault();

          // Get markdown content after cursor by slicing the doc
          const from = state.selection.from;
          const docEnd = state.doc.content.size - 1; // -1 for the closing paragraph tag

          // Extract text after cursor from the current editor state
          let contentAfterCursor = "";
          if (from < docEnd) {
            // Get the text content from cursor to end
            contentAfterCursor = state.doc.textBetween(from, docEnd, "\n", "");
            // Delete everything after cursor
            const tr = state.tr.delete(from, docEnd);
            view.dispatch(tr);
          }

          onEnterRef.current(contentAfterCursor);
          return true;
        }

        // Backspace at position 0 — merge with previous block
        if (event.key === "Backspace" && onBackspaceAtStartRef.current) {
          const { state } = view;
          const { from, empty } = state.selection;
          if (empty && from <= 1) {
            event.preventDefault();
            // Get current markdown content via the editor instance
            // We need to access the editor — use a small workaround via the dom
            const editorEl = view.dom.closest(".tiptap");
            const editorInstance = (editorEl as any)?.__tiptapEditor;
            let md = "";
            if (editorInstance) {
              md = (editorInstance.storage as any).markdown?.getMarkdown() ?? "";
            } else {
              // Fallback: get text content from ProseMirror doc
              md = state.doc.textContent;
            }
            onBackspaceAtStartRef.current(md);
            return true;
          }
        }

        // ArrowUp on first line — move to previous block
        if (event.key === "ArrowUp" && onArrowUpRef.current) {
          const { state } = view;
          const { from } = state.selection;
          try {
            const coords = view.coordsAtPos(from);
            const startCoords = view.coordsAtPos(1);
            if (Math.abs(coords.top - startCoords.top) < 2) {
              onArrowUpRef.current();
              return true;
            }
          } catch {
            // If coordsAtPos fails (empty doc), treat as first line
            if (from <= 1) {
              onArrowUpRef.current();
              return true;
            }
          }
        }

        // Tab — indent block (unless inside list/task item)
        if (event.key === "Tab" && !event.shiftKey && onIndentRef.current) {
          const { $from } = view.state.selection;
          const parent = $from.node($from.depth);
          if (parent.type.name === "listItem" || parent.type.name === "taskItem") return false;
          event.preventDefault();
          onIndentRef.current();
          return true;
        }

        // Shift+Tab — outdent block (unless inside list/task item)
        if (event.key === "Tab" && event.shiftKey && onOutdentRef.current) {
          const { $from } = view.state.selection;
          const parent = $from.node($from.depth);
          if (parent.type.name === "listItem" || parent.type.name === "taskItem") return false;
          event.preventDefault();
          onOutdentRef.current();
          return true;
        }

        // ArrowDown on last line — move to next block
        if (event.key === "ArrowDown" && onArrowDownRef.current) {
          const { state } = view;
          const { from } = state.selection;
          const docEnd = state.doc.content.size - 1;
          try {
            const coords = view.coordsAtPos(from);
            const endCoords = view.coordsAtPos(docEnd);
            if (Math.abs(coords.top - endCoords.top) < 2) {
              onArrowDownRef.current();
              return true;
            }
          } catch {
            // If coordsAtPos fails (empty doc), treat as last line
            if (from >= docEnd || docEnd <= 1) {
              onArrowDownRef.current();
              return true;
            }
          }
        }

        return false;
      },
      handlePaste(view, event) {
        const text = event.clipboardData?.getData('text/plain') ?? '';

        // Don't split if inside a code block
        const { $from } = view.state.selection;
        if ($from.node($from.depth).type.name === 'codeBlock') {
          return false; // Let default handle it
        }

        // Check if multi-line
        const lines = text.split('\n').filter(l => l.trim());
        if (lines.length <= 1) {
          return false; // Single line, let default handle
        }

        // Check if it looks like a code block
        if (text.trimStart().startsWith('```')) {
          return false; // Let TipTap handle code fences
        }

        if (!onPasteMultilineRef.current) {
          return false; // No handler, let default handle
        }

        event.preventDefault();

        // Insert first line into current block
        const firstLine = lines[0];
        view.dispatch(view.state.tr.insertText(firstLine));

        // Call the callback with remaining lines to create new blocks
        onPasteMultilineRef.current(lines.slice(1));
        return true;
      },
    },
    onBlur({ editor }) {
      const markdown = (editor.storage as any).markdown?.getMarkdown() ?? "";
      const normalized = markdown.trim();
      const originalNormalized = contentRef.current.trim();
      if (normalized !== originalNormalized) {
        onSaveRef.current(normalized);
      }
    },
  }, [onPageLinkClick, onBlockRefClick]);

  // Sync external content changes (e.g. after backend refresh)
  useEffect(() => {
    if (!editor) return;
    const currentMarkdown = ((editor.storage as any).markdown?.getMarkdown() ?? "").trim();
    if (content.trim() !== currentMarkdown) {
      editor.commands.setContent(content);
    }
  }, [content, editor]);

  return editor;
}
