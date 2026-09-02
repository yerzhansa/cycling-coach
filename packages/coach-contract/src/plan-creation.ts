import { z } from "zod";
import { TrainingExportCivilDateSchema } from "./training-export.js";

const PlanCreationUlidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
const PlanCreationCommandIdSchema = z.string().min(1).max(512);
const PlanCreationCivilDateSchema = TrainingExportCivilDateSchema;

export const PLAN_CREATION_ANSWER_KEYS = [
  "goal",
  "success",
  "plan-length",
  "start-timing",
  "schedule-mode",
  "availability",
  "commitments",
  "baseline",
  "restriction",
] as const;

const PlanCreationPlanLengthWeeksSchema = z.union([
  z.literal(4),
  z.literal(8),
  z.literal(12),
  z.literal(16),
]);
const PlanCreationWeekdaySchema = z.number().int().min(1).max(7);
const PlanCreationWeeklyHoursLimitSchema = z.number().positive();
const PlanCreationLongestWorkoutHoursSchema = z.number().positive();
const completeOptionSet = <T extends string | number>(
  values: readonly T[],
  expected: readonly T[],
): boolean =>
  values.length === expected.length &&
  new Set(values).size === expected.length &&
  expected.every((value) => values.includes(value));
const PlanCreationUsableWeekdaysSchema = z
  .array(PlanCreationWeekdaySchema)
  .min(1)
  .max(7)
  .refine((weekdays) => new Set(weekdays).size === weekdays.length);
const PlanCreationAvailabilityAnswerSchema = z.discriminatedUnion("mode", [
  z
    .object({
      kind: z.literal("availability"),
      mode: z.literal("fixed"),
      weeklyHoursLimit: PlanCreationWeeklyHoursLimitSchema,
      longestWorkoutHours: PlanCreationLongestWorkoutHoursSchema,
      usableWeekdays: PlanCreationUsableWeekdaysSchema,
    })
    .strict()
    .refine((answer) => answer.longestWorkoutHours <= answer.weeklyHoursLimit, {
      path: ["longestWorkoutHours"],
    }),
  z
    .object({
      kind: z.literal("availability"),
      mode: z.literal("flexible"),
      weeklyHoursLimit: PlanCreationWeeklyHoursLimitSchema,
      longestWorkoutHours: PlanCreationLongestWorkoutHoursSchema,
    })
    .strict()
    .refine((answer) => answer.longestWorkoutHours <= answer.weeklyHoursLimit, {
      path: ["longestWorkoutHours"],
    }),
]);

export const PlanCreationGoalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("event-candidate"), candidateId: PlanCreationUlidSchema }).strict(),
  z
    .object({
      kind: z.literal("event-manual"),
      name: z.string().min(1).max(512),
      date: PlanCreationCivilDateSchema,
    })
    .strict(),
  z.object({ kind: z.literal("fitness"), outcome: z.string().min(1).max(2_000) }).strict(),
]);
export type PlanCreationGoal = z.infer<typeof PlanCreationGoalSchema>;

export const PlanCreationSuccessSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("event-finish"),
      choice: z.enum(["finish-comfortably", "finish-fast", "race-for-result"]),
    })
    .strict(),
  z.object({ kind: z.literal("authored"), text: z.string().min(1).max(2_000) }).strict(),
]);
export type PlanCreationSuccess = z.infer<typeof PlanCreationSuccessSchema>;

export const PlanCreationAnswerInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("goal"), goal: PlanCreationGoalSchema }).strict(),
  z.object({ kind: z.literal("success"), success: PlanCreationSuccessSchema }).strict(),
  z.object({ kind: z.literal("plan-length"), weeks: PlanCreationPlanLengthWeeksSchema }).strict(),
  z
    .object({
      kind: z.literal("start-timing"),
      timing: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("as-soon-as-possible") }).strict(),
        z.object({ kind: z.literal("earliest"), date: PlanCreationCivilDateSchema }).strict(),
      ]),
    })
    .strict(),
  z.object({ kind: z.literal("schedule-mode"), mode: z.enum(["fixed", "flexible"]) }).strict(),
  PlanCreationAvailabilityAnswerSchema,
  z
    .object({
      kind: z.literal("commitments"),
      commitments: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("none") }).strict(),
        z.object({ kind: z.literal("authored"), text: z.string().min(1).max(2_000) }).strict(),
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("baseline"),
      baseline: z.enum(["regular", "occasional", "starting-again"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("restriction"),
      restriction: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("none") }).strict(),
        z
          .object({
            kind: z.literal("no-training"),
            endDate: PlanCreationCivilDateSchema.optional(),
          })
          .strict(),
        z
          .object({
            kind: z.literal("no-hard-training"),
            endDate: PlanCreationCivilDateSchema.optional(),
          })
          .strict(),
        z
          .object({
            kind: z.literal("max-duration"),
            hours: PlanCreationLongestWorkoutHoursSchema,
            endDate: PlanCreationCivilDateSchema.optional(),
          })
          .strict(),
      ]),
    })
    .strict(),
]);
export type PlanCreationAnswerInput = z.infer<typeof PlanCreationAnswerInputSchema>;

export const GoalEventCandidateSchema = z
  .object({
    candidateId: PlanCreationUlidSchema,
    name: z.string().min(1).max(512),
    date: PlanCreationCivilDateSchema,
    sourceLabel: z.string().min(1).max(128),
  })
  .strict();
export type GoalEventCandidate = z.infer<typeof GoalEventCandidateSchema>;

const PlanCreationQuestionStepSchema = z
  .object({
    current: z.number().int().min(1).max(9),
    total: z.number().int().min(1).max(9),
  })
  .strict()
  .refine((step) => step.current <= step.total, { path: ["current"] });

const PlanCreationAuthoredOptionSchema = z
  .object({
    label: z.literal("Something else"),
    description: z.string().min(1).max(240),
    editorLabel: z.string().min(1).max(240),
    placeholder: z.string().min(1).max(240),
  })
  .strict();

export const PlanCreationOpenQuestionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("goal-question"),
      step: PlanCreationQuestionStepSchema,
      prompt: z.string().min(1).max(240),
      candidates: z.array(GoalEventCandidateSchema).max(10),
      manualOption: PlanCreationAuthoredOptionSchema.extend({
        nameLabel: z.string().min(1).max(128),
        dateLabel: z.string().min(1).max(128),
      }).strict(),
      fitnessOption: z
        .object({
          label: z.string().min(1).max(128),
          description: z.string().min(1).max(240),
          editorLabel: z.string().min(1).max(240),
          placeholder: z.string().min(1).max(240),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("success-question"),
      step: PlanCreationQuestionStepSchema,
      prompt: z.string().min(1).max(240),
      input: z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("event-finish"),
            options: z
              .array(
                z
                  .object({
                    choice: z.enum(["finish-comfortably", "finish-fast", "race-for-result"]),
                    label: z.string().min(1).max(128),
                    description: z.string().min(1).max(240),
                  })
                  .strict(),
              )
              .length(3),
            authored: PlanCreationAuthoredOptionSchema,
          })
          .strict(),
        z
          .object({
            kind: z.literal("authored"),
            options: z
              .array(
                z
                  .object({
                    text: z.string().min(1).max(2_000),
                    label: z.string().min(1).max(128),
                    description: z.string().min(1).max(240),
                  })
                  .strict(),
              )
              .length(3),
            authored: PlanCreationAuthoredOptionSchema,
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("plan-length-question"),
      step: PlanCreationQuestionStepSchema,
      prompt: z.string().min(1).max(240),
      options: z
        .array(
          z
            .object({
              weeks: PlanCreationPlanLengthWeeksSchema,
              label: z.string().min(1).max(128),
              description: z.string().min(1).max(240),
            })
            .strict(),
        )
        .length(4)
        .refine((options) =>
          completeOptionSet(
            options.map((option) => option.weeks),
            [4, 8, 12, 16],
          ),
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("start-timing-question"),
      step: PlanCreationQuestionStepSchema,
      prompt: z.string().min(1).max(240),
      earliestAllowed: PlanCreationCivilDateSchema,
      options: z
        .array(
          z
            .object({
              timing: z.enum(["as-soon-as-possible", "earliest"]),
              label: z.string().min(1).max(128),
              description: z.string().min(1).max(240),
            })
            .strict(),
        )
        .length(2)
        .refine((options) =>
          completeOptionSet(
            options.map((option) => option.timing),
            ["as-soon-as-possible", "earliest"],
          ),
        ),
      dateLabel: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      kind: z.literal("schedule-mode-question"),
      step: PlanCreationQuestionStepSchema,
      prompt: z.string().min(1).max(240),
      options: z
        .array(
          z
            .object({
              mode: z.enum(["fixed", "flexible"]),
              label: z.string().min(1).max(128),
              description: z.string().min(1).max(240),
            })
            .strict(),
        )
        .length(2)
        .refine((options) =>
          completeOptionSet(
            options.map((option) => option.mode),
            ["fixed", "flexible"],
          ),
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("availability-question"),
      step: PlanCreationQuestionStepSchema,
      prompt: z.string().min(1).max(240),
      mode: z.enum(["fixed", "flexible"]),
      derivedPoolNote: z.string().min(1).max(240),
    })
    .strict(),
  z
    .object({
      kind: z.literal("commitments-question"),
      step: PlanCreationQuestionStepSchema,
      prompt: z.string().min(1).max(240),
      noneOption: z
        .object({
          label: z.string().min(1).max(128),
          description: z.string().min(1).max(240),
        })
        .strict(),
      authoredOption: PlanCreationAuthoredOptionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("baseline-question"),
      step: PlanCreationQuestionStepSchema,
      prompt: z.string().min(1).max(240),
      options: z
        .array(
          z
            .object({
              baseline: z.enum(["regular", "occasional", "starting-again"]),
              label: z.string().min(1).max(128),
              description: z.string().min(1).max(240),
            })
            .strict(),
        )
        .length(3)
        .refine((options) =>
          completeOptionSet(
            options.map((option) => option.baseline),
            ["regular", "occasional", "starting-again"],
          ),
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("restriction-question"),
      step: PlanCreationQuestionStepSchema,
      prompt: z.string().min(1).max(240),
      options: z
        .array(
          z
            .object({
              kind: z.enum(["none", "no-training", "no-hard-training", "max-duration"]),
              label: z.string().min(1).max(128),
              description: z.string().min(1).max(240),
            })
            .strict(),
        )
        .length(4)
        .refine((options) =>
          completeOptionSet(
            options.map((option) => option.kind),
            ["none", "no-training", "no-hard-training", "max-duration"],
          ),
        ),
    })
    .strict(),
]);
export type PlanCreationOpenQuestion = z.infer<typeof PlanCreationOpenQuestionSchema>;

export const PlanCreationAnswerSummarySchema = z
  .object({
    answerKey: z.enum(PLAN_CREATION_ANSWER_KEYS),
    title: z.string().min(1).max(128),
    detail: z.string().min(1).max(2_000),
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("athlete") }).strict(),
      z
        .object({ kind: z.literal("derived"), label: z.string().min(1).max(128) })
        .strict(),
    ]),
    question: PlanCreationOpenQuestionSchema,
    answer: PlanCreationAnswerInputSchema,
  })
  .strict()
  .superRefine((summary, context) => {
    if (summary.answer.kind !== summary.answerKey) {
      context.addIssue({ code: "custom", path: ["answer"], message: "answer key mismatch" });
    }
    if (summary.question.kind.replace(/-question$/u, "") !== summary.answerKey) {
      context.addIssue({ code: "custom", path: ["question"], message: "question key mismatch" });
    }
  });
export type PlanCreationAnswerSummary = z.infer<typeof PlanCreationAnswerSummarySchema>;

export const PlanCreationCardModelSchema = z
  .object({
    creationId: PlanCreationUlidSchema,
    version: z.number().int().positive(),
    status: z.literal("in-progress"),
    readiness: z.enum(["incomplete", "ready"]),
    answeredSummaries: z.array(PlanCreationAnswerSummarySchema).max(16),
    openQuestion: PlanCreationOpenQuestionSchema.nullable(),
  })
  .strict()
  .superRefine((card, context) => {
    if ((card.readiness === "ready") !== (card.openQuestion === null)) {
      context.addIssue({
        code: "custom",
        path: ["readiness"],
        message: "readiness and open question contradict each other",
      });
    }
  });
export type PlanCreationCardModel = z.infer<typeof PlanCreationCardModelSchema>;

export const PlanCreationStartRpcParamsSchema = z
  .object({ commandId: PlanCreationCommandIdSchema })
  .strict();
export type PlanCreationStartRpcParams = z.infer<typeof PlanCreationStartRpcParamsSchema>;

export const PlanCreationStartRpcResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("started"),
      outcome: z.enum(["created", "resumed"]),
      planCreation: PlanCreationCardModelSchema,
    })
    .strict(),
  z.object({ status: z.literal("rejected"), reason: z.literal("command-conflict") }).strict(),
]);
export type PlanCreationStartRpcResult = z.infer<typeof PlanCreationStartRpcResultSchema>;

export const PlanCreationAnswerRpcParamsSchema = z
  .object({
    commandId: PlanCreationCommandIdSchema,
    creationId: PlanCreationUlidSchema,
    expectedVersion: z.number().int().positive(),
    answer: PlanCreationAnswerInputSchema,
  })
  .strict();
export type PlanCreationAnswerRpcParams = z.infer<typeof PlanCreationAnswerRpcParamsSchema>;

export const PlanCreationAnswerRpcResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("answered"), planCreation: PlanCreationCardModelSchema }).strict(),
  z
    .object({
      status: z.literal("rejected"),
      reason: z.enum([
        "stale-version",
        "command-conflict",
        "no-unfinished-creation",
        "answer-not-expected",
        "invalid-answer",
      ]),
      planCreation: PlanCreationCardModelSchema.nullable(),
    })
    .strict(),
]);
export type PlanCreationAnswerRpcResult = z.infer<typeof PlanCreationAnswerRpcResultSchema>;

export interface PlanCreationOperations {
  "plan_creation.start"(request: PlanCreationStartRpcParams): Promise<PlanCreationStartRpcResult>;
  "plan_creation.answer"(
    request: PlanCreationAnswerRpcParams,
  ): Promise<PlanCreationAnswerRpcResult>;
}
