import { useEditor } from "@tiptap/react";
import { useRef, useCallback, useEffect } from "react";
import StarterKit from "@tiptap/starter-kit";
import { HardBreak } from "@tiptap/extension-hard-break";
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
import Image from "@tiptap/extension-image";
import { common, createLowlight } from "lowlight";
import { Markdown } from "tiptap-markdown";
import { WikiLinkNode } from "./WikiLinkNode";
import { BlockRefNode } from "./BlockRefNode";
import { TagNode } from "./TagNode";
import { SlashCommands, setSlashCallbacks } from "./slashCommands";
import { PageLinkSuggestion } from "./PageLinkSuggestion";
import { BlockRefSuggestion } from "./BlockRefSuggestion";

const lowlight = createLowlight(common);

/**
 * A line break inside a block is stored as a plain "\n" (blocks are line-oriented:
 * "Line1\nLine2"). Parsing uses `breaks: true` so that newline becomes a hardBreak
 * instead of collapsing to a space; this serializer writes it back as "\n"
 * (tiptap-markdown's default is CommonMark's backslash-newline), so an edited
 * multi-line block round-trips byte-for-byte.
 */
const LineBreak = HardBreak.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any, parent: any, index: number) {
          for (let i = index + 1; i < parent.childCount; i++) {
            if (parent.child(i).type !== node.type) {
              state.write(state.inTable ? "<br>" : "\n");
              return;
            }
          }
        },
        parse: {},
      },
    };
  },
});

interface UseBlockEditorOptions {
  content: string;
  onSave: (markdown: string) => void;
  onPageLinkClick: (title: string, shiftKey?: boolean) => void;
  onBlockRefClick?: (blockId: string) => void;
  onEnter?: (contentAfterCursor: string, savedContent?: string) => void;
  /** Checked BEFORE the editor mutates anything on Enter. Returning false makes the
   *  Enter a no-op (e.g. a previous split is still being persisted). */
  canEnter?: () => boolean;
  onBackspaceAtStart?: (content: string) => void;
  onArrowUp?: () => void;
  onArrowDown?: () => void;
  onToggleTodo?: () => void;
  onPasteMultiline?: (lines: string[]) => void;
  onIndent?: () => void;
  onOutdent?: () => void;
  onSlashCommand?: (newMarkdown: string) => void;
  onTagClick?: (tag: string) => void;
}

export function useBlockEditor({
  content,
  onSave,
  onPageLinkClick,
  onBlockRefClick,
  onEnter,
  canEnter,
  onBackspaceAtStart,
  onArrowUp,
  onArrowDown,
  onToggleTodo,
  onPasteMultiline,
  onIndent,
  onOutdent,
  onSlashCommand,
  onTagClick,
}: UseBlockEditorOptions) {
  const onSaveRef = useRef(onSave);
  // NOT a mirror of the `content` prop — this tracks the last markdown the editor
  // itself produced or applied, so the sync effect below can tell an echo of our own
  // save apart from a genuine external change. Assigning `content` to it on every
  // render (as the callback refs below do) makes the echo check always true and
  // permanently disables setContent: external updates then never reach the DOM.
  const contentRef = useRef(content);
  const onPageLinkClickRef = useRef(onPageLinkClick);
  const onBlockRefClickRef = useRef(onBlockRefClick);
  const onEnterRef = useRef(onEnter);
  const canEnterRef = useRef(canEnter);
  const onBackspaceAtStartRef = useRef(onBackspaceAtStart);
  const onArrowUpRef = useRef(onArrowUp);
  const onArrowDownRef = useRef(onArrowDown);
  const onToggleTodoRef = useRef(onToggleTodo);
  const onPasteMultilineRef = useRef(onPasteMultiline);
  const onIndentRef = useRef(onIndent);
  const onOutdentRef = useRef(onOutdent);
  const onSlashCommandRef = useRef(onSlashCommand);
  const onTagClickRef = useRef(onTagClick);
  const editorInstanceRef = useRef<any>(null);
  const skipSyncRef = useRef(false);
  const slashActiveRef = useRef(false);
  // True only after a real user edit since the last save/external sync. Blur and
  // unmount save ONLY when dirty: merely focusing a block must never rewrite its
  // stored content with the serializer's normalization (`* x` -> `- x`, setext ->
  // ATX, loose lists, entity-escaped HTML...).
  const dirtyRef = useRef(false);
  // Set while we apply external content ourselves, so it never counts as a user edit.
  const applyingExternalRef = useRef(false);
  onSaveRef.current = onSave;
  onPageLinkClickRef.current = onPageLinkClick;
  onBlockRefClickRef.current = onBlockRefClick;
  onEnterRef.current = onEnter;
  canEnterRef.current = canEnter;
  onBackspaceAtStartRef.current = onBackspaceAtStart;
  onArrowUpRef.current = onArrowUp;
  onArrowDownRef.current = onArrowDown;
  onToggleTodoRef.current = onToggleTodo;
  onPasteMultilineRef.current = onPasteMultiline;
  onIndentRef.current = onIndent;
  onOutdentRef.current = onOutdent;
  onSlashCommandRef.current = onSlashCommand;
  onTagClickRef.current = onTagClick;

  // Slash callbacks are set per-editor instance after creation (see useEffect below)

  /** The ONE way to read the editor's current content as markdown (trimmed). */
  const getMarkdown = useCallback((): string => {
    const ed = editorInstanceRef.current;
    if (!ed || ed.isDestroyed) return "";
    return (((ed.storage as any).markdown?.getMarkdown?.() ?? "") as string).trim();
  }, []);

  /** Serialize an arbitrary doc node (e.g. a `doc.cut(...)` half) to markdown. */
  const serializeDoc = (node: any): string => {
    const ed = editorInstanceRef.current;
    const serializer = (ed?.storage as any)?.markdown?.serializer;
    if (!serializer) return node.textContent ?? "";
    // A half with no text and no atoms (links/tags/images) is empty: don't let an
    // empty heading/paragraph shell serialize to a stray "#".
    let hasContent = node.textContent.length > 0;
    if (!hasContent) node.descendants((n: any) => { if (n.isAtom || n.isLeaf && !n.isText) hasContent = true; return !hasContent; });
    if (!hasContent) return "";
    return serializer.serialize(node) as string;
  };

  /** Record a save we performed ourselves: marks it as the last-produced markdown. */
  const commitSave = (markdown: string) => {
    contentRef.current = markdown;
    dirtyRef.current = false;
    skipSyncRef.current = true;
    onSaveRef.current(markdown);
  };

  /**
   * Split the block at the current cursor. Both halves are serialized to markdown so
   * marks (bold/italic/code) and atoms (wiki links, tags, block refs) survive.
   * Shared by the Enter key handler and the test API: one code path.
   * Returns false if the split was rejected (no handler, or an Enter is in flight).
   */
  const splitAtCursor = (view: any): boolean => {
    if (!onEnterRef.current) return false;
    // A rejected Enter must be a no-op. Check the guard BEFORE mutating the doc,
    // otherwise the after-cursor text is deleted and never re-created.
    if (canEnterRef.current && !canEnterRef.current()) return false;
    const { state } = view;
    const from = state.selection.from;
    const docEnd = state.doc.content.size - 1;

    const afterMarkdown = from < docEnd ? serializeDoc(state.doc.cut(from)).trim() : "";
    const savedContent = serializeDoc(state.doc.cut(0, from)).trim();

    // Delete text after cursor from the editor (our own edit; saved right below).
    if (from < docEnd) {
      view.dispatch(state.tr.delete(from, docEnd));
    }

    commitSave(savedContent);
    // Pass both saved content and after-cursor so PageView can update local state
    onEnterRef.current(afterMarkdown, savedContent);
    return true;
  };

  /** Merge this block into the previous one (Backspace at start). */
  const mergeWithPrevious = (): boolean => {
    if (!onBackspaceAtStartRef.current) return false;
    onBackspaceAtStartRef.current(getMarkdown());
    return true;
  };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4] },
        codeBlock: false, // replaced by CodeBlockLowlight
        hardBreak: false, // replaced by LineBreak (plain-newline markdown)
      }),
      LineBreak,
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
      Image.configure({ inline: false, allowBase64: true }),
      Typography,
      Placeholder.configure({
        placeholder: ({ editor }) => editor.isFocused ? "Type '/' for commands" : "",
        showOnlyWhenEditable: true,
        showOnlyCurrent: true,
      }),
      Markdown.configure({
        html: false,
        breaks: true,
        transformPastedText: true,
        transformCopiedText: true,
      }),
      WikiLinkNode.configure({ onPageLinkClick: (title: string, shiftKey?: boolean) => onPageLinkClickRef.current(title, shiftKey) }),
      BlockRefNode.configure({ onBlockRefClick: (blockId: string) => onBlockRefClickRef.current?.(blockId) }),
      TagNode.configure({ onTagClick: (tag: string) => onTagClickRef.current?.(tag) }),
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
          // Unindent block (same as Shift+Tab), or do nothing if already at root
          if (onOutdentRef.current) {
            event.preventDefault();
            onOutdentRef.current();
          }
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
          splitAtCursor(view);
          return true;
        }

        // Backspace at position 0 — merge with previous block
        if (event.key === "Backspace" && onBackspaceAtStartRef.current) {
          const { state } = view;
          const { from, empty } = state.selection;
          if (empty && from <= 1) {
            event.preventDefault();
            // Previously read `__tiptapEditor` off the DOM (never set in TipTap v3) and
            // fell back to plain textContent, dropping links/tags/formatting.
            mergeWithPrevious();
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
        // Image paste: convert to data URL and insert as image node
        const files = event.clipboardData?.files;
        if (files && files.length > 0) {
          const file = files[0];
          if (file.type.startsWith('image/')) {
            event.preventDefault();
            const reader = new FileReader();
            reader.onload = () => {
              const src = reader.result as string;
              const ed = editorInstanceRef.current;
              if (ed) {
                ed.chain().focus().setImage({ src }).run();
                // Save after inserting image
                setTimeout(() => {
                  commitSave(getMarkdown());
                }, 50);
              }
            };
            reader.readAsDataURL(file);
            return true;
          }
        }

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
          // No selection on empty/near-empty block — create link preview card
          const docText = view.state.doc.textContent.trim();
          if (docText.length === 0 && onSlashCommandRef.current) {
            event.preventDefault();
            onSlashCommandRef.current(`{{link-preview:${text.trim()}}}`);
            return true;
          }
          // Non-empty block — insert as markdown link
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
    onUpdate({ transaction }) {
      // Only genuine document edits count, never our own external-sync setContent.
      if (transaction.docChanged && !applyingExternalRef.current && !transaction.getMeta("preventUpdate")) {
        dirtyRef.current = true;
      }
    },
    onBlur() {
      // Delay blur save to let slash commands set their flag first.
      // Blur fires on mousedown (before click), but slash command fires on click.
      // 50ms delay ensures the slash command's flag is checked after it's set.
      setTimeout(() => {
        if (slashActiveRef.current) return;
        // Focus -> blur without an edit must leave stored content byte-identical.
        if (!dirtyRef.current) return;
        const normalized = getMarkdown();
        if (normalized !== contentRef.current.trim()) {
          commitSave(normalized);
        } else {
          dirtyRef.current = false;
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
              commitSave(getMarkdown());
              // Refocus editor after slash command save
              editor.commands.focus();
            }
            slashActiveRef.current = false;
          }, 20);
        },
        // Template callback: insert remaining lines as new blocks
        (lines: string[]) => {
          onPasteMultilineRef.current?.(lines);
        },
      );
    }
  }, [editor]);

  // Sync external content changes (e.g. after backend refresh)
  useEffect(() => {
    if (!editor) return;
    const incoming = content.trim();
    const currentMarkdown = ((editor.storage as any).markdown?.getMarkdown() ?? "").trim();
    if (incoming === currentMarkdown) {
      skipSyncRef.current = false;
      return;
    }
    // Bug #21: skip echoes of our own save in a VALUE-based way, not via a one-shot
    // boolean. If `content` changed twice before this effect ran, a single boolean
    // would be cleared by the first run and the second (possibly stale) change would
    // call setContent and wipe in-progress complex-node edits. Comparing against the
    // last-saved value (contentRef) catches the echo regardless of timing.
    if (skipSyncRef.current || incoming === contentRef.current.trim()) {
      skipSyncRef.current = false;
      contentRef.current = incoming;
      return;
    }
    applyingExternalRef.current = true;
    try {
      editor.commands.setContent(content, { emitUpdate: false });
    } finally {
      applyingExternalRef.current = false;
    }
    contentRef.current = incoming;
    dirtyRef.current = false;
  }, [content, editor]);

  // Bug #5: flush unsaved edits on unmount. Navigation swaps the active page and tears
  // the editor down synchronously, before the 50ms blur-save timer can fire — silently
  // dropping the user's last keystrokes. Save on cleanup if the content changed.
  useEffect(() => {
    return () => {
      const ed = editorInstanceRef.current;
      if (!ed || !dirtyRef.current) return;
      try {
        const markdown = ((ed.storage as any).markdown?.getMarkdown() ?? "").trim();
        if (markdown !== contentRef.current.trim()) {
          contentRef.current = markdown;
          onSaveRef.current(markdown);
        }
      } catch {
        // editor already destroyed — nothing we can do
      }
    };
  }, []);

  return {
    editor,
    getMarkdown,
    /** True when the user edited since the last save / external sync. */
    isDirty: (): boolean => dirtyRef.current,
    /** Split at the editor's current selection: same path as the Enter key. */
    splitAtCursor: (): boolean => {
      const ed = editorInstanceRef.current;
      return ed && !ed.isDestroyed ? splitAtCursor(ed.view) : false;
    },
    /** Merge into the previous block: same path as Backspace at start. */
    mergeWithPrevious,
  };
}
