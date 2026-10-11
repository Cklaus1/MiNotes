import { useCallback, useEffect, useState } from "react";
import AskPanel from "./AskPanel";
import AiSettings from "./AiSettings";
import { registerTestApi } from "../lib/testApi";
import "./ai.css";

interface Props {
  activePageId: string | null;
  onOpenPage: (titleOrId: string) => unknown;
}

/**
 * Mount point for the AI platform UI: the Ask panel (Ctrl+Shift+A), AI
 * settings, and a small launcher. Other code can open them with
 * `window.dispatchEvent(new CustomEvent("minotes:open-ai", { detail: "ask" | "settings" }))`.
 */
export default function AiMount({ activePageId, onOpenPage }: Props) {
  const [askOpen, setAskOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [statusKey, setStatusKey] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.key === "A" || e.key === "a")) {
        e.preventDefault();
        setAskOpen(v => !v);
      }
    };
    const onOpen = (e: Event) => {
      const what = (e as CustomEvent<string>).detail;
      if (what === "settings") setSettingsOpen(true);
      else setAskOpen(true);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("minotes:open-ai", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("minotes:open-ai", onOpen);
    };
  }, []);

  useEffect(() => {
    registerTestApi({
      openAsk: () => { setAskOpen(true); return true; },
      openAiSettings: () => { setSettingsOpen(true); return true; },
    } as any);
  }, []);

  const openBlock = useCallback(async (pageId: string, blockId: string) => {
    await onOpenPage(pageId);
    // Wait for the page to render, then bring the cited block into view.
    const started = Date.now();
    const tick = () => {
      const el = document.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("ai-cite-flash");
        setTimeout(() => el.classList.remove("ai-cite-flash"), 1800);
      } else if (Date.now() - started < 3000) {
        setTimeout(tick, 80);
      }
    };
    tick();
  }, [onOpenPage]);

  return (
    <>
      {!askOpen && (
        <button className="ai-launcher" onClick={() => setAskOpen(true)} title="Ask your notes (Ctrl+Shift+A)" data-testid="ai-launcher">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M8 1.8l1.5 3.9 3.9 1.5-3.9 1.5L8 12.6 6.5 8.7 2.6 7.2l3.9-1.5z" strokeLinejoin="round" />
          </svg>
          Ask
        </button>
      )}
      <AskPanel
        open={askOpen}
        onClose={() => setAskOpen(false)}
        activePageId={activePageId}
        onOpenBlock={openBlock}
        onOpenSettings={() => setSettingsOpen(true)}
        statusKey={statusKey}
      />
      <AiSettings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={() => setStatusKey(k => k + 1)}
      />
    </>
  );
}
