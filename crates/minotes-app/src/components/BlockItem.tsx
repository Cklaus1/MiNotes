import { useEffect } from "react";
import { EditorContent } from "@tiptap/react";
import type { Block } from "../lib/api";
import { useBlockEditor } from "../editor";
import "../editor/editor.css";

interface Props {
  block: Block;
  onUpdate: (id: string, content: string) => void;
  onDelete: (id: string) => void;
  onPageLinkClick: (title: string) => void;
}

export default function BlockItem({ block, onUpdate, onDelete, onPageLinkClick }: Props) {
  const editor = useBlockEditor({
    content: block.content,
    onSave: (markdown) => {
      if (markdown !== block.content.trim()) {
        onUpdate(block.id, markdown);
      }
    },
    onPageLinkClick,
  });

  // Sync external content changes (e.g., after backend refresh creates new links)
  useEffect(() => {
    if (!editor) return;
    const currentMarkdown = ((editor.storage as any).markdown?.getMarkdown() ?? "").trim();
    if (block.content.trim() !== currentMarkdown) {
      editor.commands.setContent(block.content);
    }
  }, [block.content, editor]);

  return (
    <div className="block">
      <EditorContent editor={editor} className="block-content" />
    </div>
  );
}
