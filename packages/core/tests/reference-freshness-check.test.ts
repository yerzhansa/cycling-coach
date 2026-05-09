// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.

import { describe, expect, it } from "vitest";
import { freshnessOf } from "../src/reference/sync/freshness-check.js";

const fixedNow = new Date("2026-05-09T12:00:00Z");
const ago = (ms: number) => new Date(fixedNow.getTime() - ms).toISOString();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("freshnessOf", () => {
  it("returns 'fresh' when last_updated is under 24 hours old", () => {
    expect(freshnessOf({ last_updated: ago(60_000) }, fixedNow)).toBe("fresh");
    expect(freshnessOf({ last_updated: ago(23 * HOUR) }, fixedNow)).toBe("fresh");
  });

  it("returns 'flag' when last_updated is 24-48 hours old", () => {
    expect(freshnessOf({ last_updated: ago(24 * HOUR) }, fixedNow)).toBe("flag");
    expect(freshnessOf({ last_updated: ago(36 * HOUR) }, fixedNow)).toBe("flag");
  });

  it("returns 'stale' when last_updated is between 48 hours and 7 days old", () => {
    expect(freshnessOf({ last_updated: ago(48 * HOUR) }, fixedNow)).toBe("stale");
    expect(freshnessOf({ last_updated: ago(3 * DAY) }, fixedNow)).toBe("stale");
    expect(freshnessOf({ last_updated: ago(6 * DAY) }, fixedNow)).toBe("stale");
  });

  it("returns 'critical' when last_updated is over 7 days old", () => {
    expect(freshnessOf({ last_updated: ago(7 * DAY) }, fixedNow)).toBe("critical");
    expect(freshnessOf({ last_updated: ago(30 * DAY) }, fixedNow)).toBe("critical");
  });
});
