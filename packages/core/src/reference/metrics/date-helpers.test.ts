import { describe, expect, it } from "vitest";

import {
  formatYmd,
  isoDateDaysBefore,
  isoToMs,
  parseIsoMs,
} from "./date-helpers.js";

describe("isoToMs", () => {
  it("treats a date-only input as midnight UTC", () => {
    expect(isoToMs("2026-05-10")).toBe(Date.UTC(2026, 4, 10));
  });

  it("uses the time component when present", () => {
    expect(isoToMs("2026-05-10T12:00:00")).toBe(Date.UTC(2026, 4, 10, 12, 0, 0));
    expect(isoToMs("2026-05-10T23:59:59")).toBe(
      Date.UTC(2026, 4, 10, 23, 59, 59),
    );
  });
});

describe("parseIsoMs", () => {
  it("parses a valid YYYY-MM-DD to midnight UTC ms", () => {
    expect(parseIsoMs("2026-05-10")).toBe(Date.UTC(2026, 4, 10));
    expect(parseIsoMs("1900-01-01")).toBe(Date.UTC(1900, 0, 1));
  });

  it("returns null for malformed strings", () => {
    expect(parseIsoMs("not-a-date")).toBeNull();
    expect(parseIsoMs("2026-5-10")).toBeNull(); // non-zero-padded
    expect(parseIsoMs("2026/05/10")).toBeNull(); // wrong separator
    expect(parseIsoMs("")).toBeNull();
    expect(parseIsoMs("2026-05-10T00:00:00")).toBeNull(); // datetime, not date
  });

  it("returns null for out-of-range months and days", () => {
    expect(parseIsoMs("2026-00-01")).toBeNull();
    expect(parseIsoMs("2026-13-01")).toBeNull();
    expect(parseIsoMs("2026-05-00")).toBeNull();
    expect(parseIsoMs("2026-05-32")).toBeNull();
  });

  it("returns null for calendar-invalid days the JS Date constructor silently normalises", () => {
    // Date.UTC(2026, 1, 30) rolls to 2026-03-02; the round-trip check
    // catches that and returns null. Python's strptime would also reject
    // these — this is the parity-critical case.
    expect(parseIsoMs("2026-02-30")).toBeNull();
    expect(parseIsoMs("2026-02-29")).toBeNull(); // 2026 is not a leap year
    expect(parseIsoMs("2026-04-31")).toBeNull();
    expect(parseIsoMs("2026-06-31")).toBeNull();
    expect(parseIsoMs("2026-09-31")).toBeNull();
    expect(parseIsoMs("2026-11-31")).toBeNull();
  });

  it("accepts Feb 29 in actual leap years", () => {
    expect(parseIsoMs("2024-02-29")).toBe(Date.UTC(2024, 1, 29));
    expect(parseIsoMs("2000-02-29")).toBe(Date.UTC(2000, 1, 29));
    // Century non-leap (not divisible by 400)
    expect(parseIsoMs("1900-02-29")).toBeNull();
  });
});

describe("formatYmd", () => {
  it("formats an arbitrary midnight-UTC timestamp", () => {
    expect(formatYmd(Date.UTC(2026, 4, 10))).toBe("2026-05-10");
  });

  it("pads single-digit month and day to two digits", () => {
    expect(formatYmd(Date.UTC(2026, 0, 5))).toBe("2026-01-05");
    expect(formatYmd(Date.UTC(2026, 8, 9))).toBe("2026-09-09");
  });
});

describe("isoDateDaysBefore", () => {
  it("steps back the requested number of calendar days", () => {
    expect(isoDateDaysBefore("2026-05-10T12:00:00", 0)).toBe("2026-05-10");
    expect(isoDateDaysBefore("2026-05-10T12:00:00", 6)).toBe("2026-05-04");
    expect(isoDateDaysBefore("2026-05-10T12:00:00", 27)).toBe("2026-04-13");
  });

  it("handles month rollover", () => {
    expect(isoDateDaysBefore("2026-03-05T12:00:00", 10)).toBe("2026-02-23");
  });

  it("handles year rollover", () => {
    expect(isoDateDaysBefore("2026-01-03T12:00:00", 5)).toBe("2025-12-29");
  });

  it("handles leap-year February boundary", () => {
    expect(isoDateDaysBefore("2024-03-01T12:00:00", 1)).toBe("2024-02-29");
    expect(isoDateDaysBefore("2025-03-01T12:00:00", 1)).toBe("2025-02-28");
  });

  it("ignores the time component of isoNow (only the date prefix matters)", () => {
    expect(isoDateDaysBefore("2026-05-10T00:00:00", 6)).toBe(
      isoDateDaysBefore("2026-05-10T23:59:59", 6),
    );
  });
});
