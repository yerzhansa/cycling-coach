import type { DesktopFixtureScript, RunningDesktopFixture } from "./desktop-fixture.js";
import { PlanReadModelSchema } from "@enduragent/coach-contract";
import { launchDesktopFixture } from "./desktop-fixture.js";
import {
  planAttention,
  planCoachData,
  planReadModel,
} from "../../../desktop-renderer/tests/plan-fixtures.js";

const token = "q".repeat(43);
const scenario = process.env.PLAN_QA_SCENARIO ?? "PL-S001";
const planId = "plan-qa";

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

const workouts = [
  ["workout-1", "1998-08-18", "Endurance", 5_400, "as-planned", false],
  ["workout-2", "1998-08-19", "Threshold 4×8", 4_800, "adjusted", false],
  ["workout-3", "1998-08-20", "Easy endurance", 3_000, "moved", false],
  ["workout-4", "1998-08-21", "Recovery", 2_700, "missed", false],
  ["workout-5", "1998-08-22", "Café ride", 7_500, "extra", false],
  ["workout-6", "1998-08-23", "Suggested endurance", 1_800, "decision-needed", true],
].map(([id, date, name, durationS, status, requiresConfirmation], index) => ({
  id: String(id),
  date: String(date),
  sport: "cycling",
  name: String(name),
  durationS: Number(durationS),
  match: {
    kind: status === "extra" ? ("extra" as const) : ("planned" as const),
    status: status as "as-planned" | "adjusted" | "moved" | "missed" | "extra" | "decision-needed",
    activityId: status === "upcoming" ? null : `activity-${index + 1}`,
    matchId: `match-${index + 1}`,
    actualDate: String(date),
    actualDurationS: Number(durationS),
    requiresConfirmation: Boolean(requiresConfirmation),
    createdAtMs: index + 1,
  },
}));

const todayWorkout = {
  ...workouts[3],
  id: "today-recovery",
  date: "1998-08-22",
  name: "Recovery spin",
  durationS: 2_700,
  match: {
    ...workouts[3]!.match,
    activityId: "activity-today",
    matchId: "match-today",
    actualDate: "1998-08-22",
    actualDurationS: 2_700,
  },
};

const history = [
  {
    id: "history-adjustment",
    kind: "proposal-applied" as const,
    label: "Sunday adjustment applied",
    occurredAtMs: 903_766_320_000,
    targetWorkoutId: "workout-6",
    before: { date: "1998-08-23", name: "Endurance", durationS: 5_400 },
    after: { date: "1998-08-23", name: "Recovery", durationS: 1_800 },
    weekLoadBefore: 420,
    weekLoadAfter: 360,
    undoStatus: "eligible" as const,
    undoReason: null,
  },
  {
    id: "history-activation",
    kind: "activation" as const,
    label: "Plan approved",
    occurredAtMs: 900_331_200_000,
    targetWorkoutId: null,
    before: null,
    after: null,
    weekLoadBefore: null,
    weekLoadAfter: null,
    undoStatus: "none" as const,
    undoReason: null,
  },
];

const seasonDates = [
  ["1998-07-13", "1998-07-19"],
  ["1998-07-20", "1998-07-26"],
  ["1998-07-27", "1998-08-02"],
  ["1998-08-03", "1998-08-09"],
  ["1998-08-10", "1998-08-16"],
  ["1998-08-17", "1998-08-23"],
  ["1998-08-24", "1998-08-30"],
  ["1998-08-31", "1998-09-06"],
  ["1998-09-07", "1998-09-13"],
  ["1998-09-14", "1998-09-20"],
  ["1998-09-21", "1998-09-27"],
  ["1998-09-28", "1998-10-04"],
] as const;

const seasonWeeks = seasonDates.map(([startDate, endDate], index) => ({
  weekIndex: index + 1,
  startDate,
  endDate,
  phase: index === 11 ? "Race" : index >= 10 ? "Taper" : index === 3 ? "Recovery" : "Build",
  purpose: index === 11 ? "Goal race" : "Follow the approved week",
  status:
    index === 5 ? ("current" as const) : index < 5 ? ("completed" as const) : ("planned" as const),
  plannedDurationS: index === 11 ? 29_100 : 32_400,
}));

const raceWeek = {
  startDate: "1998-09-28",
  endDate: "1998-10-04",
  raceDate: "1998-10-04",
  trainingDurationS: 11_100,
  raceDurationS: 18_000,
  totalDurationS: 29_100,
  days: [
    ["1998-09-28", "Mon", null, "Rest", null, "Absorb", "rest"],
    ["1998-09-29", "Tue", "race-1", "Openers · 3×1 min", 2_700, "Sharpen", "training"],
    ["1998-09-30", "Wed", "race-2", "Easy endurance", 3_000, "Maintain", "training"],
    ["1998-10-01", "Thu", null, "Rest", null, "Freshen", "rest"],
    ["1998-10-02", "Fri", "race-3", "Race opener", 1_800, "Sharpen", "training"],
    ["1998-10-03", "Sat", "race-4", "Pre-race spin", 3_600, "Prime", "training"],
    ["1998-10-04", "Sun", "race-5", "Gran Fondo Almaty", 18_000, "Race", "race"],
  ].map(([date, weekday, workoutId, name, durationS, purpose, kind]) => ({
    date: String(date),
    weekday: weekday as "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun",
    workoutId: workoutId === null ? null : String(workoutId),
    name: String(name),
    durationS: durationS === null ? null : Number(durationS),
    purpose: String(purpose),
    kind: kind as "training" | "rest" | "race",
  })),
};

const activeData = {
  plan,
  today: "1998-08-22",
  weekIndex: 6,
  todayWorkout,
  workouts,
  matchSync: { lastSuccessfulSyncAtMs: 903_766_320_000, awaitingSync: false },
  selectedWorkoutId: null,
  history,
  settings: {
    autoApply: false,
    weeklyReview: true,
    updatedAtMs: 903_766_320_000,
    selectedSetting: null,
    error: null,
  },
  season: {
    priority: "A" as const,
    distanceKm: 120,
    weeks: seasonWeeks,
    constraint: {
      weekIndex: 8,
      title: "FTP refresh required before Build 2",
      detail: "Later durations stay fixed; power targets wait for refreshed FTP.",
    },
    raceWeek,
  },
  readiness: {
    form: {
      status: "available" as const,
      asOf: "1998-08-22",
      current: 1,
      raceRange: { min: 4, max: 9 },
      assumptions: ["Planned load is completed", "Recovery remains normal"],
      unavailableReason: null,
      lastSuccessfulRefreshAtMs: 903_766_320_000,
    },
    feasibility: {
      verdict: "on-track" as const,
      supportedDistanceKm: { min: 115, max: 130 },
      reasons: ["Training is consistent"],
      recommendation: "Keep the approved taper",
    },
    courseEstimate: {
      status: "available" as const,
      rangeMinutes: { min: 288, max: 312 },
      previousRangeMinutes: null,
      confidence: "moderate" as const,
      assumptions: ["Dry roads", "Low wind", "Planned fueling", "No mechanical delay"],
      changedAssumption: null,
      unavailableReason: null,
    },
    estimatedCp: {
      status: "available" as const,
      watts: 287,
      calculatedOn: "1998-08-22",
      lastSuccessfulSyncAtMs: 903_766_320_000,
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
      fatigue: "normal" as const,
    },
    taperRefusal: null,
    error: null,
  },
};

function modelFor(id: string) {
  if (id === "PL-S001") return planReadModel();
  if (id === "PL-S017" || id === "PL-S016") {
    return planReadModel({
      lifecycle: "intake",
      scenarioId: id as "PL-S017" | "PL-S016",
      projection: "coach",
      data: planCoachData({
        ready: id === "PL-S016",
        course: {
          status: "undecided",
          accepted: null,
          candidate: null,
          fileName: null,
          detail: null,
        },
        messages: [
          {
            id: "coach-1",
            turnId: null,
            role: "coach",
            text: "Let’s build this here in Plan. What event are you training toward?",
          },
          {
            id: "athlete-1",
            turnId: "turn-1",
            role: "athlete",
            text: "Gran Fondo Almaty on 4 October. I want to finish in the front half.",
          },
          {
            id: "coach-2",
            turnId: "turn-1",
            role: "coach",
            text: "I found your recent rides, recovery, weekly availability, and FTP 282 W. Add a Race Course now, or keep the Draft course-agnostic.",
          },
        ],
      }),
    });
  }
  if (id === "PL-S003") {
    return planReadModel({
      lifecycle: "intake",
      scenarioId: "PL-S003",
      projection: "coach",
      data: planCoachData({
        ftp: {
          status: "required",
          manual: null,
          intervalsFtp: null,
          intervalsEftp: null,
          usedSource: null,
          usedWatts: null,
          conflict: false,
          error: null,
        },
      }),
    });
  }
  if (id === "PL-S102") {
    return planReadModel({
      lifecycle: "ended",
      scenarioId: "PL-S102",
      projection: "coach",
      planId,
      data: planCoachData({
        messages: [
          {
            id: "coach-history-1",
            turnId: null,
            role: "coach",
            text: "Let’s build this here in Plan. What event are you training toward?",
          },
          {
            id: "athlete-history-1",
            turnId: "turn-history-1",
            role: "athlete",
            text: "Gran Fondo Almaty on 4 October. I want to finish in the front half.",
          },
          {
            id: "coach-history-2",
            turnId: "turn-history-1",
            role: "coach",
            text: "I found your recent rides, recovery, weekly availability, and FTP 282 W.",
          },
        ],
      }),
    });
  }
  if (["PL-S002", "PL-S031", "PL-S050", "PL-S070"].includes(id)) {
    return planReadModel({
      lifecycle: "draft",
      scenarioId: id as "PL-S002" | "PL-S031" | "PL-S050" | "PL-S070",
      projection: "draft",
      planId,
      revision: id === "PL-S002" ? 1 : 2,
      data: planCoachData({
        draft: {
          id: "draft-qa",
          planId,
          revision: id === "PL-S002" ? 1 : 2,
          status: "ready",
          snapshot: { completeWeeks: 12 },
        },
        plan,
        course: {
          status: "omitted",
          accepted: null,
          candidate: null,
          fileName: null,
          detail: null,
        },
        startDate: {
          status: id === "PL-S050" ? "updated" : "ready",
          selectedDate: "1998-07-13",
          today: "1998-07-13",
          targetDate: "1998-10-04",
          kind: "full-plan",
          inclusiveDays: 84,
          totalWeeks: 12,
          raceWeekday: 0,
          raceDayOfPlanWeek: 7,
          error: null,
        },
      }),
    });
  }
  if (
    id === "PL-S014" ||
    id === "PL-S089" ||
    id === "PL-S094" ||
    id === "PL-S095" ||
    id === "PL-S096"
  ) {
    const cleanupFailed = id === "PL-S014";
    return planReadModel({
      lifecycle: "ended",
      scenarioId: id as "PL-S014" | "PL-S089" | "PL-S094" | "PL-S095" | "PL-S096",
      projection: "ended",
      planId,
      reconciliation: cleanupFailed
        ? {
            status: "failed",
            created: 0,
            pending: 0,
            failed: 1,
            total: 1,
            currentThrough: null,
            error: {
              code: "provider-failed",
              message: "Cleanup could not be verified.",
              retryable: true,
            },
          }
        : {
            status: "verified",
            created: 0,
            pending: 0,
            failed: 0,
            total: 0,
            currentThrough: "1998-10-06",
            error: null,
          },
      data: {
        plan,
        endedAtMs: 903_766_320_000,
        raceOutcome: id === "PL-S096" ? "not-completed" : id === "PL-S014" ? "completed" : null,
        outcomeAvailable: id === "PL-S094" || id === "PL-S095",
        cleanupItems: [
          {
            id: "cleanup-1",
            date: "1998-08-19",
            externalId: "external-1",
            status: cleanupFailed ? "failed" : "verified",
            errorCode: cleanupFailed ? "calendar-delete-failed" : null,
          },
        ],
      },
    });
  }
  const selectedWorkout = workouts[5];
  const selected = id === "PL-S021" ? selectedWorkout : null;
  const activeScenario = id as
    | "PL-S004"
    | "PL-S005"
    | "PL-S006"
    | "PL-S009"
    | "PL-S010"
    | "PL-S012"
    | "PL-S013"
    | "PL-S021"
    | "PL-S028"
    | "PL-S090"
    | "PL-S091"
    | "PL-S092"
    | "PL-S093";
  return {
    ...planReadModel({
      lifecycle: "active",
      scenarioId: activeScenario,
      projection: id === "PL-S028" ? "attention" : "active",
      planId,
      attentionCount: id === "PL-S028" ? 2 : id === "PL-S021" ? 1 : 0,
      data: {
        ...activeData,
        ...(id === "PL-S009"
          ? {
              matchSync: {
                lastSuccessfulSyncAtMs: 903_766_320_000,
                awaitingSync: true,
              },
              season: {
                ...activeData.season,
                raceWeek: {
                  ...raceWeek,
                  days: raceWeek.days.map((day) =>
                    day.weekday === "Fri" ? { ...day, purpose: "Blocked" } : day,
                  ),
                },
              },
            }
          : {}),
        ...(id === "PL-S093"
          ? {
              settings: {
                ...activeData.settings,
                selectedSetting: "auto-apply" as const,
                error: {
                  code: "persistence-failed" as const,
                  message: "Could not save.",
                  retryable: true,
                },
              },
            }
          : {}),
        selectedWorkoutId: selected?.id ?? null,
        selectedWorkout: selected,
        selectedWorkoutSourceScenarioId: selected === null ? null : "PL-S004",
      },
    }),
    attention: id === "PL-S028" ? planAttention(2) : planAttention(id === "PL-S021" ? 1 : 0),
  };
}

function response(value: unknown): readonly string[] {
  return [JSON.stringify(value)];
}

function qaModel(id: string) {
  return PlanReadModelSchema.parse(modelFor(id));
}

let current = qaModel(scenario);

function fixtureScript(): DesktopFixtureScript {
  return {
    onRequest(value) {
      const request = value as {
        readonly method: string;
        readonly params: Record<string, unknown>;
      };
      if (request.method === "getPlanState") return response({ status: "ready", state: current });
      if (request.method === "executePlanTransition") {
        const transitionId = String(request.params.transitionId ?? "");
        const destination = request.params.destinationScenarioId;
        if (transitionId === "PL-T01") current = qaModel("PL-S017");
        else if (transitionId === "PL-T05") current = qaModel("PL-S016");
        else if (transitionId === "PL-T06") current = qaModel("PL-S002");
        else if (transitionId === "PL-T11") current = qaModel("PL-S004");
        else if (transitionId === "PL-T33") {
          current =
            current.attention.destination === "direct" ? qaModel("PL-S021") : qaModel("PL-S028");
        } else if (transitionId === "PL-T34" || transitionId === "PL-T13") {
          current = qaModel("PL-S021");
        } else if (transitionId === "PL-T08") current = qaModel("PL-S050");
        else if (transitionId === "PL-T22") current = qaModel("PL-S090");
        else if (typeof destination === "string") current = qaModel(destination);
        return response({ status: "completed", state: current });
      }
      if (request.method === "getSetupStatus") {
        return response({
          schemaVersion: 1,
          intake: {
            swim_skill_floor: null,
            continuous_distance_capable: null,
            open_water_comfort: null,
            prior_bsi: false,
            clinician_cleared: null,
            injury_status: "none",
          },
          durableTrainingData: true,
        });
      }
      if (request.method === "getAthleteState") {
        return response({
          schemaVersion: "1",
          lastUpdated: "1998-08-22T08:00:00.000Z",
          freshness: "fresh",
          degraded: false,
          lastSynced: "1998-08-22T07:55:00.000Z",
          athleteProfile: {},
          currentStatus: {},
          derivedMetrics: {},
          recentActivities: [],
          plannedWorkouts: [],
          wellness: {},
          trainingContext: {
            performanceProgress: { kind: "unavailable", reason: "not-synced" },
            recentRides: {
              kind: "computed",
              asOf: "1998-08-22T08:00:00.000Z",
              windowDays: 28,
              items: [],
            },
            anchorZones: { kind: "unavailable", reason: "not-synced" },
            cyclingLoad: { kind: "unavailable", reason: "not-synced" },
            plan: { kind: "computed", asOf: "1998-08-22T08:00:00.000Z", items: [] },
            adherence: { kind: "unavailable", reason: "not-synced" },
            wellnessTrend: { kind: "unavailable", reason: "not-synced" },
          },
        });
      }
      if (request.method === "getRuntimeConfig") {
        return response({
          schemaVersion: 3,
          llm: { provider: "codex-agent", model: "fixture", credential_configured: true },
          intervals: {
            athlete_id: "0",
            credential_configured: true,
            managedByEnvironment: { athleteId: false },
          },
          session: {
            historyTokenBudgetRatio: 0.3,
            idleMinutes: 0,
            dailyResetHour: 4,
            resetArchiveRetentionDays: 0,
            timezone: "UTC",
            managedByEnvironment: {
              historyTokenBudgetRatio: false,
              idleMinutes: false,
              dailyResetHour: false,
              resetArchiveRetentionDays: false,
              timezone: false,
            },
          },
        });
      }
      if (request.method === "getUnitsPreference")
        return response({ value: "metric", source: "default" });
      if (request.method === "getChatQueue")
        return response({ schemaVersion: 1, revision: 0, items: [] });
      if (request.method === "hasSession") return response({ hasSession: false });
      if (request.method === "getCoachDecision") return response({ decision: null });
      if (request.method === "getTranscriptPage") {
        return response({ schemaVersion: 1, status: "page", turns: [], nextCursor: null });
      }
      if (request.method === "getSpendSummary") {
        return response({
          schemaVersion: 1,
          status: "available",
          timezone: "UTC",
          currency: "USD",
          today: { date: "1998-08-22", amountUsd: 0, capUsd: null },
          month: { month: "1998-08", amountUsd: 0 },
        });
      }
      throw new TypeError(`unexpected fixture method ${request.method}`);
    },
  };
}

let fixture: RunningDesktopFixture | undefined;

async function close(): Promise<void> {
  await fixture?.close();
  process.exit(0);
}

fixture = await launchDesktopFixture({
  script: fixtureScript(),
  token,
  ...(process.env.PLAN_QA_EXECUTABLE === undefined
    ? {}
    : { executable: process.env.PLAN_QA_EXECUTABLE }),
  ...(process.env.PLAN_QA_APPLICATION === undefined
    ? {}
    : { applicationBundle: process.env.PLAN_QA_APPLICATION }),
  width: Number(process.env.PLAN_QA_WIDTH ?? 1180),
  height: Number(process.env.PLAN_QA_HEIGHT ?? 820),
  colorScheme: process.env.PLAN_QA_THEME === "dark" ? "dark" : "light",
  reducedMotion: true,
  hidden: false,
});

process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
process.stdout.write(`PLAN_QA_READY ${scenario}\n`);
