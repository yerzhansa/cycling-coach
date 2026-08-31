import {
  GetRuntimeConfigRpcResultSchema,
  GetSetupStatusRpcResultSchema,
  GetTranscriptPageRpcResultSchema,
  ListPlanningRequestsRpcResultSchema,
  PlanReadModelSchema,
  ResumePlanningRequestsRpcResultSchema,
  ChatAttachmentComposerReadModelSchema,
} from "@enduragent/coach-contract";
import { describe, expect, it } from "vitest";
import {
  createPlanInspectionFixtureScript,
  PLAN_INSPECTION_SCENARIO_ID,
  PLAN_INSPECTION_TURNS,
} from "./helpers/plan-inspection-live.js";

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
