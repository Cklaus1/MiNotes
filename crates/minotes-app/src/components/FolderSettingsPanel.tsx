import { useState, useEffect, useRef, useCallback } from "react";
import * as api from "../lib/api";
import type { FolderTree } from "../lib/api";
import { showUndoToast } from "../lib/toast";

interface Props {
  folderId: string;
  onClose: () => void;
  onRefresh: () => void;
}

const FOLDER_ICONS = ["\uD83D\uDCC1", "\uD83D\uDCC2", "\uD83D\uDCBC", "\uD83C\uDFE0", "\u2B50", "\uD83D\uDE80", "\uD83D\uDCA1", "\uD83C\uDFAF", "\uD83D\uDCD6", "\uD83D\uDD12"];
const FOLDER_COLORS = ["#cdd6f4", "#89b4fa", "#a6e3a1", "#f9e2af", "#fab387", "#f38ba8", "#cba6f7", "#94e2d5"];

export default function FolderSettingsPanel({ folderId, onClose, onRefresh }: Props) {
  const [folder, setFolder] = useState<FolderTree | null>(null);
  const [name, setName] = useState("");
  const [pageCount, setPageCount] = useState(0);
  const [closing, setClosing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef("");
  const folderRef = useRef<FolderTree | null>(null);

  const softClose = useCallback(async () => {
    // Save any pending name change before closing
    const trimmed = nameRef.current.trim();
    const currentFolder = folderRef.current;
    if (currentFolder && trimmed && trimmed !== currentFolder.name) {
      await api.renameFolder(folderId, trimmed).catch(() => {});
    }
    // Always refresh sidebar on close (icon/color/name might have changed)
    onRefresh();
    window.dispatchEvent(new Event("minotes-sidebar-refresh"));
    setClosing(true);
    setTimeout(onClose, 200);
  }, [onClose, folderId, onRefresh]);

  // Close when clicking outside the panel (on canvas/main content)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        // Don't close if clicking inside sidebar or another portal (context menu)
        const target = e.target as HTMLElement;
        if (target.closest(".sidebar") || target.closest(".sidebar-context-menu")) return;
        softClose();
      }
    };
    // Delay slightly to avoid the opening click
    const timer = setTimeout(() => window.addEventListener("mousedown", handler), 50);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousedown", handler);
    };
  }, [softClose]);

  useEffect(() => {
    // Load folder details
    api.getFolderTree().then(tree => {
      const find = (folders: any[]): any => {
        for (const f of folders) {
          if (f.id === folderId) return f;
          const child = find(f.children ?? []);
          if (child) return child;
        }
        return null;
      };
      const found = find(tree.folders ?? []);
      if (found) {
        setFolder(found);
        setName(found.name);
        setPageCount(found.pages?.length ?? 0);
      }
    }).catch(() => {});
  }, [folderId]);

  // Keep refs in sync for softClose to read
  nameRef.current = name;
  folderRef.current = folder;

  if (!folder) return null;

  const handleRename = async () => {
    if (closing) return; // softClose handles save
    const trimmed = name.trim();
    if (trimmed && trimmed !== folder.name) {
      await api.renameFolder(folderId, trimmed);
      setFolder({ ...folder, name: trimmed });
      folderRef.current = { ...folder, name: trimmed };
      refreshSidebar();
    }
  };

  const refreshSidebar = () => {
    refreshSidebar();
    window.dispatchEvent(new Event("minotes-sidebar-refresh"));
  };

  const handleIconChange = async (newIcon: string) => {
    const updated = { ...folder, icon: newIcon };
    setFolder(updated);
    folderRef.current = updated;
    await api.updateFolderAppearance(folderId, newIcon, folder.color ?? undefined);
    refreshSidebar();
  };

  const handleTrash = async () => {
    const count = await api.trashFolder(folderId);
    onClose();
    refreshSidebar();
    showUndoToast(`"${folder.name}" deleted (${count} pages)`, async () => {
      await api.restoreFromTrash(folderId, "folder");
      refreshSidebar();
    });
  };

  return (
    <div ref={panelRef} className={`folder-settings-panel ${closing ? "folder-settings-closing" : ""}`}>
      <div className="folder-settings-header">
        <span className="folder-settings-title">Project Settings</span>
        <button className="settings-close-btn" onClick={softClose}>&times;</button>
      </div>

      <div className="folder-settings-body">
        {/* Name */}
        <div className="folder-settings-section">
          <input
            className="folder-settings-name-input"
            value={name}
            onChange={e => setName(e.target.value)}
            onBlur={handleRename}
            onKeyDown={e => { if (e.key === "Enter") handleRename(); }}
          />
        </div>

        <div className="folder-settings-sep" />

        {/* Appearance */}
        <div className="folder-settings-section">
          <div className="folder-settings-section-title">Appearance</div>
          <div className="folder-settings-row">
            <span className="folder-settings-label">Icon</span>
            <div className="folder-settings-icon-grid">
              {FOLDER_ICONS.map(icon => (
                <button
                  key={icon}
                  className={`folder-settings-icon-btn ${folder.icon === icon ? "active" : ""}`}
                  onClick={() => handleIconChange(icon)}
                >
                  {icon}
                </button>
              ))}
            </div>
          </div>
          <div className="folder-settings-row">
            <span className="folder-settings-label">Color</span>
            <div className="folder-settings-color-grid">
              {FOLDER_COLORS.map(color => (
                <button
                  key={color}
                  className={`folder-settings-color-btn ${folder.color === color ? "active" : ""}`}
                  style={{ background: color }}
                  onClick={async () => {
                    const updated = { ...folder, color };
                    setFolder(updated);
                    folderRef.current = updated;
                    await api.updateFolderAppearance(folderId, folder.icon ?? undefined, color);
                    refreshSidebar();
                  }}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="folder-settings-sep" />

        {/* Security */}
        <div className="folder-settings-section">
          <div className="folder-settings-section-title">Security</div>
          <div className="folder-settings-row">
            <span className="folder-settings-label">Lock folder</span>
            <span className="folder-settings-value-muted">Coming soon</span>
          </div>
        </div>

        <div className="folder-settings-sep" />

        {/* Advanced */}
        <div className="folder-settings-section">
          <div className="folder-settings-section-title">Advanced</div>
          <div className="folder-settings-row">
            <span className="folder-settings-label">Encrypt folder</span>
            <span className="folder-settings-value-muted">Coming soon</span>
          </div>
        </div>

        <div className="folder-settings-sep" />

        {/* Info */}
        <div className="folder-settings-section">
          <div className="folder-settings-section-title">Info</div>
          <div className="folder-settings-info">{pageCount} pages</div>
        </div>

        <div className="folder-settings-sep" />

        {/* Danger Zone */}
        <div className="folder-settings-section">
          <div className="folder-settings-section-title danger">Danger Zone</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-sm" onClick={async () => {
              const count = await api.archiveFolder(folderId);
              refreshSidebar();
              softClose();
              showUndoToast(`"${name}" archived (${count} pages)`, async () => {
                await api.unarchiveFolder(folderId);
                refreshSidebar();
              });
            }}>
              Archive
            </button>
            <button className="btn btn-sm btn-danger" onClick={handleTrash}>
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
