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
import { SlashCommands } from "./slashCommands";

const lowlight = createLowlight(common);

interface UseBlockEditorOptions {
  content: string;
  onSave: (markdown: string) => void;
  onPageLinkClick: (title: string) => void;
}

export function useBlockEditor({ content, onSave, onPageLinkClick }: UseBlockEditorOptions) {
  const onSaveRef = useRef(onSave);
  const contentRef = useRef(content);
  onSaveRef.current = onSave;
  contentRef.current = content;

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
      SlashCommands,
    ],
    content,
    editorProps: {
      attributes: {
        class: "block-editor-prosemirror",
      },
      handleKeyDown(_view, event) {
        if (event.key === "Escape") {
          _view.dom.blur();
          return true;
        }
        return false;
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
  }, [onPageLinkClick]);

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
