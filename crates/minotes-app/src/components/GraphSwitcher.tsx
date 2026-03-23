import { useState, useEffect } from "react";
import type { GraphInfo } from "../lib/api";
import * as api from "../lib/api";

interface Props {
  onSwitch: () => void;
}

export default function GraphSwitcher({ onSwitch }: Props) {
  const [graphs, setGraphs] = useState<GraphInfo[]>([]);
  const [currentGraph, setCurrentGraph] = useState("default");
  const [showDropdown, setShowDropdown] = useState(false);
  const [newGraphName, setNewGraphName] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const [gs, current] = await Promise.all([
        api.listGraphs(),
        api.getCurrentGraph(),
      ]);
      setGraphs(gs);
      setCurrentGraph(current);
    } catch (e) {
      console.error("Failed to load graphs:", e);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleSwitch = async (name: string) => {
    if (name === currentGraph) {
      setShowDropdown(false);
      return;
    }
    try {
      setError(null);
      await api.switchGraph(name);
      setCurrentGraph(name);
      setShowDropdown(false);
      onSwitch();
    } catch (e: any) {
      setError(e?.toString() ?? "Switch failed");
    }
  };

  const handleCreate = async () => {
    const trimmed = newGraphName.trim();
    if (!trimmed) return;
    try {
      setError(null);
      await api.createGraph(trimmed);
      setNewGraphName("");
      setShowCreate(false);
      await load();
    } catch (e: any) {
      setError(e?.toString() ?? "Create failed");
    }
  };

  const handleDelete = async (name: string) => {
    if (!confirm(`Delete graph "${name}"? This cannot be undone.`)) return;
    try {
      setError(null);
      await api.deleteGraph(name);
      await load();
    } catch (e: any) {
      setError(e?.toString() ?? "Delete failed");
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="graph-switcher">
      <button
        className="graph-switcher-btn"
        onClick={() => setShowDropdown(!showDropdown)}
        title="Switch graph"
      >
        <span className="graph-switcher-icon">&#9671;</span>
        <span className="graph-switcher-name">{currentGraph}</span>
        <span className="graph-switcher-caret">{showDropdown ? "\u25B4" : "\u25BE"}</span>
      </button>

      {showDropdown && (
        <div className="graph-switcher-dropdown">
          <div className="graph-switcher-header">
            <span>Graphs</span>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => setShowCreate(!showCreate)}
            >
              + New
            </button>
          </div>

          {showCreate && (
            <div className="graph-switcher-create">
              <input
                className="search-input"
                placeholder="Graph name..."
                value={newGraphName}
                onChange={e => setNewGraphName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter") handleCreate();
                  if (e.key === "Escape") setShowCreate(false);
                }}
                autoFocus
              />
            </div>
          )}

          {error && <div className="graph-switcher-error">{error}</div>}

          <div className="graph-switcher-list">
            {graphs.map(g => (
              <div
                key={g.name}
                className={`graph-switcher-item ${g.name === currentGraph ? "active" : ""}`}
                onClick={() => handleSwitch(g.name)}
              >
                <span className="graph-switcher-item-name">
                  {g.name === currentGraph ? "\u25C9" : "\u25CB"} {g.name}
                </span>
                <span className="graph-switcher-item-size">{formatSize(g.size_bytes)}</span>
                {g.name !== currentGraph && (
                  <button
                    className="graph-switcher-item-delete"
                    onClick={e => {
                      e.stopPropagation();
                      handleDelete(g.name);
                    }}
                    title="Delete graph"
                  >
                    x
                  </button>
                )}
              </div>
            ))}
            {graphs.length === 0 && (
              <div className="graph-switcher-empty">No graphs found</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
