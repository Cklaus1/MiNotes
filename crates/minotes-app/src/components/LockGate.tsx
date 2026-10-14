import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as api from "../lib/api";
import { ASK_PASSPHRASE, LOCK_CHANGED, lockNow, type PassphraseRequest } from "../lib/encryption";
import { setOpenNotebook } from "../lib/webviewState";
import { getSettings } from "../lib/settings";
import { showToast } from "../lib/toast";
import { errorMessage } from "../lib/errors";
import { PassphrasePrompt, UnlockScreen } from "./EncryptionDialogs";

/** How often the auto-lock check runs, and the clock jump that means the
 *  computer slept (Tauri reports no sleep event — PRD-encryption §4.4). */
const TICK_MS = 15_000;
const SLEEP_GAP_MS = 60_000;

/**
 * Wraps the whole app. While the open notebook is encrypted and locked it shows
 * only the unlock screen — the app (every view and its state) is unmounted, so
 * no page content stays in the window. It also runs auto-lock (idle timer and
 * sleep detection), Ctrl+Shift+L, and hosts the in-app passphrase prompt.
 */
export default function LockGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<api.NotebookSession | null>(null);
  const [known, setKnown] = useState(false);
  const [prompt, setPrompt] = useState<PassphraseRequest | null>(null);
  const lastInput = useRef(Date.now());

  const apply = useCallback(async (s: api.NotebookSession | null) => {
    await setOpenNotebook(s);
    setSession(s);
    setKnown(true);
  }, []);

  const reload = useCallback(async () => {
    try {
      await apply(await api.getNotebookSession());
    } catch {
      setKnown(true);
    }
  }, [apply]);

  useEffect(() => {
    reload();
    const onChange = (e: Event) => {
      const s = (e as CustomEvent<api.NotebookSession | null>).detail;
      if (s) apply(s); else reload();
    };
    const onLockedError = () => { reload(); };
    const onAsk = (e: Event) => setPrompt((e as CustomEvent<PassphraseRequest>).detail);
    window.addEventListener(LOCK_CHANGED, onChange);
    window.addEventListener(api.NOTEBOOK_LOCKED_EVENT, onLockedError);
    window.addEventListener(ASK_PASSPHRASE, onAsk);
    return () => {
      window.removeEventListener(LOCK_CHANGED, onChange);
      window.removeEventListener(api.NOTEBOOK_LOCKED_EVENT, onLockedError);
      window.removeEventListener(ASK_PASSPHRASE, onAsk);
    };
  }, [apply, reload]);

  const unlockedEncrypted = !!session?.encrypted && !session.locked;

  const doLock = useCallback(() => {
    lockNow().catch(e => showToast(`Couldn't lock: ${errorMessage(e)}`));
  }, []);

  // Ctrl+Shift+L: lock now.
  useEffect(() => {
    if (!unlockedEncrypted) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        e.stopPropagation();
        doLock();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [unlockedEncrypted, doLock]);

  // Auto-lock: after N idle minutes, and when the clock jumped (the computer slept).
  useEffect(() => {
    if (!unlockedEncrypted) return;
    lastInput.current = Date.now();
    const touch = () => { lastInput.current = Date.now(); };
    const events = ["keydown", "mousedown", "mousemove", "wheel", "touchstart"] as const;
    events.forEach(ev => window.addEventListener(ev, touch, { passive: true, capture: true }));
    let lastTick = Date.now();
    const timer = window.setInterval(() => {
      const now = Date.now();
      const slept = now - lastTick > SLEEP_GAP_MS;
      lastTick = now;
      const minutes = getSettings().autoLockMinutes;
      const idle = minutes > 0 && now - lastInput.current > minutes * 60_000;
      if (slept || idle) doLock();
    }, TICK_MS);
    return () => {
      events.forEach(ev => window.removeEventListener(ev, touch, { capture: true }));
      window.clearInterval(timer);
    };
  }, [unlockedEncrypted, doLock]);

  const promptHost = prompt && (
    <PassphrasePrompt
      title={prompt.title}
      message={prompt.message}
      onDone={s => { prompt.resolve(s); setPrompt(null); }}
    />
  );

  if (!known) return null;
  if (session?.locked) {
    return (
      <>
        <UnlockScreen key={session.key} session={session} />
        {promptHost}
      </>
    );
  }
  return (
    <>
      {children}
      {promptHost}
    </>
  );
}
