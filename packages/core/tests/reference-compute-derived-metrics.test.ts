// `computeDerivedMetrics` runs the metric registry over a MetricInput to
// produce the flat `derived_metrics` object the sync persists. These tests pin
// that (a) it covers the whole registry key-set, (b) it computes real values —
// including the stream-driven DFA-α1 profile — off a golden fixture, and (c) a
// single throwing metric is isolated to `null` + a warning, never sinking the
// rest.

import { describe, expect, it, vi } from "vitest";

import {
  computeDerivedMetrics,
  METRIC_COMPUTE_FAILED_LOG_PREFIX,
} from "../src/reference/sync/compute-derived-metrics.js";
import { METRIC_REGISTRY } from "../src/reference/metrics/registry.js";
import type { MetricInput } from "../src/reference/metrics/metric-input.js";
import { buildFixtureShape } from "../src/reference/sync/fixture-bridge.js";
import { GoldenFixtureSchema, loadFixture } from "./helpers/load-fixture.js";

function dfaEquippedInput(): MetricInput {
  const fixture = loadFixture("golden/dfa-equipped", GoldenFixtureSchema);
  // Anchor frozenNow just after the newest session so the trailing DFA window
  // captures the fixture's sufficient rides (epoch-agnostic).
  const newest = fixture.activities
    .map((a) => a.start_date_local.slice(0, 10))
    .sort()
    .at(-1)!;
  return { fixture, frozenNow: `${newest}T12:00:00` };
}

describe("computeDerivedMetrics", () => {
  it("covers the full registry key-set", () => {
    const out = computeDerivedMetrics(dfaEquippedInput());
    expect(Object.keys(out).sort()).toEqual(Object.keys(METRIC_REGISTRY).sort());
  });

  it("computes the stream-driven DFA-α1 profile on a real fixture", () => {
    const out = computeDerivedMetrics(dfaEquippedInput());
    const profile = out["capability.dfa_a1_profile"] as {
      latest_session?: { sufficient?: boolean };
      trailing_by_sport?: Record<string, { aet_estimate?: unknown; aet_crossing_sessions?: number }>;
    } | null;
    expect(profile).not.toBeNull();
    expect(profile?.latest_session).toBeDefined();
    expect(profile?.latest_session?.sufficient).toBe(true);
    // The additive 0.75 aerobic-threshold field rides through the production
    // registry path alongside the faithful lt1/lt2 estimates.
    const cycling = profile?.trailing_by_sport?.cycling;
    expect(cycling).toBeDefined();
    expect(cycling).toHaveProperty("aet_estimate");
    expect(typeof cycling?.aet_crossing_sessions).toBe("number");
  });

  it("computes load-management metrics (no throw on real data)", () => {
    const out = computeDerivedMetrics(dfaEquippedInput());
    expect(out).toHaveProperty("acwr");
    expect(out).toHaveProperty("monotony");
    expect(out).toHaveProperty("strain");
  });

  it("does not throw any real registry metric on a deliberately sparse (but schema-valid) fixture", () => {
    // The isolation path should never actually fire for real metrics on thin
    // live data — each degrades to a legitimate null/empty block. A warning here
    // means a real metric throws on sparse input (a production risk).
    const log = vi.fn();
    const sparse = buildFixtureShape({
      activities: [
        { id: 1, start_date_local: "2026-06-01T07:00:00", type: "Ride", moving_time: 3600, elapsed_time: 3700 },
      ],
      wellness: [
        { id: "2026-06-01", weight: null, restingHR: null, hrv: null, sleepSecs: null, sleepQuality: null },
      ],
      ftpHistory: [],
    });
    computeDerivedMetrics({ fixture: sparse, frozenNow: "2026-06-02T12:00:00" }, { log });
    expect(log).not.toHaveBeenCalled();
  });

  it("isolates a throwing metric to null + warning, leaving the rest intact", () => {
    const log = vi.fn();
    const out = computeDerivedMetrics({ fixture: {} as never, frozenNow: "x" }, {
      log,
      registry: {
        good: { compute: () => 42 },
        bad: {
          compute: () => {
            throw new Error("boom");
          },
        },
      },
    });
    expect(out).toEqual({ good: 42, bad: null });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain(METRIC_COMPUTE_FAILED_LOG_PREFIX);
    expect(log.mock.calls[0]?.[0]).toContain("bad");
    expect(log.mock.calls[0]?.[0]).toContain("boom");
  });
});
