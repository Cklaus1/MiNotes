import { useEditor } from "@tiptap/react";
import { useRef, useCallback, useEffect } from "react";
import { isInTable, moveToCellBelow } from "./tables";
import { setSlashCallbacks, slashPluginKey } from "./slashCommands";
import { pageLinkPluginKey } from "./PageLinkSuggestion";
import { blockRefPluginKey } from "./BlockRefSuggestion";
import { createBlockExtensions } from "./blockExtensions";
// ── Import / attachments ──
import { attachmentHash, encodeName, isImage, openAttachment, storeFile } from "../lib/attachments";
import { showToast } from "../lib/toast";
// ── End import ──


/** True while a suggestion menu (/, [[, (( ) is open in this editor state. */
function suggestionMenuOpen(state: any): boolean {
  return [slashPluginKey, pageLinkPluginKey, blockRefPluginKey]
    .some((key) => !!(key.getState(state) as any)?.active);
}

/** Tab, including WebKitGTK's Shift+Tab (GDK ISO_Left_Tab) which may not report key "Tab". */
function isTabKey(event: KeyboardEvent): boolean {
  return event.key === "Tab" || event.key === "ISO_Left_Tab" || event.code === "Tab" || event.keyCode === 9;
}

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
  /** Escape (no menu open): leave editing. */
  onEscape?: () => void;
  onSlashCommand?: (newMarkdown: string) => void;
  onTagClick?: (tag: string) => void;
  /** `/flashcard`: make this block a flashcard. */
  onMakeFlashcard?: () => void;
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
  onEscape,
  onSlashCommand,
  onTagClick,
  onMakeFlashcard,
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
  const onEscapeRef = useRef(onEscape);
  const onSlashCommandRef = useRef(onSlashCommand);
  const onTagClickRef = useRef(onTagClick);
  const onMakeFlashcardRef = useRef(onMakeFlashcard);
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
  onEscapeRef.current = onEscape;
  onSlashCommandRef.current = onSlashCommand;
  onTagClickRef.current = onTagClick;
  onMakeFlashcardRef.current = onMakeFlashcard;

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

  /** Persist the editor's current content now (e.g. after a table structure change). */
  const saveNow = () => {
    const ed = editorInstanceRef.current;
    if (!ed || ed.isDestroyed) return;
    const md = getMarkdown();
    if (md !== contentRef.current.trim()) commitSave(md);
    else dirtyRef.current = false;
  };

  /** Merge this block into the previous one (Backspace at start). */
  const mergeWithPrevious = (): boolean => {
    if (!onBackspaceAtStartRef.current) return false;
    onBackspaceAtStartRef.current(getMarkdown());
    return true;
  };

  const editor = useEditor({
    extensions: createBlockExtensions({
      onPageLinkClick: (title: string, shiftKey?: boolean) => onPageLinkClickRef.current(title, shiftKey),
      onBlockRefClick: (blockId: string) => onBlockRefClickRef.current?.(blockId),
      onTagClick: (tag: string) => onTagClickRef.current?.(tag),
    }),
    content,
    editorProps: {
      attributes: {
        class: "block-editor-prosemirror",
      },
      handleKeyDown(view, event) {
        if (event.key === "Escape" || event.key === "Esc") {
          // An open /, [[ or (( menu gets the Escape: the suggestion plugin closes it
          // and the cursor stays where it was. (These editorProps run BEFORE plugin
          // key handlers, so swallowing Escape here kept the menus open.)
          if (suggestionMenuOpen(view.state)) return false;
          // Otherwise Escape leaves editing ("Close"); outdenting is Shift+Tab's job.
          if (onEscapeRef.current) {
            event.preventDefault();
            onEscapeRef.current();
            return true;
          }
          return false;
        }

        // Ctrl+Enter — cycle TODO state
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && onToggleTodoRef.current) {
          event.preventDefault();
          onToggleTodoRef.current();
          return true;
        }

        // Table cells: Tab / Shift+Tab move between cells (Tab in the last cell adds a
        // row), Enter moves to the cell below (adding a row at the bottom). Enter must
        // never split a cell into two paragraphs: that isn't expressible as a pipe table.
        if (isInTable(view.state) && !document.querySelector('.tippy-box') &&
            (isTabKey(event) || (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey))) {
          const ed = editorInstanceRef.current;
          if (!ed) return false;
          event.preventDefault();
          if (event.key === "Enter") {
            moveToCellBelow(ed);
          } else if (event.shiftKey) {
            ed.commands.goToPreviousCell();
          } else if (!ed.commands.goToNextCell()) {
            ed.chain().addRowAfter().goToNextCell().run();
          }
          // A row added at the end is a structural change: persist it now.
          if (dirtyRef.current) saveNow();
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

        // Tab / Shift+Tab — indent / outdent the block. Inside a list in the block,
        // first try to sink/lift the list item; when that isn't possible (first item,
        // top level) fall back to the block. Tab must never fall through to the
        // browser, whose default moves focus to another block.
        if (isTabKey(event) && !document.querySelector('.tippy-box')) {
          const ed = editorInstanceRef.current;
          const { $from } = view.state.selection;
          // Innermost list item around the cursor, and whether it is nested in another.
          let itemType: string | null = null;
          let itemDepth = -1;
          let nested = false;
          for (let d = $from.depth; d > 0; d--) {
            const name = $from.node(d).type.name;
            if (name !== "listItem" && name !== "taskItem") continue;
            if (itemType === null) { itemType = name; itemDepth = d; } else { nested = true; break; }
          }
          event.preventDefault();
          if (itemType && ed) {
            // Sink needs a previous item to nest under; lift only un-nests (lifting a
            // top-level item would turn "- [ ] task" into plain text instead of
            // outdenting the block).
            const hasPrevItem = $from.index(itemDepth - 1) > 0;
            const handled = event.shiftKey
              ? nested && ed.commands.liftListItem(itemType)
              : hasPrevItem && ed.commands.sinkListItem(itemType);
            if (handled) return true;
          }
          if (event.shiftKey) onOutdentRef.current?.();
          else onIndentRef.current?.();
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
      // ── Import / attachments: a link to a stored file opens it with the OS ──
      handleClick(_view, _pos, event) {
        const a = (event.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
        const hash = attachmentHash(a?.getAttribute("href"));
        if (!hash) return false;
        event.preventDefault();
        openAttachment(hash).catch((e) => showToast(`Couldn't open the file: ${e}`));
        return true;
      },
      handlePaste(view, event) {
        // A pasted image or file is stored as an attachment (in the notebook,
        // by content hash) and referenced from the block — not inlined as data.
        const files = event.clipboardData?.files;
        if (files && files.length > 0) {
          const list = Array.from(files);
          event.preventDefault();
          (async () => {
            for (const file of list) {
              try {
                const att = await storeFile(file);
                const ed = editorInstanceRef.current;
                if (!ed || ed.isDestroyed) return;
                const ref = `attachment:${att.hash}/${encodeName(att.name)}`;
                if (isImage(att)) {
                  ed.chain().focus().setImage({ src: ref, alt: att.name }).run();
                } else {
                  ed.chain().focus().insertContent({ type: "text", text: att.name, marks: [{ type: "link", attrs: { href: ref } }] }).run();
                }
              } catch (e) {
                showToast(`Couldn't attach ${file.name || "the file"}: ${e}`);
              }
            }
            setTimeout(() => commitSave(getMarkdown()), 50);
          })();
          return true;
        }
        void view;
        // ── End import ──

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
        // Unmounted meanwhile (the block went back to static rendering): the unmount
        // flush already saved; a destroyed editor would read as "" and wipe the block.
        const ed = editorInstanceRef.current;
        if (!ed || ed.isDestroyed) return;
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
        () => onMakeFlashcardRef.current?.(),
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
        dirtyRef.current = false;
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
    /** Save the current content immediately (structural edits that shouldn't wait for blur). */
    saveNow,
  };
}
