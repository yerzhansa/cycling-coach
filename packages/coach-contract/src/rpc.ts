import { z } from "zod";
import { AthleteStateSchema } from "./athlete-state.js";
import {
  ChatRequestSchema,
  ChatResponseSchema,
  HasSessionRequestSchema,
  HasSessionResponseSchema,
  ResetSessionRequestSchema,
  ResetSessionResponseSchema,
  type CoachEngine,
} from "./engine.js";
import { TurnEventSchema } from "./turn-event.js";
import {
  GetSpendSummaryRpcParamsSchema,
  SetDailySpendCapRpcParamsSchema,
  SpendSummarySchema,
  type SpendOperations,
} from "./spend.js";
import {
  SelfTestRpcParamsSchema,
  SelfTestRpcResultSchema,
  type SelfTestRpcResult,
} from "./self-test.js";

export const JsonValueSchema = z.json();
export type JsonValue = z.infer<typeof JsonValueSchema>;

export const JsonRpcIdSchema = z.union([
  z.string().min(1),
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
]);
export type JsonRpcId = z.infer<typeof JsonRpcIdSchema>;

export const JsonRpcErrorObjectSchema = z
  .object({
    code: z.number().int(),
    message: z.string(),
    data: JsonValueSchema.optional(),
  })
  .strict();
export type JsonRpcErrorObject = z.infer<typeof JsonRpcErrorObjectSchema>;

export const JsonRpcRequestEnvelopeSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: JsonRpcIdSchema,
    method: z.string().min(1),
    params: JsonValueSchema,
  })
  .strict();
export type JsonRpcRequestEnvelope = z.infer<typeof JsonRpcRequestEnvelopeSchema>;

export const JsonRpcSuccessResponseEnvelopeSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: JsonRpcIdSchema,
    result: JsonValueSchema,
  })
  .strict();
export type JsonRpcSuccessResponseEnvelope = z.infer<typeof JsonRpcSuccessResponseEnvelopeSchema>;

export const JsonRpcErrorResponseEnvelopeSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: JsonRpcIdSchema,
    error: JsonRpcErrorObjectSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.error.code === -32700) {
      context.addIssue({
        code: "custom",
        path: ["error", "code"],
        message: "parse error must use an unrecoverable null id",
      });
    }
  });
export type JsonRpcErrorResponseEnvelope = z.infer<typeof JsonRpcErrorResponseEnvelopeSchema>;

export const JsonRpcProtocolErrorCodeSchema = z.union([z.literal(-32700), z.literal(-32600)]);
export type JsonRpcProtocolErrorCode = z.infer<typeof JsonRpcProtocolErrorCodeSchema>;

export const JsonRpcProtocolErrorObjectSchema = JsonRpcErrorObjectSchema.extend({
  code: JsonRpcProtocolErrorCodeSchema,
}).strict();
export type JsonRpcProtocolErrorObject = z.infer<typeof JsonRpcProtocolErrorObjectSchema>;

export const JsonRpcProtocolErrorResponseEnvelopeSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.null(),
    error: JsonRpcProtocolErrorObjectSchema,
  })
  .strict();
export type JsonRpcProtocolErrorResponseEnvelope = z.infer<
  typeof JsonRpcProtocolErrorResponseEnvelopeSchema
>;

export const JsonRpcResponseEnvelopeSchema = z.union([
  JsonRpcSuccessResponseEnvelopeSchema,
  JsonRpcErrorResponseEnvelopeSchema,
  JsonRpcProtocolErrorResponseEnvelopeSchema,
]);
export type JsonRpcResponseEnvelope = z.infer<typeof JsonRpcResponseEnvelopeSchema>;

export const JsonRpcNotificationEnvelopeSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    method: z.string().min(1),
    params: JsonValueSchema,
  })
  .strict();
export type JsonRpcNotificationEnvelope = z.infer<typeof JsonRpcNotificationEnvelopeSchema>;

export const COACH_RPC_METHOD_NAMES = [
  "chat",
  "resetSession",
  "hasSession",
  "getAthleteState",
  "importFiles",
  "sync",
  "saveIntake",
  "configureRuntime",
  "getRuntimeConfig",
  "getUnitsPreference",
  "setUnitsPreference",
  "getSpendSummary",
  "setDailySpendCap",
  "selfTest",
] as const satisfies readonly (keyof CoachRpcService)[];

export const CoachRpcMethodNameSchema = z.enum(COACH_RPC_METHOD_NAMES);
export type CoachRpcMethodName = z.infer<typeof CoachRpcMethodNameSchema>;

export const COACH_TURN_EVENT_NOTIFICATION_METHOD = "coach.turnEvent" as const;

export const ChatRpcParamsSchema = ChatRequestSchema.superRefine((value, context) => {
  if (!JsonValueSchema.safeParse(value).success) {
    context.addIssue({
      code: "custom",
      message: "chat params must contain only JSON values",
    });
  }
});
export type ChatRpcParams = z.infer<typeof ChatRpcParamsSchema>;

export const EmptyRpcParamsSchema = z.object({}).strict();
export type EmptyRpcParams = z.infer<typeof EmptyRpcParamsSchema>;

export const AbsoluteImportPathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => value.startsWith("/") && !value.includes("\0"), {
    message: "import paths must be absolute",
  });

export const ImportFilesRpcParamsSchema = z
  .object({
    paths: z.array(AbsoluteImportPathSchema).min(1).max(256),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.paths).size !== value.paths.length) {
      context.addIssue({ code: "custom", path: ["paths"], message: "paths must be unique" });
    }
  });
export type ImportFilesRpcParams = z.infer<typeof ImportFilesRpcParamsSchema>;

export const ImportFilesRpcResultSchema = z
  .object({
    schemaVersion: z.literal(2),
    files: z
      .object({
        total: z.number().int().nonnegative(),
        imported: z.number().int().nonnegative(),
        quarantined: z.number().int().nonnegative(),
      })
      .strict(),
    changes: z
      .object({
        rawFilesInserted: z.number().int().nonnegative(),
        sourceRecordsInserted: z.number().int().nonnegative(),
        sourceRecordsUpdated: z.number().int().nonnegative(),
        relinkedSourceRecords: z.number().int().nonnegative(),
      })
      .strict(),
    publication: z
      .object({
        scope: z.literal("activities-and-streams"),
        status: z.enum(["available", "retryable-failure"]),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.files.imported + value.files.quarantined !== value.files.total) {
      context.addIssue({ code: "custom", path: ["files"], message: "file counts must balance" });
    }
  });
export type ImportFilesRpcResult = z.infer<typeof ImportFilesRpcResultSchema>;

export const SyncRpcParamsSchema = EmptyRpcParamsSchema;
export type SyncRpcParams = z.infer<typeof SyncRpcParamsSchema>;

export const SyncRpcResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    published: z.boolean(),
    referenceSucceeded: z.boolean(),
    requests: z
      .object({
        store: z.number().int().nonnegative(),
        reference: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.requests.store + value.requests.reference !== value.requests.total) {
      context.addIssue({
        code: "custom",
        path: ["requests"],
        message: "request counts must balance",
      });
    }
  });
export type SyncRpcResult = z.infer<typeof SyncRpcResultSchema>;

export const InjuryStatusSchema = z.enum(["none", "managing", "returning"]);
export type InjuryStatus = z.infer<typeof InjuryStatusSchema>;

export const SaveIntakeRpcParamsSchema = z
  .object({
    swim_skill_floor: z.null(),
    continuous_distance_capable: z.null(),
    open_water_comfort: z.null(),
    prior_bsi: z.boolean(),
    clinician_cleared: z.boolean().nullable(),
    injury_status: InjuryStatusSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const needsClearance = value.prior_bsi || value.injury_status !== "none";
    if (needsClearance === (value.clinician_cleared === null)) {
      context.addIssue({
        code: "custom",
        path: ["clinician_cleared"],
        message: needsClearance
          ? "clinician clearance is required"
          : "clinician clearance must be null",
      });
    }
  });
export type SaveIntakeRpcParams = z.infer<typeof SaveIntakeRpcParamsSchema>;

export const SaveIntakeRpcResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    saved: z.literal(true),
  })
  .strict();
export type SaveIntakeRpcResult = z.infer<typeof SaveIntakeRpcResultSchema>;

export const LlmProviderSchema = z.enum([
  "anthropic",
  "openai",
  "google",
  "openai-codex",
  "deepseek",
  "qwen",
  "minimax",
  "kimi",
  "zai",
  "openrouter",
]);
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

const RuntimeOptionalStringSchema = z.string().min(1).max(512).nullable();

const RuntimeLlmSchema = z
  .object({
    provider: LlmProviderSchema.optional(),
    model: z.string().min(1).max(512).optional(),
    api_key: z.string().min(1).max(16_384).optional(),
    base_url: z.string().min(1).max(4_096).nullable().optional(),
    flush_model: RuntimeOptionalStringSchema.optional(),
    compact_model: RuntimeOptionalStringSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.provider === "openai-codex" && value.api_key !== undefined) {
      context.addIssue({ code: "custom", path: ["api_key"], message: "api_key must be absent" });
    }
    if (Object.keys(value).length === 0) {
      context.addIssue({ code: "custom", message: "llm patch must not be empty" });
    }
  });

const RuntimeIntervalsSchema = z
  .object({
    api_key: z.string().min(1).max(16_384).optional(),
    athlete_id: z.string().min(1).max(512).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value).length === 0) {
      context.addIssue({ code: "custom", message: "intervals patch must not be empty" });
    }
  });

export const ConfigureRuntimeRpcParamsSchema = z
  .object({
    llm: RuntimeLlmSchema.optional(),
    intervals: RuntimeIntervalsSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.llm === undefined && value.intervals === undefined) {
      context.addIssue({ code: "custom", message: "at least one runtime slot is required" });
    }
  });
export type ConfigureRuntimeRpcParams = z.infer<typeof ConfigureRuntimeRpcParamsSchema>;

export const ConfigureRuntimeRpcResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    applied: z
      .object({
        llm: z.boolean(),
        intervals: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type ConfigureRuntimeRpcResult = z.infer<typeof ConfigureRuntimeRpcResultSchema>;

export const RuntimeConfigSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    llm: z
      .object({
        provider: LlmProviderSchema,
        model: z.string().min(1).max(512),
        credential_configured: z.boolean(),
      })
      .strict(),
    intervals: z
      .object({
        athlete_id: z.string().max(512),
      })
      .strict(),
    session: z
      .object({
        historyTokenBudgetRatio: z.number().finite(),
        idleMinutes: z.number().int(),
        dailyResetHour: z.number().int(),
        resetArchiveRetentionDays: z.number().int(),
        timezone: z.string().max(512),
      })
      .strict(),
  })
  .strict();
export type RuntimeConfigSnapshot = z.infer<typeof RuntimeConfigSnapshotSchema>;

export const GetRuntimeConfigRpcParamsSchema = EmptyRpcParamsSchema;
export type GetRuntimeConfigRpcParams = z.infer<typeof GetRuntimeConfigRpcParamsSchema>;
export const GetRuntimeConfigRpcResultSchema = RuntimeConfigSnapshotSchema;
export type GetRuntimeConfigRpcResult = z.infer<typeof GetRuntimeConfigRpcResultSchema>;

export const UnitsPreferenceSchema = z.enum(["metric", "imperial"]);
export type UnitsPreference = z.infer<typeof UnitsPreferenceSchema>;

export const GetUnitsPreferenceRpcParamsSchema = EmptyRpcParamsSchema;
export type GetUnitsPreferenceRpcParams = z.infer<typeof GetUnitsPreferenceRpcParamsSchema>;
export const GetUnitsPreferenceRpcResultSchema = z
  .object({
    value: UnitsPreferenceSchema,
    source: z.enum(["cycling", "athlete", "default"]),
  })
  .strict();
export type GetUnitsPreferenceRpcResult = z.infer<typeof GetUnitsPreferenceRpcResultSchema>;

export const SetUnitsPreferenceRpcParamsSchema = z
  .object({ value: UnitsPreferenceSchema })
  .strict();
export type SetUnitsPreferenceRpcParams = z.infer<typeof SetUnitsPreferenceRpcParamsSchema>;
export const SetUnitsPreferenceRpcResultSchema = z
  .object({ value: UnitsPreferenceSchema, source: z.literal("cycling") })
  .strict();
export type SetUnitsPreferenceRpcResult = z.infer<typeof SetUnitsPreferenceRpcResultSchema>;

export const OperationProgressEventSchema = z
  .object({
    phase: z.enum(["started", "completed"]),
    completed: z.number().int().nonnegative(),
    total: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.completed > value.total) {
      context.addIssue({ code: "custom", path: ["completed"], message: "completed exceeds total" });
    }
    if (value.phase === "started" && value.completed !== 0) {
      context.addIssue({
        code: "custom",
        path: ["completed"],
        message: "started progress begins at zero",
      });
    }
    if (value.phase === "completed" && value.completed !== value.total) {
      context.addIssue({
        code: "custom",
        path: ["completed"],
        message: "completed progress reaches total",
      });
    }
  });
export type OperationProgressEvent = z.infer<typeof OperationProgressEventSchema>;

export interface CoachOperations {
  importFiles(
    request: ImportFilesRpcParams,
    onEvent?: (event: OperationProgressEvent) => void,
  ): Promise<ImportFilesRpcResult>;
  sync(
    request: SyncRpcParams,
    onEvent?: (event: OperationProgressEvent) => void,
  ): Promise<SyncRpcResult>;
  saveIntake(request: SaveIntakeRpcParams): Promise<SaveIntakeRpcResult>;
  configureRuntime(request: ConfigureRuntimeRpcParams): Promise<ConfigureRuntimeRpcResult>;
  getRuntimeConfig(request: GetRuntimeConfigRpcParams): Promise<GetRuntimeConfigRpcResult>;
  getUnitsPreference?(request: GetUnitsPreferenceRpcParams): Promise<GetUnitsPreferenceRpcResult>;
  setUnitsPreference?(request: SetUnitsPreferenceRpcParams): Promise<SetUnitsPreferenceRpcResult>;
}

export interface CoachSelfTestOperations {
  selfTest(onEvent?: (event: OperationProgressEvent) => void): Promise<SelfTestRpcResult>;
}

export type CoachRpcService = CoachEngine &
  CoachOperations &
  SpendOperations &
  CoachSelfTestOperations;

export const CoachRpcRequestEnvelopeSchema = z.discriminatedUnion("method", [
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("chat"),
      params: ChatRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("resetSession"),
      params: ResetSessionRequestSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("hasSession"),
      params: HasSessionRequestSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("getAthleteState"),
      params: EmptyRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("importFiles"),
      params: ImportFilesRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("sync"),
      params: SyncRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("saveIntake"),
      params: SaveIntakeRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("configureRuntime"),
      params: ConfigureRuntimeRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("getRuntimeConfig"),
      params: GetRuntimeConfigRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("getUnitsPreference"),
      params: GetUnitsPreferenceRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("setUnitsPreference"),
      params: SetUnitsPreferenceRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("getSpendSummary"),
      params: GetSpendSummaryRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("setDailySpendCap"),
      params: SetDailySpendCapRpcParamsSchema,
    })
    .strict(),
  z
    .object({
      jsonrpc: z.literal("2.0"),
      id: JsonRpcIdSchema,
      method: z.literal("selfTest"),
      params: SelfTestRpcParamsSchema,
    })
    .strict(),
]);
export type CoachRpcRequestEnvelope = z.infer<typeof CoachRpcRequestEnvelopeSchema>;

export const CoachTurnEventNotificationEnvelopeSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    method: z.literal(COACH_TURN_EVENT_NOTIFICATION_METHOD),
    params: z
      .object({
        requestId: JsonRpcIdSchema,
        requestMethod: z.literal("chat"),
        turnId: z.string().min(1),
        event: TurnEventSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.params.turnId !== value.params.event.turnId) {
      context.addIssue({
        code: "custom",
        path: ["params", "turnId"],
        message: "notification turnId must equal event.turnId",
      });
    }
  });
export type CoachTurnEventNotificationEnvelope = z.infer<
  typeof CoachTurnEventNotificationEnvelopeSchema
>;

export const COACH_OPERATION_PROGRESS_NOTIFICATION_METHOD = "coach.operationProgress" as const;

export const CoachOperationProgressNotificationEnvelopeSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    method: z.literal(COACH_OPERATION_PROGRESS_NOTIFICATION_METHOD),
    params: z
      .object({
        requestId: JsonRpcIdSchema,
        requestMethod: z.enum(["importFiles", "sync", "selfTest"]),
        event: OperationProgressEventSchema,
      })
      .strict(),
  })
  .strict();
export type CoachOperationProgressNotificationEnvelope = z.infer<
  typeof CoachOperationProgressNotificationEnvelopeSchema
>;

export const CoachRpcNotificationEnvelopeSchema = z.union([
  CoachTurnEventNotificationEnvelopeSchema,
  CoachOperationProgressNotificationEnvelopeSchema,
]);
export type CoachRpcNotificationEnvelope = z.infer<typeof CoachRpcNotificationEnvelopeSchema>;

export const CoachRpcEnvelopeSchema = z.union([
  CoachRpcRequestEnvelopeSchema,
  JsonRpcResponseEnvelopeSchema,
  CoachRpcNotificationEnvelopeSchema,
]);
export type CoachRpcEnvelope = z.infer<typeof CoachRpcEnvelopeSchema>;

export function parseCoachRpcEnvelope(text: string): CoachRpcEnvelope {
  return CoachRpcEnvelopeSchema.parse(JSON.parse(text));
}

export function serializeCoachRpcEnvelope(value: unknown): string {
  const parsed = CoachRpcEnvelopeSchema.parse(value);
  JsonValueSchema.parse(parsed);
  return JSON.stringify(parsed);
}

export type CoachRpcMethodRegistryShape = {
  readonly [K in keyof CoachRpcService]: {
    readonly wireName: K;
    readonly requestSchema: z.ZodType;
    readonly responseSchema: z.ZodType;
    readonly eventSchema: z.ZodType;
  };
};

export const NoRpcEventSchema = z.never();
export type NoRpcEvent = z.infer<typeof NoRpcEventSchema>;

export const COACH_RPC_METHOD_REGISTRY = {
  chat: {
    wireName: "chat",
    requestSchema: ChatRpcParamsSchema,
    responseSchema: ChatResponseSchema,
    eventSchema: TurnEventSchema,
  },
  resetSession: {
    wireName: "resetSession",
    requestSchema: ResetSessionRequestSchema,
    responseSchema: ResetSessionResponseSchema,
    eventSchema: NoRpcEventSchema,
  },
  hasSession: {
    wireName: "hasSession",
    requestSchema: HasSessionRequestSchema,
    responseSchema: HasSessionResponseSchema,
    eventSchema: NoRpcEventSchema,
  },
  getAthleteState: {
    wireName: "getAthleteState",
    requestSchema: EmptyRpcParamsSchema,
    responseSchema: AthleteStateSchema,
    eventSchema: NoRpcEventSchema,
  },
  importFiles: {
    wireName: "importFiles",
    requestSchema: ImportFilesRpcParamsSchema,
    responseSchema: ImportFilesRpcResultSchema,
    eventSchema: OperationProgressEventSchema,
  },
  sync: {
    wireName: "sync",
    requestSchema: SyncRpcParamsSchema,
    responseSchema: SyncRpcResultSchema,
    eventSchema: OperationProgressEventSchema,
  },
  saveIntake: {
    wireName: "saveIntake",
    requestSchema: SaveIntakeRpcParamsSchema,
    responseSchema: SaveIntakeRpcResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  configureRuntime: {
    wireName: "configureRuntime",
    requestSchema: ConfigureRuntimeRpcParamsSchema,
    responseSchema: ConfigureRuntimeRpcResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  getRuntimeConfig: {
    wireName: "getRuntimeConfig",
    requestSchema: GetRuntimeConfigRpcParamsSchema,
    responseSchema: GetRuntimeConfigRpcResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  getUnitsPreference: {
    wireName: "getUnitsPreference",
    requestSchema: GetUnitsPreferenceRpcParamsSchema,
    responseSchema: GetUnitsPreferenceRpcResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  setUnitsPreference: {
    wireName: "setUnitsPreference",
    requestSchema: SetUnitsPreferenceRpcParamsSchema,
    responseSchema: SetUnitsPreferenceRpcResultSchema,
    eventSchema: NoRpcEventSchema,
  },
  getSpendSummary: {
    wireName: "getSpendSummary",
    requestSchema: GetSpendSummaryRpcParamsSchema,
    responseSchema: SpendSummarySchema,
    eventSchema: NoRpcEventSchema,
  },
  setDailySpendCap: {
    wireName: "setDailySpendCap",
    requestSchema: SetDailySpendCapRpcParamsSchema,
    responseSchema: SpendSummarySchema,
    eventSchema: NoRpcEventSchema,
  },
  selfTest: {
    wireName: "selfTest",
    requestSchema: SelfTestRpcParamsSchema,
    responseSchema: SelfTestRpcResultSchema,
    eventSchema: OperationProgressEventSchema,
  },
} as const satisfies CoachRpcMethodRegistryShape;

export type CoachRpcRequest<K extends CoachRpcMethodName> = z.input<
  (typeof COACH_RPC_METHOD_REGISTRY)[K]["requestSchema"]
>;
export type CoachRpcResponse<K extends CoachRpcMethodName> = z.output<
  (typeof COACH_RPC_METHOD_REGISTRY)[K]["responseSchema"]
>;
export type CoachRpcEvent<K extends CoachRpcMethodName> = z.output<
  (typeof COACH_RPC_METHOD_REGISTRY)[K]["eventSchema"]
>;

export type CoachRpcNotification<K extends CoachRpcMethodName> = K extends "chat"
  ? CoachTurnEventNotificationEnvelope
  : K extends "importFiles" | "sync" | "selfTest"
    ? CoachOperationProgressNotificationEnvelope
    : never;
