import { tool, zodSchema } from "ai";
import { PlanIntakePatchSchema, type PlanIntakePatch } from "@enduragent/coach-contract";
import { getTurnContext } from "./turn-context.js";

export const PLAN_INTAKE_TOOL_NAME = "record_plan_intake";

export function createPlanIntakeTool() {
  return tool({
    description:
      "Record only Plan intake facts the athlete explicitly supplied or confirmed in this conversation.",
    inputSchema: zodSchema(PlanIntakePatchSchema),
    execute: async (value: PlanIntakePatch, options: unknown) => {
      const context = getTurnContext(options);
      if (context === undefined || !context.chatId.startsWith("plan:")) {
        throw new Error("Plan intake context is unavailable.");
      }
      context.planIntake.patch = PlanIntakePatchSchema.parse({
        ...context.planIntake.patch,
        ...value,
      });
      return { recorded: true };
    },
  });
}
