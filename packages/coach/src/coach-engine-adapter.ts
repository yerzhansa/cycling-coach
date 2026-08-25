import {
  AnswerCoachDecisionRpcParamsSchema,
  AnswerCoachDecisionRpcResultSchema,
  AthleteStateSchema,
  ChatRequestSchema,
  ChatResponseSchema,
  GetCoachDecisionRpcParamsSchema,
  GetCoachDecisionRpcResultSchema,
  HasSessionRequestSchema,
  HasSessionResponseSchema,
  ResetSessionRequestSchema,
  ResetSessionResponseSchema,
  ResumeCoachDecisionRpcParamsSchema,
  ResumeCoachDecisionRpcResultSchema,
  SkipCoachDecisionRpcParamsSchema,
  SkipCoachDecisionRpcResultSchema,
  StopChatRequestSchema,
  StopChatResponseSchema,
  TurnEventSchema,
  type AthleteState,
  type CoachEngine,
} from "@enduragent/coach-contract";
import type { CyclingFtpAnchorResolver } from "@enduragent/kernel/anchors";

export interface CoachEngineAdapterInput {
  readonly backend: CoachEngine;
  readonly getAthleteState: () => Promise<AthleteState>;
  readonly cyclingFtpAnchorResolver: CyclingFtpAnchorResolver;
  readonly now: () => number;
}

export function createCoachEngineAdapter(input: CoachEngineAdapterInput): CoachEngine {
  return {
    async chat(request, onEvent) {
      const parsed = ChatRequestSchema.parse(request);
      const callEpochS = Math.floor(input.now() / 1_000);
      const resolvedCs = await input.cyclingFtpAnchorResolver.resolve({
        effectiveAtEpochS: callEpochS,
        evaluatedAtEpochS: callEpochS,
      });
      const resolvedRequest = {
        ...parsed,
        turn: {
          ...parsed.turn,
          resolvedCs,
        },
      };
      let firstEventValidationError: unknown | undefined;
      const response = await input.backend.chat(resolvedRequest, (event) => {
        if (firstEventValidationError !== undefined) return;
        const result = TurnEventSchema.safeParse(event);
        if (!result.success) {
          firstEventValidationError = result.error;
          return;
        }
        try {
          onEvent?.(result.data);
        } catch {}
      });
      if (firstEventValidationError !== undefined) throw firstEventValidationError;
      return ChatResponseSchema.parse(response);
    },
    async stopChat(request) {
      const parsed = StopChatRequestSchema.parse(request);
      return StopChatResponseSchema.parse(
        await input.backend.stopChat?.(parsed).then((value) => value ?? { stopped: false }),
      );
    },
    async resetSession(request) {
      const parsed = ResetSessionRequestSchema.parse(request);
      return ResetSessionResponseSchema.parse(await input.backend.resetSession(parsed));
    },
    async hasSession(request) {
      const parsed = HasSessionRequestSchema.parse(request);
      return HasSessionResponseSchema.parse(await input.backend.hasSession(parsed));
    },
    async getAthleteState() {
      return AthleteStateSchema.parse(await input.getAthleteState());
    },
    async getCoachDecision(request) {
      const parsed = GetCoachDecisionRpcParamsSchema.parse(request);
      return GetCoachDecisionRpcResultSchema.parse(await input.backend.getCoachDecision(parsed));
    },
    async answerCoachDecision(request, onEvent) {
      const parsed = AnswerCoachDecisionRpcParamsSchema.parse(request);
      let firstEventValidationError: unknown | undefined;
      const response = await input.backend.answerCoachDecision(parsed, (event) => {
        if (firstEventValidationError !== undefined) return;
        const result = TurnEventSchema.safeParse(event);
        if (!result.success) {
          firstEventValidationError = result.error;
          return;
        }
        try {
          onEvent?.(result.data);
        } catch {}
      });
      if (firstEventValidationError !== undefined) throw firstEventValidationError;
      return AnswerCoachDecisionRpcResultSchema.parse(response);
    },
    async skipCoachDecision(request) {
      const parsed = SkipCoachDecisionRpcParamsSchema.parse(request);
      return SkipCoachDecisionRpcResultSchema.parse(await input.backend.skipCoachDecision(parsed));
    },
    async resumeCoachDecision(request, onEvent) {
      const parsed = ResumeCoachDecisionRpcParamsSchema.parse(request);
      let firstEventValidationError: unknown | undefined;
      const response = await input.backend.resumeCoachDecision(parsed, (event) => {
        if (firstEventValidationError !== undefined) return;
        const result = TurnEventSchema.safeParse(event);
        if (!result.success) {
          firstEventValidationError = result.error;
          return;
        }
        try {
          onEvent?.(result.data);
        } catch {}
      });
      if (firstEventValidationError !== undefined) throw firstEventValidationError;
      return ResumeCoachDecisionRpcResultSchema.parse(response);
    },
  };
}
