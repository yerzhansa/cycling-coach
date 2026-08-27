import { describe, expect, it } from "vitest";
import { projectPlanSeason } from "../src/planning/season.js";

const plan = {
  id: "plan-1",
  name: "Gran Fondo Almaty",
  primaryGoal: "Finish in the front half",
  startDate: "2026-07-13",
  targetDate: "2026-07-26",
  kind: "full-plan" as const,
  totalWeeks: 2,
  weekStartDay: 1,
  workoutCount: 3,
  plannedDurationS: 27_000,
};

const workouts = [
  {
    id: "easy",
    date: "2026-07-14",
    sport: "cycling",
    name: "Easy endurance",
    durationS: 3_600,
  },
  {
    id: "openers",
    date: "2026-07-25",
    sport: "cycling",
    name: "Pre-race spin",
    durationS: 3_600,
  },
  {
    id: "race",
    date: "2026-07-26",
    sport: "cycling",
    name: "Gran Fondo Almaty",
    durationS: 18_000,
  },
];

describe("Plan Season projection", () => {
  it("projects every civil week and marks completed, current, and blocked status", () => {
    const season = projectPlanSeason({
      plan,
      today: "2026-07-20",
      workouts,
      metadata: {
        weeks: [
          { phase: "Base", purpose: "Endurance" },
          { phase: "Taper", purpose: "Freshen" },
        ],
        priority: "A",
        distanceKm: 120,
        constraint: { weekIndex: 2, title: "Sync down", detail: "Plan is authoritative." },
      },
    });
    expect(season.weeks).toEqual([
      expect.objectContaining({
        weekIndex: 1,
        startDate: "2026-07-13",
        endDate: "2026-07-19",
        status: "completed",
        plannedDurationS: 3_600,
      }),
      expect.objectContaining({
        weekIndex: 2,
        startDate: "2026-07-20",
        endDate: "2026-07-26",
        phase: "Race",
        purpose: "Goal race",
        status: "blocked",
        plannedDurationS: 21_600,
      }),
    ]);
  });

  it("keeps race time separate and inserts honest rest days", () => {
    const raceWeek = projectPlanSeason({
      plan,
      today: "2026-07-20",
      workouts,
      metadata: { weeks: [], priority: null, distanceKm: null, constraint: null },
    }).raceWeek!;
    expect(raceWeek).toMatchObject({
      startDate: "2026-07-20",
      endDate: "2026-07-26",
      raceDate: "2026-07-26",
      trainingDurationS: 3_600,
      raceDurationS: 18_000,
      totalDurationS: 21_600,
    });
    expect(raceWeek.days).toHaveLength(7);
    expect(raceWeek.days[0]).toMatchObject({ weekday: "Mon", name: "Rest", kind: "rest" });
    expect(raceWeek.days[6]).toMatchObject({
      weekday: "Sun",
      workoutId: "race",
      kind: "race",
    });
  });

  it("keeps a midweek race fixed inside its Plan week", () => {
    const midweek = projectPlanSeason({
      plan: { ...plan, targetDate: "2026-07-22" },
      today: "2026-07-20",
      workouts: [{ ...workouts[2]!, date: "2026-07-22" }],
      metadata: { weeks: [], priority: null, distanceKm: null, constraint: null },
    }).raceWeek!;
    expect(midweek.startDate).toBe("2026-07-20");
    expect(midweek.days[2]).toMatchObject({ weekday: "Wed", kind: "race", workoutId: "race" });
  });

  it("degrades missing optional phase metadata without losing the read", () => {
    expect(
      projectPlanSeason({
        plan: { ...plan, targetDate: null },
        today: "2026-07-01",
        workouts: [],
        metadata: { weeks: [], priority: null, distanceKm: null, constraint: null },
      }),
    ).toMatchObject({
      weeks: [
        expect.objectContaining({ phase: "Plan", purpose: "Follow the approved week" }),
        expect.objectContaining({ phase: "Plan", purpose: "Follow the approved week" }),
      ],
      raceWeek: null,
    });
  });
});
