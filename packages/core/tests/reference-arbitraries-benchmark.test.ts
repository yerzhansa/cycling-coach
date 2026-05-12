// Perf-floor self-test for `MATH_CRITICAL_RUNS`. Math-critical metrics opt
// into 10_000 runs to surface stddev-zero edges that emerge ~1-in-5000
// weekly histories. The 30s timeout that pairs with it
// (`MATH_CRITICAL_TIMEOUT_MS`) is defense against fast-check shrink: a
// property that fails on a complex input can spend 100x the happy-path
// budget shrinking. Without the paired timeout, CI flakes.
//
// This file locks in the *current* perf as a baseline. If a future change
// to arbitraries breaks the perf floor (e.g., introducing slow `.chain()`
// composition), this test fails before the math-critical tests downstream
// time out under their 30s budget — surfacing perf creep that the bigger
// timeout would otherwise hide.

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  MATH_CRITICAL_RUNS,
  MATH_CRITICAL_TIMEOUT_MS,
  arbitraryWeeklyRollup,
} from "./helpers/reference-arbitraries.js";

describe("MATH_CRITICAL constants", () => {
  it("MATH_CRITICAL_RUNS is 10_000 — paired with MATH_CRITICAL_TIMEOUT_MS", () => {
    expect(MATH_CRITICAL_RUNS).toBe(10_000);
    expect(MATH_CRITICAL_TIMEOUT_MS).toBe(30_000);
  });

  it(
    `arbitraryWeeklyRollup × ${MATH_CRITICAL_RUNS.toLocaleString()} runs completes well under the 30s shrink budget (perf-floor: <5s)`,
    () => {
      const startedAt = Date.now();
      fc.assert(
        fc.property(arbitraryWeeklyRollup, () => true),
        {
          numRuns: MATH_CRITICAL_RUNS,
          timeout: MATH_CRITICAL_TIMEOUT_MS,
        },
      );
      const elapsedMs = Date.now() - startedAt;
      // Plan budget: <5_000ms. Generous CI headroom (some CI machines are
      // slow); the constant for math-critical metrics is 30_000ms so this
      // perf floor leaves 6x headroom on top of the test budget.
      expect(elapsedMs).toBeLessThan(5_000);
    },
    MATH_CRITICAL_TIMEOUT_MS,
  );
});
