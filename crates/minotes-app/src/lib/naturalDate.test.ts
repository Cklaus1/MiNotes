import { describe, expect, test } from "vitest";
import { journalLink, parseNaturalDate } from "./naturalDate";
import { localDateKey } from "./dates";

// Wednesday 21 October 2026, mid-afternoon local time.
const NOW = new Date(2026, 9, 21, 15, 30);
const at = (phrase: string) => {
  const d = parseNaturalDate(phrase, NOW);
  return d ? localDateKey(d) : null;
};

describe("parseNaturalDate", () => {
  test("relative words", () => {
    expect(at("today")).toBe("2026-10-21");
    expect(at("Tomorrow")).toBe("2026-10-22");
    expect(at("yesterday")).toBe("2026-10-20");
  });

  test("weekdays", () => {
    expect(at("friday")).toBe("2026-10-23");
    expect(at("fri")).toBe("2026-10-23");
    expect(at("this friday")).toBe("2026-10-23");
    expect(at("next friday")).toBe("2026-10-23");
    expect(at("next wednesday")).toBe("2026-10-28"); // never today
    expect(at("wednesday")).toBe("2026-10-21"); // today is a Wednesday
    expect(at("last friday")).toBe("2026-10-16");
    expect(at("last wednesday")).toBe("2026-10-14");
    expect(at("monday")).toBe("2026-10-26");
    expect(at("thurs")).toBe("2026-10-22");
  });

  test("offsets", () => {
    expect(at("in 3 days")).toBe("2026-10-24");
    expect(at("in a week")).toBe("2026-10-28");
    expect(at("in 2 weeks")).toBe("2026-11-04");
    expect(at("in 1 month")).toBe("2026-11-21");
    expect(at("3 days ago")).toBe("2026-10-18");
    expect(at("+3d")).toBe("2026-10-24");
    expect(at("-2w")).toBe("2026-10-07");
    expect(at("next week")).toBe("2026-10-28");
    expect(at("last month")).toBe("2026-09-21");
  });

  test("calendar dates", () => {
    expect(at("2026-12-01")).toBe("2026-12-01");
    expect(at("mar 30")).toBe("2027-03-30"); // past this year → next year
    expect(at("30 march")).toBe("2027-03-30");
    expect(at("dec 25")).toBe("2026-12-25");
    expect(at("October 21")).toBe("2026-10-21"); // today counts
    expect(at("march 30 2028")).toBe("2028-03-30");
    expect(at("31st of december")).toBe("2026-12-31");
  });

  test("month ends clamp", () => {
    expect(localDateKey(parseNaturalDate("in 1 month", new Date(2026, 0, 31))!)).toBe("2026-02-28");
  });

  test("not dates", () => {
    for (const p of ["", "banana", "next banana", "feb 30", "2026-02-30", "in many days", "mon key"]) expect(at(p), p).toBeNull();
  });

  test("journal link", () => {
    expect(journalLink(new Date(2026, 9, 30))).toBe("[[Journal/2026-10-30]]");
  });
});
