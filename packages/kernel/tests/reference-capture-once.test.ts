import { METRIC_REGISTRY } from "@enduragent/kernel/reference/registry";
import { compareReferenceCapture } from "@enduragent/kernel/reference/capture-once";
import { describe, expect, it } from "vitest";

const frozenNow = "1998-06-04T12:00:00";
const empty = Object.freeze({ activities: [], wellness: [], ftp_history: [] });

describe.sequential("Reference capture comparator", () => {
  it("compares complete fixtures and every registry entry dynamically", () => {
    const comparison = compareReferenceCapture({ direct: empty, projected: empty, frozenNow });

    expect(comparison).toMatchObject({
      fixtureBytesEqual: true,
      metricMapsComplete: true,
      metricBytesEqual: true,
      registryKeyCount: Object.keys(METRIC_REGISTRY).length,
      directMetricExceptionKeys: [],
      projectedMetricExceptionKeys: [],
      fixtureMismatchFamilies: [],
      metricMismatchKeys: [],
      directFamilyCounts: { activities: 0, ftp_history: 0, wellness: 0 },
      projectedFamilyCounts: { activities: 0, ftp_history: 0, wellness: 0 },
    });
    expect(Object.isFrozen(comparison)).toBe(true);
    for (const value of [comparison.directMetricExceptionKeys, comparison.projectedMetricExceptionKeys,
      comparison.fixtureMismatchFamilies, comparison.metricMismatchKeys, comparison.directFamilyCounts,
      comparison.projectedFamilyCounts]) expect(Object.isFrozen(value)).toBe(true);
  });

  it("preserves array order and distinguishes omission from null", () => {
    const first = { id: "1998-06-01", weight: null, restingHR: null, hrv: null, sleepSecs: null, sleepQuality: null };
    const second = { id: "1998-06-02", weight: null, restingHR: null, hrv: null, sleepSecs: null, sleepQuality: null };
    const direct = { ...empty, wellness: [first, second], current_ftp_indoor: null };
    const projected = { ...empty, wellness: [second, first] };
    const comparison = compareReferenceCapture({ direct, projected, frozenNow });

    expect(comparison.fixtureBytesEqual).toBe(false);
    expect(comparison.fixtureMismatchFamilies).toEqual(["current_ftp_indoor", "wellness"]);
    expect(comparison.directFamilyCounts.current_ftp_indoor).toBe(1);
    expect(comparison.projectedFamilyCounts.current_ftp_indoor).toBe(0);
    expect(comparison.directFamilyCounts.wellness).toBe(2);
    expect(comparison.projectedFamilyCounts.wellness).toBe(2);
  });

  it("reports only registry keys when a compute throws and restores the registry", () => {
    const key = Object.keys(METRIC_REGISTRY)[0]!;
    const original = METRIC_REGISTRY[key]!;
    METRIC_REGISTRY[key] = { compute() { throw new Error("private payload"); } };
    try {
      const comparison = compareReferenceCapture({ direct: empty, projected: empty, frozenNow });
      expect(comparison.metricMapsComplete).toBe(false);
      expect(comparison.metricBytesEqual).toBe(false);
      expect(comparison.directMetricExceptionKeys).toEqual([key]);
      expect(comparison.projectedMetricExceptionKeys).toEqual([key]);
      expect(comparison.metricMismatchKeys).toEqual([]);
    } finally {
      METRIC_REGISTRY[key] = original;
    }
  });

  it("validates both fixtures with the strict shipped schema", () => {
    expect(() => compareReferenceCapture({
      direct: { ...empty, unexpected: true } as never,
      projected: empty,
      frozenNow,
    })).toThrow();
  });
});
