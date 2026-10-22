import { describe, expect, test } from "vitest";
import { linkFirstMention } from "./linkMention";

describe("linkFirstMention", () => {
  test("wraps the mention, keeping its case", () => {
    expect(linkFirstMention("Talked about project alpha today", "Project Alpha")).toBe("Talked about [[project alpha]] today");
    expect(linkFirstMention("Project Alpha: kickoff", "Project Alpha")).toBe("[[Project Alpha]]: kickoff");
  });

  test("only whole words", () => {
    expect(linkFirstMention("Rustacean meetup", "Rust")).toBeNull();
    expect(linkFirstMention("Learn Rust, then Rustacean", "Rust")).toBe("Learn [[Rust]], then Rustacean");
  });

  test("the first mention that isn't already inside something", () => {
    expect(linkFirstMention("see [[Rust]] and also Rust", "Rust")).toBe("see [[Rust]] and also [[Rust]]");
    expect(linkFirstMention("`Rust` code and [Rust](https://rust-lang.org) and https://x.org/Rust", "Rust")).toBeNull();
    expect(linkFirstMention("{{embed ((x))}} #Rust", "Rust")).toBeNull();
    expect(linkFirstMention("```\nRust\n```\nRust here", "Rust")).toBe("```\nRust\n```\n[[Rust]] here");
  });

  test("nothing to link", () => {
    expect(linkFirstMention("nothing here", "Rust")).toBeNull();
    expect(linkFirstMention("Rust", "")).toBeNull();
  });

  test("titles with punctuation", () => {
    expect(linkFirstMention("Read C++ Primer now", "C++ Primer")).toBe("Read [[C++ Primer]] now");
    expect(linkFirstMention("the 2026-10-21 notes", "2026-10-21")).toBe("the [[2026-10-21]] notes");
  });
});
