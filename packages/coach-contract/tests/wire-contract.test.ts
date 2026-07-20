import { describe, expect, it } from "vitest";
import {
  AgentErrorKindSchema,
  AthleteStateSchema,
  COACH_RPC_METHOD_NAMES,
  COACH_RPC_METHOD_REGISTRY,
  COACH_TURN_EVENT_NOTIFICATION_METHOD,
  COACH_OPERATION_PROGRESS_NOTIFICATION_METHOD,
  ChatResponseSchema,
  ChatRpcParamsSchema,
  ClientHandshakeFrameSchema,
  CoachRpcEnvelopeSchema,
  CoachRpcRequestEnvelopeSchema,
  CoachOperationProgressNotificationEnvelopeSchema,
  CoachTurnEventNotificationEnvelopeSchema,
  DaemonOwnerSchema,
  EmptyRpcParamsSchema,
  ConfigureRuntimeRpcParamsSchema,
  ConfigureRuntimeRpcResultSchema,
  GetUnitsPreferenceRpcParamsSchema,
  GetUnitsPreferenceRpcResultSchema,
  ImportFilesRpcParamsSchema,
  ImportFilesRpcResultSchema,
  OperationProgressEventSchema,
  SaveIntakeRpcParamsSchema,
  SaveIntakeRpcResultSchema,
  SyncRpcParamsSchema,
  SyncRpcResultSchema,
  HasSessionRequestSchema,
  HasSessionResponseSchema,
  JsonRpcErrorResponseEnvelopeSchema,
  JsonRpcProtocolErrorResponseEnvelopeSchema,
  JsonRpcResponseEnvelopeSchema,
  JsonRpcSuccessResponseEnvelopeSchema,
  LlmProviderSchema,
  NoRpcEventSchema,
  PROTOCOL_VERSION,
  ResetSessionRequestSchema,
  ResetSessionResponseSchema,
  SetUnitsPreferenceRpcParamsSchema,
  SetUnitsPreferenceRpcResultSchema,
  GetSpendSummaryRpcParamsSchema,
  SetDailySpendCapRpcParamsSchema,
  SelfTestCommandTerminalSchema,
  SelfTestRpcParamsSchema,
  SelfTestRpcResultSchema,
  SpendSummarySchema,
  ServerHandshakeFrameSchema,
  TurnEventSchema,
  UNKNOWN_CYCLING_TRAINING_CONTEXT,
  compareProtocolVersions,
  createAcceptedServerHandshakeFrame,
  createClientHandshakeFrame,
  createVersionMismatchServerHandshakeFrame,
  parseCoachRpcEnvelope,
  serializeCoachRpcEnvelope,
  type CoachRpcService,
  type CoachRpcEnvelope,
} from "../src/index.js";

const turnEvent = {
  type: "turn-start",
  turnId: "turn-1",
  chatId: "chat-1",
} as const;

const notification = {
  jsonrpc: "2.0",
  method: COACH_TURN_EVENT_NOTIFICATION_METHOD,
  params: {
    requestId: 1,
    requestMethod: "chat",
    turnId: "turn-1",
    event: turnEvent,
  },
} as const;

const progressNotification = {
  jsonrpc: "2.0",
  method: COACH_OPERATION_PROGRESS_NOTIFICATION_METHOD,
  params: {
    requestId: 5,
    requestMethod: "importFiles",
    event: { phase: "started", completed: 0, total: 1 },
  },
} as const;

function roundTrip(value: unknown): CoachRpcEnvelope {
  const serialized = serializeCoachRpcEnvelope(value);
  expect(serialized.endsWith("\n")).toBe(false);
  const first = parseCoachRpcEnvelope(serialized);
  const second = parseCoachRpcEnvelope(serializeCoachRpcEnvelope(first));
  expect(second).toEqual(first);
  return second;
}

describe("JSON-RPC envelopes", () => {
  it("round trips requests, successes, ordinary errors, protocol errors, and notifications", () => {
    const values = [
      { jsonrpc: "2.0", id: 1, method: "chat", params: { chatId: "chat-1", message: "hello" } },
      { jsonrpc: "2.0", id: 1, result: { text: "hello" } },
      { jsonrpc: "2.0", id: 1, error: { code: -32600, message: "invalid request" } },
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } },
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } },
      notification,
      progressNotification,
    ];
    for (const value of values) expect(roundTrip(value)).toEqual(value);
  });

  it("keeps null ids exclusive to the two unrecoverable protocol errors", () => {
    expect(
      JsonRpcErrorResponseEnvelopeSchema.safeParse({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32700, message: "parse error" },
      }).success,
    ).toBe(false);
    expect(
      JsonRpcSuccessResponseEnvelopeSchema.safeParse({
        jsonrpc: "2.0",
        id: null,
        result: {},
      }).success,
    ).toBe(false);
    expect(
      JsonRpcProtocolErrorResponseEnvelopeSchema.safeParse({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: "foreign" },
      }).success,
    ).toBe(false);
  });

  it("rejects malformed JSON, missing and extra keys, invalid ids, and mixed terminals", () => {
    expect(() => parseCoachRpcEnvelope("{")).toThrow();
    const invalid = [
      { jsonrpc: "2.0", id: 1, method: "chat" },
      { jsonrpc: "2.0", id: 1, method: "chat", params: {}, extra: true },
      { jsonrpc: "2.0", id: "", method: "chat", params: {} },
      { jsonrpc: "2.0", id: -1, method: "chat", params: {} },
      { jsonrpc: "2.0", id: 1.5, method: "chat", params: {} },
      { jsonrpc: "2.0", id: Number.MAX_SAFE_INTEGER + 1, method: "chat", params: {} },
      { jsonrpc: "2.0", id: 1, result: {}, error: { code: 1, message: "mixed" } },
      { ...notification, id: 1 },
    ];
    for (const value of invalid)
      expect(CoachRpcEnvelopeSchema.safeParse(value).success).toBe(false);
  });

  it("rejects non-JSON payload values", () => {
    const invalid = [undefined, () => undefined, Symbol("x"), 1n, NaN, Infinity, -Infinity];
    for (const value of invalid) {
      expect(
        JsonRpcResponseEnvelopeSchema.safeParse({ jsonrpc: "2.0", id: 1, result: value }).success,
      ).toBe(false);
      expect(() =>
        serializeCoachRpcEnvelope({
          jsonrpc: "2.0",
          id: 1,
          error: { code: 1, message: "x", data: value },
        }),
      ).toThrow();
    }
  });
});

const spendSummary = SpendSummarySchema.parse({
  localDate: "1998-07-06",
  timezone: "UTC",
  dailyCapUsd: 0.5,
  knownSpendUsd: 0,
  generationCount: 0,
  pricedGenerationCount: 0,
  unpricedGenerationCount: 0,
  malformedLineCount: 0,
  spendComplete: true,
  capStatus: "below",
  cacheReadTokens: 0,
  knownCacheReadSavingsUsd: 0,
  cacheSavingsComplete: true,
  routes: [],
});

describe("coach request and event projection", () => {
  it("admits exactly the thirteen strict method requests", () => {
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "chat", params: { chatId: "chat-1", message: "hello" } },
      { jsonrpc: "2.0", id: 2, method: "resetSession", params: { chatId: "chat-1" } },
      { jsonrpc: "2.0", id: 3, method: "hasSession", params: { chatId: "chat-1" } },
      { jsonrpc: "2.0", id: 4, method: "getAthleteState", params: {} },
      { jsonrpc: "2.0", id: 5, method: "importFiles", params: { paths: ["/synthetic/ride.fit"] } },
      { jsonrpc: "2.0", id: 6, method: "sync", params: {} },
      {
        jsonrpc: "2.0",
        id: 7,
        method: "saveIntake",
        params: {
          swim_skill_floor: null,
          continuous_distance_capable: null,
          open_water_comfort: null,
          prior_bsi: false,
          clinician_cleared: null,
          injury_status: "none",
        },
      },
      {
        jsonrpc: "2.0",
        id: 8,
        method: "configureRuntime",
        params: { llm: { provider: "anthropic", model: "model", api_key: "placeholder" } },
      },
      { jsonrpc: "2.0", id: 9, method: "getUnitsPreference", params: {} },
      {
        jsonrpc: "2.0",
        id: 10,
        method: "setUnitsPreference",
        params: { value: "imperial" },
      },
      { jsonrpc: "2.0", id: 11, method: "getSpendSummary", params: {} },
      {
        jsonrpc: "2.0",
        id: 12,
        method: "setDailySpendCap",
        params: { dailyCapUsd: 0.75 },
      },
      { jsonrpc: "2.0", id: 13, method: "selfTest", params: {} },
    ];
    for (const request of requests) {
      expect(CoachRpcRequestEnvelopeSchema.parse(request)).toEqual(request);
      expect(roundTrip(request)).toEqual(request);
    }
    expect(
      CoachRpcRequestEnvelopeSchema.safeParse({ jsonrpc: "2.0", id: 4, method: "getAthleteState" })
        .success,
    ).toBe(false);
    expect(
      CoachRpcRequestEnvelopeSchema.safeParse({
        jsonrpc: "2.0",
        id: 4,
        method: "getAthleteState",
        params: { chatId: "x" },
      }).success,
    ).toBe(false);
    expect(
      CoachRpcRequestEnvelopeSchema.safeParse({
        jsonrpc: "2.0",
        id: 5,
        method: "analyze",
        params: {},
      }).success,
    ).toBe(false);
  });

  it("rejects every nested non-JSON resolvedCs value at every wire boundary", () => {
    const values = [() => undefined, Symbol("x"), undefined, 1n, NaN, Infinity, -Infinity];
    for (const value of values) {
      const params = {
        chatId: "chat-1",
        message: "hello",
        turn: { resolvedCs: { nested: value } },
      };
      const request = { jsonrpc: "2.0", id: 1, method: "chat", params };
      expect(ChatRpcParamsSchema.safeParse(params).success).toBe(false);
      expect(CoachRpcRequestEnvelopeSchema.safeParse(request).success).toBe(false);
      expect(CoachRpcEnvelopeSchema.safeParse(request).success).toBe(false);
      expect(() => serializeCoachRpcEnvelope(request)).toThrow();
    }
  });

  it("binds notification request and turn identifiers", () => {
    expect(CoachTurnEventNotificationEnvelopeSchema.parse(notification)).toEqual(notification);
    expect(
      CoachTurnEventNotificationEnvelopeSchema.safeParse({
        ...notification,
        params: { ...notification.params, turnId: "turn-2" },
      }).success,
    ).toBe(false);
    expect(
      CoachTurnEventNotificationEnvelopeSchema.safeParse({
        ...notification,
        params: { ...notification.params, requestMethod: "hasSession" },
      }).success,
    ).toBe(false);
  });

  it("validates operational paths, balanced results, and progress", () => {
    expect(ImportFilesRpcParamsSchema.parse({ paths: ["/synthetic/ride.fit"] })).toEqual({
      paths: ["/synthetic/ride.fit"],
    });
    for (const paths of [
      ["ride.fit"],
      ["/synthetic/a.fit", "/synthetic/a.fit"],
      [],
      ["/synthetic/\0.fit"],
    ]) {
      expect(ImportFilesRpcParamsSchema.safeParse({ paths }).success).toBe(false);
    }
    const importResult = {
      schemaVersion: 1,
      files: { total: 2, imported: 1, quarantined: 1 },
      changes: {
        rawFilesInserted: 1,
        sourceRecordsInserted: 1,
        sourceRecordsUpdated: 0,
        relinkedSourceRecords: 0,
      },
    } as const;
    expect(ImportFilesRpcResultSchema.parse(importResult)).toEqual(importResult);
    expect(
      ImportFilesRpcResultSchema.safeParse({
        ...importResult,
        files: { ...importResult.files, total: 3 },
      }).success,
    ).toBe(false);
    const syncResult = {
      schemaVersion: 1,
      published: true,
      referenceSucceeded: true,
      requests: { store: 2, reference: 1, total: 3 },
    } as const;
    expect(SyncRpcResultSchema.parse(syncResult)).toEqual(syncResult);
    expect(
      SyncRpcResultSchema.safeParse({
        ...syncResult,
        requests: { ...syncResult.requests, total: 4 },
      }).success,
    ).toBe(false);
    expect(
      OperationProgressEventSchema.parse({ phase: "started", completed: 0, total: 1 }),
    ).toEqual({ phase: "started", completed: 0, total: 1 });
    expect(
      OperationProgressEventSchema.parse({ phase: "completed", completed: 1, total: 1 }),
    ).toEqual({ phase: "completed", completed: 1, total: 1 });
    expect(
      OperationProgressEventSchema.safeParse({ phase: "completed", completed: 0, total: 1 })
        .success,
    ).toBe(false);
    expect(CoachOperationProgressNotificationEnvelopeSchema.parse(progressNotification)).toEqual(
      progressNotification,
    );
  });

  it("validates strict intake and runtime configuration round trips", () => {
    const safeIntake = {
      swim_skill_floor: null,
      continuous_distance_capable: null,
      open_water_comfort: null,
      prior_bsi: false,
      clinician_cleared: null,
      injury_status: "none",
    } as const;
    const clearedIntake = {
      ...safeIntake,
      prior_bsi: true,
      clinician_cleared: true,
      injury_status: "returning",
    } as const;
    expect(SaveIntakeRpcParamsSchema.parse(safeIntake)).toEqual(safeIntake);
    expect(SaveIntakeRpcParamsSchema.parse(clearedIntake)).toEqual(clearedIntake);
    for (const invalid of [
      { ...safeIntake, swim_skill_floor: "novice" },
      { ...safeIntake, extra: true },
      { ...safeIntake, clinician_cleared: true },
      { ...clearedIntake, clinician_cleared: null },
    ]) {
      expect(SaveIntakeRpcParamsSchema.safeParse(invalid).success).toBe(false);
    }
    expect(SaveIntakeRpcResultSchema.parse({ schemaVersion: 1, saved: true })).toEqual({
      schemaVersion: 1,
      saved: true,
    });

    const llm = { provider: "openrouter", model: "model-a", api_key: "placeholder" } as const;
    const codex = { provider: "openai-codex", model: "model-codex" } as const;
    const intervals = { api_key: "placeholder", athlete_id: "athlete-a" } as const;
    for (const params of [{ llm }, { llm: codex }, { intervals }, { llm, intervals }]) {
      expect(ConfigureRuntimeRpcParamsSchema.parse(params)).toEqual(params);
    }
    for (const invalid of [
      {},
      { llm: { ...llm, extra: true } },
      { llm: { provider: "openai-codex", model: "model-codex", api_key: "placeholder" } },
      { intervals: { api_key: "", athlete_id: "athlete-a" } },
      { llm, extra: true },
    ]) {
      expect(ConfigureRuntimeRpcParamsSchema.safeParse(invalid).success).toBe(false);
    }
    for (const provider of LlmProviderSchema.options.filter(
      (provider) => provider !== "openai-codex",
    )) {
      expect(
        ConfigureRuntimeRpcParamsSchema.safeParse({ llm: { provider, model: "model-a" } }).success,
      ).toBe(false);
    }
    const result = { schemaVersion: 1, applied: { llm: true, intervals: false } } as const;
    expect(ConfigureRuntimeRpcResultSchema.parse(result)).toEqual(result);
    expect(JSON.stringify(result)).not.toContain("placeholder");
    expect(LlmProviderSchema.options).toEqual([
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
  });

  it("keeps the method registry exhaustive and schema-identical", async () => {
    const fake: CoachRpcService = {
      chat: async () => ({ text: "ok" }),
      resetSession: async () => ({ memoryFlushed: true }),
      hasSession: async () => ({ hasSession: false }),
      getAthleteState: async () =>
        AthleteStateSchema.parse({
          schemaVersion: "1",
          lastUpdated: "2020-01-01T00:00:00.000Z",
          freshness: "fresh",
          degraded: false,
          lastSynced: null,
          athleteProfile: {},
          currentStatus: {},
          derivedMetrics: {},
          recentActivities: [],
          plannedWorkouts: [],
          wellness: {},
        }),
      importFiles: async ({ paths }) => ({
        schemaVersion: 1,
        files: { total: paths.length, imported: paths.length, quarantined: 0 },
        changes: {
          rawFilesInserted: 0,
          sourceRecordsInserted: 0,
          sourceRecordsUpdated: 0,
          relinkedSourceRecords: 0,
        },
      }),
      sync: async () => ({
        schemaVersion: 1,
        published: false,
        referenceSucceeded: true,
        requests: { store: 0, reference: 0, total: 0 },
      }),
      saveIntake: async () => ({ schemaVersion: 1, saved: true }),
      configureRuntime: async ({ llm, intervals }) => ({
        schemaVersion: 1,
        applied: { llm: llm !== undefined, intervals: intervals !== undefined },
      }),
      getUnitsPreference: async () => ({ value: "metric", source: "default" }),
      setUnitsPreference: async ({ value }) => ({ value, source: "cycling" }),
      getSpendSummary: async () => spendSummary,
      setDailySpendCap: async () => spendSummary,
      selfTest: async () => ({
        schemaVersion: 1,
        type: "self-test-terminal",
        ok: false,
        error: { code: "RUNNER_ERROR", message: "packaged self-test failed" },
      }),
    };
    expect(Object.keys(COACH_RPC_METHOD_REGISTRY)).toEqual(Object.keys(fake));
    expect(COACH_RPC_METHOD_NAMES).toEqual(Object.keys(fake));
    expect(COACH_RPC_METHOD_REGISTRY.chat).toEqual({
      wireName: "chat",
      requestSchema: ChatRpcParamsSchema,
      responseSchema: ChatResponseSchema,
      eventSchema: TurnEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.resetSession).toEqual({
      wireName: "resetSession",
      requestSchema: ResetSessionRequestSchema,
      responseSchema: ResetSessionResponseSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.hasSession).toEqual({
      wireName: "hasSession",
      requestSchema: HasSessionRequestSchema,
      responseSchema: HasSessionResponseSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.getAthleteState).toEqual({
      wireName: "getAthleteState",
      requestSchema: EmptyRpcParamsSchema,
      responseSchema: AthleteStateSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.importFiles).toEqual({
      wireName: "importFiles",
      requestSchema: ImportFilesRpcParamsSchema,
      responseSchema: ImportFilesRpcResultSchema,
      eventSchema: OperationProgressEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.sync).toEqual({
      wireName: "sync",
      requestSchema: SyncRpcParamsSchema,
      responseSchema: SyncRpcResultSchema,
      eventSchema: OperationProgressEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.saveIntake).toEqual({
      wireName: "saveIntake",
      requestSchema: SaveIntakeRpcParamsSchema,
      responseSchema: SaveIntakeRpcResultSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.configureRuntime).toEqual({
      wireName: "configureRuntime",
      requestSchema: ConfigureRuntimeRpcParamsSchema,
      responseSchema: ConfigureRuntimeRpcResultSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.getUnitsPreference).toEqual({
      wireName: "getUnitsPreference",
      requestSchema: GetUnitsPreferenceRpcParamsSchema,
      responseSchema: GetUnitsPreferenceRpcResultSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.setUnitsPreference).toEqual({
      wireName: "setUnitsPreference",
      requestSchema: SetUnitsPreferenceRpcParamsSchema,
      responseSchema: SetUnitsPreferenceRpcResultSchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.getSpendSummary).toEqual({
      wireName: "getSpendSummary",
      requestSchema: GetSpendSummaryRpcParamsSchema,
      responseSchema: SpendSummarySchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.setDailySpendCap).toEqual({
      wireName: "setDailySpendCap",
      requestSchema: SetDailySpendCapRpcParamsSchema,
      responseSchema: SpendSummarySchema,
      eventSchema: NoRpcEventSchema,
    });
    expect(COACH_RPC_METHOD_REGISTRY.selfTest).toEqual({
      wireName: "selfTest",
      requestSchema: SelfTestRpcParamsSchema,
      responseSchema: SelfTestRpcResultSchema,
      eventSchema: OperationProgressEventSchema,
    });
    for (const method of [
      "resetSession",
      "hasSession",
      "getAthleteState",
      "saveIntake",
      "configureRuntime",
      "getUnitsPreference",
      "setUnitsPreference",
      "getSpendSummary",
      "setDailySpendCap",
    ] as const) {
      expect(COACH_RPC_METHOD_REGISTRY[method].eventSchema.safeParse(undefined).success).toBe(
        false,
      );
      expect(COACH_RPC_METHOD_REGISTRY[method].eventSchema.safeParse({}).success).toBe(false);
    }
    await expect(fake.chat({ chatId: "chat-1", message: "hello" })).resolves.toEqual({
      text: "ok",
    });
  });

  it("validates strict self-test terminals and rejects contradictory resource results", () => {
    const digest = "a".repeat(64);
    const success = {
      schemaVersion: 1,
      type: "self-test-terminal",
      ok: true,
      runtime: { node: "24.18.0", electron: "43.1.1", v8: "15.0" },
      resources: {
        algorithm: "sha256",
        matrixSha256: digest,
        insideAsarSha256: digest,
        extraResourcesSha256: digest,
        byteIdentical: true,
      },
      suites: {
        parity: { cases: 2, passed: 2 },
        differential: { cases: 3, passed: 3 },
      },
    } as const;
    expect(SelfTestRpcResultSchema.parse(success)).toEqual(success);
    for (const invalid of [
      { ...success, extra: true },
      { ...success, resources: { ...success.resources, matrixSha256: digest.toUpperCase() } },
      { ...success, resources: { ...success.resources, extraResourcesSha256: "b".repeat(64) } },
      { ...success, suites: { ...success.suites, parity: { cases: 2, passed: 1 } } },
      { ...success, suites: { ...success.suites, differential: { cases: 0, passed: 0 } } },
    ]) {
      expect(SelfTestRpcResultSchema.safeParse(invalid).success).toBe(false);
    }
    const unavailable = {
      schemaVersion: 1,
      type: "self-test-terminal",
      ok: false,
      error: {
        code: "DAEMON_UNAVAILABLE",
        message: "Enduragent could not reach the local service.",
      },
    } as const;
    expect(SelfTestRpcResultSchema.safeParse(unavailable).success).toBe(false);
    expect(SelfTestCommandTerminalSchema.parse(unavailable)).toEqual(unavailable);
  });

  it("round trips strict units preference requests and results", () => {
    expect(
      roundTrip({ jsonrpc: "2.0", id: 40, method: "getUnitsPreference", params: {} }),
    ).toMatchObject({ method: "getUnitsPreference" });
    expect(
      roundTrip({
        jsonrpc: "2.0",
        id: 41,
        method: "setUnitsPreference",
        params: { value: "imperial" },
      }),
    ).toMatchObject({ method: "setUnitsPreference" });
    expect(GetUnitsPreferenceRpcResultSchema.parse({ value: "metric", source: "athlete" })).toEqual(
      { value: "metric", source: "athlete" },
    );
    expect(
      SetUnitsPreferenceRpcResultSchema.parse({ value: "imperial", source: "cycling" }),
    ).toEqual({ value: "imperial", source: "cycling" });
    expect(
      SetUnitsPreferenceRpcParamsSchema.safeParse({ value: "metric", extra: true }).success,
    ).toBe(false);
    expect(
      GetUnitsPreferenceRpcResultSchema.safeParse({ value: "other", source: "default" }).success,
    ).toBe(false);
  });

  it("round trips an athlete state result with persisted training context", () => {
    const state = AthleteStateSchema.parse({
      schemaVersion: "1",
      lastUpdated: "2026-07-19T08:00:00.000Z",
      freshness: "fresh",
      degraded: false,
      lastSynced: "2026-07-19T07:55:00.000Z",
      athleteProfile: {},
      currentStatus: {},
      derivedMetrics: {},
      recentActivities: [],
      plannedWorkouts: [],
      wellness: {},
      trainingContext: UNKNOWN_CYCLING_TRAINING_CONTEXT,
    });
    expect(roundTrip({ jsonrpc: "2.0", id: 42, result: state })).toEqual({
      jsonrpc: "2.0",
      id: 42,
      result: state,
    });
    expect(
      AthleteStateSchema.safeParse({
        ...state,
        trainingContext: {
          ...state.trainingContext,
          currentTrainingStress: 72,
        },
      }).success,
    ).toBe(false);
  });
});

describe("handshake", () => {
  it("round trips client, accepted, and both mismatch directions", () => {
    const client = createClientHandshakeFrame("synthetic-test-token");
    expect(ClientHandshakeFrameSchema.parse(JSON.parse(JSON.stringify(client)))).toEqual(client);
    const accepted = createAcceptedServerHandshakeFrame("service-managed", PROTOCOL_VERSION);
    expect(ServerHandshakeFrameSchema.parse(JSON.parse(JSON.stringify(accepted)))).toEqual(
      accepted,
    );
    const older = createVersionMismatchServerHandshakeFrame(
      "ephemeral-client-started",
      PROTOCOL_VERSION - 1,
      PROTOCOL_VERSION,
    );
    const newer = createVersionMismatchServerHandshakeFrame(
      "unmanaged-foreground",
      PROTOCOL_VERSION + 1,
      PROTOCOL_VERSION,
    );
    expect(ServerHandshakeFrameSchema.parse(older)).toEqual(older);
    expect(ServerHandshakeFrameSchema.parse(newer)).toEqual(newer);
  });

  it("rejects invalid token and fail-open handshake shapes", () => {
    const invalid = [
      { type: "handshake", clientProtocolVersion: 1 },
      { type: "handshake", token: "", clientProtocolVersion: 1 },
      { type: "handshake", token: "x", clientProtocolVersion: 1, extra: true },
    ];
    for (const frame of invalid)
      expect(ClientHandshakeFrameSchema.safeParse(frame).success).toBe(false);
    const serverInvalid = [
      {
        type: "handshake",
        status: "accepted",
        clientProtocolVersion: 1,
        serverProtocolVersion: 2,
        owner: "service-managed",
      },
      {
        type: "handshake",
        status: "version-mismatch",
        clientProtocolVersion: 2,
        serverProtocolVersion: 2,
        direction: "client-older",
        owner: "service-managed",
      },
      {
        type: "handshake",
        status: "version-mismatch",
        clientProtocolVersion: 1,
        serverProtocolVersion: 2,
        direction: "client-newer",
        owner: "service-managed",
      },
      {
        type: "handshake",
        status: "future",
        clientProtocolVersion: 1,
        serverProtocolVersion: 1,
        owner: "service-managed",
      },
      {
        type: "handshake",
        status: "accepted",
        clientProtocolVersion: 1,
        serverProtocolVersion: 1,
        owner: "service-managed",
        extra: true,
      },
    ];
    for (const frame of serverInvalid)
      expect(ServerHandshakeFrameSchema.safeParse(frame).success).toBe(false);
  });

  it("pins the closed owner enum and independent comparison truth table", () => {
    expect(DaemonOwnerSchema.options).toEqual([
      "service-managed",
      "ephemeral-client-started",
      "unmanaged-foreground",
      "app-supervised",
    ]);
    expect(compareProtocolVersions(1, 2)).toBe("client-older");
    expect(compareProtocolVersions(2, 2)).toBe("equal");
    expect(compareProtocolVersions(3, 2)).toBe("client-newer");
    expect(() => createAcceptedServerHandshakeFrame("service-managed", 1, 2)).toThrow();
    expect(() => createVersionMismatchServerHandshakeFrame("service-managed", 2, 2)).toThrow();
  });
});

describe("additive protocol signals", () => {
  it("keeps all existing error kinds and adds detached only", () => {
    for (const kind of [
      "rate_limit",
      "provider-auth",
      "provider-down",
      "intervals",
      "unknown",
      "detached",
    ] as const) {
      expect(AgentErrorKindSchema.parse(kind)).toBe(kind);
    }
    expect(AgentErrorKindSchema.safeParse("aborted").success).toBe(false);
  });

  it("uses protocol version five", () => {
    expect(PROTOCOL_VERSION).toBe(5);
  });
});
