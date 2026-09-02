import {
  AthleteStateSchema,
  GetRuntimeConfigRpcResultSchema,
  GetSetupStatusRpcResultSchema,
  GetTranscriptPageRpcResultSchema,
  ListPlanningRequestsRpcResultSchema,
  PlanReadModelSchema,
  ResumePlanningRequestsRpcResultSchema,
  ChatAttachmentComposerReadModelSchema,
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
} from "./helpers/plan-inspection-live.js";
import { TRAINING_CURRENT_ATHLETE_STATE } from "./helpers/training-current-athlete-state.js";

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
