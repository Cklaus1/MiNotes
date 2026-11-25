import { useEffect, useState } from "react";
import ImportDialog from "./ImportDialog";
import * as api from "../lib/api";
import { attachmentMarkdown } from "../lib/attachments";
import { OPEN_IMPORT, openImport, setNextImportPick } from "../lib/importPicks";
import { registerTestApi } from "../lib/testApi";
import { showToast } from "../lib/toast";

interface Props {
  onOpenPage: (titleOrId: string) => unknown;
  onRefresh: () => unknown;
}

/**
 * Mount point for Import and attachments: the Import dialog (opened with the
 * `minotes:open-import` event — notebook menu, empty state, Ctrl+Shift+I), and
 * files dropped from the OS onto a block in the desktop app, which are stored
 * as attachments and appended to that block.
 */
export default function ImportMount({ onOpenPage, onRefresh }: Props) {
  const [open, setOpen] = useState<{ kind?: api.ImportSourceKind } | null>(null);

  useEffect(() => {
    const onOpen = (e: Event) => setOpen({ kind: (e as CustomEvent<api.ImportSourceKind | undefined>).detail });
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.key === "I" || e.key === "i")) {
        e.preventDefault();
        setOpen({});
      }
    };
    window.addEventListener(OPEN_IMPORT, onOpen);
    window.addEventListener("keydown", onKey);
    registerTestApi({
      openImport: (kind?: api.ImportSourceKind) => openImport(kind),
      setNextImportPick: (paths: string[] | string | null) => setNextImportPick(paths),
    } as any);
    return () => {
      window.removeEventListener(OPEN_IMPORT, onOpen);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // Desktop: files dropped on a block become attachments in it.
  useEffect(() => {
    if (!api.isTauri) return;
    let unlisten: (() => void) | null = null;
    let dead = false;
    import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview().onDragDropEvent(async (ev) => {
        if (ev.payload.type !== "drop") return;
        const ratio = window.devicePixelRatio || 1;
        const { x, y } = ev.payload.position;
        const el = document.elementFromPoint(x / ratio, y / ratio) as HTMLElement | null;
        const blockEl = el?.closest("[data-block-id]") as HTMLElement | null;
        const blockId = blockEl?.getAttribute("data-block-id");
        if (!blockId) return;
        try {
          const stored = await api.storeDroppedFiles();
          if (!stored.length) return;
          const b = await api.getBlock(blockId);
          if (!b) return;
          const refs = stored.map(attachmentMarkdown).join("\n");
          await api.updateBlock(blockId, b.content.trim() ? `${b.content}\n${refs}` : refs);
          await onRefresh();
          showToast(`Attached ${stored.length} file${stored.length === 1 ? "" : "s"}`);
        } catch (e) {
          showToast(`Couldn't attach the dropped file: ${e}`);
        }
      }),
    ).then((u) => { if (dead) u(); else unlisten = u; }).catch(() => {});
    return () => { dead = true; unlisten?.(); };
  }, [onRefresh]);

  if (!open) return null;
  return <ImportDialog initialKind={open.kind} onClose={() => setOpen(null)} onOpenPage={onOpenPage} onRefresh={onRefresh} />;
}
