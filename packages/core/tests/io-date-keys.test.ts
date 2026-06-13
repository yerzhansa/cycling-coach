import { describe, it, expect } from "vitest";

import {
  MS_PER_DAY,
  parseDateKeyMs,
  isRealDateKey,
  eachDateKeyInRange,
} from "../src/io/date-keys.js";

describe("parseDateKeyMs", () => {
  it("returns the midnight-UTC epoch-ms for a valid key", () => {
    expect(parseDateKeyMs("1998-03-01")).toBe(Date.UTC(1998, 2, 1));
  });

  it("returns a non-finite value for garbage", () => {
    expect(Number.isFinite(parseDateKeyMs("nope"))).toBe(false);
  });
});

describe("isRealDateKey", () => {
  it("is true for a real date", () => {
    expect(isRealDateKey("1998-03-01")).toBe(true);
  });

  it("is false for calendar-invalid dates Date.parse would normalise", () => {
    expect(isRealDateKey("2026-02-30")).toBe(false);
    expect(isRealDateKey("2026-13-01")).toBe(false);
    expect(isRealDateKey("2026-04-31")).toBe(false);
  });

  it("is false for wrong shape", () => {
    expect(isRealDateKey("2026-3-1")).toBe(false);
    expect(isRealDateKey("2026/03/01")).toBe(false);
    expect(isRealDateKey("")).toBe(false);
  });
});

describe("eachDateKeyInRange", () => {
  it("is inclusive of both endpoints", () => {
    expect(eachDateKeyInRange("1998-03-01", "1998-03-03")).toEqual([
      "1998-03-01",
      "1998-03-02",
      "1998-03-03",
    ]);
  });

  it("returns exactly [from] for a single-day range", () => {
    expect(eachDateKeyInRange("1998-03-01", "1998-03-01")).toEqual(["1998-03-01"]);
  });

  it("crosses a month boundary correctly", () => {
    const days = eachDateKeyInRange("1998-02-28", "1998-03-01");
    expect(days).toEqual(["1998-02-28", "1998-03-01"]);
  });

  it("returns [] when either bound is malformed", () => {
    expect(eachDateKeyInRange("nope", "1998-03-01")).toEqual([]);
    expect(eachDateKeyInRange("1998-03-01", "nope")).toEqual([]);
  });
});

describe("inclusivity consistency (anti-drift)", () => {
  it("pins the loop-bound convention to the +1 range-day count", () => {
    const from = "1998-03-01";
    const to = "1998-03-31";
    expect(eachDateKeyInRange(from, to).length).toBe(
      (parseDateKeyMs(to) - parseDateKeyMs(from)) / MS_PER_DAY + 1,
    );
  });
});
