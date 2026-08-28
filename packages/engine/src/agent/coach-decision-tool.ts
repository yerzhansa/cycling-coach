import { tool, zodSchema } from "ai";
import {
  RequestUserDecisionInputSchema,
  RequestUserDecisionResultSchema,
  type CoachDecisionAnswer,
  type CoachDecisionReadModel,
  type RequestUserDecisionInput,
} from "@enduragent/coach-contract";
import type { CoachDecisionStorePort } from "../host-ports.js";
import { getTurnContext } from "./turn-context.js";

export const COACH_DECISION_TOOL_NAME = "request_user_decision";

function recommendedFirst(
  options: readonly RequestUserDecisionInput["options"][number][],
): RequestUserDecisionInput["options"] {
  return [
    ...options.filter((option) => option.recommended),
    ...options.filter((option) => !option.recommended),
  ];
}

export function createCoachDecisionTool(input: {
  readonly store: CoachDecisionStorePort;
  readonly randomId: () => string;
  readonly now: () => number;
}) {
  return tool({
    description:
      "Ask the athlete to choose between material coaching or Plan directions in the host decision panel.",
    inputSchema: zodSchema(RequestUserDecisionInputSchema),
    execute: async (value: RequestUserDecisionInput, options: unknown) => {
      const execution = options as { toolCallId?: unknown };
      const context = getTurnContext(options);
      if (
        context === undefined ||
        context.chatId === "" ||
        typeof execution.toolCallId !== "string"
      ) {
        throw new Error("Coach decision context is unavailable.");
      }
      if (context.chatId !== "desktop" && !context.chatId.startsWith("plan:")) {
        context.decision.fallbackText = numberedDecisionFallback(value);
        throw new Error("Coach decision panels are unavailable for this chat.");
      }
      const orderedOptions = recommendedFirst(value.options);
      const decisionId = input.randomId();
      const decision: CoachDecisionReadModel = {
        decisionId,
        chatId: context.chatId,
        messageId: input.randomId(),
        question: value.question,
        options: orderedOptions.map((option) => ({ ...option, id: input.randomId() })),
        status: "unanswered",
      };
      let persisted: CoachDecisionReadModel;
      try {
        persisted = input.store.appendDecisionRequested({
          decision,
          turnId: context.turnId,
          toolCallId: execution.toolCallId,
          athleteText: context.athleteText,
          requestedAt: new Date(input.now()).toISOString(),
          ...(context.planIntake.patch === null
            ? {}
            : { planIntakePatch: context.planIntake.patch }),
        });
      } catch (error) {
        context.decision.fallbackText = numberedDecisionFallback(value);
        throw error;
      }
      context.decision.requested = persisted;
      return RequestUserDecisionResultSchema.parse({
        status: "presented",
        decisionId: persisted.decisionId,
      });
    },
  });
}

export function decisionConsequence(
  decision: CoachDecisionReadModel,
  answer: CoachDecisionAnswer,
): string {
  if (answer.kind === "custom") return answer.text;
  const optionId = answer.optionId;
  const option = decision.options.find((candidate) => candidate.id === optionId);
  if (option === undefined) throw new Error("Decision answer references an unknown option.");
  return option.consequence;
}

export function decisionContinuationMessage(
  decision: Extract<CoachDecisionReadModel, { status: "answered" }>,
): string {
  const optionId = decision.answer.kind === "option" ? decision.answer.optionId : undefined;
  const answer =
    optionId === undefined
      ? decision.answer.kind === "custom"
        ? decision.answer.text
        : undefined
      : decision.options.find((option) => option.id === optionId)?.label;
  if (answer === undefined) throw new Error("Decision answer references an unknown option.");
  return [
    "The athlete answered a host-owned coaching decision.",
    `Question: ${decision.question}`,
    `Answer: ${answer}`,
    `Consequence: ${decision.consequence}`,
    "Continue the coaching response from this choice. Do not claim that Plan, Calendar, Training, or Memory changed.",
  ].join("\n");
}

export function decisionRequestInput(decision: CoachDecisionReadModel): RequestUserDecisionInput {
  return {
    question: decision.question,
    options: decision.options.map(({ id: _id, ...option }) => option),
  };
}

export function numberedDecisionFallback(input: RequestUserDecisionInput): string {
  return [
    input.question,
    ...recommendedFirst(input.options).map(
      (option, index) =>
        `${index + 1}. ${option.label}${option.recommended ? " (Recommended)" : ""} — ${option.description}`,
    ),
    "Reply with a number, write your own answer, or say skip.",
  ].join("\n");
}
