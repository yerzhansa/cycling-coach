import { describe, expect, it } from "vitest";
import {
  buildActivePlanReadModel,
  buildPlanLifecycleReadModel,
} from "../src/planning-lifecycle.js";

const queue = { schemaVersion: 1 as const, revision: 0, items: [] };
const conversation = {
  id: "conversation-1",
  planId: null,
  replacesPlanId: null,
  sourceConversationId: null,
};

function build(input: Partial<Parameters<typeof buildPlanLifecycleReadModel>[0]> = {}) {
  return buildPlanLifecycleReadModel({
    conversation,
    turns: [],
    readyToCreateDraft: false,
    queue,
    decision: null,
    draft: null,
    ...input,
  });
}

describe("Plan lifecycle projection", () => {
  it("exposes read-only Season and race-week Scenarios from an active Plan", () => {
    const data = {
      plan: {
        id: "plan-1",
        name: "Gran Fondo",
        primaryGoal: "Finish",
        startDate: "2026-08-17",
        targetDate: "2026-08-30",
        kind: "full-plan" as const,
        totalWeeks: 2,
        weekStartDay: 1,
        workoutCount: 1,
        plannedDurationS: 18_000,
      },
      today: "2026-08-18",
      weekIndex: 1,
      todayWorkout: null,
      workouts: [],
      season: {
        priority: "A" as const,
        distanceKm: 120,
        weeks: [
          {
            weekIndex: 1,
            startDate: "2026-08-17",
            endDate: "2026-08-23",
            phase: "Build",
            purpose: "Develop threshold",
            status: "current" as const,
            plannedDurationS: 0,
          },
          {
            weekIndex: 2,
            startDate: "2026-08-24",
            endDate: "2026-08-30",
            phase: "Race",
            purpose: "Goal race",
            status: "planned" as const,
            plannedDurationS: 18_000,
          },
        ],
        constraint: null,
        raceWeek: {
          startDate: "2026-08-24",
          endDate: "2026-08-30",
          raceDate: "2026-08-30",
          trainingDurationS: 0,
          raceDurationS: 18_000,
          totalDurationS: 18_000,
          days: (["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const).map(
            (weekday, index) => ({
              date: `2026-08-${24 + index}`,
              weekday,
              workoutId: index === 6 ? "workout-1" : null,
              name: index === 6 ? "Gran Fondo" : "Rest",
              durationS: index === 6 ? 18_000 : null,
              purpose: index === 6 ? "Race" : "Absorb",
              kind: index === 6 ? ("race" as const) : ("rest" as const),
            }),
          ),
        },
      },
    };
    const reconciliation = {
      status: "not-applicable" as const,
      created: 0,
      pending: 0,
      failed: 0,
      total: 0,
      currentThrough: null,
      error: null,
    };
    const season = buildActivePlanReadModel({
      scenarioId: "PL-S006",
      planId: "plan-1",
      revision: 1,
      data,
      reconciliation,
    });
    expect(season).toMatchObject({ scenarioId: "PL-S006", title: "Season", projection: "active" });
    expect(season.transitions.map((transition) => transition.transitionId)).toContain("PL-T31");
    expect(
      buildActivePlanReadModel({
        scenarioId: "PL-S009",
        planId: "plan-1",
        revision: 1,
        data,
        reconciliation,
      }),
    ).toMatchObject({ scenarioId: "PL-S009", title: "Race week", projection: "active" });
  });

  it("counts every unresolved WorkoutMatch decision and opens one directly or several as a list", () => {
    const data = {
      plan: {
        id: "plan-1",
        name: "Gran Fondo",
        primaryGoal: "Finish",
        startDate: "2026-08-17",
        targetDate: null,
        kind: "short-race-preparation" as const,
        totalWeeks: 4,
        weekStartDay: 1,
        workoutCount: 2,
        plannedDurationS: 7_200,
      },
      today: "2026-08-18",
      weekIndex: 1,
      todayWorkout: null,
      workouts: ["workout-1", "workout-2"].map((id, index) => ({
        id,
        date: `2026-08-${18 + index}`,
        sport: "cycling",
        name: `Workout ${index + 1}`,
        durationS: 3_600,
        match: {
          kind: "planned" as const,
          status: "decision-needed" as const,
          activityId: `activity-${index + 1}`,
          matchId: `match-${index + 1}`,
          actualDate: `2026-08-${18 + index}`,
          actualDurationS: 3_500,
          requiresConfirmation: true,
          createdAtMs: index + 1,
        },
      })),
    };
    const multiple = buildActivePlanReadModel({
      scenarioId: "PL-S004",
      planId: "plan-1",
      revision: 0,
      data,
      reconciliation: {
        status: "not-applicable",
        created: 0,
        pending: 0,
        failed: 0,
        total: 0,
        currentThrough: null,
        error: null,
      },
    });
    expect(multiple.attention).toMatchObject({ count: 2, destination: "list" });
    const single = buildActivePlanReadModel({
      scenarioId: "PL-S004",
      planId: "plan-1",
      revision: 0,
      data: { ...data, workouts: data.workouts.slice(0, 1) },
      reconciliation: multiple.reconciliation,
    });
    expect(single.attention).toMatchObject({ count: 1, destination: "direct" });
  });

  it("only advertises Proposal actions backed by the required capabilities", () => {
    const proposalId = "proposal-1";
    const data = {
      plan: {
        id: "plan-1",
        name: "Gran Fondo",
        primaryGoal: "Finish",
        startDate: "2026-08-17",
        targetDate: null,
        kind: "short-race-preparation" as const,
        totalWeeks: 4,
        weekStartDay: 1,
        workoutCount: 1,
        plannedDurationS: 3_600,
      },
      today: "2026-08-18",
      weekIndex: 1,
      todayWorkout: null,
      workouts: [
        {
          id: "workout-1",
          date: "2026-08-18",
          sport: "cycling",
          name: "Endurance",
          durationS: 3_600,
        },
      ],
      selectedWorkoutId: null,
      selectedProposalId: proposalId,
      proposals: [
        {
          id: proposalId,
          revision: 1,
          title: "Shorten Sunday",
          rationale: "Protect recovery.",
          confidence: "High" as const,
          targetWorkoutId: "workout-1",
          affectedDate: "2026-08-18",
          createdAtMs: 1,
          stale: false,
          diff: [{ field: "week-load" as const, label: "Week load", before: "420", after: "360" }],
          premises: [],
          error: null,
        },
      ],
    };
    const base = {
      scenarioId: "PL-S007" as const,
      planId: "plan-1",
      revision: 1,
      data,
      reconciliation: {
        status: "not-applicable" as const,
        created: 0,
        pending: 0,
        failed: 0,
        total: 0,
        currentThrough: null,
        error: null,
      },
    };

    const unavailable = buildActivePlanReadModel(base);
    expect(unavailable.transitions.map((transition) => transition.transitionId)).not.toEqual(
      expect.arrayContaining(["PL-T18", "PL-T19"]),
    );

    const available = buildActivePlanReadModel({
      ...base,
      proposalCapabilities: {
        canRevise: true,
        canVerifyPremises: true,
        canCalculateLoad: true,
      },
    });
    expect(available.transitions.map((transition) => transition.transitionId)).toEqual(
      expect.arrayContaining(["PL-T18", "PL-T19"]),
    );

    const staleWithoutReviser = buildActivePlanReadModel({
      ...base,
      data: {
        ...data,
        proposals: data.proposals.map((proposal) => ({ ...proposal, stale: true })),
      },
      proposalCapabilities: {
        canRevise: false,
        canVerifyPremises: true,
        canCalculateLoad: true,
      },
    });
    expect(
      staleWithoutReviser.transitions.map((transition) => transition.transitionId),
    ).not.toContain("PL-T19");
  });

  it("advertises single-step Undo only when the server projection marks an entry eligible", () => {
    const data = {
      plan: {
        id: "plan-1",
        name: "Gran Fondo",
        primaryGoal: "Finish",
        startDate: "2026-08-17",
        targetDate: null,
        kind: "short-race-preparation" as const,
        totalWeeks: 4,
        weekStartDay: 1,
        workoutCount: 1,
        plannedDurationS: 3_600,
      },
      today: "2026-08-18",
      weekIndex: 1,
      todayWorkout: null,
      workouts: [
        {
          id: "workout-1",
          date: "2026-08-20",
          sport: "cycling",
          name: "Recovery",
          durationS: 1_800,
        },
      ],
      history: [
        {
          id: "history-1",
          kind: "proposal-applied" as const,
          label: "Sunday recovery applied",
          occurredAtMs: 20,
          targetWorkoutId: "workout-1",
          before: {
            date: "2026-08-20",
            name: "Endurance",
            durationS: 5_400,
          },
          after: {
            date: "2026-08-20",
            name: "Recovery",
            durationS: 1_800,
          },
          weekLoadBefore: 420,
          weekLoadAfter: 360,
          undoStatus: "eligible" as const,
          undoReason: null,
        },
      ],
    };
    const base = {
      scenarioId: "PL-S005" as const,
      planId: "plan-1",
      revision: 1,
      data,
      reconciliation: {
        status: "not-applicable" as const,
        created: 0,
        pending: 0,
        failed: 0,
        total: 0,
        currentThrough: null,
        error: null,
      },
    };
    expect(
      buildActivePlanReadModel(base).transitions.map((transition) => transition.transitionId),
    ).toContain("PL-T21");
    expect(
      buildActivePlanReadModel({
        ...base,
        data: {
          ...data,
          history: [
            {
              ...data.history[0]!,
              undoStatus: "expired" as const,
              undoReason: "newer-change" as const,
            },
          ],
        },
      }).transitions.map((transition) => transition.transitionId),
    ).not.toContain("PL-T21");
  });

  it("projects immediate Plan settings and the automatic-application result", () => {
    const history = {
      id: "history-1",
      kind: "proposal-applied" as const,
      label: "Sunday duration reduced",
      occurredAtMs: 20,
      targetWorkoutId: "workout-1",
      before: { date: "2026-08-30", name: "Endurance", durationS: 5_400 },
      after: { date: "2026-08-30", name: "Endurance", durationS: 2_700 },
      weekLoadBefore: null,
      weekLoadAfter: null,
      undoStatus: "eligible" as const,
      undoReason: null,
    };
    const data = {
      plan: {
        id: "plan-1",
        name: "Gran Fondo",
        primaryGoal: "Finish",
        startDate: "2026-07-13",
        targetDate: "2026-10-04",
        kind: "full-plan" as const,
        totalWeeks: 12,
        weekStartDay: 1,
        workoutCount: 1,
        plannedDurationS: 2_700,
      },
      today: "2026-08-26",
      weekIndex: 7,
      todayWorkout: null,
      workouts: [],
      history: [history],
      selectedHistoryId: history.id,
      settings: {
        autoApply: true,
        weeklyReview: true,
        updatedAtMs: 20,
        selectedSetting: "auto-apply" as const,
        error: null,
      },
    };
    const base = {
      planId: "plan-1",
      revision: 1,
      data,
      reconciliation: {
        status: "not-applicable" as const,
        created: 0,
        pending: 0,
        failed: 0,
        total: 0,
        currentThrough: null,
        error: null,
      },
    };
    const settings = buildActivePlanReadModel({ ...base, scenarioId: "PL-S090" });
    expect(settings).toMatchObject({
      title: "Plan settings",
      data: { settings: { autoApply: true, weeklyReview: true } },
    });
    expect(settings.transitions.map((transition) => transition.transitionId)).toEqual(
      expect.arrayContaining(["PL-T22", "PL-T39"]),
    );

    const automatic = buildActivePlanReadModel({ ...base, scenarioId: "PL-S101" });
    expect(automatic).toMatchObject({
      title: "Plan updated",
      data: {
        selectedHistoryId: history.id,
        history: [expect.objectContaining({ id: history.id })],
      },
    });
    expect(automatic.transitions.map((transition) => transition.transitionId)).toContain("PL-T21");
  });

  it("blocks Draft creation until an FTP source is available", () => {
    const ftp = {
      status: "required" as const,
      manual: null,
      intervalsFtp: null,
      intervalsEftp: null,
      usedSource: null,
      usedWatts: null,
      conflict: false,
      error: null,
    };
    const blocked = build({ readyToCreateDraft: true, ftp });
    expect(blocked).toMatchObject({ scenarioId: "PL-S003", projection: "coach" });
    expect(blocked.transitions.map((transition) => transition.transitionId)).not.toContain(
      "PL-T06",
    );
    expect(
      build({
        readyToCreateDraft: true,
        ftp: {
          ...ftp,
          status: "accepted",
          manual: { watts: 282, refreshedAtMs: 1 },
          usedSource: "manual",
          usedWatts: 282,
        },
      }),
    ).toMatchObject({ scenarioId: "PL-S016" });
  });

  it("projects FTP refresh, conflict, failure, and accepted return states", () => {
    const ftp = {
      status: "accepted" as const,
      manual: { watts: 282, refreshedAtMs: 1 },
      intervalsFtp: { watts: 282, refreshedAtMs: 2 },
      intervalsEftp: null,
      usedSource: "manual" as const,
      usedWatts: 282,
      conflict: false,
      error: null,
    };
    expect(build({ ftp, ftpScenario: "PL-S057" })).toMatchObject({
      scenarioId: "PL-S057",
      title: "Refreshing Intervals",
    });
    expect(
      build({
        ftp: {
          ...ftp,
          status: "conflict",
          intervalsFtp: { watts: 278, refreshedAtMs: 2 },
          conflict: true,
        },
        ftpScenario: "PL-S060",
      }),
    ).toMatchObject({ scenarioId: "PL-S060", title: "FTP source selected" });
    expect(build({ ftp, ftpScenario: "PL-S062" })).toMatchObject({
      scenarioId: "PL-S062",
      title: "FTP accepted",
    });
  });

  it("keeps the dedicated conversation available from intake through readiness", () => {
    expect(build()).toMatchObject({
      scenarioId: "PL-S017",
      lifecycle: "intake",
      projection: "coach",
    });
    const ready = build({ readyToCreateDraft: true });
    expect(ready).toMatchObject({
      scenarioId: "PL-S016",
      lifecycle: "intake",
      projection: "coach",
    });
    expect(ready.transitions.map((transition) => transition.transitionId)).toContain("PL-T06");
  });

  it("projects every Race Course recovery state without hiding a ready Draft", () => {
    const summary = {
      fileName: "almaty-gran-fondo.gpx",
      format: "gpx" as const,
      pointCount: 42,
      distanceM: 120_000,
      elevationGainM: 1_500,
      elevationStatus: "available" as const,
    };
    const draft = {
      id: "draft-1",
      planId: "plan-1",
      revision: 1,
      status: "ready" as const,
      snapshot: {},
    };
    expect(
      build({
        draft,
        courseScenario: "PL-S069",
        course: {
          status: "recalculation-failed",
          accepted: summary,
          candidate: { ...summary, fileName: "replacement.gpx" },
          fileName: null,
          detail: "Draft recalculation failed.",
        },
      }),
    ).toMatchObject({
      scenarioId: "PL-S069",
      lifecycle: "draft",
      projection: "draft",
      revision: 1,
      data: { course: { status: "recalculation-failed" } },
    });
    expect(
      build({
        courseScenario: "PL-S104",
        course: {
          status: "omission-failed",
          accepted: null,
          candidate: null,
          fileName: null,
          detail: "Nothing changed.",
        },
      }),
    ).toMatchObject({
      scenarioId: "PL-S104",
      lifecycle: "intake",
      projection: "coach",
    });
  });

  it("projects forming, revised, and discarded Draft states without losing the conversation", () => {
    expect(
      build({
        draft: { id: "draft-1", planId: "plan-1", revision: 1, status: "forming", snapshot: {} },
      }),
    ).toMatchObject({ scenarioId: "PL-S018", lifecycle: "draft-forming", projection: "draft" });
    expect(
      build({
        draft: { id: "draft-1", planId: "plan-1", revision: 2, status: "ready", snapshot: {} },
      }),
    ).toMatchObject({ scenarioId: "PL-S031", lifecycle: "draft", title: "Draft updated" });
    const discarded = build({
      draft: { id: "draft-1", planId: "plan-1", revision: 2, status: "discarded", snapshot: {} },
    });
    expect(discarded).toMatchObject({
      scenarioId: "PL-S020",
      lifecycle: "intake",
      projection: "coach",
    });
    expect(discarded.data).toMatchObject({ conversationId: "conversation-1" });
  });

  it("keeps the active Plan while a replacement Draft is discussed and formed", () => {
    const replacement = { ...conversation, planId: "plan-1", replacesPlanId: "plan-1" };
    expect(build({ conversation: replacement })).toMatchObject({
      scenarioId: "PL-S079",
      lifecycle: "replacement-intake",
    });
    expect(
      build({
        conversation: replacement,
        draft: { id: "draft-2", planId: "plan-2", revision: 1, status: "forming", snapshot: {} },
      }),
    ).toMatchObject({ scenarioId: "PL-S105", lifecycle: "replacement-draft-forming" });
  });

  it("projects replacement confirmation and the cleanup barrier before new mirror writes", () => {
    const replacementConversation = {
      ...conversation,
      planId: "plan-2",
      replacesPlanId: "plan-1",
    };
    const draft = {
      id: "draft-2",
      planId: "plan-2",
      revision: 1,
      status: "ready" as const,
      snapshot: {},
    };
    expect(
      build({
        conversation: replacementConversation,
        draft,
        replacementConfirmation: true,
      }),
    ).toMatchObject({
      scenarioId: "PL-S081",
      lifecycle: "replacement-draft",
      transitions: [
        { transitionId: "PL-T26", status: "available" },
        { transitionId: "PL-T39", status: "available" },
      ],
    });

    const data = {
      plan: {
        id: "plan-2",
        name: "Replacement Plan",
        primaryGoal: "Finish",
        startDate: "2026-08-27",
        targetDate: "2026-11-18",
        kind: "full-plan" as const,
        totalWeeks: 12,
        weekStartDay: 4,
        workoutCount: 1,
        plannedDurationS: 3_600,
      },
      today: "2026-08-26",
      weekIndex: 1,
      todayWorkout: null,
      workouts: [],
      replacement: {
        id: "replacement-1",
        previousPlan: {
          id: "plan-1",
          name: "Previous Plan",
          primaryGoal: "Finish",
          startDate: "2026-07-09",
          targetDate: "2026-09-30",
          kind: "full-plan" as const,
          totalWeeks: 12,
          weekStartDay: 4,
          workoutCount: 0,
          plannedDurationS: 0,
        },
        activatedAtMs: 100,
        cleanupItems: [],
      },
    };
    const reconciliation = {
      status: "not-started" as const,
      created: 0,
      pending: 0,
      failed: 0,
      total: 0,
      currentThrough: null,
      error: null,
    };
    expect(
      buildActivePlanReadModel({
        scenarioId: "PL-S083",
        planId: "plan-2",
        revision: 1,
        data,
        reconciliation,
      }),
    ).toMatchObject({
      title: "Old Plan cleanup needs attention",
      attention: { count: 1, destination: "direct" },
      transitions: expect.arrayContaining([
        expect.objectContaining({ transitionId: "PL-T27", status: "available" }),
      ]),
    });
    expect(
      buildActivePlanReadModel({
        scenarioId: "PL-S085",
        planId: "plan-2",
        revision: 1,
        data,
        reconciliation,
      }).transitions,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ transitionId: "PL-T28", status: "available" }),
      ]),
    );
  });

  it("keeps every Race readiness state in the active lifecycle with refresh available", () => {
    const data = {
      plan: {
        id: "plan-1",
        name: "Gran Fondo Plan",
        primaryGoal: "Finish",
        startDate: "2026-07-09",
        targetDate: "2026-09-30",
        kind: "full-plan" as const,
        totalWeeks: 12,
        weekStartDay: 4,
        workoutCount: 0,
        plannedDurationS: 0,
      },
      today: "2026-08-26",
      weekIndex: 7,
      todayWorkout: null,
      workouts: [],
    };
    const reconciliation = {
      status: "not-started" as const,
      created: 0,
      pending: 0,
      failed: 0,
      total: 0,
      currentThrough: null,
      error: null,
    };
    for (const scenarioId of [
      "PL-S012",
      "PL-S074",
      "PL-S075",
      "PL-S076",
      "PL-S077",
      "PL-S078",
      "PL-S098",
    ] as const) {
      const model = buildActivePlanReadModel({
        scenarioId,
        planId: "plan-1",
        revision: 1,
        data,
        reconciliation,
      });
      expect(model).toMatchObject({
        lifecycle: "active",
        projection: "active",
        title: "Race readiness",
        transitions: expect.arrayContaining([
          expect.objectContaining({ transitionId: "PL-T32", status: "available" }),
          expect.objectContaining({ transitionId: "PL-T39", status: "available" }),
        ]),
      });
    }
  });
});
