import { describe, expect, test } from "vitest";
import { extractTypedProperties, propertyLine } from "./typedProperties";

describe("typed key:: value lines", () => {
  test("a property line under the text becomes a property", () => {
    expect(extractTypedProperties("Fix the login bug\nstatus:: doing")).toEqual({
      content: "Fix the login bug",
      properties: [{ key: "status", value: "doing" }],
    });
  });

  test("several, any order; the last of a key wins; values keep links", () => {
    const r = extractTypedProperties("owner:: [[Ann]]\nTitle line\npriority:: high\npriority:: low");
    expect(r.content).toBe("Title line");
    expect(r.properties).toEqual([{ key: "owner", value: "[[Ann]]" }, { key: "priority", value: "low" }]);
  });

  test("a block that is only a property keeps an empty text", () => {
    expect(extractTypedProperties("due:: 2026-11-01")).toEqual({ content: "", properties: [{ key: "due", value: "2026-11-01" }] });
  });

  test("an empty value is allowed (key:: at the end of the line)", () => {
    expect(extractTypedProperties("x\ntags::").properties).toEqual([{ key: "tags", value: "" }]);
  });

  test(":: inside text, links and code is not a property", () => {
    for (const md of [
      "see [[Work::Roadmap]]",
      "a::b in prose",
      "note:: but with a space before\n not:: a key? no — 'not' is fine",
      "```\nkey:: value\n```",
      "two words:: value",
      "-dash:: no",
      "Ratio 3::4",
    ]) {
      const r = extractTypedProperties(md);
      if (md.startsWith("note::")) { expect(r.properties.map(p => p.key)).toEqual(["note"]); continue; }
      expect(r, md).toEqual({ content: md, properties: [] });
    }
  });

  test("round trip with the markdown copy's property lines (F-7)", () => {
    // What the mirror writes for a block "Ship it" with these properties, minus
    // its indentation, is exactly what typing them gives back.
    const typed = ["Ship it", propertyLine("status", "done"), propertyLine("owner", "Bo")].join("\n");
    const r = extractTypedProperties(typed);
    expect(r.content).toBe("Ship it");
    expect(r.properties.map(p => propertyLine(p.key, p.value))).toEqual(["status:: done", "owner:: Bo"]);
  });
});
