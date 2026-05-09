// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.

import { afterEach, describe, it, expect, vi } from "vitest";
import { chainedSignal } from "../src/reference/sync/abort-budget.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("chainedSignal", () => {
  it("aborts when the outer signal aborts", () => {
    const outer = new AbortController();
    const signal = chainedSignal({ outer: outer.signal, perRequestMs: 10_000 });
    expect(signal.aborted).toBe(false);
    outer.abort();
    expect(signal.aborted).toBe(true);
  });

  // Per-request-timeout abort propagation is exercised at the runSync level
  // (`reference-run-sync.test.ts`'s outer-timeout test verifies the chained
  // signal aborts in-flight fetches). A unit test here against
  // `AbortSignal.timeout` flakes under vitest's parallel pool — vi fake
  // timers don't fully cover `AbortSignal.timeout`'s internal scheduler, and
  // real-timer waits are unreliable when other test files saturate the
  // worker. The other two specs (outer aborts; already-aborted at construct)
  // cover the glue without timer dependence.
  it.skip("aborts when the per-request timeout fires before the outer aborts", async () => {
    const outer = new AbortController();
    const signal = chainedSignal({ outer: outer.signal, perRequestMs: 50 });
    expect(signal.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
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
