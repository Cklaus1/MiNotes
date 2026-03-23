import { useEffect, useState, lazy, Suspense } from "react";
import { EditorContent } from "@tiptap/react";
import type { Block, Property } from "../lib/api";
import * as api from "../lib/api";
import { useBlockEditor } from "../editor";
import { getSettings } from "../lib/settings";
import "../editor/editor.css";

// Lazy-load CM6 editor — only downloaded when obsidianEditorEnabled
const CM6BlockEditor = lazy(() => import("../editor/CM6BlockEditor"));

interface Props {
  block: Block;
  onUpdate: (id: string, content: string) => void;
  onDelete: (id: string) => void;
  onPageLinkClick: (title: string) => void;
}

export default function BlockItem({ block, onUpdate, onDelete, onPageLinkClick }: Props) {
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

  const tiptapEditor = useBlockEditor({
    content: block.content,
    onSave: (markdown) => {
      if (markdown !== block.content.trim()) {
        onUpdate(block.id, markdown);
      }
    },
    onPageLinkClick,
  });

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

  return (
    <div className="block">
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
    </div>
  );
}
