import { describe, it, expect } from "vitest";
import { formatPaceFromMps, renderPaceMMSS, PACE_UNAVAILABLE } from "./pace-format.js";

describe("formatPaceFromMps", () => {
  it("renders /mi at the mile divisor for MINS_MILE", () => {
    // 1609.344 / 4.0 = 402.336 → round 402 → 6:42
    expect(formatPaceFromMps(4.0, "MINS_MILE")).toBe("6:42/mi");
  });

  it("renders /km at the km divisor for MINS_KM", () => {
    // 1000 / 4.0 = 250 → 4:10
    expect(formatPaceFromMps(4.0, "MINS_KM")).toBe("4:10/km");
  });

  it("falls through to /km for null", () => {
    expect(formatPaceFromMps(4.0, null)).toBe("4:10/km");
  });

  it("falls through to /km for undefined", () => {
    expect(formatPaceFromMps(4.0, undefined)).toBe("4:10/km");
    expect(formatPaceFromMps(4.0)).toBe("4:10/km");
  });

  it("falls through to /km for NONE", () => {
    expect(formatPaceFromMps(4.0, "NONE")).toBe("4:10/km");
  });

  it("falls through to /km for an unrecognized string", () => {
    expect(formatPaceFromMps(4.0, "SECS_KM")).toBe("4:10/km");
    expect(formatPaceFromMps(4.0, "totally-bogus")).toBe("4:10/km");
  });

  it("rounds on rendered seconds, matching the zones paceMMSS contract", () => {
    // zones paceMMSS: Math.round(1000 / 4.0) = 250 → 4:10. Identical here.
    expect(formatPaceFromMps(4.0, "MINS_KM")).toBe("4:10/km");
    // A speed that forces a non-trivial round: 1000 / 3.7 = 270.27 → 270 → 4:30
    expect(formatPaceFromMps(3.7, "MINS_KM")).toBe("4:30/km");
  });

  it("returns the sentinel for a non-positive speed, never Infinity:00", () => {
    expect(formatPaceFromMps(0, "MINS_KM")).toBe(PACE_UNAVAILABLE);
    expect(formatPaceFromMps(-2, "MINS_KM")).toBe(PACE_UNAVAILABLE);
    expect(formatPaceFromMps(0, "MINS_KM")).not.toContain("Infinity");
  });

  it("returns the sentinel for a non-finite speed, never NaN", () => {
    expect(formatPaceFromMps(Number.NaN, "MINS_KM")).toBe(PACE_UNAVAILABLE);
    expect(formatPaceFromMps(Number.POSITIVE_INFINITY, "MINS_KM")).toBe(PACE_UNAVAILABLE);
    expect(formatPaceFromMps(Number.NaN, "MINS_KM")).not.toContain("NaN");
  });
});

describe("renderPaceMMSS", () => {
  it("renders pace-per-100m for swimming reuse", () => {
    // 100 / 1.25 = 80 → 1:20
    expect(renderPaceMMSS(1.25, 100)).toBe("1:20");
  });

  it("rounds on the rendered total seconds", () => {
    // 1000 / 4.0 = 250 → 4:10
    expect(renderPaceMMSS(4.0, 1000)).toBe("4:10");
  });

  it("returns the sentinel for non-positive / non-finite speeds", () => {
    expect(renderPaceMMSS(0, 100)).toBe(PACE_UNAVAILABLE);
    expect(renderPaceMMSS(Number.NaN, 100)).toBe(PACE_UNAVAILABLE);
    expect(renderPaceMMSS(Number.POSITIVE_INFINITY, 100)).toBe(PACE_UNAVAILABLE);
  });
});
