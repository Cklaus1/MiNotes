import { describe, expect, it } from "vitest";
import { ago, chipText, phaseOf, type SyncView } from "./syncStatus";
import type { GitSyncStatus } from "./api";

const status = (s: Partial<GitSyncStatus>): GitSyncStatus => ({
  enabled: true, remote_url: "/r.git", branch: "main", last_sync: null, ...s,
});
const view = (s: GitSyncStatus | null, over: Partial<SyncView> = {}): SyncView => ({
  phase: phaseOf(s), status: s, error: s?.last_error ?? null, errorKind: s?.last_error_kind ?? null, ...over,
});

describe("sync status (UX review: honest sync states)", () => {
  it("never says synced without a remote or before a push", () => {
    expect(chipText(view(status({ remote_url: null, last_sync: null })))).toBe("Not synced — no remote");
    expect(chipText(view(status({ last_sync: null })))).toBe("Not synced yet");
    const t = new Date(Date.now() - 120_000).toISOString();
    expect(chipText(view(status({ last_sync: t })))).toBe("Synced 2 min ago");
  });

  it("a paused folder is paused, whatever its config says", () => {
    const s = status({ needs_confirmation: true, last_sync: new Date().toISOString() });
    expect(phaseOf(s)).toBe("paused");
    expect(chipText(view(s))).toBe("Sync paused");
  });

  it("a missing remote is an error, not a quiet Offline", () => {
    const missing = status({ last_error: "Remote not found — …", last_error_kind: "remote_not_found" });
    expect(phaseOf(missing)).toBe("error");
    expect(chipText(view(missing))).toBe("Sync remote not found");
    const net = status({ last_error: "Network error — …", last_error_kind: "offline" });
    expect(phaseOf(net)).toBe("offline");
    expect(chipText(view(net))).toBe("Offline");
    expect(phaseOf(status({ enabled: false }))).toBe("off");
  });

  it("formats relative times", () => {
    const now = Date.parse("2026-10-21T12:00:00Z");
    expect(ago("2026-10-21T11:59:50Z", now)).toBe("just now");
    expect(ago("2026-10-21T09:00:00Z", now)).toBe("3 h ago");
    expect(ago("2026-10-20T10:00:00Z", now)).toBe("yesterday");
  });
});
