import { describe, expect, it } from "vitest";
import {
  ExecutePlanTransitionRpcResultSchema,
  GetPlanStateRpcResultSchema,
  PLAN_TRANSITION_IDS,
  PlanAttentionSchema,
  PlanActiveWorkoutProjectionSchema,
  PlanDraftPlanProjectionSchema,
  PlanEndedProjectionDataSchema,
  PlanFtpProjectionSchema,
  PlanHydrationStateSchema,
  PlanProgressEventSchema,
  PlanRaceCourseProjectionSchema,
  PlanReadinessProjectionSchema,
  PlanSeasonProjectionSchema,
  PlanSettingsProjectionSchema,
  PlanStartDateProjectionSchema,
  PlanScenarioIdSchema,
  PlanTransitionCommandSchema,
  type PlanTransitionCommand,
} from "../src/planning.js";

const commandId = "command-1";
const planId = "plan-1";
const draftId = "draft-1";
const conversationId = "conversation-1";
const proposalId = "proposal-1";
const requestId = "request-1";
const workoutId = "workout-1";
const eventId = "event-1";

const commands = [
  { transitionId: "PL-T01", commandId, sourceConversationId: null },
  {
    transitionId: "PL-T02",
    commandId,
    conversationId,
    filePath: "/tmp/course.gpx",
    elevation: "require",
  },
  { transitionId: "PL-T03", commandId, conversationId },
  { transitionId: "PL-T04", commandId, conversationId, source: "manual", watts: 282 },
  { transitionId: "PL-T05", commandId, conversationId, text: "Four days each week" },
  { transitionId: "PL-T06", commandId, conversationId },
  { transitionId: "PL-T07", commandId, draftId, text: "Move Friday to Thursday" },
  { transitionId: "PL-T08", commandId, draftId, startDate: "1998-07-13" },
  {
    transitionId: "PL-T09",
    commandId,
    draftId,
    course: { action: "attach", filePath: "/tmp/course.fit", elevation: "allow-missing" },
  },
  { transitionId: "PL-T10", commandId, draftId },
  { transitionId: "PL-T11", commandId, draftId, expectedRevision: 2 },
  { transitionId: "PL-T12", commandId, planId },
  { transitionId: "PL-T13", commandId, planId, workoutId },
  { transitionId: "PL-T14", commandId, planId, workoutId, activityId: "activity-1" },
  { transitionId: "PL-T15", commandId, planId, workoutId, eventId },
  { transitionId: "PL-T16", commandId, planId, workoutId, eventId },
  {
    transitionId: "PL-T17",
    commandId,
    planId,
    proposalId,
    selectedProposalReturn: {
      sourceScenarioId: "PL-S010",
      returnFocusId: "workout-row-1",
    },
  },
  { transitionId: "PL-T18", commandId, proposalId, text: "Make it thirty minutes" },
  { transitionId: "PL-T19", commandId, proposalId, expectedRevision: 3 },
  { transitionId: "PL-T20", commandId, proposalId },
  { transitionId: "PL-T21", commandId, planId, ledgerId: "ledger-1" },
  { transitionId: "PL-T22", commandId, planId, setting: "auto-apply", value: true },
  { transitionId: "PL-T23", commandId, planId },
  { transitionId: "PL-T24", commandId, planId },
  { transitionId: "PL-T25", commandId, planId },
  {
    transitionId: "PL-T26",
    commandId,
    activePlanId: planId,
    draftId,
    expectedRevision: 4,
  },
  { transitionId: "PL-T27", commandId, planId, replacementPlanId: "plan-2" },
  { transitionId: "PL-T28", commandId, planId },
  { transitionId: "PL-T29", commandId, planId, asOf: "1998-10-05" },
  { transitionId: "PL-T30", commandId, planId, outcome: "completed" },
  { transitionId: "PL-T31", commandId, planId },
  { transitionId: "PL-T32", commandId, planId },
  { transitionId: "PL-T33", commandId, planId },
  { transitionId: "PL-T34", commandId, attentionId: "attention-1" },
  { transitionId: "PL-T35", commandId, planId, weekStart: "1998-08-17" },
  {
    transitionId: "PL-T36",
    commandId,
    sourceConversationId: conversationId,
    requestId,
  },
  { transitionId: "PL-T37", commandId, sourceConversationId: conversationId, requestId },
  { transitionId: "PL-T38", commandId, planId, proposalId, expectedRevision: 5 },
  {
    transitionId: "PL-T39",
    commandId,
    action: "open",
    sourceScenarioId: "PL-S004",
    destinationScenarioId: "PL-S021",
    returnFocusId: "workout-row-1",
  },
  {
    transitionId: "PL-T40",
    commandId,
    requestId,
    resolution: { kind: "use-date", date: "1998-08-26" },
  },
] satisfies PlanTransitionCommand[];

const state = {
  schemaVersion: 1 as const,
  scenarioId: "PL-S004",
  lifecycle: "active" as const,
  planId,
  revision: 6,
  title: "Gran Fondo Almaty",
  summary: "Build phase",
  projection: "active" as const,
  transitions: [
    { transitionId: "PL-T13" as const, status: "available" as const, reason: null },
    { transitionId: "PL-T23" as const, status: "available" as const, reason: null },
  ],
  reconciliation: {
    status: "not-started" as const,
    created: 0,
    pending: 0,
    failed: 0,
    total: 0,
    currentThrough: null,
    error: null,
  },
  attention: { count: 0, destination: "none" as const, items: [] },
  activeOperation: null,
  data: { week: 6 },
};

describe("planning contract", () => {
  it("accepts every canonical scenario identifier and rejects identifiers outside the ledger", () => {
    for (let index = 1; index <= 105; index += 1) {
      expect(PlanScenarioIdSchema.parse(`PL-S${String(index).padStart(3, "0")}`)).toBe(
        `PL-S${String(index).padStart(3, "0")}`,
      );
    }
    for (const value of ["PL-S000", "PL-S106", "PL-S01", "PL-T01"]) {
      expect(PlanScenarioIdSchema.safeParse(value).success).toBe(false);
    }
  });

  it("accepts one strict command for every lifecycle transition", () => {
    expect(
      commands.map((command) => PlanTransitionCommandSchema.parse(command).transitionId),
    ).toEqual(PLAN_TRANSITION_IDS);
  });

  it("rejects missing, extra, and transition-specific command fields", () => {
    expect(
      PlanTransitionCommandSchema.safeParse({
        transitionId: "PL-T12",
        commandId,
        planId,
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      PlanTransitionCommandSchema.safeParse({ transitionId: "PL-T08", commandId, draftId }).success,
    ).toBe(false);
    expect(
      PlanTransitionCommandSchema.safeParse({
        transitionId: "PL-T17",
        commandId,
        planId,
        proposalId,
        selectedProposalReturn: {
          sourceScenarioId: "PL-S010",
          returnFocusId: "",
        },
      }).success,
    ).toBe(false);
    expect(
      PlanTransitionCommandSchema.safeParse({
        transitionId: "PL-T04",
        commandId,
        conversationId,
        source: "manual",
        watts: null,
      }).success,
    ).toBe(false);
    expect(
      PlanTransitionCommandSchema.safeParse({
        transitionId: "PL-T09",
        commandId,
        draftId,
        course: { action: "remove" },
      }).success,
    ).toBe(true);
    expect(
      PlanTransitionCommandSchema.safeParse({
        transitionId: "PL-T04",
        commandId,
        conversationId,
        source: "intervals-ftp",
        watts: 282,
      }).success,
    ).toBe(false);
    expect(
      PlanTransitionCommandSchema.safeParse({
        transitionId: "PL-T04",
        commandId,
        conversationId,
        source: "intervals",
        watts: null,
      }).success,
    ).toBe(true);
    expect(
      PlanTransitionCommandSchema.safeParse({
        transitionId: "PL-T24",
        commandId,
        planId,
        mode: "verify",
      }).success,
    ).toBe(true);
    expect(
      PlanTransitionCommandSchema.safeParse({
        transitionId: "PL-T24",
        commandId,
        planId,
        mode: "continue-anyway",
      }).success,
    ).toBe(false);
  });

  it("keeps selected FTP source, value, conflicts, and refresh failures coherent", () => {
    const accepted = {
      status: "accepted" as const,
      manual: { watts: 282, refreshedAtMs: 1 },
      intervalsFtp: { watts: 282, refreshedAtMs: 2 },
      intervalsEftp: null,
      usedSource: "manual" as const,
      usedWatts: 282,
      conflict: false,
      error: null,
    };
    expect(PlanFtpProjectionSchema.parse(accepted)).toEqual(accepted);
    expect(PlanFtpProjectionSchema.safeParse({ ...accepted, usedWatts: 278 }).success).toBe(false);
    expect(
      PlanFtpProjectionSchema.safeParse({
        ...accepted,
        status: "conflict",
        intervalsFtp: { watts: 278, refreshedAtMs: 2 },
        conflict: true,
      }).success,
    ).toBe(true);
    expect(
      PlanFtpProjectionSchema.safeParse({
        ...accepted,
        status: "refresh-failed",
        error: { code: "provider-failed", message: "Refresh failed", retryable: true },
      }).success,
    ).toBe(true);
    expect(
      PlanFtpProjectionSchema.safeParse({ ...accepted, status: "accepted", error: {} }).success,
    ).toBe(false);
  });

  it("keeps Plan settings values, the selected control, and save errors coherent", () => {
    const settings = {
      autoApply: false,
      weeklyReview: true,
      updatedAtMs: 42,
      selectedSetting: "auto-apply" as const,
      error: null,
    };
    expect(PlanSettingsProjectionSchema.parse(settings)).toEqual(settings);
    expect(
      PlanSettingsProjectionSchema.parse({
        ...settings,
        error: { code: "persistence-failed", message: "Could not save.", retryable: true },
      }),
    ).toMatchObject({ selectedSetting: "auto-apply", error: { retryable: true } });
    expect(
      PlanSettingsProjectionSchema.safeParse({ ...settings, selectedSetting: "all" }).success,
    ).toBe(false);
    expect(PlanSettingsProjectionSchema.safeParse({ ...settings, saveAll: true }).success).toBe(
      false,
    );
  });

  it("keeps Race Course transition intent and projection states coherent", () => {
    expect(
      PlanTransitionCommandSchema.safeParse({
        transitionId: "PL-T02",
        commandId,
        conversationId,
        filePath: "/tmp/course.gpx",
      }).success,
    ).toBe(false);
    const summary = {
      fileName: "course.gpx",
      format: "gpx" as const,
      pointCount: 42,
      distanceM: 120_000,
      elevationGainM: null,
      elevationStatus: "unavailable" as const,
    };
    expect(
      PlanRaceCourseProjectionSchema.parse({
        status: "missing-elevation",
        accepted: null,
        candidate: summary,
        fileName: null,
        detail: null,
      }),
    ).toMatchObject({ status: "missing-elevation", candidate: summary });
    expect(
      PlanRaceCourseProjectionSchema.safeParse({
        status: "ready",
        accepted: null,
        candidate: summary,
        fileName: null,
        detail: null,
      }).success,
    ).toBe(false);
    expect(
      PlanRaceCourseProjectionSchema.safeParse({
        status: "missing-elevation",
        accepted: null,
        candidate: { ...summary, elevationGainM: 900, elevationStatus: "available" },
        fileName: null,
        detail: null,
      }).success,
    ).toBe(false);
  });

  it("keeps Draft plan and start-date consequences explicit", () => {
    expect(
      PlanDraftPlanProjectionSchema.parse({
        id: planId,
        name: "Gran Fondo Plan",
        primaryGoal: "Finish in the front half",
        startDate: "2026-07-13",
        targetDate: "2026-10-04",
        kind: "full-plan",
        totalWeeks: 12,
        weekStartDay: 1,
        workoutCount: 58,
        plannedDurationS: 309_600,
        phaseSummary: ["Build", "Recovery", "Taper", "Race"],
        ftpWatts: 282,
      }),
    ).toMatchObject({
      kind: "full-plan",
      totalWeeks: 12,
      phaseSummary: ["Build", "Recovery", "Taper", "Race"],
      ftpWatts: 282,
    });
    expect(
      PlanActiveWorkoutProjectionSchema.parse({
        id: workoutId,
        date: "1998-08-22",
        sport: "cycling",
        name: "Recovery spin",
        durationS: 2_700,
        powerTargetW: { min: 130, max: 165 },
        cue: "Keep the pedals light.",
      }),
    ).toMatchObject({ powerTargetW: { min: 130, max: 165 } });
    const updated = {
      status: "updated" as const,
      selectedDate: "2026-07-20",
      today: "2026-07-13",
      targetDate: "2026-10-04",
      kind: "short-race-preparation" as const,
      inclusiveDays: 77,
      totalWeeks: 11,
      raceWeekday: 0,
      raceDayOfPlanWeek: 7,
      error: null,
    };
    expect(PlanStartDateProjectionSchema.parse(updated)).toEqual(updated);
    expect(PlanStartDateProjectionSchema.safeParse({ ...updated, status: "invalid" }).success).toBe(
      false,
    );
  });

  it("keeps canonical race-outcome detail aligned with the stored outcome", () => {
    const plan = {
      id: planId,
      name: "Gran Fondo Almaty",
      primaryGoal: "Finish in the front half",
      startDate: "1998-07-13",
      targetDate: "1998-10-04",
      kind: "full-plan" as const,
      totalWeeks: 12,
      weekStartDay: 1,
      workoutCount: 58,
      plannedDurationS: 309_600,
    };
    const raceOutcomeDetails = {
      outcome: "completed" as const,
      raceDate: "1998-10-04",
      goal: "Front half",
      result: "Front third",
      trainingDurationS: 303_600,
      raceDurationS: 18_180,
      totalDurationS: 321_780,
      modeledFinishMinutes: { min: 288, max: 312 },
      actualDurationS: 18_180,
      appliedChangeCount: 12,
    };
    const value = {
      plan,
      endedAtMs: 1,
      raceOutcome: "completed" as const,
      raceOutcomeDetails,
      cleanupItems: [],
    };
    expect(PlanEndedProjectionDataSchema.safeParse(value).success).toBe(true);
    expect(
      PlanEndedProjectionDataSchema.safeParse({ ...value, raceOutcome: "not-completed" }).success,
    ).toBe(false);
  });

  it("encodes the approved attention count and destination rule", () => {
    expect(PlanAttentionSchema.parse({ count: 0, destination: "none", items: [] })).toEqual({
      count: 0,
      destination: "none",
      items: [],
    });
    const item = {
      id: "attention-1",
      title: "Confirm Sunday endurance",
      scenarioId: "PL-S028",
      priority: "dated",
      affectedDate: "1998-08-23",
      createdAtMs: 1,
    };
    expect(
      PlanAttentionSchema.safeParse({ count: 1, destination: "direct", items: [item] }).success,
    ).toBe(true);
    expect(
      PlanAttentionSchema.safeParse({ count: 1, destination: "list", items: [item] }).success,
    ).toBe(false);
  });

  it("keeps Season weeks contiguous and race accounting exact", () => {
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((weekday, index) => ({
      date: `1998-08-${17 + index}`,
      weekday,
      workoutId: index === 6 ? "race-1" : null,
      name: index === 6 ? "Goal race" : "Rest",
      durationS: index === 6 ? 18_000 : null,
      purpose: index === 6 ? "Race" : "Absorb",
      kind: index === 6 ? "race" : "rest",
    }));
    const season = {
      priority: "A",
      distanceKm: 120,
      weeks: [
        {
          weekIndex: 1,
          startDate: "1998-08-17",
          endDate: "1998-08-23",
          phase: "Race",
          purpose: "Goal race",
          status: "current",
          plannedDurationS: 18_000,
        },
      ],
      constraint: null,
      raceWeek: {
        startDate: "1998-08-17",
        endDate: "1998-08-23",
        raceDate: "1998-08-23",
        trainingDurationS: 0,
        raceDurationS: 18_000,
        totalDurationS: 18_000,
        days,
      },
    };
    expect(PlanSeasonProjectionSchema.safeParse(season).success).toBe(true);
    expect(
      PlanSeasonProjectionSchema.safeParse({
        ...season,
        raceWeek: { ...season.raceWeek, totalDurationS: 17_000 },
      }).success,
    ).toBe(false);
    expect(
      PlanSeasonProjectionSchema.safeParse({
        ...season,
        weeks: [{ ...season.weeks[0], weekIndex: 2 }],
      }).success,
    ).toBe(false);
  });

  it("keeps Race readiness modeled, unavailable, and refresh intent explicit", () => {
    const readiness = {
      form: {
        status: "available",
        asOf: "1998-08-22",
        current: 1,
        raceRange: { min: 4, max: 9 },
        assumptions: ["Planned training", "Normal recovery"],
        unavailableReason: null,
        lastSuccessfulRefreshAtMs: 100,
      },
      feasibility: {
        verdict: "on-track",
        supportedDistanceKm: { min: 135, max: 145 },
        reasons: ["The modeled range supports the goal"],
        recommendation: "Continue the approved Plan",
      },
      courseEstimate: {
        status: "available",
        rangeMinutes: { min: 288, max: 312 },
        previousRangeMinutes: null,
        confidence: "moderate",
        assumptions: ["Dry roads", "Low wind"],
        changedAssumption: null,
        unavailableReason: null,
      },
      estimatedCp: {
        status: "available",
        watts: 287,
        calculatedOn: "1998-08-22",
        lastSuccessfulSyncAtMs: 100,
        unavailableReason: null,
        efforts: [
          {
            activityId: "ride-short",
            ride: "Tuesday Hill Repeats",
            date: "1998-08-18",
            durationS: 180,
            averagePowerW: 407,
            device: "Favero Assioma Duo",
          },
          {
            activityId: "ride-long",
            ride: "Sunday Tempo Climb",
            date: "1998-08-09",
            durationS: 900,
            averagePowerW: 311,
            device: "Garmin Rally RS200",
          },
        ],
      },
      evidence: {
        prescribedDurationS: 154_800,
        riddenDurationS: 142_800,
        adjustedDurationS: 7_800,
        missedKeyWorkouts: 0,
        fatigue: "normal",
      },
      taperRefusal: null,
      error: null,
    };
    expect(PlanReadinessProjectionSchema.parse(readiness)).toEqual(readiness);
    expect(
      PlanReadinessProjectionSchema.safeParse({
        ...readiness,
        estimatedCp: { ...readiness.estimatedCp, watts: 0 },
      }).success,
    ).toBe(true);
    expect(
      PlanReadinessProjectionSchema.safeParse({
        ...readiness,
        form: {
          ...readiness.form,
          status: "unavailable",
          raceRange: null,
          unavailableReason: "missing-planned-load",
        },
      }).success,
    ).toBe(true);
    expect(
      PlanReadinessProjectionSchema.safeParse({
        ...readiness,
        courseEstimate: { ...readiness.courseEstimate, rangeMinutes: null },
      }).success,
    ).toBe(false);
    expect(
      PlanReadinessProjectionSchema.safeParse({
        ...readiness,
        estimatedCp: { ...readiness.estimatedCp, efforts: [] },
      }).success,
    ).toBe(false);
    expect(
      PlanReadinessProjectionSchema.safeParse({
        ...readiness,
        estimatedCp: {
          ...readiness.estimatedCp,
          status: "unavailable",
          unavailableReason: "missing-effort",
        },
      }).success,
    ).toBe(false);
    expect(
      PlanReadinessProjectionSchema.safeParse({
        ...readiness,
        estimatedCp: {
          ...readiness.estimatedCp,
          status: "stale",
          lastSuccessfulSyncAtMs: null,
        },
      }).success,
    ).toBe(false);
    expect(
      PlanTransitionCommandSchema.parse({
        transitionId: "PL-T32",
        commandId,
        planId,
        mode: "refresh",
      }),
    ).toMatchObject({ transitionId: "PL-T32", mode: "refresh" });
  });

  it("keeps loading, stale, failed, and unsupported hydration explicit", () => {
    expect(PlanHydrationStateSchema.parse({ status: "loading" })).toEqual({ status: "loading" });
    expect(
      PlanHydrationStateSchema.parse({
        status: "unsupported-capability",
        capability: "planning",
      }),
    ).toEqual({ status: "unsupported-capability", capability: "planning" });
    expect(GetPlanStateRpcResultSchema.parse({ status: "ready", state })).toEqual({
      status: "ready",
      state,
    });
    expect(GetPlanStateRpcResultSchema.safeParse({ status: "failed" }).success).toBe(false);
  });

  it("validates transition progress and terminal results", () => {
    const progress = {
      commandId,
      transitionId: "PL-T12" as const,
      operationId: "operation-1",
      phase: "completed" as const,
      completed: 7,
      total: 7,
    };
    expect(PlanProgressEventSchema.parse(progress)).toEqual(progress);
    expect(PlanProgressEventSchema.safeParse({ ...progress, completed: 6 }).success).toBe(false);
    const running = {
      ...progress,
      transitionId: "PL-T05" as const,
      phase: "running" as const,
      completed: 0,
      turnEvent: {
        type: "turn-start" as const,
        turnId: "turn-1",
        chatId: "plan:00000000000000000000000001",
      },
    };
    expect(PlanProgressEventSchema.parse(running)).toEqual(running);
    expect(
      PlanProgressEventSchema.safeParse({ ...running, phase: "completed", completed: 1 }).success,
    ).toBe(false);
    expect(ExecutePlanTransitionRpcResultSchema.parse({ status: "completed", state })).toEqual({
      status: "completed",
      state,
    });
  });

  it("keeps Plan coach decisions inside PL-T05", () => {
    const decision = {
      transitionId: "PL-T05" as const,
      commandId,
      conversationId,
      text: "Keep Saturday available",
      decision: {
        action: "answer" as const,
        decisionId: "decision-1",
        answer: { kind: "option" as const, optionId: "option-1" },
      },
    };
    expect(PlanTransitionCommandSchema.parse(decision)).toEqual(decision);
    expect(
      PlanTransitionCommandSchema.safeParse({
        ...decision,
        decision: { action: "answer", decisionId: "decision-1" },
      }).success,
    ).toBe(false);
  });
});
