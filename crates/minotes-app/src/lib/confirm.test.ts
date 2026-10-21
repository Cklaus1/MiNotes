/**
 * The app-wide confirmation dialog (lib/confirm.ts): a real boolean, Escape and
 * Cancel say no, keys never reach the app underneath, and the encrypted-notebook
 * export warning blocks the export when declined (UX review C-1).
 */
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("./api", () => ({
  getNotebookSession: async () => ({ key: "vault", name: "Vault", encrypted: true }),
}));

import { answerConfirm, confirmDialog, isConfirmOpen, subscribeConfirm, type PendingConfirm } from "./confirm";
import { confirmPlaintextExport } from "./encryption";

let unsubscribe: (() => void) | null = null;
afterEach(() => { unsubscribe?.(); unsubscribe = null; });

/** A stand-in for <ConfirmHost/>: records what is shown, answers via `answer`. */
function host(answer?: (req: PendingConfirm) => boolean | undefined) {
  const shown: PendingConfirm[] = [];
  unsubscribe = subscribeConfirm((req) => {
    if (!req) return;
    shown.push(req);
    const a = answer?.(req);
    if (a !== undefined) queueMicrotask(() => answerConfirm(req.id, a));
  });
  return shown;
}

const key = (k: string) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

describe("confirmDialog", () => {
  test("with no dialog host it answers no (never a silent yes)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await confirmDialog("Delete?")).toBe(false);
  });

  test("resolves to the button pressed — a real boolean", async () => {
    host((r) => r.message === "yes please");
    await expect(confirmDialog("yes please")).resolves.toBe(true);
    await expect(confirmDialog("no thanks")).resolves.toBe(false);
  });

  test("Escape answers no, and the key never reaches the app's own listeners", async () => {
    const shown = host();
    const seen: string[] = [];
    const appListener = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener("keydown", appListener, true);
    try {
      const p = confirmDialog({ message: "Empty trash?", confirmLabel: "Delete", danger: true });
      expect(isConfirmOpen()).toBe(true);
      expect(shown[0]).toMatchObject({ message: "Empty trash?", confirmLabel: "Delete", danger: true });
      key("z");
      key("Escape");
      expect(await p).toBe(false);
      expect(isConfirmOpen()).toBe(false);
      expect(seen).toEqual([]);
      key("Escape");
      expect(seen).toEqual(["Escape"]);
    } finally {
      window.removeEventListener("keydown", appListener, true);
    }
  });

  test("several requests are shown one after another, in order", async () => {
    const shown = host((r) => r.message === "second");
    const a = confirmDialog("first");
    const b = confirmDialog("second");
    expect(shown.map((s) => s.message)).toEqual(["first"]);
    answerConfirm(shown[0].id, false);
    expect(await a).toBe(false);
    expect(await b).toBe(true);
    expect(shown.map((s) => s.message)).toEqual(["first", "second"]);
  });
});

describe("encrypted notebook: plaintext export warning", () => {
  test("declining blocks the export, every time — window.confirm is never used", async () => {
    // What the desktop dialog plugin installs: an async confirm (a Promise is truthy).
    const nativeConfirm = vi.fn(async () => false);
    (window as any).confirm = nativeConfirm;
    const shown = host(() => false);
    expect(await confirmPlaintextExport()).toBe(false);
    expect(await confirmPlaintextExport()).toBe(false);
    expect(shown).toHaveLength(2);
    expect(shown[0].message).toMatch(/unencrypted/);
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  test("accepting lets it go on, and it asks only once per notebook", async () => {
    const shown = host(() => true);
    expect(await confirmPlaintextExport()).toBe(true);
    expect(await confirmPlaintextExport()).toBe(true);
    expect(shown).toHaveLength(1);
  });
});
