import {
  AthleteStateSchema,
  GetRuntimeConfigRpcResultSchema,
  GetSetupStatusRpcResultSchema,
  GetTranscriptPageRpcResultSchema,
  ListPlanningRequestsRpcResultSchema,
  PlanReadModelSchema,
  ResumePlanningRequestsRpcResultSchema,
  ChatAttachmentComposerReadModelSchema,
  TrainingHistoryPanelSchema,
} from "@enduragent/coach-contract";
import { describe, expect, it } from "vitest";
import { PLAN_QA_ATHLETE_STATE } from "./helpers/inspection-athlete-states.js";
import {
  createPlanInspectionFixtureScript,
  inspectionAthleteState,
  PLAN_CURRENT_INSPECTION_FIXTURE,
  PLAN_INSPECTION_SCENARIO_ID,
  PLAN_INSPECTION_TURNS,
  TRAINING_CURRENT_INSPECTION_FIXTURE,
  TRAINING_INCOMPLETE_INSPECTION_FIXTURE,
  TRAINING_LIMITED_INSPECTION_FIXTURE,
  TRAINING_NO_POWER_INSPECTION_FIXTURE,
  TRAINING_STALE_INSPECTION_FIXTURE,
} from "./helpers/plan-inspection-live.js";
import { TRAINING_CURRENT_ATHLETE_STATE } from "./helpers/training-current-athlete-state.js";
import { TRAINING_INCOMPLETE_ATHLETE_STATE } from "./helpers/training-incomplete-athlete-state.js";
import { TRAINING_LIMITED_ATHLETE_STATE } from "./helpers/training-limited-athlete-state.js";
import { TRAINING_NO_POWER_ATHLETE_STATE } from "./helpers/training-no-power-athlete-state.js";
import { TRAINING_STALE_ATHLETE_STATE } from "./helpers/training-stale-athlete-state.js";

function request(method: string, params: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0", method, params };
}

async function result(
  script: ReturnType<typeof createPlanInspectionFixtureScript>,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const frames = await script.onRequest(request(method, params));
  return JSON.parse(frames.at(-1) ?? "null") as unknown;
}

describe("Plan inspection live fixture", () => {
  it.each([
    [PLAN_CURRENT_INSPECTION_FIXTURE, PLAN_QA_ATHLETE_STATE, 1],
    [TRAINING_CURRENT_INSPECTION_FIXTURE, TRAINING_CURRENT_ATHLETE_STATE, 7],
    [TRAINING_NO_POWER_INSPECTION_FIXTURE, TRAINING_NO_POWER_ATHLETE_STATE, 6],
    [TRAINING_LIMITED_INSPECTION_FIXTURE, TRAINING_LIMITED_ATHLETE_STATE, 2],
    [TRAINING_INCOMPLETE_INSPECTION_FIXTURE, TRAINING_INCOMPLETE_ATHLETE_STATE, 2],
    [TRAINING_STALE_INSPECTION_FIXTURE, TRAINING_STALE_ATHLETE_STATE, 2],
  ])("returns schema-valid athlete state for %s", async (name, expected, expectedRideCount) => {
    const athleteState = inspectionAthleteState(name);
    const script = createPlanInspectionFixtureScript(athleteState);
    const state = AthleteStateSchema.parse(await result(script, "getAthleteState"));
    expect(state).toEqual(expected);
    expect(state.trainingContext?.recentRides.kind).toBe("computed");
    expect(
      state.trainingContext?.recentRides.kind === "computed"
        ? state.trainingContext.recentRides.items
        : [],
    ).toHaveLength(expectedRideCount);
    expect(() =>
      TrainingHistoryPanelSchema.parse(state.trainingContext?.trainingHistory),
    ).not.toThrow();
  });

  it("refuses an unknown fixture at direct-execution selection", () => {
    expect(() => inspectionAthleteState("arbitrary-script")).toThrow(
      "unknown desktop inspection fixture",
    );
  });

  it("provides the populated Training inspection story", async () => {
    const script = createPlanInspectionFixtureScript(TRAINING_CURRENT_ATHLETE_STATE);
    const state = AthleteStateSchema.parse(await result(script, "getAthleteState"));
    const context = state.trainingContext;

    expect(context?.recentRides.kind).toBe("computed");
    expect(context?.recentRides.kind === "computed" ? context.recentRides.items : []).toHaveLength(
      7,
    );
    expect(context?.trainingHistory.kind).toBe("computed");
    if (context?.trainingHistory.kind !== "computed") throw new TypeError("expected history");
    expect(context.trainingHistory.anchorWeek.rides.items).toHaveLength(4);
    expect(context.trainingHistory.previousWeek?.rides.items).toHaveLength(3);
    expect(context.trainingHistory.anchorWeek.trend.kind).toBe("computed");
    expect(
      context.trainingHistory.anchorWeek.trend.kind === "computed"
        ? context.trainingHistory.anchorWeek.trend.buckets
        : [],
    ).toHaveLength(6);
    expect(context.trainingHistory.anchorWeek.callout?.kind).toBe("longest-ride-28d");
    expect(context.performanceProgress.kind).toBe("computed");
    expect(context.cyclingLoad).toMatchObject({ kind: "computed", value: 307 });
  });

  it("preserves the four Training data-state contracts", () => {
    const noPower = TRAINING_NO_POWER_ATHLETE_STATE.trainingContext;
    expect(noPower?.performanceProgress).toEqual({
      kind: "unavailable",
      reason: "insufficient-data",
    });
    expect(noPower?.trainingHistory.kind).toBe("computed");
    if (noPower?.trainingHistory.kind !== "computed") throw new TypeError("expected history");
    expect(noPower.trainingHistory.anchorWeek.rides.items).not.toHaveLength(0);
    expect(
      noPower.trainingHistory.anchorWeek.rides.items.every(
        (ride) => ride.averagePowerWatts === null,
      ),
    ).toBe(true);
    expect(noPower.recentRides.kind).toBe("computed");
    if (noPower.recentRides.kind !== "computed") throw new TypeError("expected recent rides");
    const noPowerCallout = noPower.trainingHistory.anchorWeek.callout;
    expect(noPowerCallout?.kind).toBe("longest-ride-28d");
    if (noPowerCallout?.kind !== "longest-ride-28d") {
      throw new TypeError("expected longest ride callout");
    }
    const longestDuration = Math.max(
      ...noPower.recentRides.items
        .filter(
          (ride) =>
            ride.localDate >= noPowerCallout.window.start &&
            ride.localDate <= noPowerCallout.window.end,
        )
        .map((ride) => ride.movingSeconds ?? 0),
    );
    expect(noPowerCallout.durationSeconds).toBe(longestDuration);

    const limited = TRAINING_LIMITED_ATHLETE_STATE.trainingContext?.trainingHistory;
    expect(limited?.kind).toBe("computed");
    if (limited?.kind !== "computed") throw new TypeError("expected history");
    expect(limited.anchorWeek.trend).toEqual({
      kind: "unavailable",
      reason: "limited-history",
    });
    expect(limited.anchorWeek.rides.items).toHaveLength(1);
    expect(limited.anchorWeek.totals).toEqual({
      rideCount: { kind: "computed", value: 1 },
      ridingSeconds: { kind: "computed", value: 5_340 },
      distanceMeters: { kind: "computed", value: 41_000 },
      load: { kind: "computed", value: 78 },
    });
    expect(limited.previousWeek?.rides.items).toHaveLength(1);
    expect(limited.previousWeek?.totals).toEqual({
      rideCount: { kind: "computed", value: 1 },
      ridingSeconds: { kind: "computed", value: 4_080 },
      distanceMeters: { kind: "computed", value: 30_000 },
      load: { kind: "computed", value: 54 },
    });
    expect(limited.anchorWeek.callout).toBeNull();

    const incompleteContext = TRAINING_INCOMPLETE_ATHLETE_STATE.trainingContext;
    if (incompleteContext === undefined) throw new Error("expected training context");
    const incomplete = incompleteContext?.trainingHistory;
    expect(incomplete?.kind).toBe("computed");
    if (incomplete?.kind !== "computed") throw new TypeError("expected history");
    expect(incompleteContext.recentRides.kind).toBe("computed");
    if (incompleteContext.recentRides.kind !== "computed") {
      throw new TypeError("expected recent rides");
    }
    expect(incompleteContext.recentRides.asOf).toBe(incomplete.asOf);
    expect(incomplete.coverage.kind).toBe("incomplete");
    expect(incomplete.anchorWeek.coverage.kind).toBe("incomplete");
    expect(incomplete.anchorWeek.coverage).toEqual({
      kind: "incomplete",
      recordedThrough: "1998-08-28",
      reason: "source-degraded",
    });
    expect(incomplete.anchorWeek.totals).toEqual({
      rideCount: { kind: "partial", value: 2, reason: "incomplete-coverage" },
      ridingSeconds: { kind: "partial", value: 11_100, reason: "incomplete-coverage" },
      distanceMeters: { kind: "partial", value: 92_000, reason: "incomplete-coverage" },
      load: { kind: "partial", value: 160, reason: "incomplete-coverage" },
    });
    expect(incomplete.anchorWeek.rides).toMatchObject({
      count: { kind: "at-least", value: 2 },
      truncated: true,
    });
    expect(incomplete.anchorWeek.rides.items.map((ride) => ride.title)).toEqual([
      "Park tempo",
      "Country endurance",
    ]);
    expect(incomplete.anchorWeek.trend).toEqual({
      kind: "unavailable",
      reason: "incomplete-source",
    });
    expect(incomplete.anchorWeek.callout).toBeNull();
    expect(incomplete.previousWeek?.coverage).toEqual({ kind: "complete" });
    expect(incomplete.previousWeek?.totals).toEqual({
      rideCount: { kind: "computed", value: 0 },
      ridingSeconds: { kind: "computed", value: 0 },
      distanceMeters: { kind: "computed", value: 0 },
      load: { kind: "computed", value: 0 },
    });
    expect(incomplete.previousWeek?.rides).toEqual({
      count: { kind: "exact", value: 0 },
      items: [],
      truncated: false,
    });

    const stale = TRAINING_STALE_ATHLETE_STATE.trainingContext?.trainingHistory;
    expect(stale?.kind).toBe("stale");
    if (stale?.kind !== "stale") throw new TypeError("expected stale history");
    expect(stale.lastGood.displayMode).toBe("last-recorded");
    expect(stale.lastGood.anchorWeek.calendarState).toBe("closed");
    expect(stale.lastGood.anchorWeek.callout).toBeNull();
    expect(stale.lastGood.previousWeek).toBeNull();
  });

  it("keeps Training fixture ride IDs distinct across data states", () => {
    const states = [
      TRAINING_CURRENT_ATHLETE_STATE,
      TRAINING_NO_POWER_ATHLETE_STATE,
      TRAINING_LIMITED_ATHLETE_STATE,
      TRAINING_INCOMPLETE_ATHLETE_STATE,
      TRAINING_STALE_ATHLETE_STATE,
    ];
    const rideIds = states.flatMap((state) =>
      state.trainingContext?.recentRides.kind === "computed"
        ? state.trainingContext.recentRides.items.map((ride) => ride.id)
        : [],
    );

    expect(new Set(rideIds).size).toBe(rideIds.length);
  });

  it("uses privacy-safe ordinary Main Chat turns", async () => {
    const script = createPlanInspectionFixtureScript();
    const transcript = GetTranscriptPageRpcResultSchema.parse(
      await result(script, "getTranscriptPage"),
    );

    expect(transcript.status).toBe("page");
    expect(transcript.turns).toEqual(PLAN_INSPECTION_TURNS);
    expect(transcript.turns.every((turn) => turn.completedAt.startsWith("1998-"))).toBe(true);
  });

  it("provides completed setup and empty schema-valid Chat startup state", async () => {
    const script = createPlanInspectionFixtureScript();
    const setup = GetSetupStatusRpcResultSchema.parse(await result(script, "getSetupStatus"));
    expect(setup.durableTrainingData).toBe(true);
    expect(setup.intake).not.toBeNull();
    expect(
      GetRuntimeConfigRpcResultSchema.parse(await result(script, "getRuntimeConfig")),
    ).toMatchObject({ llm: { provider: "codex-agent", credential_configured: true } });
    expect(await result(script, "hasSession")).toEqual({ hasSession: true });
    expect(
      ChatAttachmentComposerReadModelSchema.parse(
        await result(script, "getChatAttachmentComposer"),
      ),
    ).toMatchObject({ schemaVersion: 1, draft: null });
    expect(
      ResumePlanningRequestsRpcResultSchema.parse(await result(script, "resumePlanningRequests")),
    ).toEqual({ deliveries: [] });
    expect(
      ListPlanningRequestsRpcResultSchema.parse(
        await result(script, "listPlanningRequests", { chatId: "main" }),
      ),
    ).toEqual({ deliveries: [] });
  });

  it("starts on the active Plan and follows the existing next-Plan transition", async () => {
    const script = createPlanInspectionFixtureScript();
    const initial = (await result(script, "getPlanState")) as {
      readonly status: string;
      readonly state: unknown;
    };
    const initialPlan = PlanReadModelSchema.parse(initial.state);
    expect(initial.status).toBe("ready");
    expect(initialPlan.scenarioId).toBe(PLAN_INSPECTION_SCENARIO_ID);
    expect(initialPlan.lifecycle).toBe("active");

    const transitioned = (await result(script, "executePlanTransition", {
      transitionId: "PL-T25",
      commandId: "inspection-command-start-plan",
      planId: initialPlan.planId,
    })) as { readonly status: string; readonly state: unknown };
    const next = PlanReadModelSchema.parse(transitioned.state);
    expect(transitioned.status).toBe("completed");
    expect(next.scenarioId).toBe("PL-S079");

    const refreshed = (await result(script, "getPlanState")) as {
      readonly status: string;
      readonly state: unknown;
    };
    expect(PlanReadModelSchema.parse(refreshed.state).scenarioId).toBe("PL-S079");
  });
});
