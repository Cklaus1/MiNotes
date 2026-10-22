import { describe, expect, it } from "vitest";
import { parseConflictTitle } from "./conflicts";
import { checkTone, shortRemote, isEncryptedRemote, remoteError } from "./syncRemote";
import { parseConflictTitle as mockParse } from "./syncMock";

describe("conflict copy titles", () => {
  it("parses the page and the device (the same as core parse_conflict_title)", () => {
    for (const parse of [parseConflictTitle, (t: string) => { const r = mockParse(t); return r && { base: r[0], device: r[1] }; }]) {
      expect(parse("Plan (conflict from laptop)")).toEqual({ base: "Plan", device: "laptop" });
      expect(parse("Plan (conflict from laptop) (2)")).toEqual({ base: "Plan", device: "laptop" });
      expect(parse("A (b) (conflict from my-pc.local)")).toEqual({ base: "A (b)", device: "my-pc.local" });
      expect(parse("Plan (2)")).toBeNull();
      expect(parse("Plan")).toBeNull();
    }
  });
});

describe("sync remote wording", () => {
  const c = (status: string, warning: string | null = null) =>
    ({ status, message: "", branches: [], default_branch: null, warning, url: "" }) as never;
  it("tones", () => {
    expect(checkTone(c("empty"))).toBe("ok");
    expect(checkTone(c("reachable", "not bare"))).toBe("warn");
    expect(checkTone(c("offline"))).toBe("warn");
    expect(checkTone(c("auth"))).toBe("bad");
    expect(checkTone(c("invalid"))).toBe("bad");
  });
  it("short addresses and error codes", () => {
    expect(shortRemote("git@github.com:me/notes.git")).toBe("github.com:me/notes");
    expect(shortRemote("https://user@gitlab.com/me/notes.git")).toBe("gitlab.com/me/notes");
    expect(isEncryptedRemote("ENCRYPTED_REMOTE: This notebook is encrypted")).toBe(true);
    expect(isEncryptedRemote("Not found")).toBe(false);
    expect(remoteError("Git error: Not found — x")).toBe("Not found — x");
  });
});
