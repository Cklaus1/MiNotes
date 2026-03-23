import { useState, useEffect, useCallback } from "react";
import type { CssSnippet } from "../lib/api";
import * as api from "../lib/api";
import { reloadSnippets } from "../lib/cssLoader";

interface Props {
  open: boolean;
  onClose: () => void;
}

type EditorMode = "add-custom" | "add-obsidian" | "edit" | null;

export default function CssSnippetManager({ open, onClose }: Props) {
  const [snippets, setSnippets] = useState<CssSnippet[]>([]);
  const [mode, setMode] = useState<EditorMode>(null);
  const [editName, setEditName] = useState("");
  const [editCss, setEditCss] = useState("");
  const [editOriginalName, setEditOriginalName] = useState("");
  const [error, setError] = useState("");

  const loadSnippets = useCallback(async () => {
    try {
      const list = await api.listCssSnippets();
      setSnippets(list);
    } catch (e) {
      console.error("Failed to load CSS snippets:", e);
    }
  }, []);

  useEffect(() => {
    if (open) {
      loadSnippets();
      setMode(null);
      setError("");
    }
  }, [open, loadSnippets]);

  const handleAdd = async () => {
    if (!editName.trim() || !editCss.trim()) {
      setError("Name and CSS are required.");
      return;
    }
    try {
      const source = mode === "add-obsidian" ? "obsidian" : "custom";
      await api.addCssSnippet(editName.trim(), editCss.trim(), source);
      await reloadSnippets();
      await loadSnippets();
      setMode(null);
      setEditName("");
      setEditCss("");
      setError("");
    } catch (e: any) {
      setError(String(e));
    }
  };

  const handleUpdate = async () => {
    if (!editCss.trim()) {
      setError("CSS content is required.");
      return;
    }
    try {
      await api.addCssSnippet(editOriginalName, editCss.trim());
      // addCssSnippet would fail on duplicate, so we use a workaround:
      // Actually we need to call a different approach. Let's delete and re-add? No, we have no update command.
      // But we don't have update_snippet_css exposed. Let's just use the toggle pattern.
      // Actually, looking at the backend, we have update_snippet_css but it's not exposed as a Tauri command.
      // We'll work around by deleting and re-adding.
    } catch {
      // Expected — let's do delete + re-add
    }
    try {
      // Find the snippet to preserve its source
      const snippet = snippets.find(s => s.name === editOriginalName);
      const source = snippet?.source ?? "custom";
      await api.deleteCssSnippet(editOriginalName);
      await api.addCssSnippet(editOriginalName, editCss.trim(), source);
      // If it was enabled before, it stays enabled (default is enabled)
      if (snippet && !snippet.enabled) {
        await api.toggleCssSnippet(editOriginalName);
      }
      await reloadSnippets();
      await loadSnippets();
      setMode(null);
      setEditCss("");
      setEditOriginalName("");
      setError("");
    } catch (e: any) {
      setError(String(e));
    }
  };

  const handleToggle = async (name: string) => {
    try {
      await api.toggleCssSnippet(name);
      await reloadSnippets();
      await loadSnippets();
    } catch (e) {
      console.error("Toggle failed:", e);
    }
  };

  const handleDelete = async (name: string) => {
    if (!confirm(`Delete snippet "${name}"?`)) return;
    try {
      await api.deleteCssSnippet(name);
      await reloadSnippets();
      await loadSnippets();
    } catch (e) {
      console.error("Delete failed:", e);
    }
  };

  const startEdit = (snippet: CssSnippet) => {
    setMode("edit");
    setEditOriginalName(snippet.name);
    setEditName(snippet.name);
    setEditCss(snippet.css);
    setError("");
  };

  if (!open) return null;

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="command-palette" onClick={e => e.stopPropagation()} style={{ maxWidth: 700, maxHeight: "80vh" }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ fontSize: 16, fontWeight: 600 }}>CSS Snippets</h2>
          <button className="btn btn-sm" onClick={onClose}>Close</button>
        </div>

        {mode === null ? (
          <div style={{ padding: 16 }}>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <button className="btn btn-primary" onClick={() => { setMode("add-custom"); setEditName(""); setEditCss(""); setError(""); }}>
                + Add Custom CSS
              </button>
              <button className="btn" onClick={() => { setMode("add-obsidian"); setEditName(""); setEditCss(""); setError(""); }}>
                + Add Obsidian Snippet
              </button>
            </div>

            {snippets.length === 0 ? (
              <div style={{ color: "var(--text-muted)", textAlign: "center", padding: 32 }}>
                No CSS snippets yet. Add one to customize your MiNotes appearance.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {snippets.map(s => (
                  <div
                    key={s.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "10px 12px",
                      background: "var(--bg-surface)",
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                    }}
                  >
                    <button
                      className="btn btn-sm"
                      onClick={() => handleToggle(s.name)}
                      style={{
                        minWidth: 32,
                        background: s.enabled ? "var(--success)" : "var(--bg-secondary)",
                        color: s.enabled ? "#000" : "var(--text-muted)",
                      }}
                      title={s.enabled ? "Enabled (click to disable)" : "Disabled (click to enable)"}
                    >
                      {s.enabled ? "ON" : "OFF"}
                    </button>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 500 }}>{s.name}</div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        {s.source === "obsidian" ? "Obsidian" : "Custom"} &middot; {s.css.length} chars
                      </div>
                    </div>
                    <button className="btn btn-sm" onClick={() => startEdit(s)} title="Edit CSS">
                      Edit
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={() => handleDelete(s.name)}
                      style={{ color: "var(--danger)" }}
                      title="Delete snippet"
                    >
                      Del
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600 }}>
              {mode === "edit" ? `Edit: ${editOriginalName}` : mode === "add-obsidian" ? "Add Obsidian Snippet" : "Add Custom CSS"}
            </h3>

            {mode !== "edit" && (
              <input
                className="search-input"
                placeholder="Snippet name..."
                value={editName}
                onChange={e => setEditName(e.target.value)}
                autoFocus
              />
            )}

            <textarea
              style={{
                width: "100%",
                minHeight: 200,
                padding: 12,
                fontFamily: "monospace",
                fontSize: 13,
                background: "var(--bg-secondary)",
                color: "var(--text-primary)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                resize: "vertical",
              }}
              placeholder="Paste CSS here..."
              value={editCss}
              onChange={e => setEditCss(e.target.value)}
              autoFocus={mode === "edit"}
            />

            {error && (
              <div style={{ color: "var(--danger)", fontSize: 12 }}>{error}</div>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-primary" onClick={mode === "edit" ? handleUpdate : handleAdd}>
                {mode === "edit" ? "Save Changes" : "Add Snippet"}
              </button>
              <button className="btn" onClick={() => setMode(null)}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
