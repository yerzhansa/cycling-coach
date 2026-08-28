import { describe, expect, it } from "vitest";
import {
  composeWeeklyReview,
  orderPlanAttentionItems,
  selectWeeklyReviewWindow,
} from "../src/index.js";
import type { ProjectedWorkoutMatch } from "../src/planning/workout-match.js";

function row(status: ProjectedWorkoutMatch["status"], id: string): ProjectedWorkoutMatch {
  return {
    workoutId: status === "extra" ? null : id,
    activityId: status === "missed" ? null : id,
    matchId: null,
    status,
    plannedDateKey: status === "extra" ? null : 20260817,
    actualDateKey: status === "missed" ? null : 20260817,
    plannedDurationS: status === "extra" ? null : 3600,
    actualDurationS: status === "missed" ? null : 3600,
    actualSport: status === "missed" ? null : "cycling",
    requiresConfirmation: status === "decision-needed",
    createdAtMs: 1,
  };
}

describe("weekly review", () => {
  it("selects only the latest completed Monday-Sunday week after an in-week sync", () => {
    expect(
      selectWeeklyReviewWindow({
        todayDateKey: 20260828,
        planStartDateKey: 20260713,
        targetDateKey: 20261004,
        lastSuccessfulSyncDateKey: 20260828,
        enabled: true,
      }),
    ).toEqual({ weekStartDateKey: 20260817, weekEndDateKey: 20260823 });
    expect(
      selectWeeklyReviewWindow({
        todayDateKey: 20260824,
        planStartDateKey: 20260713,
        targetDateKey: 20261004,
        lastSuccessfulSyncDateKey: 20260823,
        enabled: true,
      }),
    ).toBeNull();
  });

  it("supports late opening, never selects an older backfill, and stays quiet near the race", () => {
    expect(
      selectWeeklyReviewWindow({
        todayDateKey: 20260918,
        planStartDateKey: 20260713,
        targetDateKey: 20261004,
        lastSuccessfulSyncDateKey: 20260918,
        enabled: true,
      }),
    ).toEqual({ weekStartDateKey: 20260907, weekEndDateKey: 20260913 });
    expect(
      selectWeeklyReviewWindow({
        todayDateKey: 20260928,
        planStartDateKey: 20260713,
        targetDateKey: 20261004,
        lastSuccessfulSyncDateKey: 20260928,
        enabled: true,
      }),
    ).toBeNull();
  });

  it("composes five neutral counts and pauses on unresolved sync or decisions", () => {
    expect(
      composeWeeklyReview([
        row("as-planned", "a"),
        row("adjusted", "b"),
        row("moved", "c"),
        row("missed", "d"),
        row("extra", "e"),
      ]),
    ).toEqual({
      counts: { asPlanned: 1, adjusted: 1, moved: 1, missed: 1, extra: 1 },
      summary:
        "Last week: 1 as planned, 1 adjusted, 1 moved, 1 missed, 1 extra. This is a description, not a score.",
    });
    expect(composeWeeklyReview([row("awaiting-sync", "a")])).toBeNull();
    expect(composeWeeklyReview([row("decision-needed", "a")])).toBeNull();
  });
});

describe("Plan attention ordering", () => {
  it("orders blockers, nearest dates, newest creation time, then stable id", () => {
    const base = {
      title: "Attention",
      scenarioId: "PL-S007",
      priority: "dated" as const,
      affectedDate: "2026-08-30",
      createdAtMs: 1,
    };
    expect(
      orderPlanAttentionItems([
        { ...base, id: "later", affectedDate: "2026-09-01" },
        { ...base, id: "older", createdAtMs: 2 },
        { ...base, id: "newer", createdAtMs: 3 },
        { ...base, id: "blocker", priority: "blocker", affectedDate: null },
      ]).map((item) => item.id),
    ).toEqual(["blocker", "newer", "older", "later"]);
  });
});
