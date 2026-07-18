import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  evaluateSessionFreshness,
  resolveDailyResetAtMs,
} from "../src/agent/session-freshness.js";

describe("evaluateSessionFreshness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats a null lastMessageTime as fresh", () => {
    expect(
      evaluateSessionFreshness({
        lastMessageTime: null,
        dailyResetHour: 4,
        idleMinutes: 0,
      }),
    ).toEqual({ fresh: true });
  });

  it("treats a malformed lastMessageTime as stale with reason daily", () => {
    expect(
      evaluateSessionFreshness({
        lastMessageTime: "not-a-date",
        dailyResetHour: 4,
        idleMinutes: 0,
      }),
    ).toEqual({ fresh: false, reason: "daily" });
  });

  it("marks a message before today's reset hour stale (daily)", () => {
    expect(
      evaluateSessionFreshness({
        lastMessageTime: "2026-06-11T03:00:00.000Z",
        dailyResetHour: 4,
        idleMinutes: 0,
      }),
    ).toEqual({ fresh: false, reason: "daily" });
  });

  it("marks a message after today's reset hour fresh", () => {
    expect(
      evaluateSessionFreshness({
        lastMessageTime: "2026-06-11T05:00:00.000Z",
        dailyResetHour: 4,
        idleMinutes: 0,
      }),
    ).toEqual({ fresh: true });
  });

  it("applies the tz offset to the reset boundary (the DST-class boundary proxy)", () => {
    expect(
      evaluateSessionFreshness({
        lastMessageTime: "2026-06-11T07:00:00.000Z",
        dailyResetHour: 4,
        idleMinutes: 0,
        tz: "America/New_York",
      }),
    ).toEqual({ fresh: false, reason: "daily" });
    expect(
      evaluateSessionFreshness({
        lastMessageTime: "2026-06-11T09:00:00.000Z",
        dailyResetHour: 4,
        idleMinutes: 0,
        tz: "America/New_York",
      }),
    ).toEqual({ fresh: true });
  });

  it("fires idle expiry when idleMinutes is enabled", () => {
    const stale = new Date(Date.now() - 31 * 60_000).toISOString();
    const fresh = new Date(Date.now() - 29 * 60_000).toISOString();
    expect(
      evaluateSessionFreshness({
        lastMessageTime: stale,
        dailyResetHour: 0,
        idleMinutes: 30,
      }),
    ).toEqual({ fresh: false, reason: "idle" });
    expect(
      evaluateSessionFreshness({
        lastMessageTime: fresh,
        dailyResetHour: 0,
        idleMinutes: 30,
      }),
    ).toEqual({ fresh: true });
  });

  it("disables the idle check when idleMinutes is 0", () => {
    const longIdle = new Date(Date.now() - 10 * 3_600_000).toISOString();
    expect(
      evaluateSessionFreshness({
        lastMessageTime: longIdle,
        dailyResetHour: 0,
        idleMinutes: 0,
      }),
    ).toEqual({ fresh: true });
  });

  it("resolveDailyResetAtMs returns today's reset when the hour has passed", () => {
    expect(resolveDailyResetAtMs(4, "UTC")).toBe(Date.UTC(2026, 5, 11, 4, 0, 0));
  });

  it("resolveDailyResetAtMs falls back to yesterday's reset before the hour", () => {
    vi.setSystemTime(new Date("2026-06-11T02:00:00.000Z"));
    expect(resolveDailyResetAtMs(4, "UTC")).toBe(Date.UTC(2026, 5, 10, 4, 0, 0));
  });
});
