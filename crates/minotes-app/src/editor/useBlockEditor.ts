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
import { SlashCommands, setSlashCallbacks } from "./slashCommands";
import { PageLinkSuggestion } from "./PageLinkSuggestion";
import { BlockRefSuggestion } from "./BlockRefSuggestion";

const lowlight = createLowlight(common);

interface UseBlockEditorOptions {
  content: string;
  onSave: (markdown: string) => void;
  onPageLinkClick: (title: string, shiftKey?: boolean) => void;
  onBlockRefClick?: (blockId: string) => void;
  onEnter?: (contentAfterCursor: string, savedContent?: string) => void;
  onBackspaceAtStart?: (content: string) => void;
  onArrowUp?: () => void;
  onArrowDown?: () => void;
  onToggleTodo?: () => void;
  onPasteMultiline?: (lines: string[]) => void;
  onIndent?: () => void;
  onOutdent?: () => void;
  onSlashCommand?: (newMarkdown: string) => void;
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
  onSlashCommand,
}: UseBlockEditorOptions) {
  const onSaveRef = useRef(onSave);
  const contentRef = useRef(content);
  const onPageLinkClickRef = useRef(onPageLinkClick);
  const onBlockRefClickRef = useRef(onBlockRefClick);
  const onEnterRef = useRef(onEnter);
  const onBackspaceAtStartRef = useRef(onBackspaceAtStart);
  const onArrowUpRef = useRef(onArrowUp);
  const onArrowDownRef = useRef(onArrowDown);
  const onToggleTodoRef = useRef(onToggleTodo);
  const onPasteMultilineRef = useRef(onPasteMultiline);
  const onIndentRef = useRef(onIndent);
  const onOutdentRef = useRef(onOutdent);
  const onSlashCommandRef = useRef(onSlashCommand);
  const editorInstanceRef = useRef<any>(null);
  const skipSyncRef = useRef(false);
  const slashActiveRef = useRef(false);
  onSaveRef.current = onSave;
  contentRef.current = content;
  onPageLinkClickRef.current = onPageLinkClick;
  onBlockRefClickRef.current = onBlockRefClick;
  onEnterRef.current = onEnter;
  onBackspaceAtStartRef.current = onBackspaceAtStart;
  onArrowUpRef.current = onArrowUp;
  onArrowDownRef.current = onArrowDown;
  onToggleTodoRef.current = onToggleTodo;
  onPasteMultilineRef.current = onPasteMultiline;
  onIndentRef.current = onIndent;
  onOutdentRef.current = onOutdent;
  onSlashCommandRef.current = onSlashCommand;

  // Slash callbacks are set per-editor instance after creation (see useEffect below)

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
      TaskList.extend({
        parseHTML() {
          return [
            { tag: 'ul[data-type="taskList"]', priority: 51 },
            { tag: 'ul.contains-task-list', priority: 51 },
          ];
        },
      }),
      TaskItem.extend({
        parseHTML() {
          return [
            { tag: `li[data-type="taskItem"]`, priority: 52 },
            {
              tag: 'li.task-list-item',
              priority: 52,
              getAttrs: (el: HTMLElement) => {
                const checkbox = el.querySelector('input[type="checkbox"]');
                return { checked: checkbox ? (checkbox as HTMLInputElement).checked : false };
              },
            },
          ];
        },
      }).configure({ nested: true }),
      Highlight,
      Typography,
      Placeholder.configure({
        placeholder: ({ editor }) => editor.isFocused ? "Type '/' for commands" : "",
        showOnlyWhenEditable: true,
        showOnlyCurrent: true,
      }),
      Markdown.configure({
        html: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
      WikiLinkNode.configure({ onPageLinkClick: (title: string, shiftKey?: boolean) => onPageLinkClickRef.current(title, shiftKey) }),
      BlockRefNode.configure({ onBlockRefClick: (blockId: string) => onBlockRefClickRef.current?.(blockId) }),
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

        // Enter — split block (unless Shift, inside list/code/table/blockquote, or popup open)
        if (event.key === "Enter" && !event.shiftKey && onEnterRef.current && !document.querySelector('.tippy-box')) {
          const { state } = view;
          const { $from } = state.selection;
          const parentNode = $from.node($from.depth);
          const grandparent = $from.depth > 1 ? $from.node($from.depth - 1) : null;

          // Check all ancestors, not just immediate parent
          let isInsideSpecialNode = false;
          for (let d = $from.depth; d >= 0; d--) {
            const node = $from.node(d);
            const name = node.type.name;
            if (name === "listItem" || name === "taskItem" || name === "codeBlock" ||
                name === "table" || name === "blockquote" || name === "bulletList" ||
                name === "orderedList" || name === "taskList") {
              isInsideSpecialNode = true;
              break;
            }
          }
          if (isInsideSpecialNode) {
            return false; // Let TipTap handle Enter natively (new list item, etc.)
          }

          event.preventDefault();

          const ed = editorInstanceRef.current;
          const from = state.selection.from;
          const docEnd = state.doc.content.size - 1;

          // Get plain text after cursor (for the new block)
          let textAfterCursor = "";
          if (from < docEnd) {
            textAfterCursor = state.doc.textBetween(from, docEnd, "\n", "");
          }

          // Delete text after cursor from the editor
          if (from < docEnd) {
            const tr = state.tr.delete(from, docEnd);
            view.dispatch(tr);
          }

          // Get markdown of remaining content (preserves formatting)
          const markdownBefore = ed?.storage?.markdown?.getMarkdown?.() ?? "";

          // Save current block with before-cursor content
          const savedContent = markdownBefore.trim();
          contentRef.current = savedContent;
          skipSyncRef.current = true;
          onSaveRef.current(savedContent);

          // Create new block with after-cursor text
          // Pass both saved content and after-cursor so PageView can update local state
          onEnterRef.current(textAfterCursor, savedContent);
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
        // Skip if a suggestion popup is open (slash commands, [[ links, etc.)
        if (event.key === "ArrowUp" && onArrowUpRef.current && !document.querySelector('.tippy-box')) {
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
        // Skip if a suggestion popup is open
        if (event.key === "ArrowDown" && onArrowDownRef.current && !document.querySelector('.tippy-box')) {
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

        // URL-to-link paste: if pasting a URL over selected text, wrap as [text](url)
        const urlPattern = /^https?:\/\/\S+$/;
        if (urlPattern.test(text.trim())) {
          const { from, to, empty } = view.state.selection;
          if (!empty) {
            // Has selection — wrap as markdown link [selected text](url)
            const selectedText = view.state.doc.textBetween(from, to);
            event.preventDefault();
            view.dispatch(view.state.tr.insertText(`[${selectedText}](${text.trim()})`, from, to));
            return true;
          }
          // No selection — insert as markdown link, try to auto-title
          // For now, insert as clickable [url](url) — title fetch would be async
          event.preventDefault();
          view.dispatch(view.state.tr.insertText(`[${text.trim()}](${text.trim()})`));
          return true;
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
      // Delay blur save to let slash commands set their flag first.
      // Blur fires on mousedown (before click), but slash command fires on click.
      // 50ms delay ensures the slash command's flag is checked after it's set.
      setTimeout(() => {
        if (slashActiveRef.current) return;
        const markdown = (editor.storage as any).markdown?.getMarkdown() ?? "";
        const normalized = markdown.trim();
        const originalNormalized = contentRef.current.trim();
        if (normalized !== originalNormalized) {
          contentRef.current = normalized;
          skipSyncRef.current = true;
          onSaveRef.current(normalized);
        }
      }, 50);
    },
  // IMPORTANT: empty deps — never recreate the editor. All callbacks use refs.
  // Recreating destroys complex node state (task lists, tables) that can't round-trip through markdown.
  }, []);

  // Keep editorInstanceRef in sync so handleKeyDown can access storage
  useEffect(() => {
    editorInstanceRef.current = editor;
    // Set per-editor slash command callbacks (avoids module-level singleton race)
    if (editor) {
      setSlashCallbacks(
        editor,
        (md: string) => {
          slashActiveRef.current = true;
          onSlashCommandRef.current?.(md);
          setTimeout(() => { slashActiveRef.current = false; }, 100);
        },
        () => {
          slashActiveRef.current = true;
          setTimeout(() => {
            if (editor) {
              const md = (editor.storage as any).markdown?.getMarkdown?.() ?? "";
              contentRef.current = md.trim();
              skipSyncRef.current = true;
              onSaveRef.current(md.trim());
              // Refocus editor after slash command save
              editor.commands.focus();
            }
            slashActiveRef.current = false;
          }, 20);
        },
      );
    }
  }, [editor]);

  // Sync external content changes (e.g. after backend refresh)
  useEffect(() => {
    if (!editor) return;
    // Skip sync if we just saved from this editor (avoids setContent corrupting complex nodes)
    if (skipSyncRef.current) {
      skipSyncRef.current = false;
      return;
    }
    const currentMarkdown = ((editor.storage as any).markdown?.getMarkdown() ?? "").trim();
    if (content.trim() !== currentMarkdown) {
      editor.commands.setContent(content);
    }
  }, [content, editor]);

  return editor;
}
