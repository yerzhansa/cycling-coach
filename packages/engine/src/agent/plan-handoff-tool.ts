import { tool, zodSchema } from "ai";
import {
  PlanHandoffSuggestionSchema,
  PlanHandoffToolResultSchema,
  type PlanHandoffSuggestion,
} from "@enduragent/coach-contract";
import { getTurnContext } from "./turn-context.js";

export const PLAN_HANDOFF_TOOL_NAME = "request_plan_handoff";

export function createPlanHandoffTool() {
  return tool({
    description:
      "Request one host-owned Continue in Plan card when the athlete's text needs Plan-native creation or structured review. This does not change Plan.",
    inputSchema: zodSchema(PlanHandoffSuggestionSchema),
    execute: async (request: PlanHandoffSuggestion, options: unknown) => {
      const suggestion = PlanHandoffSuggestionSchema.parse(request);
      const context = getTurnContext(options);
      const selected =
        context?.chatId === "desktop" ? (context.planHandoff.suggestion ?? suggestion) : suggestion;
      if (context?.chatId === "desktop" && context.planHandoff.suggestion === null) {
        context.planHandoff.suggestion = selected;
      }
      return PlanHandoffToolResultSchema.parse({ status: "ready", suggestion: selected });
    },
  });
}
