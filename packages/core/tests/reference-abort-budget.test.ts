// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.

import { afterEach, describe, it, expect, vi } from "vitest";
import { chainedSignal } from "../src/reference/sync/abort-budget.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * `AbortSignal.timeout` uses Node's internal timer scheduler — `vi.useFakeTimers()`
 * cannot intercept it directly, so the per-request-timeout tests below replace
 * `AbortSignal.timeout` with a `setTimeout`-driven controller (which fake timers
 * DO intercept). The mock preserves the only observable behavior the tests
 * care about: the returned signal aborts after `ms` of fake time.
 */
function mockAbortSignalTimeout(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("timeout (mock)")), ms);
    return controller.signal;
  });
}

describe("chainedSignal", () => {
  it("aborts when the outer signal aborts", () => {
    const outer = new AbortController();
    const signal = chainedSignal({ outer: outer.signal, perRequestMs: 10_000 });
    expect(signal.aborted).toBe(false);
    outer.abort();
    expect(signal.aborted).toBe(true);
  });

  it("aborts when the per-request timeout fires before the outer aborts", async () => {
    vi.useFakeTimers();
    mockAbortSignalTimeout();

    const outer = new AbortController();
    const signal = chainedSignal({ outer: outer.signal, perRequestMs: 50 });
    expect(signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(60);

    expect(signal.aborted).toBe(true);
    expect(outer.signal.aborted).toBe(false);
  });

  it("starts already-aborted when the outer signal is already aborted at construction", () => {
    const outer = new AbortController();
    outer.abort();
    const signal = chainedSignal({ outer: outer.signal, perRequestMs: 10_000 });
    expect(signal.aborted).toBe(true);
  });
});
