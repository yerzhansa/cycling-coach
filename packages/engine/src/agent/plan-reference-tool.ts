import { tool, zodSchema } from "ai";
import {
  PlanReferenceToolResultSchema,
  RequestPlanReferenceInputSchema,
  type PlanReferenceSelection,
  type RequestPlanReferenceInput,
} from "@enduragent/coach-contract";
import type { PlanningReadPort } from "../host-ports.js";
import { getTurnContext } from "./turn-context.js";

export const PLAN_REFERENCE_TOOL_NAME = "read_plan_reference";

export function createPlanReferenceTool(input: { readonly planning: PlanningReadPort }) {
  return tool({
    description:
      "Read the athlete's current saved Plan and request one standard read-only Plan card. Use active_plan_summary for Plan-level questions, current_week for week/date questions, and workout_detail only after a prior result supplied the exact workoutId.",
    inputSchema: zodSchema(RequestPlanReferenceInputSchema),
    execute: async (request: RequestPlanReferenceInput, options: unknown) => {
      const readModel = await input.planning.getPlanningReadModel();
      if (readModel.status === "no-plan") {
        return PlanReferenceToolResultSchema.parse({ status: "unavailable", reason: "no-plan" });
      }
      const plan = readModel.plan;
      let selection: PlanReferenceSelection;
      let workout = null;
      if (request.kind === "active_plan_summary") {
        if (plan.currentWeek === null) {
          return PlanReferenceToolResultSchema.parse({
            status: "unavailable",
            reason: "outside-plan-dates",
          });
        }
        selection = { kind: request.kind, planId: plan.id };
      } else if (request.kind === "current_week") {
        if (plan.currentWeek === null) {
          return PlanReferenceToolResultSchema.parse({
            status: "unavailable",
            reason: "outside-plan-dates",
          });
        }
        selection = { kind: request.kind, planId: plan.id, weekNumber: plan.currentWeek };
      } else {
        workout = plan.workouts.find((candidate) => candidate.id === request.workoutId) ?? null;
        if (workout === null) {
          return PlanReferenceToolResultSchema.parse({
            status: "unavailable",
            reason: "workout-not-found",
          });
        }
        selection = {
          kind: request.kind,
          planId: plan.id,
          workoutId: workout.id,
        };
      }
      const context = getTurnContext(options);
      if (context?.chatId === "desktop") context.planReference.selection = selection;
      return PlanReferenceToolResultSchema.parse({
        status: "ready",
        selection,
        plan,
        workout,
      });
    },
  });
}
