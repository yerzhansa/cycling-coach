import { describe, expect, it } from "vitest";
import type { CyclingFtpAnchorResult } from "@enduragent/kernel/anchors";
import { projectCyclingTrainingContext } from "../src/training-context.js";

const anchor: CyclingFtpAnchorResult = {
  kind: "ftp",
  watts: 250,
  validFrom: "2026-06-01",
  source: "manual",
  confidence: "manual",
  ageDays: 48,
  stalenessBand: "aging",
  stale: true,
};

function activity(overrides: Record<string, unknown> = {}) {
  return {
    id: "ride-1",
    start_date_local: "2026-07-17T07:00:00",
    type: "Ride",
    moving_time: 3600,
    elapsed_time: 3700,
    icu_training_load: 70,
    ...overrides,
  };
}

function wellness(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    weight: 70,
    restingHR: 48,
    hrv: 62,
    sleepSecs: 28_800,
    sleepQuality: 3,
    ...overrides,
  };
}

function project(overrides: Partial<Parameters<typeof projectCyclingTrainingContext>[0]> = {}) {
  return projectCyclingTrainingContext({
    asOf: "2026-07-18T00:00:00.000Z",
    anchor,
    derivedMetrics: {
      consistency_index: 0.75,
      consistency_details: { planned_days: 4, completed_days: 5, matched_days: 3 },
    },
    recentActivities: [activity(), activity({ id: "run-1", type: "Run", icu_training_load: 20 })],
    plannedWorkouts: [
      {
        id: 2,
        category: "WORKOUT",
        start_date_local: "2026-07-20T08:00:00",
        name: null,
        type: "Ride",
      },
    ],
    wellness: [wellness("2026-07-17")],
    ...overrides,
  });
}

describe("cycling training context projection", () => {
  it("projects the canonical anchor and all six canonical zone rows", () => {
    const result = project();
    expect(result.anchorZones).toMatchObject({
      kind: "computed",
      anchor: {
        watts: anchor.watts,
        validFrom: anchor.validFrom,
        source: anchor.source,
        confidence: anchor.confidence,
        ageDays: anchor.ageDays,
        stalenessBand: anchor.stalenessBand,
        stale: anchor.stale,
      },
      zones: expect.arrayContaining([
        expect.objectContaining({ name: "Sweet Spot (88-94%)", overlaps: true }),
      ]),
    });
    if (result.anchorZones.kind === "computed") expect(result.anchorZones.zones).toHaveLength(6);
    expect(project({ anchor: null }).anchorZones).toEqual({
      kind: "unknown",
      reason: "not-synced",
    });
    expect(
      project({ anchor: { kind: "missing", refusal: "missing-cycling-ftp-anchor" } }).anchorZones,
    ).toEqual({ kind: "unknown", reason: "missing-anchor" });
  });

  it.each(["fresh", "aging", "stale", "very-stale"] as const)(
    "preserves the %s staleness band",
    (stalenessBand) => {
      const result = project({ anchor: { ...anchor, stalenessBand } });
      expect(
        result.anchorZones.kind === "computed" && result.anchorZones.anchor.stalenessBand,
      ).toBe(stalenessBand);
    },
  );

  it("aggregates only valid persisted cycling platform Load values", () => {
    const result = project({
      recentActivities: [
        activity({ id: "zero", icu_training_load: 0 }),
        activity({ id: "missing", icu_training_load: null }),
        activity({ id: "invalid", icu_training_load: -1 }),
        activity({ id: "nonfinite", icu_training_load: Number.POSITIVE_INFINITY }),
        activity({ id: "run", type: "Run", icu_training_load: 90 }),
      ],
    });
    expect(result.cyclingLoad).toEqual({
      kind: "computed",
      asOf: "2026-07-18T00:00:00.000Z",
      source: "intervals.icu",
      windowDays: 7,
      value: 0,
      activityCount: 2,
      missingLoadCount: 1,
    });
    expect(
      project({ recentActivities: [activity({ icu_training_load: null })] }).cyclingLoad,
    ).toEqual({
      kind: "unknown",
      reason: "no-platform-load",
    });
  });

  it("filters, sorts, and caps cycling plan rows", () => {
    const rows = Array.from({ length: 9 }, (_, index) => ({
      id: 20 - index,
      category: "WORKOUT",
      start_date_local: `2026-07-${String(20 + (index % 2)).padStart(2, "0")}T08:00:00`,
      name: index === 0 ? null : `Workout ${index}`,
      type: "Ride",
    }));
    rows.push({
      id: 100,
      category: "WORKOUT",
      start_date_local: "2026-07-19T08:00:00",
      name: "Run",
      type: "Run",
    });
    const result = project({ plannedWorkouts: rows });
    expect(result.plan.kind === "computed" && result.plan.items).toHaveLength(7);
    if (result.plan.kind === "computed") {
      expect(result.plan.items.map((item) => Number(item.id))).toEqual([
        12, 14, 16, 18, 20, 13, 15,
      ]);
    }
    expect(project({ plannedWorkouts: [] }).plan).toEqual({ kind: "unknown", reason: "no-plan" });
  });

  it("projects persisted adherence only when its complete shape is valid", () => {
    expect(project().adherence).toMatchObject({
      kind: "computed",
      ratio: 0.75,
      plannedDays: 4,
      completedDays: 5,
      matchedDays: 3,
    });
    expect(
      project({
        derivedMetrics: {
          consistency_index: 0,
          consistency_details: { planned_days: 0, completed_days: 0, matched_days: 0 },
        },
      }).adherence,
    ).toEqual({ kind: "unknown", reason: "no-plan" });
    expect(project({ derivedMetrics: { consistency_index: 2 } }).adherence).toEqual({
      kind: "unknown",
      reason: "insufficient-data",
    });
  });

  it("sorts and caps wellness rows while allowing partial series", () => {
    const rows = Array.from({ length: 9 }, (_, index) =>
      wellness(`2026-07-${String(9 - index).padStart(2, "0")}`, {
        hrv: index === 0 ? null : 50 + index,
        sleepSecs: null,
      }),
    );
    const result = project({ wellness: rows });
    expect(result.wellnessTrend.kind).toBe("computed");
    if (result.wellnessTrend.kind === "computed") {
      expect(result.wellnessTrend.series.map((entry) => entry.points.length)).toEqual([6, 0, 7]);
      expect(result.wellnessTrend.series[0]?.points[0]?.date).toBe("2026-07-03");
    }
    expect(project({ wellness: {} }).wellnessTrend).toEqual({
      kind: "unknown",
      reason: "no-wellness",
    });
    expect(
      project({
        wellness: [wellness("2026-07-01", { hrv: null, sleepSecs: null, restingHR: null })],
      }).wellnessTrend,
    ).toEqual({
      kind: "unknown",
      reason: "insufficient-data",
    });
  });

  it("does not project unrelated wellness balance inputs", () => {
    const result = JSON.stringify(
      project({ wellness: [wellness("2026-07-17", { fitness: 80, fatigue: 70 })] }),
    );
    expect(result).not.toContain("fitness");
    expect(result).not.toContain("fatigue");
  });
});
