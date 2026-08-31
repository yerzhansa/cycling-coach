import { z } from "zod";
import { TrainingExportCivilDateSchema } from "./training-export.js";

export const PLANNING_V2_SCHEMA_VERSION = 2 as const;

export const PlanningV2EntityIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
export const PlanningV2CommandIdSchema = z.string().min(1).max(512);
export const PlanningV2RequestDigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
export const PlanningV2FingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/u);
export const PlanningV2RevisionSchema = z.number().int().positive();
export const PlanningV2CursorSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const PlanningV2CalendarStatusSchema = z
  .object({
    status: z.enum(["not-applicable", "pending", "updating", "updated", "needs-attention"]),
    pendingOperations: z.number().int().nonnegative(),
    attentionCount: z.number().int().nonnegative(),
    lastSuccessfulSyncAtMs: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type PlanningV2CalendarStatus = z.infer<typeof PlanningV2CalendarStatusSchema>;

const PlanningV2PlanSummaryBaseSchema = z
  .object({
    id: PlanningV2EntityIdSchema,
    version: PlanningV2RevisionSchema,
    revision: PlanningV2RevisionSchema,
    name: z.string().min(1).max(200),
    goal: z.string().min(1).max(2_000),
    startDate: TrainingExportCivilDateSchema,
    endDate: TrainingExportCivilDateSchema,
    updatedAtMs: z.number().int().nonnegative(),
    calendar: PlanningV2CalendarStatusSchema,
    focusId: z.string().min(1).max(256),
  })
  .strict();

export const PlanningV2ActivePlanSummarySchema = PlanningV2PlanSummaryBaseSchema.extend({
  lifecycle: z.literal("active"),
}).strict();
export type PlanningV2ActivePlanSummary = z.infer<typeof PlanningV2ActivePlanSummarySchema>;

export const PlanningV2ClosedPlanSummarySchema = PlanningV2PlanSummaryBaseSchema.extend({
  lifecycle: z.literal("closed"),
  closedAtMs: z.number().int().nonnegative(),
  closeReason: z.enum(["completed", "stopped", "unavailable"]),
}).strict();
export type PlanningV2ClosedPlanSummary = z.infer<typeof PlanningV2ClosedPlanSummarySchema>;

export const PlanningV2CreationSummarySchema = z
  .object({
    id: PlanningV2EntityIdSchema,
    version: PlanningV2RevisionSchema,
    status: z.enum(["in-progress", "review"]),
    reviewState: z.enum(["current", "needs-review"]),
    name: z.string().min(1).max(200).nullable(),
    goal: z.string().min(1).max(2_000).nullable(),
    confirmedAnswers: z.number().int().nonnegative(),
    requiredAnswers: z.number().int().nonnegative(),
    currentDraftRevision: PlanningV2RevisionSchema.nullable(),
    updatedAtMs: z.number().int().nonnegative(),
    focusId: z.string().min(1).max(256),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.status === "review") !== (value.currentDraftRevision !== null)) {
      context.addIssue({
        code: "custom",
        path: ["currentDraftRevision"],
        message: "review requires a current Draft and in-progress forbids one",
      });
    }
  });
export type PlanningV2CreationSummary = z.infer<typeof PlanningV2CreationSummarySchema>;

export const PlanListV2RequestSchema = z
  .object({
    schemaVersion: z.literal(PLANNING_V2_SCHEMA_VERSION),
    closedCursor: PlanningV2CursorSchema.nullable(),
    closedLimit: z.number().int().min(1).max(50),
  })
  .strict();
export type PlanListV2Request = z.infer<typeof PlanListV2RequestSchema>;

export const PlanListV2ResultSchema = z
  .object({
    schemaVersion: z.literal(PLANNING_V2_SCHEMA_VERSION),
    asOfMs: z.number().int().nonnegative(),
    creation: PlanningV2CreationSummarySchema.nullable(),
    activePlan: PlanningV2ActivePlanSummarySchema.nullable(),
    closedPlans: z.array(PlanningV2ClosedPlanSummarySchema).max(50),
    nextClosedCursor: PlanningV2CursorSchema.nullable(),
    attention: z
      .object({
        total: z.number().int().nonnegative(),
        creation: z.number().int().nonnegative(),
        activePlan: z.number().int().nonnegative(),
        calendar: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.attention.total !==
      value.attention.creation + value.attention.activePlan + value.attention.calendar
    ) {
      context.addIssue({
        code: "custom",
        path: ["attention", "total"],
        message: "attention total must equal its categories",
      });
    }
  });
export type PlanListV2Result = z.infer<typeof PlanListV2ResultSchema>;

const ESSENTIAL_QUESTION_IDS = [
  "goal",
  "success-definition",
  "goal-date",
  "plan-duration",
  "plan-start-date",
  "weekly-availability",
  "fixed-commitments",
  "training-baseline",
  "schedule-preference",
  "training-restriction-status",
] as const;

export const PlanningV2QuestionIdSchema = z.union([
  z.enum(ESSENTIAL_QUESTION_IDS),
  z.string().regex(/^sport:[a-z0-9][a-z0-9.-]{0,121}$/u),
]);
export type PlanningV2QuestionId = z.infer<typeof PlanningV2QuestionIdSchema>;

export const PlanningV2WeekdaySchema = z.enum([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);

const PlanningV2CatalogQuestionIdSchema = z.string().regex(/^sport:[a-z0-9][a-z0-9.-]{0,121}$/u);

export const PlanningV2WeeklyAvailabilityAnswerSchema = z
  .object({
    kind: z.literal("weekly-availability"),
    questionId: z.literal("weekly-availability"),
    days: z
      .array(
        z
          .object({
            weekday: PlanningV2WeekdaySchema,
            maximumMinutes: z.number().int().positive().max(1_440),
          })
          .strict(),
      )
      .min(1)
      .max(7),
  })
  .strict();

export const PlanningV2AnswerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("text"),
      questionId: z.enum(["goal", "success-definition", "fixed-commitments"]),
      value: z.string().min(1).max(4_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("date"),
      questionId: z.enum(["goal-date", "plan-start-date"]),
      value: TrainingExportCivilDateSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("duration-weeks"),
      questionId: z.literal("plan-duration"),
      value: z.number().int().min(1).max(104),
    })
    .strict(),
  PlanningV2WeeklyAvailabilityAnswerSchema,
  z
    .object({
      kind: z.literal("training-baseline"),
      questionId: z.literal("training-baseline"),
      source: z.enum(["observed", "self-report", "starting-again"]),
      typicalSessionsPerWeek: z.number().int().nonnegative().max(21).nullable(),
      typicalWeeklyMinutes: z.number().int().nonnegative().max(10_080).nullable(),
      longestRecentSessionMinutes: z.number().int().nonnegative().max(2_880).nullable(),
      recentConsistency: z.enum(["consistent", "reduced", "inactive"]).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("schedule-preference"),
      questionId: z.literal("schedule-preference"),
      value: z.enum(["fixed", "flexible", "not-applicable"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("training-restriction-status"),
      questionId: z.literal("training-restriction-status"),
      value: z.enum(["none", "confirmed", "uncertain"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("sport-choice"),
      questionId: PlanningV2CatalogQuestionIdSchema,
      value: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({
      kind: z.literal("sport-quantity"),
      questionId: PlanningV2CatalogQuestionIdSchema,
      value: z.number().finite(),
      unit: z.string().min(1).max(64),
    })
    .strict(),
  z
    .object({
      kind: z.literal("sport-text"),
      questionId: PlanningV2CatalogQuestionIdSchema,
      value: z.string().min(1).max(4_000),
    })
    .strict(),
]);
export type PlanningV2Answer = z.infer<typeof PlanningV2AnswerSchema>;

export const PlanningV2EffectiveContextEntrySchema = z
  .object({
    answer: PlanningV2AnswerSchema,
    source: z.enum(["creation-answer", "athlete-preference", "observed", "default"]),
    sourceId: PlanningV2EntityIdSchema.nullable(),
    freshness: z.enum(["current", "stale", "conflicting"]),
  })
  .strict();

export const PlanningV2AthletePreferenceSchema = z
  .object({
    id: PlanningV2EntityIdSchema,
    version: PlanningV2RevisionSchema,
    answer: PlanningV2AnswerSchema,
    updatedAtMs: z.number().int().nonnegative(),
  })
  .strict();

const PlanningV2RestrictionBaseShape = {
  id: PlanningV2EntityIdSchema,
  version: PlanningV2RevisionSchema,
  startDate: TrainingExportCivilDateSchema,
  endDate: TrainingExportCivilDateSchema.nullable(),
  confirmedAtMs: z.number().int().nonnegative(),
};

export const PlanningV2TrainingRestrictionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("no-training"), ...PlanningV2RestrictionBaseShape }).strict(),
  z.object({ kind: z.literal("no-hard-training"), ...PlanningV2RestrictionBaseShape }).strict(),
  z
    .object({
      kind: z.literal("maximum-duration"),
      ...PlanningV2RestrictionBaseShape,
      maximumDurationMinutes: z.number().int().positive().max(1_440),
    })
    .strict(),
]);

export const PlanningV2ObservedEvidenceSchema = z
  .object({
    id: PlanningV2EntityIdSchema,
    questionId: PlanningV2QuestionIdSchema,
    version: z.string().min(1).max(256),
    observedAtMs: z.number().int().nonnegative(),
    freshness: z.enum(["current", "stale"]),
  })
  .strict();

export const PlanningV2AllowedCommandSchema = z.enum([
  "plan_creation.start",
  "plan_creation.answer",
  "plan_creation.preview",
  "plan_creation.activate",
  "plan_creation.discard",
  "plan_change.preview",
  "plan_change.apply",
  "plan.close",
]);
export type PlanningV2AllowedCommand = z.infer<typeof PlanningV2AllowedCommandSchema>;

export const PlanningV2ContextTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plan"), planId: PlanningV2EntityIdSchema }).strict(),
  z.object({ kind: z.literal("plan-creation"), creationId: PlanningV2EntityIdSchema }).strict(),
  z
    .object({
      kind: z.literal("draft"),
      creationId: PlanningV2EntityIdSchema,
      draftRevision: PlanningV2RevisionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("plan-change"),
      planId: PlanningV2EntityIdSchema,
      changeId: PlanningV2EntityIdSchema,
    })
    .strict(),
]);
export type PlanningV2ContextTarget = z.infer<typeof PlanningV2ContextTargetSchema>;

export const PlanGetContextV2RequestSchema = z
  .object({
    schemaVersion: z.literal(PLANNING_V2_SCHEMA_VERSION),
    target: PlanningV2ContextTargetSchema,
  })
  .strict();
export type PlanGetContextV2Request = z.infer<typeof PlanGetContextV2RequestSchema>;

export const PlanningV2ContextDetailSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("active-plan"),
      plan: PlanningV2ActivePlanSummarySchema,
      snapshotFingerprint: PlanningV2FingerprintSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("closed-plan"),
      plan: PlanningV2ClosedPlanSummarySchema,
      snapshotFingerprint: PlanningV2FingerprintSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("plan-creation"),
      creation: PlanningV2CreationSummarySchema,
      answers: z.array(PlanningV2AnswerSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal("draft"),
      id: PlanningV2EntityIdSchema,
      creationId: PlanningV2EntityIdSchema,
      creationVersion: PlanningV2RevisionSchema,
      revision: PlanningV2RevisionSchema,
      fingerprint: PlanningV2FingerprintSchema,
      generatedAtMs: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("plan-change"),
      id: PlanningV2EntityIdSchema,
      planId: PlanningV2EntityIdSchema,
      version: PlanningV2RevisionSchema,
      status: z.enum(["preview", "applied", "stale", "discarded"]),
      basePlanRevision: PlanningV2RevisionSchema,
      resultPlanRevision: PlanningV2RevisionSchema.nullable(),
      previewFingerprint: PlanningV2FingerprintSchema,
    })
    .strict(),
]);

export const PlanGetContextV2ResultSchema = z
  .object({
    schemaVersion: z.literal(PLANNING_V2_SCHEMA_VERSION),
    asOfMs: z.number().int().nonnegative(),
    detail: PlanningV2ContextDetailSchema,
    effectiveContext: z.array(PlanningV2EffectiveContextEntrySchema),
    athletePreferences: z.array(PlanningV2AthletePreferenceSchema),
    trainingRestrictions: z.array(PlanningV2TrainingRestrictionSchema),
    observedEvidence: z.array(PlanningV2ObservedEvidenceSchema),
    allowedCommands: z.array(PlanningV2AllowedCommandSchema),
  })
  .strict();
export type PlanGetContextV2Result = z.infer<typeof PlanGetContextV2ResultSchema>;

const PlanningV2CommandBaseShape = {
  schemaVersion: z.literal(PLANNING_V2_SCHEMA_VERSION),
  commandId: PlanningV2CommandIdSchema,
  requestDigest: PlanningV2RequestDigestSchema,
};

export const PlanCreationStartV2CommandSchema = z
  .object({
    ...PlanningV2CommandBaseShape,
    name: z.literal("plan_creation.start"),
    intent: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("new") }).strict(),
        z.object({ kind: z.literal("from-plan"), planId: PlanningV2EntityIdSchema }).strict(),
      ])
      .nullable(),
  })
  .strict();

export const PlanCreationAnswerV2CommandSchema = z
  .object({
    ...PlanningV2CommandBaseShape,
    name: z.literal("plan_creation.answer"),
    creationId: PlanningV2EntityIdSchema,
    expectedCreationVersion: PlanningV2RevisionSchema,
    answer: PlanningV2AnswerSchema,
    confirmed: z.literal(true),
    scope: z.enum(["only-this-plan", "future-plans-too"]),
  })
  .strict();

export const PlanCreationPreviewV2CommandSchema = z
  .object({
    ...PlanningV2CommandBaseShape,
    name: z.literal("plan_creation.preview"),
    creationId: PlanningV2EntityIdSchema,
    expectedCreationVersion: PlanningV2RevisionSchema,
  })
  .strict();

export const PlanCreationActivateV2CommandSchema = z
  .object({
    ...PlanningV2CommandBaseShape,
    name: z.literal("plan_creation.activate"),
    creationId: PlanningV2EntityIdSchema,
    expectedCreationVersion: PlanningV2RevisionSchema,
    draftId: PlanningV2EntityIdSchema,
    draftRevision: PlanningV2RevisionSchema,
    draftFingerprint: PlanningV2FingerprintSchema,
  })
  .strict();

export const PlanCreationDiscardV2CommandSchema = z
  .object({
    ...PlanningV2CommandBaseShape,
    name: z.literal("plan_creation.discard"),
    creationId: PlanningV2EntityIdSchema,
    expectedCreationVersion: PlanningV2RevisionSchema,
  })
  .strict();

export const PlanningV2PlanChangeIntentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("adjust-load"),
      direction: z.enum(["increase", "reduce"]),
      effectiveDate: TrainingExportCivilDateSchema,
      rationale: z.string().min(1).max(2_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("adjust-availability"),
      availability: PlanningV2WeeklyAvailabilityAnswerSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("change-goal"),
      goal: z.string().min(1).max(2_000),
      successDefinition: z.string().min(1).max(2_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("apply-training-restriction"),
      restrictionId: PlanningV2EntityIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("sport-intent"),
      intentId: z.string().regex(/^sport:[a-z0-9][a-z0-9.-]{0,121}$/u),
      answer: PlanningV2AnswerSchema,
    })
    .strict(),
]);

export const PlanChangePreviewV2CommandSchema = z
  .object({
    ...PlanningV2CommandBaseShape,
    name: z.literal("plan_change.preview"),
    planId: PlanningV2EntityIdSchema,
    expectedPlanVersion: PlanningV2RevisionSchema,
    expectedPlanRevision: PlanningV2RevisionSchema,
    intent: PlanningV2PlanChangeIntentSchema,
  })
  .strict();

export const PlanChangeApplyV2CommandSchema = z
  .object({
    ...PlanningV2CommandBaseShape,
    name: z.literal("plan_change.apply"),
    planId: PlanningV2EntityIdSchema,
    changeId: PlanningV2EntityIdSchema,
    expectedChangeVersion: PlanningV2RevisionSchema,
    expectedPlanVersion: PlanningV2RevisionSchema,
    expectedPlanRevision: PlanningV2RevisionSchema,
    previewFingerprint: PlanningV2FingerprintSchema,
  })
  .strict();

export const PlanCloseV2CommandSchema = z
  .object({
    ...PlanningV2CommandBaseShape,
    name: z.literal("plan.close"),
    planId: PlanningV2EntityIdSchema,
    expectedPlanVersion: PlanningV2RevisionSchema,
    expectedPlanRevision: PlanningV2RevisionSchema,
    reason: z.enum(["completed", "stopped"]),
    actor: z.enum(["athlete", "system:plan-completion"]),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.reason === "completed") !== (value.actor === "system:plan-completion")) {
      context.addIssue({
        code: "custom",
        path: ["actor"],
        message: "completed closure requires the Plan completion actor",
      });
    }
  });

export const PlanningV2CommandSchema = z.discriminatedUnion("name", [
  PlanCreationStartV2CommandSchema,
  PlanCreationAnswerV2CommandSchema,
  PlanCreationPreviewV2CommandSchema,
  PlanCreationActivateV2CommandSchema,
  PlanCreationDiscardV2CommandSchema,
  PlanChangePreviewV2CommandSchema,
  PlanChangeApplyV2CommandSchema,
  PlanCloseV2CommandSchema,
]);
export type PlanningV2Command = z.infer<typeof PlanningV2CommandSchema>;

export const PlanningV2CommandErrorSchema = z
  .object({
    code: z.enum([
      "invalid-input",
      "not-found",
      "conflict",
      "stale-revision",
      "command-conflict",
      "blocked",
      "provider-failed",
      "persistence-failed",
    ]),
    message: z.string().min(1).max(2_000),
    retryable: z.boolean(),
    currentVersion: PlanningV2RevisionSchema.nullable(),
    currentRevision: PlanningV2RevisionSchema.nullable(),
  })
  .strict();

const planningV2CommandResultSchema = <
  Name extends PlanningV2Command["name"],
  Data extends z.ZodType,
>(
  name: Name,
  data: Data,
) =>
  z.discriminatedUnion("status", [
    z
      .object({
        schemaVersion: z.literal(PLANNING_V2_SCHEMA_VERSION),
        name: z.literal(name),
        commandId: PlanningV2CommandIdSchema,
        requestDigest: PlanningV2RequestDigestSchema,
        status: z.enum(["succeeded", "replayed"]),
        data,
      })
      .strict(),
    z
      .object({
        schemaVersion: z.literal(PLANNING_V2_SCHEMA_VERSION),
        name: z.literal(name),
        commandId: PlanningV2CommandIdSchema,
        requestDigest: PlanningV2RequestDigestSchema,
        status: z.literal("rejected"),
        error: PlanningV2CommandErrorSchema,
      })
      .strict(),
  ]);

export const PlanCreationStartV2ResultSchema = planningV2CommandResultSchema(
  "plan_creation.start",
  z
    .object({
      outcome: z.enum(["created", "existing"]),
      creation: PlanningV2CreationSummarySchema,
    })
    .strict(),
);

export const PlanCreationAnswerV2ResultSchema = planningV2CommandResultSchema(
  "plan_creation.answer",
  z
    .object({
      creation: PlanningV2CreationSummarySchema,
      answerId: PlanningV2EntityIdSchema,
      preferenceId: PlanningV2EntityIdSchema.nullable(),
    })
    .strict(),
);

export const PlanCreationPreviewV2ResultSchema = planningV2CommandResultSchema(
  "plan_creation.preview",
  z
    .object({
      creation: PlanningV2CreationSummarySchema,
      draftId: PlanningV2EntityIdSchema,
      draftRevision: PlanningV2RevisionSchema,
      draftFingerprint: PlanningV2FingerprintSchema,
    })
    .strict(),
);

export const PlanCreationActivateV2ResultSchema = planningV2CommandResultSchema(
  "plan_creation.activate",
  z
    .object({
      creationId: PlanningV2EntityIdSchema,
      activePlan: PlanningV2ActivePlanSummarySchema,
      closedPlanId: PlanningV2EntityIdSchema.nullable(),
      calendar: PlanningV2CalendarStatusSchema,
    })
    .strict(),
);

export const PlanCreationDiscardV2ResultSchema = planningV2CommandResultSchema(
  "plan_creation.discard",
  z.object({ creationId: PlanningV2EntityIdSchema, status: z.literal("discarded") }).strict(),
);

export const PlanChangePreviewV2ResultSchema = planningV2CommandResultSchema(
  "plan_change.preview",
  z
    .object({
      changeId: PlanningV2EntityIdSchema,
      changeVersion: PlanningV2RevisionSchema,
      planId: PlanningV2EntityIdSchema,
      basePlanRevision: PlanningV2RevisionSchema,
      previewFingerprint: PlanningV2FingerprintSchema,
    })
    .strict(),
);

export const PlanChangeApplyV2ResultSchema = planningV2CommandResultSchema(
  "plan_change.apply",
  z
    .object({
      changeId: PlanningV2EntityIdSchema,
      activePlan: PlanningV2ActivePlanSummarySchema,
      calendar: PlanningV2CalendarStatusSchema,
    })
    .strict(),
);

export const PlanCloseV2ResultSchema = planningV2CommandResultSchema(
  "plan.close",
  z
    .object({
      closedPlan: PlanningV2ClosedPlanSummarySchema,
      calendar: PlanningV2CalendarStatusSchema,
    })
    .strict(),
);

export const PlanningV2CommandResultSchema = z.union([
  PlanCreationStartV2ResultSchema,
  PlanCreationAnswerV2ResultSchema,
  PlanCreationPreviewV2ResultSchema,
  PlanCreationActivateV2ResultSchema,
  PlanCreationDiscardV2ResultSchema,
  PlanChangePreviewV2ResultSchema,
  PlanChangeApplyV2ResultSchema,
  PlanCloseV2ResultSchema,
]);
export type PlanningV2CommandResult = z.infer<typeof PlanningV2CommandResultSchema>;

export type PlanCreationStartV2Command = z.infer<typeof PlanCreationStartV2CommandSchema>;
export type PlanCreationAnswerV2Command = z.infer<typeof PlanCreationAnswerV2CommandSchema>;
export type PlanCreationPreviewV2Command = z.infer<typeof PlanCreationPreviewV2CommandSchema>;
export type PlanCreationActivateV2Command = z.infer<typeof PlanCreationActivateV2CommandSchema>;
export type PlanCreationDiscardV2Command = z.infer<typeof PlanCreationDiscardV2CommandSchema>;
export type PlanChangePreviewV2Command = z.infer<typeof PlanChangePreviewV2CommandSchema>;
export type PlanChangeApplyV2Command = z.infer<typeof PlanChangeApplyV2CommandSchema>;
export type PlanCloseV2Command = z.infer<typeof PlanCloseV2CommandSchema>;
export type PlanCreationStartV2Result = z.infer<typeof PlanCreationStartV2ResultSchema>;
export type PlanCreationAnswerV2Result = z.infer<typeof PlanCreationAnswerV2ResultSchema>;
export type PlanCreationPreviewV2Result = z.infer<typeof PlanCreationPreviewV2ResultSchema>;
export type PlanCreationActivateV2Result = z.infer<typeof PlanCreationActivateV2ResultSchema>;
export type PlanCreationDiscardV2Result = z.infer<typeof PlanCreationDiscardV2ResultSchema>;
export type PlanChangePreviewV2Result = z.infer<typeof PlanChangePreviewV2ResultSchema>;
export type PlanChangeApplyV2Result = z.infer<typeof PlanChangeApplyV2ResultSchema>;
export type PlanCloseV2Result = z.infer<typeof PlanCloseV2ResultSchema>;

export interface PlanningV2Operations {
  "plan.list"?(request: PlanListV2Request): Promise<PlanListV2Result>;
  "plan.get_context"?(request: PlanGetContextV2Request): Promise<PlanGetContextV2Result>;
  "plan_creation.start"?(request: PlanCreationStartV2Command): Promise<PlanCreationStartV2Result>;
  "plan_creation.answer"?(
    request: PlanCreationAnswerV2Command,
  ): Promise<PlanCreationAnswerV2Result>;
  "plan_creation.preview"?(
    request: PlanCreationPreviewV2Command,
  ): Promise<PlanCreationPreviewV2Result>;
  "plan_creation.activate"?(
    request: PlanCreationActivateV2Command,
  ): Promise<PlanCreationActivateV2Result>;
  "plan_creation.discard"?(
    request: PlanCreationDiscardV2Command,
  ): Promise<PlanCreationDiscardV2Result>;
  "plan_change.preview"?(request: PlanChangePreviewV2Command): Promise<PlanChangePreviewV2Result>;
  "plan_change.apply"?(request: PlanChangeApplyV2Command): Promise<PlanChangeApplyV2Result>;
  "plan.close"?(request: PlanCloseV2Command): Promise<PlanCloseV2Result>;
}

export const LegacyPlanStatusSchema = z.enum(["draft", "active", "ended"]);
export const LegacyToPlanningV2LifecycleResultSchema = z.union([
  z.object({ aggregate: z.literal("plan-creation"), status: z.literal("review") }).strict(),
  z.object({ aggregate: z.literal("plan"), lifecycle: z.literal("active") }).strict(),
  z
    .object({
      aggregate: z.literal("plan"),
      lifecycle: z.literal("closed"),
      closeReason: z.literal("unavailable"),
    })
    .strict(),
]);

export function adaptLegacyPlanStatusToPlanningV2(
  value: unknown,
): z.infer<typeof LegacyToPlanningV2LifecycleResultSchema> {
  const status = LegacyPlanStatusSchema.parse(value);
  if (status === "draft") return { aggregate: "plan-creation", status: "review" };
  if (status === "active") return { aggregate: "plan", lifecycle: "active" };
  return { aggregate: "plan", lifecycle: "closed", closeReason: "unavailable" };
}

export const PlanningV2ToLegacyLifecycleInputSchema = z.union([
  z
    .object({
      aggregate: z.literal("plan-creation"),
      status: z.enum(["in-progress", "review"]),
    })
    .strict(),
  z.object({ aggregate: z.literal("plan"), lifecycle: z.literal("active") }).strict(),
  z
    .object({
      aggregate: z.literal("plan"),
      lifecycle: z.literal("closed"),
      closeReason: z.enum(["completed", "stopped", "unavailable"]),
    })
    .strict(),
]);

export const PlanningV2ToLegacyLifecycleResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("mapped"), legacyStatus: LegacyPlanStatusSchema }).strict(),
  z
    .object({
      status: z.literal("incompatible"),
      reason: z.enum(["unfinished-creation", "close-reason-would-be-lost"]),
    })
    .strict(),
]);

export function adaptPlanningV2LifecycleToLegacy(
  value: unknown,
): z.infer<typeof PlanningV2ToLegacyLifecycleResultSchema> {
  const lifecycle = PlanningV2ToLegacyLifecycleInputSchema.parse(value);
  if (lifecycle.aggregate === "plan-creation") {
    return lifecycle.status === "review"
      ? { status: "mapped", legacyStatus: "draft" }
      : { status: "incompatible", reason: "unfinished-creation" };
  }
  if (lifecycle.lifecycle === "active") return { status: "mapped", legacyStatus: "active" };
  return lifecycle.closeReason === "unavailable"
    ? { status: "mapped", legacyStatus: "ended" }
    : { status: "incompatible", reason: "close-reason-would-be-lost" };
}
