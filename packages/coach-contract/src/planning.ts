import { z } from "zod";
import { ChatQueueSnapshotSchema } from "./chat-queue.js";
import { CoachDecisionAnswerSchema, CoachDecisionReadModelSchema } from "./coach-decision.js";
import { PlatformAbsolutePathSchema } from "./platform-path.js";
import { TrainingExportCivilDateSchema } from "./training-export.js";
import { TurnEventSchema } from "./turn-event.js";

export const PLAN_TRANSITION_IDS = [
  "PL-T01",
  "PL-T02",
  "PL-T03",
  "PL-T04",
  "PL-T05",
  "PL-T06",
  "PL-T07",
  "PL-T08",
  "PL-T09",
  "PL-T10",
  "PL-T11",
  "PL-T12",
  "PL-T13",
  "PL-T14",
  "PL-T15",
  "PL-T16",
  "PL-T17",
  "PL-T18",
  "PL-T19",
  "PL-T20",
  "PL-T21",
  "PL-T22",
  "PL-T23",
  "PL-T24",
  "PL-T25",
  "PL-T26",
  "PL-T27",
  "PL-T28",
  "PL-T29",
  "PL-T30",
  "PL-T31",
  "PL-T32",
  "PL-T33",
  "PL-T34",
  "PL-T35",
  "PL-T36",
  "PL-T37",
  "PL-T38",
  "PL-T39",
] as const;

export const PLAN_MIN_FULL_DAYS = 84 as const;

export const PlanTransitionIdSchema = z.enum(PLAN_TRANSITION_IDS);
export type PlanTransitionId = z.infer<typeof PlanTransitionIdSchema>;

export const PlanScenarioIdSchema = z.string().regex(/^PL-S(?:00[1-9]|0[1-9][0-9]|10[0-5])$/);
export type PlanScenarioId = z.infer<typeof PlanScenarioIdSchema>;

export const PlanLifecycleSchema = z.enum([
  "none",
  "intake",
  "draft-forming",
  "draft",
  "active",
  "ended",
  "replacement-intake",
  "replacement-draft-forming",
  "replacement-draft",
]);
export type PlanLifecycle = z.infer<typeof PlanLifecycleSchema>;

export const PlanErrorSchema = z
  .object({
    code: z.enum([
      "unavailable",
      "invalid-input",
      "conflict",
      "stale-base",
      "expired",
      "provider-failed",
      "persistence-failed",
      "verification-failed",
    ]),
    message: z.string().min(1),
    retryable: z.boolean(),
  })
  .strict();
export type PlanError = z.infer<typeof PlanErrorSchema>;

export const PlanAttentionItemSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    scenarioId: PlanScenarioIdSchema,
    priority: z.enum(["blocker", "dated", "recent"]),
    affectedDate: TrainingExportCivilDateSchema.nullable(),
  })
  .strict();
export type PlanAttentionItem = z.infer<typeof PlanAttentionItemSchema>;

export const PlanAttentionSchema = z
  .object({
    count: z.number().int().nonnegative(),
    destination: z.enum(["none", "direct", "list"]),
    items: z.array(PlanAttentionItemSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.count !== value.items.length) {
      context.addIssue({
        code: "custom",
        path: ["count"],
        message: "attention count must equal unresolved items",
      });
    }
    const destination = value.count === 0 ? "none" : value.count === 1 ? "direct" : "list";
    if (value.destination !== destination) {
      context.addIssue({
        code: "custom",
        path: ["destination"],
        message: "attention destination does not match unresolved count",
      });
    }
  });
export type PlanAttention = z.infer<typeof PlanAttentionSchema>;

export const PlanProjectionKindSchema = z.enum([
  "no-plan",
  "coach",
  "draft",
  "active",
  "workout",
  "proposal",
  "reconciliation",
  "attention",
  "history",
  "settings",
  "season",
  "readiness",
  "ended",
]);
export type PlanProjectionKind = z.infer<typeof PlanProjectionKindSchema>;

export const PlanTransitionGuardSchema = z
  .object({
    transitionId: PlanTransitionIdSchema,
    status: z.enum(["available", "blocked"]),
    reason: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.status === "blocked") !== (value.reason !== null)) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "blocked transitions require a reason and available transitions forbid one",
      });
    }
  });
export type PlanTransitionGuard = z.infer<typeof PlanTransitionGuardSchema>;

export const PlanReconciliationSchema = z
  .object({
    status: z.enum(["not-applicable", "not-started", "running", "verified", "failed"]),
    created: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    currentThrough: TrainingExportCivilDateSchema.nullable(),
    error: PlanErrorSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.created + value.pending + value.failed !== value.total) {
      context.addIssue({
        code: "custom",
        path: ["total"],
        message: "reconciliation counts must equal total",
      });
    }
    if ((value.status === "failed") !== (value.error !== null)) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "failed reconciliation requires an error and other states forbid one",
      });
    }
    if (value.status === "not-applicable" && (value.total !== 0 || value.currentThrough !== null)) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "not-applicable reconciliation forbids counts and dates",
      });
    }
    if (
      value.status === "verified" &&
      (value.pending !== 0 || value.failed !== 0 || value.currentThrough === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "verified reconciliation requires a current date and no unresolved items",
      });
    }
  });
export type PlanReconciliation = z.infer<typeof PlanReconciliationSchema>;

export const PlanProgressEventSchema = z
  .object({
    commandId: z.string().min(1),
    transitionId: PlanTransitionIdSchema,
    operationId: z.string().min(1),
    phase: z.enum(["queued", "running", "completed", "failed"]),
    completed: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    turnEvent: TurnEventSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.completed > value.total) {
      context.addIssue({
        code: "custom",
        path: ["completed"],
        message: "completed exceeds total",
      });
    }
    if (value.phase === "queued" && value.completed !== 0) {
      context.addIssue({
        code: "custom",
        path: ["completed"],
        message: "queued progress begins at zero",
      });
    }
    if (value.phase === "completed" && value.completed !== value.total) {
      context.addIssue({
        code: "custom",
        path: ["completed"],
        message: "completed progress reaches total",
      });
    }
    if (value.turnEvent !== undefined && value.phase !== "running") {
      context.addIssue({
        code: "custom",
        path: ["turnEvent"],
        message: "coach turn events require running progress",
      });
    }
  });
export type PlanProgressEvent = z.infer<typeof PlanProgressEventSchema>;

export const PlanCoachMessageSchema = z
  .object({
    id: z.string().min(1),
    turnId: z.string().min(1).nullable(),
    role: z.enum(["athlete", "coach"]),
    text: z.string(),
  })
  .strict();
export type PlanCoachMessage = z.infer<typeof PlanCoachMessageSchema>;

export const PlanDraftProjectionSchema = z
  .object({
    id: z.string().min(1),
    planId: z.string().min(1),
    revision: z.number().int().positive(),
    status: z.enum(["forming", "ready", "failed", "discarded", "approved"]),
    snapshot: z.json(),
  })
  .strict();
export type PlanDraftProjection = z.infer<typeof PlanDraftProjectionSchema>;

export const PlanDraftPlanProjectionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    primaryGoal: z.string(),
    startDate: TrainingExportCivilDateSchema,
    targetDate: TrainingExportCivilDateSchema.nullable(),
    kind: z.enum(["full-plan", "short-race-preparation"]),
    totalWeeks: z.number().int().positive(),
    weekStartDay: z.number().int().min(0).max(6),
    workoutCount: z.number().int().nonnegative(),
    plannedDurationS: z.number().int().nonnegative(),
  })
  .strict();
export type PlanDraftPlanProjection = z.infer<typeof PlanDraftPlanProjectionSchema>;

export const PlanActiveWorkoutProjectionSchema = z
  .object({
    id: z.string().min(1),
    date: TrainingExportCivilDateSchema,
    sport: z.string().min(1),
    name: z.string().min(1),
    durationS: z.number().int().positive().nullable(),
    match: z
      .object({
        kind: z.enum(["planned", "extra"]),
        status: z.enum([
          "as-planned",
          "adjusted",
          "moved",
          "missed",
          "extra",
          "decision-needed",
          "awaiting-sync",
          "upcoming",
        ]),
        activityId: z.string().min(1).nullable(),
        matchId: z.string().min(1).nullable(),
        actualDate: TrainingExportCivilDateSchema.nullable(),
        actualDurationS: z.number().int().positive().nullable(),
        requiresConfirmation: z.boolean(),
      })
      .strict()
      .optional(),
    drift: z
      .object({
        status: z.literal("detected"),
        eventId: z.string().min(1),
        plan: z
          .object({
            date: TrainingExportCivilDateSchema,
            name: z.string().min(1),
            durationS: z.number().int().positive().nullable(),
          })
          .strict(),
        provider: z
          .object({
            date: TrainingExportCivilDateSchema,
            name: z.string().min(1),
            durationS: z.number().int().positive().nullable(),
          })
          .strict(),
        error: PlanErrorSchema.nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PlanActiveWorkoutProjection = z.infer<typeof PlanActiveWorkoutProjectionSchema>;

export const PlanProposalProjectionSchema = z
  .object({
    id: z.string().min(1),
    revision: z.number().int().positive(),
    title: z.string().min(1),
    rationale: z.string().min(1),
    confidence: z.enum(["Low", "Moderate", "High"]),
    targetWorkoutId: z.string().min(1),
    affectedDate: TrainingExportCivilDateSchema,
    stale: z.boolean(),
    diff: z.array(
      z
        .object({
          field: z.enum(["duration", "workout", "date", "week-load"]),
          label: z.string().min(1),
          before: z.string(),
          after: z.string(),
        })
        .strict(),
    ),
    premises: z.array(
      z
        .object({
          id: z.string().min(1),
          sourceType: z.string().min(1),
          sourceId: z.string().min(1),
          sourceLabel: z.string().min(1),
          sourceDate: TrainingExportCivilDateSchema.nullable(),
          confidence: z.enum(["Low", "Moderate", "High"]),
          snapshotJson: z.string().min(1),
        })
        .strict(),
    ),
    error: PlanErrorSchema.nullable(),
  })
  .strict();
export type PlanProposalProjection = z.infer<typeof PlanProposalProjectionSchema>;

export const PlanHistoryEntrySchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["activation", "proposal-applied", "drift-adopted", "undo"]),
    label: z.string().min(1),
    occurredAtMs: z.number().int().nonnegative(),
    targetWorkoutId: z.string().min(1).nullable(),
    before: z
      .object({
        date: TrainingExportCivilDateSchema,
        name: z.string().min(1),
        durationS: z.number().int().positive().nullable(),
      })
      .strict()
      .nullable(),
    after: z
      .object({
        date: TrainingExportCivilDateSchema,
        name: z.string().min(1),
        durationS: z.number().int().positive().nullable(),
      })
      .strict()
      .nullable(),
    weekLoadBefore: z.number().nonnegative().nullable(),
    weekLoadAfter: z.number().nonnegative().nullable(),
    undoStatus: z.enum(["none", "eligible", "expired", "undone"]),
    undoReason: z
      .enum([
        "newer-change",
        "plan-not-active",
        "workout-missing",
        "workout-not-future",
        "workout-not-coach-owned",
        "workout-changed",
        "already-undone",
      ])
      .nullable(),
  })
  .strict();
export type PlanHistoryEntry = z.infer<typeof PlanHistoryEntrySchema>;

export const PlanSettingsProjectionSchema = z
  .object({
    autoApply: z.boolean(),
    weeklyReview: z.boolean(),
    updatedAtMs: z.number().int().nonnegative(),
    selectedSetting: z.enum(["auto-apply", "weekly-review"]).nullable(),
    error: PlanErrorSchema.nullable(),
  })
  .strict();
export type PlanSettingsProjection = z.infer<typeof PlanSettingsProjectionSchema>;

export const PlanActiveProjectionDataSchema = z
  .object({
    plan: PlanDraftPlanProjectionSchema,
    today: TrainingExportCivilDateSchema,
    weekIndex: z.number().int().positive(),
    todayWorkout: PlanActiveWorkoutProjectionSchema.nullable(),
    workouts: z.array(PlanActiveWorkoutProjectionSchema),
    matchSync: z
      .object({
        lastSuccessfulSyncAtMs: z.number().int().nonnegative().nullable(),
        awaitingSync: z.boolean(),
      })
      .strict()
      .optional(),
    selectedWorkoutId: z.string().min(1).nullable().optional(),
    proposals: z.array(PlanProposalProjectionSchema).optional(),
    selectedProposalId: z.string().min(1).nullable().optional(),
    proposalRevisionText: z.string().nullable().optional(),
    history: z.array(PlanHistoryEntrySchema).optional(),
    selectedHistoryId: z.string().min(1).nullable().optional(),
    settings: PlanSettingsProjectionSchema.optional(),
  })
  .strict();
export type PlanActiveProjectionData = z.infer<typeof PlanActiveProjectionDataSchema>;

export const PlanEndedProjectionDataSchema = z
  .object({
    plan: PlanDraftPlanProjectionSchema,
    endedAtMs: z.number().int().nonnegative(),
    cleanupItems: z.array(
      z
        .object({
          id: z.string().min(1),
          date: TrainingExportCivilDateSchema,
          externalId: z.string().min(1),
          status: z.enum(["pending", "running", "failed", "verified"]),
          errorCode: z.string().min(1).nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type PlanEndedProjectionData = z.infer<typeof PlanEndedProjectionDataSchema>;

export const PlanStartDateProjectionSchema = z
  .object({
    status: z.enum(["ready", "invalid", "recalculating", "failed", "updated"]),
    selectedDate: TrainingExportCivilDateSchema,
    today: TrainingExportCivilDateSchema,
    targetDate: TrainingExportCivilDateSchema,
    kind: z.enum(["full-plan", "short-race-preparation"]).nullable(),
    inclusiveDays: z.number().int().positive().nullable(),
    totalWeeks: z.number().int().positive().nullable(),
    raceWeekday: z.number().int().min(0).max(6).nullable(),
    raceDayOfPlanWeek: z.number().int().min(1).max(7).nullable(),
    error: PlanErrorSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasPreview =
      value.kind !== null &&
      value.inclusiveDays !== null &&
      value.totalWeeks !== null &&
      value.raceWeekday !== null &&
      value.raceDayOfPlanWeek !== null;
    if ((value.status === "invalid") === hasPreview) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "invalid dates forbid a preview and valid dates require one",
      });
    }
    if ((value.status === "invalid" || value.status === "failed") !== (value.error !== null)) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "invalid or failed start dates require an error",
      });
    }
  });
export type PlanStartDateProjection = z.infer<typeof PlanStartDateProjectionSchema>;

export const PlanRaceCourseSummarySchema = z
  .object({
    fileName: z.string().min(1),
    format: z.enum(["gpx", "fit"]),
    pointCount: z.number().int().positive(),
    distanceM: z.number().positive(),
    elevationGainM: z.number().nonnegative().nullable(),
    elevationStatus: z.enum(["available", "unavailable"]),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.elevationStatus === "available") !== (value.elevationGainM !== null)) {
      context.addIssue({
        code: "custom",
        path: ["elevationGainM"],
        message: "Course elevation status must match its gain",
      });
    }
  });
export type PlanRaceCourseSummary = z.infer<typeof PlanRaceCourseSummarySchema>;

export const PlanRaceCourseProjectionSchema = z
  .object({
    status: z.enum([
      "undecided",
      "omitted",
      "parsing",
      "invalid",
      "missing-elevation",
      "recalculating",
      "recalculation-failed",
      "ready",
      "omission-failed",
    ]),
    accepted: PlanRaceCourseSummarySchema.nullable(),
    candidate: PlanRaceCourseSummarySchema.nullable(),
    fileName: z.string().min(1).nullable(),
    detail: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const empty =
      value.accepted === null &&
      value.candidate === null &&
      value.fileName === null &&
      value.detail === null;
    const valid =
      ((value.status === "undecided" || value.status === "omitted") && empty) ||
      (value.status === "ready" &&
        value.accepted !== null &&
        value.candidate === null &&
        value.fileName === null &&
        value.detail === null) ||
      (value.status === "parsing" &&
        value.candidate === null &&
        value.fileName !== null &&
        value.detail === null) ||
      (value.status === "invalid" &&
        value.candidate === null &&
        value.fileName !== null &&
        value.detail !== null) ||
      (value.status === "missing-elevation" &&
        value.candidate?.elevationStatus === "unavailable" &&
        value.fileName === null &&
        value.detail === null) ||
      (value.status === "recalculating" && value.fileName === null && value.detail === null) ||
      (value.status === "recalculation-failed" &&
        value.fileName === null &&
        value.detail !== null) ||
      (value.status === "omission-failed" &&
        value.accepted === null &&
        value.candidate === null &&
        value.fileName === null &&
        value.detail !== null);
    if (!valid) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Course projection fields do not match its status",
      });
    }
  });
export type PlanRaceCourseProjection = z.infer<typeof PlanRaceCourseProjectionSchema>;

export const PlanRaceCourseFileSelectionSchema = PlatformAbsolutePathSchema.nullable();
export type PlanRaceCourseFileSelection = z.infer<typeof PlanRaceCourseFileSelectionSchema>;

export const PlanFtpSourceValueSchema = z
  .object({
    watts: z.number().int().min(1).max(9_999),
    refreshedAtMs: z.number().int().nonnegative(),
  })
  .strict();
export type PlanFtpSourceValue = z.infer<typeof PlanFtpSourceValueSchema>;

export const PlanFtpProjectionSchema = z
  .object({
    status: z.enum(["required", "no-source", "refresh-failed", "conflict", "accepted"]),
    manual: PlanFtpSourceValueSchema.nullable(),
    intervalsFtp: PlanFtpSourceValueSchema.nullable(),
    intervalsEftp: PlanFtpSourceValueSchema.nullable(),
    usedSource: z.enum(["manual", "intervals-ftp", "intervals-eftp"]).nullable(),
    usedWatts: z.number().int().min(1).max(9_999).nullable(),
    conflict: z.boolean(),
    error: PlanErrorSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.usedSource === null) !== (value.usedWatts === null)) {
      context.addIssue({
        code: "custom",
        path: ["usedWatts"],
        message: "used FTP source and watts must appear together",
      });
    }
    const selected =
      value.usedSource === "manual"
        ? value.manual
        : value.usedSource === "intervals-ftp"
          ? value.intervalsFtp
          : value.usedSource === "intervals-eftp"
            ? value.intervalsEftp
            : null;
    if (value.usedSource !== null && selected === null) {
      context.addIssue({
        code: "custom",
        path: ["usedSource"],
        message: "used FTP source must be available",
      });
    }
    if (selected !== null && selected.watts !== value.usedWatts) {
      context.addIssue({
        code: "custom",
        path: ["usedWatts"],
        message: "used FTP watts must match the selected source",
      });
    }
    if ((value.status === "refresh-failed") !== (value.error !== null)) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "only a failed FTP refresh carries an error",
      });
    }
    if (
      ((value.status === "required" || value.status === "no-source") &&
        value.usedSource !== null) ||
      (value.status === "accepted" && (value.usedSource === null || value.conflict)) ||
      (value.status === "conflict" && (value.usedSource === null || !value.conflict))
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "FTP status must match source availability and conflict state",
      });
    }
  });
export type PlanFtpProjection = z.infer<typeof PlanFtpProjectionSchema>;

export const PlanCoachProjectionDataSchema = z
  .object({
    conversationId: z.string().min(1),
    chatId: z.string().min(1),
    sourceConversationId: z.string().min(1).nullable(),
    replacement: z.boolean(),
    readyToCreateDraft: z.boolean(),
    messages: z.array(PlanCoachMessageSchema),
    queue: ChatQueueSnapshotSchema,
    decision: CoachDecisionReadModelSchema.nullable(),
    draft: PlanDraftProjectionSchema.nullable(),
    plan: PlanDraftPlanProjectionSchema.nullable().optional(),
    startDate: PlanStartDateProjectionSchema.optional(),
    ftp: PlanFtpProjectionSchema.nullable().optional(),
    course: PlanRaceCourseProjectionSchema.optional(),
  })
  .strict();
export type PlanCoachProjectionData = z.infer<typeof PlanCoachProjectionDataSchema>;

export const PlanReadModelSchema = z
  .object({
    schemaVersion: z.literal(1),
    scenarioId: PlanScenarioIdSchema,
    lifecycle: PlanLifecycleSchema,
    planId: z.string().min(1).nullable(),
    revision: z.number().int().nonnegative(),
    title: z.string(),
    summary: z.string(),
    projection: PlanProjectionKindSchema,
    transitions: z.array(PlanTransitionGuardSchema),
    reconciliation: PlanReconciliationSchema,
    attention: PlanAttentionSchema,
    activeOperation: PlanProgressEventSchema.nullable(),
    data: z.record(z.string(), z.json()),
  })
  .strict()
  .superRefine((value, context) => {
    const transitionIds = new Set(value.transitions.map((transition) => transition.transitionId));
    if (transitionIds.size !== value.transitions.length) {
      context.addIssue({
        code: "custom",
        path: ["transitions"],
        message: "transition guards must be unique",
      });
    }
  });
export type PlanReadModel = z.infer<typeof PlanReadModelSchema>;

export const PlanHydrationStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("loading") }).strict(),
  z.object({ status: z.literal("ready"), state: PlanReadModelSchema }).strict(),
  z
    .object({
      status: z.literal("stale"),
      state: PlanReadModelSchema,
      error: PlanErrorSchema,
    })
    .strict(),
  z.object({ status: z.literal("failed"), error: PlanErrorSchema }).strict(),
  z
    .object({
      status: z.literal("unsupported-capability"),
      capability: z.literal("planning"),
    })
    .strict(),
]);
export type PlanHydrationState = z.infer<typeof PlanHydrationStateSchema>;

const CommandIdSchema = z.string().min(1);
const EntityIdSchema = z.string().min(1);

export const PlanTransitionCommandSchema = z.discriminatedUnion("transitionId", [
  z
    .object({
      transitionId: z.literal("PL-T01"),
      commandId: CommandIdSchema,
      sourceConversationId: EntityIdSchema.nullable(),
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T02"),
      commandId: CommandIdSchema,
      conversationId: EntityIdSchema,
      filePath: PlatformAbsolutePathSchema,
      elevation: z.enum(["require", "allow-missing"]),
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T03"),
      commandId: CommandIdSchema,
      conversationId: EntityIdSchema,
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T04"),
      commandId: CommandIdSchema,
      conversationId: EntityIdSchema,
      source: z.enum(["manual", "intervals", "intervals-ftp", "intervals-eftp"]),
      watts: z.number().int().min(1).max(9_999).nullable(),
    })
    .strict()
    .superRefine((value, context) => {
      if ((value.source === "manual") !== (value.watts !== null)) {
        context.addIssue({
          code: "custom",
          path: ["watts"],
          message: "manual FTP requires watts and imported FTP forbids watts",
        });
      }
    }),
  z
    .object({
      transitionId: z.literal("PL-T05"),
      commandId: CommandIdSchema,
      conversationId: EntityIdSchema,
      text: z.string().trim().min(1),
      decision: z
        .discriminatedUnion("action", [
          z
            .object({
              action: z.literal("answer"),
              decisionId: EntityIdSchema,
              answer: CoachDecisionAnswerSchema,
            })
            .strict(),
          z.object({ action: z.literal("skip"), decisionId: EntityIdSchema }).strict(),
          z.object({ action: z.literal("resume"), decisionId: EntityIdSchema }).strict(),
        ])
        .optional(),
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T06"),
      commandId: CommandIdSchema,
      conversationId: EntityIdSchema,
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T07"),
      commandId: CommandIdSchema,
      draftId: EntityIdSchema,
      text: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T08"),
      commandId: CommandIdSchema,
      draftId: EntityIdSchema,
      startDate: TrainingExportCivilDateSchema,
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T09"),
      commandId: CommandIdSchema,
      draftId: EntityIdSchema,
      course: z.discriminatedUnion("action", [
        z
          .object({
            action: z.literal("attach"),
            filePath: PlatformAbsolutePathSchema,
            elevation: z.enum(["require", "allow-missing"]),
          })
          .strict(),
        z.object({ action: z.literal("remove") }).strict(),
      ]),
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T10"),
      commandId: CommandIdSchema,
      draftId: EntityIdSchema,
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T11"),
      commandId: CommandIdSchema,
      draftId: EntityIdSchema,
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T12"),
      commandId: CommandIdSchema,
      planId: EntityIdSchema,
      mode: z.enum(["reconcile", "verify"]).optional(),
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T13"),
      commandId: CommandIdSchema,
      planId: EntityIdSchema,
      workoutId: EntityIdSchema,
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T14"),
      commandId: CommandIdSchema,
      planId: EntityIdSchema,
      workoutId: EntityIdSchema,
      activityId: EntityIdSchema,
      decision: z.enum(["confirm", "reject"]).optional(),
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T15"),
      commandId: CommandIdSchema,
      planId: EntityIdSchema,
      workoutId: EntityIdSchema,
      eventId: EntityIdSchema,
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T16"),
      commandId: CommandIdSchema,
      planId: EntityIdSchema,
      workoutId: EntityIdSchema,
      eventId: EntityIdSchema,
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T17"),
      commandId: CommandIdSchema,
      planId: EntityIdSchema,
      proposalId: EntityIdSchema,
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T18"),
      commandId: CommandIdSchema,
      proposalId: EntityIdSchema,
      text: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T19"),
      commandId: CommandIdSchema,
      proposalId: EntityIdSchema,
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T20"),
      commandId: CommandIdSchema,
      proposalId: EntityIdSchema,
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T21"),
      commandId: CommandIdSchema,
      planId: EntityIdSchema,
      ledgerId: EntityIdSchema,
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T22"),
      commandId: CommandIdSchema,
      planId: EntityIdSchema,
      setting: z.enum(["auto-apply", "weekly-review"]),
      value: z.boolean(),
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T23"),
      commandId: CommandIdSchema,
      planId: EntityIdSchema,
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T24"),
      commandId: CommandIdSchema,
      planId: EntityIdSchema,
      mode: z.enum(["cleanup", "verify"]).optional(),
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T25"),
      commandId: CommandIdSchema,
      planId: EntityIdSchema,
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T26"),
      commandId: CommandIdSchema,
      activePlanId: EntityIdSchema,
      draftId: EntityIdSchema,
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T27"),
      commandId: CommandIdSchema,
      planId: EntityIdSchema,
      replacementPlanId: EntityIdSchema,
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T28"),
      commandId: CommandIdSchema,
      planId: EntityIdSchema,
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T29"),
      commandId: CommandIdSchema,
      planId: EntityIdSchema,
      asOf: TrainingExportCivilDateSchema,
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T30"),
      commandId: CommandIdSchema,
      planId: EntityIdSchema,
      outcome: z.enum(["completed", "not-completed"]),
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T31"),
      commandId: CommandIdSchema,
      planId: EntityIdSchema,
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T32"),
      commandId: CommandIdSchema,
      planId: EntityIdSchema,
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T33"),
      commandId: CommandIdSchema,
      planId: EntityIdSchema,
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T34"),
      commandId: CommandIdSchema,
      attentionId: EntityIdSchema,
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T35"),
      commandId: CommandIdSchema,
      planId: EntityIdSchema,
      weekStart: TrainingExportCivilDateSchema,
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T36"),
      commandId: CommandIdSchema,
      sourceConversationId: EntityIdSchema,
      requestId: EntityIdSchema,
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T37"),
      commandId: CommandIdSchema,
      sourceConversationId: EntityIdSchema,
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T38"),
      commandId: CommandIdSchema,
      planId: EntityIdSchema,
      proposalId: EntityIdSchema,
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      transitionId: z.literal("PL-T39"),
      commandId: CommandIdSchema,
      action: z.enum(["open", "close", "back", "done", "disclose"]),
      sourceScenarioId: PlanScenarioIdSchema,
      destinationScenarioId: PlanScenarioIdSchema,
      returnFocusId: EntityIdSchema,
    })
    .strict(),
]);
export type PlanTransitionCommand = z.infer<typeof PlanTransitionCommandSchema>;

export const UnsupportedPlanningCapabilitySchema = z
  .object({
    status: z.literal("unsupported-capability"),
    capability: z.literal("planning"),
  })
  .strict();
export type UnsupportedPlanningCapability = z.infer<typeof UnsupportedPlanningCapabilitySchema>;

export const GetPlanStateRpcParamsSchema = z.object({}).strict();
export type GetPlanStateRpcParams = z.infer<typeof GetPlanStateRpcParamsSchema>;

export const GetPlanStateRpcResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), state: PlanReadModelSchema }).strict(),
  z
    .object({ status: z.literal("stale"), state: PlanReadModelSchema, error: PlanErrorSchema })
    .strict(),
  z.object({ status: z.literal("failed"), error: PlanErrorSchema }).strict(),
  UnsupportedPlanningCapabilitySchema,
]);
export type GetPlanStateRpcResult = z.infer<typeof GetPlanStateRpcResultSchema>;

export const ExecutePlanTransitionRpcParamsSchema = PlanTransitionCommandSchema;
export type ExecutePlanTransitionRpcParams = z.infer<typeof ExecutePlanTransitionRpcParamsSchema>;

export const ExecutePlanTransitionRpcResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), state: PlanReadModelSchema }).strict(),
  z
    .object({
      status: z.literal("accepted"),
      operationId: EntityIdSchema,
      state: PlanReadModelSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("rejected"),
      error: PlanErrorSchema,
      state: PlanReadModelSchema,
    })
    .strict(),
  UnsupportedPlanningCapabilitySchema,
]);
export type ExecutePlanTransitionRpcResult = z.infer<typeof ExecutePlanTransitionRpcResultSchema>;

export interface PlanningOperations {
  getPlanState?(request: GetPlanStateRpcParams): Promise<GetPlanStateRpcResult>;
  executePlanTransition?(
    request: ExecutePlanTransitionRpcParams,
    onEvent?: (event: PlanProgressEvent) => void,
  ): Promise<ExecutePlanTransitionRpcResult>;
}
