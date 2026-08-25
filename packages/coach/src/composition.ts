import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import {
  Memory,
  ConfirmationGate,
  RefreshTokenReusedError,
  appendUsageLine,
  bootstrapReference,
  classifyFailure,
  compareAndSaveStoredProfile,
  createConversationStore,
  createProposalSummarizers,
  createToolConfirmationPort,
  createMissingPlatformCalendarMutations,
  createPlatformCalendarMutations,
  createSubsystemLogger,
  deleteStoredProfile,
  engineConfigFromConfig,
  extractRetryAfterMs,
  isKeylessProvider,
  loadStoredProfileSnapshot,
  makeChatClient,
  refreshCodexToken,
  resolveRuntimeConfig,
  resolveSecretRef,
  sessionConfigEnvironmentOwnership,
  type ClaudeCliRuntimeConfigPatch,
  type CodexAgentRuntimeConfigPatch,
  type Config,
  type ConversationStorePort,
  type ReferenceRuntime,
  type RuntimeConfigPatch,
  type StoredProfile,
  type StoredProfileSnapshot,
} from "@enduragent/core";
import {
  createCoachEngine,
  type CreateCoachEngineInput,
  type EngineConfig,
  type EngineHostPorts,
  type ModelTransportDecorator,
  type ReferenceStateSnapshot,
} from "@enduragent/engine";
import { resolveUserTimezone } from "@enduragent/engine/sport";
import {
  createCyclingFtpAnchorResolver,
  type CyclingFtpAnchorResolver,
} from "@enduragent/kernel/anchors";
import {
  createAnchorRepository,
  createCanonicalActivityReader,
  createIntervalsSourceRepository,
  createTrustedActivitySourceResolver,
  H,
  type AnchorRepository,
} from "@enduragent/kernel/store";
import { ErrorStateSchema, LatestJsonSchema } from "@enduragent/kernel/reference/schemas";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import { createNodeCrypto, createNodeImportRuntime } from "@enduragent/kernel-node/ingest";
import type { CoachStoreWriterContext } from "./runtime.js";
import {
  type CoachEngine,
  type CoachOperations,
  type ConfigureRuntimeRpcParams,
  type ConfigureRuntimeRpcRefusalReason,
  type GetArchivedTranscriptPageRpcParams,
  type GetArchivedTranscriptPageRpcResult,
  type GetTranscriptPageRpcParams,
  type GetTranscriptPageRpcResult,
  type ListArchivedConversationsRpcParams,
  type ListArchivedConversationsRpcResult,
  type GetRuntimeConfigRpcResult,
  type VerifyIntervalsCredentialRpcParams,
  type VerifyIntervalsCredentialRpcResult,
} from "@enduragent/coach-contract";
import { cyclingSport } from "@enduragent/sport-cycling";
import { createPersistedAthleteStateSource } from "./athlete-state-reader.js";
import { createPowerProgressStateSource } from "./power-progress.js";
import { createRecentRidesSource } from "./recent-rides.js";
import {
  assertRuntimeAthleteOwner,
  RuntimeAthleteOwnerRefusal,
  type RuntimeAthleteOwnerClaim,
} from "./backfill.js";
import {
  assertRuntimeAthleteOwnerFromEvidence,
  readIntervalsStoreOwnerState,
  type IntervalsCredentialVerificationEvidence,
  verifyIntervalsCredentialAtPathWithEvidence,
} from "./account-identity.js";
import {
  createIntervalsCredentialApprovalStore,
  digestIntervalsCredential,
  normalizeIntervalsAthleteSelector,
} from "./intervals-credential-approval.js";
import { createCoachEngineAdapter } from "./coach-engine-adapter.js";
import {
  createStoreRuntime,
  type StoreRuntime,
  type StoreRuntimeDependencies,
  type StoreRuntimeOptions,
} from "./store-runtime.js";
import { createCoachOperations } from "./operations.js";
import type { CoachOperationsDependencies } from "./operations.js";
import { createSpendMeterService, type SpendMeterService } from "./spend-meter.js";
import { createStoredActivityAnalysisService } from "./activity-analysis-service.js";
import { createAerobicDriftAnalyzer } from "./aerobic-drift.js";
import {
  createProviderActivityAnalysisClientAccess,
  createProviderActivityStreamReader,
} from "./activity-analysis-provider.js";
import {
  createProviderActivityBestEffortsArchive,
  createProviderActivityHistogramArchive,
  createProviderActivityIntervalsArchive,
  createProviderActivityPowerHeartRateArchive,
  createProviderActivityStreamArchive,
} from "./activity-analysis-archive.js";
import {
  createIntervalReviewAnalyzer,
  createProviderActivityIntervalReader,
} from "./activity-interval-review.js";
import {
  createBestEffortAnalyzer,
  createProviderActivityBestEffortReader,
} from "./activity-best-efforts.js";
import {
  createHeartRateDistributionAnalyzer,
  createPowerDistributionAnalyzer,
  createProviderActivityHistogramReader,
} from "./activity-distribution.js";
import {
  createPowerHeartRateAnalyzer,
  createProviderActivityPowerHeartRateReader,
} from "./activity-power-heart-rate.js";
import { createTrainingExportService } from "./training-export.js";
import { serializeBoundaryError } from "./daemon/error-boundary.js";

interface OAuthCredential extends StoredProfile {
  readonly type: "oauth";
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly accountId?: string;
  readonly email?: string;
}

export interface LocalCoachComposition {
  readonly engine: CoachEngine;
  readonly operations: CoachOperations;
  readonly spendMeter: SpendMeterService;
  readonly confirmations: Pick<ConfirmationGate, "peek" | "confirm" | "cancel">;
  startInitialRefresh(): Promise<void>;
  close(): Promise<void>;
}

export interface LocalCoachCompositionInput {
  readonly env: Record<string, string | undefined>;
  readonly home: AthleteHome;
  readonly context: CoachStoreWriterContext;
  readonly config: Config;
  readonly engineConfig: EngineConfig;
  readonly deferInitialRefresh?: boolean;
}

export interface LocalCoachCompositionDependencies {
  readonly bootstrap?: (
    options: Parameters<typeof bootstrapReference>[0],
  ) => Promise<LocalReferenceRuntime>;
  readonly createRuntime?: (options: LocalStoreRuntimeOptions) => LocalStoreRuntime;
  readonly runtimeDependencies?: StoreRuntimeDependencies;
  readonly createBackend?: typeof createCoachEngine;
  readonly createRepository?: (store: CoachStoreWriterContext["store"]) => AnchorRepository;
  readonly createResolver?: (repository: AnchorRepository) => CyclingFtpAnchorResolver;
  readonly now?: () => number;
  readonly platform?: NodeJS.Platform;
  readonly randomId?: () => string;
  readonly modelTransportDecorator?: ModelTransportDecorator;
  readonly onToolsAssembled?: (names: readonly string[]) => void;
  readonly closeHostAdapters?: () => void | Promise<void>;
  readonly operationsDependencies?: CoachOperationsDependencies;
  readonly persistRuntimeConfig?: typeof persistRuntimeConfig;
  readonly assertRuntimeAthleteOwner?: (
    ...args: Parameters<typeof assertRuntimeAthleteOwner>
  ) => Promise<RuntimeAthleteOwnerClaim | void>;
}

export interface LocalReferenceRuntime {
  readonly scheduler: { stop(): void };
  runScheduledOnce(signal?: AbortSignal): ReturnType<ReferenceRuntime["runScheduledOnce"]>;
}

export interface LocalStoreRuntime {
  readonly athleteData: StoreRuntime["athleteData"];
  currentDroppedActivities(): ReturnType<StoreRuntime["currentDroppedActivities"]>;
  attemptLedgerForRun(): ReturnType<StoreRuntime["attemptLedgerForRun"]>;
  runWindow(): ReturnType<StoreRuntime["runWindow"]>;
  runWindowAfter(
    work: (signal: AbortSignal) => Promise<void>,
  ): ReturnType<StoreRuntime["runWindow"]>;
  runExclusive: StoreRuntime["runExclusive"];
  runActivityWrite: StoreRuntime["runActivityWrite"];
  startScheduler(): void;
  close(): Promise<void>;
}

export type LocalStoreRuntimeOptions = Omit<StoreRuntimeOptions, "reference"> & {
  readonly reference: LocalReferenceRuntime;
};

export const INITIAL_REFRESH_RETRY_BASE_DELAY_MS = 1_000;
export const INITIAL_REFRESH_RETRY_MAX_DELAY_MS = 300_000;

function copyConfig(config: Config): Config {
  return {
    ...config,
    llm: { ...config.llm },
    intervals: { ...config.intervals },
    telegram: { ...config.telegram },
    session: { ...config.session },
  };
}

function approvedRuntimeConfig(config: Config, intervalsOwnerReady: boolean): Config {
  if (intervalsOwnerReady || config.intervals.apiKey.length === 0) return config;
  return {
    ...config,
    intervals: { ...config.intervals, apiKey: "" },
  };
}

function claudeCliPatch(
  block: NonNullable<NonNullable<ConfigureRuntimeRpcParams["llm"]>["claude_cli"]>,
): ClaudeCliRuntimeConfigPatch {
  return {
    ...(block.enabled === undefined ? {} : { enabled: block.enabled }),
    ...(block.binary_path === undefined ? {} : { binaryPath: block.binary_path }),
    ...(block.config_dir === undefined ? {} : { configDir: block.config_dir }),
    ...(block.billing === undefined ? {} : { billing: block.billing }),
  };
}

function codexAgentPatch(
  block: NonNullable<NonNullable<ConfigureRuntimeRpcParams["llm"]>["codex_agent"]>,
): CodexAgentRuntimeConfigPatch {
  return {
    ...(block.enabled === undefined ? {} : { enabled: block.enabled }),
    ...(block.binary_path === undefined ? {} : { binaryPath: block.binary_path }),
    ...(block.reasoning_effort === undefined ? {} : { reasoningEffort: block.reasoning_effort }),
  };
}

function runtimePatch(request: ConfigureRuntimeRpcParams, config: Config): RuntimeConfigPatch {
  return {
    ...(request.llm === undefined
      ? {}
      : {
          llm: {
            provider: request.llm.provider,
            model: request.llm.model,
            apiKey:
              request.llm.clear_credential === true && config.llm.provider !== "openai-codex"
                ? ""
                : request.llm.api_key,
            baseUrl: request.llm.base_url,
            flushModel: request.llm.flush_model,
            compactModel: request.llm.compact_model,
            ...(request.llm.claude_cli === undefined
              ? {}
              : { claudeCli: claudeCliPatch(request.llm.claude_cli) }),
            ...(request.llm.codex_agent === undefined
              ? {}
              : { codexAgent: codexAgentPatch(request.llm.codex_agent) }),
          },
        }),
    ...(request.intervals === undefined
      ? {}
      : {
          intervals: {
            apiKey: request.intervals.clear_credential === true ? "" : request.intervals.api_key,
            athleteId: request.intervals.athlete_id,
          },
        }),
    ...(request.session === undefined ? {} : { session: { ...request.session } }),
  };
}

function mergedRuntimeConfig(config: Config, request: ConfigureRuntimeRpcParams): Config {
  return { ...config, ...resolveRuntimeConfig(runtimePatch(request, config), config) };
}

const LLM_CREDENTIAL_ENVIRONMENT_KEYS = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  "openai-codex": undefined,
  "claude-cli": undefined,
  "codex-agent": undefined,
  deepseek: "DEEPSEEK_API_KEY",
  qwen: "ALIBABA_API_KEY",
  minimax: "MINIMAX_API_KEY",
  kimi: "MOONSHOT_API_KEY",
  zai: "ZAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
} as const;

function nonemptyEnvironmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  key: string | undefined,
): boolean {
  return key !== undefined && environment[key] !== undefined && environment[key] !== "";
}

function llmCredentialManagedByEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  provider: Config["llm"]["provider"],
): boolean {
  return (
    nonemptyEnvironmentValue(environment, LLM_CREDENTIAL_ENVIRONMENT_KEYS[provider]) ||
    (!isKeylessProvider(provider) && nonemptyEnvironmentValue(environment, "LLM_API_KEY"))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assignOptionalField(
  target: Record<string, unknown>,
  field: string,
  value: string | undefined,
): void {
  if (value === undefined) delete target[field];
  else target[field] = value;
}

function replacePrivateFile(path: string, content: string | Uint8Array): void {
  const temporaryPath = `${path}.tmp.${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(temporaryPath, content, { mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {}
    throw error;
  }
}

interface RuntimeConfigFileSnapshot {
  readonly content?: Buffer;
}

function captureRuntimeConfigFile(configDir: string): RuntimeConfigFileSnapshot {
  const path = join(configDir, "config.yaml");
  return existsSync(path) ? { content: readFileSync(path) } : {};
}

function restoreRuntimeConfigFile(configDir: string, snapshot: RuntimeConfigFileSnapshot): void {
  const path = join(configDir, "config.yaml");
  if (snapshot.content !== undefined) {
    replacePrivateFile(path, snapshot.content);
    return;
  }
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function persistRuntimeConfig(
  configDir: string,
  candidate: Config,
  request: ConfigureRuntimeRpcParams,
  previous: Config,
): void {
  const path = join(configDir, "config.yaml");
  const parsed = existsSync(path) ? (parseYaml(readFileSync(path, "utf8")) as unknown) : {};
  if (!isRecord(parsed)) throw new TypeError("Runtime config must be a map.");
  const next = { ...parsed };
  if (request.llm !== undefined) {
    const existing =
      candidate.llm.provider === previous.llm.provider &&
      isRecord(parsed.llm) &&
      (parsed.llm.provider === undefined || parsed.llm.provider === candidate.llm.provider)
        ? parsed.llm
        : {};
    const llm: Record<string, unknown> = {
      ...existing,
      provider: candidate.llm.provider,
      model: candidate.llm.model,
    };
    if (candidate.llm.provider === "openai-codex") {
      llm.auth_profile = candidate.llm.authProfile ?? "openai-codex";
    } else delete llm.auth_profile;
    assignOptionalField(llm, "base_url", candidate.llm.baseUrl);
    assignOptionalField(llm, "flush_model", candidate.llm.flushModel);
    assignOptionalField(llm, "compact_model", candidate.llm.compactModel);
    if (request.llm.claude_cli !== undefined) {
      const block: Record<string, unknown> = isRecord(llm.claude_cli) ? { ...llm.claude_cli } : {};
      for (const [field, value] of Object.entries(request.llm.claude_cli)) {
        if (value === null) delete block[field];
        else block[field] = value;
      }
      llm.claude_cli = block;
    }
    if (request.llm.codex_agent !== undefined) {
      const block: Record<string, unknown> = isRecord(llm.codex_agent)
        ? { ...llm.codex_agent }
        : {};
      for (const [field, value] of Object.entries(request.llm.codex_agent)) {
        if (value === null) delete block[field];
        else block[field] = value;
      }
      llm.codex_agent = block;
    }
    next.llm = llm;
  }
  if (request.intervals !== undefined) {
    next.intervals = {
      ...(isRecord(parsed.intervals) ? parsed.intervals : {}),
      athlete_id: candidate.intervals.athleteId,
    };
  }
  if (request.session !== undefined) {
    const session: Record<string, unknown> = {
      ...(isRecord(parsed.session) ? parsed.session : {}),
    };
    for (const field of [
      "historyTokenBudgetRatio",
      "idleMinutes",
      "dailyResetHour",
      "resetArchiveRetentionDays",
      "timezone",
    ] as const) {
      if (request.session[field] !== undefined) {
        session[field] = candidate.session[field];
      }
    }
    if (request.session.timezone !== undefined) session.timezonePinned = true;
    next.session = session;
  }
  replacePrivateFile(path, toYaml(next));
}

function runtimeCredentialConfigured(configDir: string, config: Config): boolean {
  if (config.llm.provider === "openai-codex") {
    try {
      const snapshot = loadStoredProfileSnapshot(
        join(configDir, "auth-profiles.json"),
        config.llm.authProfile ?? "openai-codex",
      );
      if (snapshot === null) return false;
      credential(snapshot.profile);
      return true;
    } catch {
      return false;
    }
  }
  if (isKeylessProvider(config.llm.provider)) return true;
  return config.llm.apiKey.length > 0;
}

function runtimeConfigSnapshot(
  configDir: string,
  config: Config,
  environment: Readonly<Record<string, string | undefined>>,
  timezone: string,
  intervalsVerificationPending: boolean,
): GetRuntimeConfigRpcResult {
  return {
    schemaVersion: 3,
    llm: {
      provider: config.llm.provider,
      model: config.llm.model,
      credential_configured: runtimeCredentialConfigured(configDir, config),
    },
    intervals: {
      athlete_id: config.intervals.athleteId,
      credential_configured: config.intervals.apiKey.length > 0,
      credential_verification_pending: intervalsVerificationPending,
      managedByEnvironment: {
        athleteId: environment.INTERVALS_ATHLETE_ID !== undefined,
      },
    },
    session: {
      ...config.session,
      timezone,
      managedByEnvironment: sessionConfigEnvironmentOwnership(environment),
    },
  };
}

interface RuntimeBundle {
  readonly engine: CoachEngine;
  readonly memory: Memory;
  readonly chatStore: ConversationStorePort;
  readonly spendMeter: SpendMeterService;
  readonly timezone: string;
  readonly confirmations: ConfirmationGate;
}

function createReconfigurableRuntimeBundle(initial: RuntimeBundle): {
  readonly engine: CoachEngine;
  readonly spendMeter: SpendMeterService;
  readonly confirmations: Pick<ConfirmationGate, "peek" | "confirm" | "cancel">;
  readonly getTranscriptPage: (
    request: GetTranscriptPageRpcParams,
  ) => Promise<GetTranscriptPageRpcResult>;
  readonly listArchivedConversations: (
    request: ListArchivedConversationsRpcParams,
  ) => Promise<ListArchivedConversationsRpcResult>;
  readonly getArchivedTranscriptPage: (
    request: GetArchivedTranscriptPageRpcParams,
  ) => Promise<GetArchivedTranscriptPageRpcResult>;
  replace<T>(
    prepare: () => T | Promise<T>,
    commit: (prepared: T) => RuntimeBundle | Promise<RuntimeBundle>,
  ): Promise<void>;
} {
  let active = initial;
  let admission = Promise.resolve();
  let activeCalls = 0;
  let pendingReplacements = 0;
  const drainWaiters = new Set<() => void>();

  const run = async <T>(operation: (bundle: RuntimeBundle) => Promise<T>): Promise<T> => {
    await admission;
    activeCalls += 1;
    const selected = active;
    try {
      return await operation(selected);
    } finally {
      activeCalls -= 1;
      if (activeCalls === 0) {
        for (const resolve of drainWaiters) resolve();
        drainWaiters.clear();
      }
    }
  };

  return {
    engine: {
      chat: (request, onEvent) => run((bundle) => bundle.engine.chat(request, onEvent)),
      stopChat: (request) =>
        run(async (bundle) => bundle.engine.stopChat?.(request) ?? { stopped: false }),
      enqueueChatMessage: (request) => run((bundle) => bundle.engine.enqueueChatMessage!(request)),
      getChatQueue: (request) => run((bundle) => bundle.engine.getChatQueue!(request)),
      removeQueuedChatMessage: (request) =>
        run((bundle) => bundle.engine.removeQueuedChatMessage!(request)),
      resumeChatQueue: (request, onEvent) =>
        run((bundle) => bundle.engine.resumeChatQueue!(request, onEvent)),
      runQueuedCommand: (request, onEvent) =>
        run((bundle) => bundle.engine.runQueuedCommand!(request, onEvent)),
      retryQueuedTurn: (request, onEvent) =>
        run((bundle) => bundle.engine.retryQueuedTurn!(request, onEvent)),
      getCoachDecision: (request) => run((bundle) => bundle.engine.getCoachDecision(request)),
      answerCoachDecision: (request, onEvent) =>
        run((bundle) => bundle.engine.answerCoachDecision(request, onEvent)),
      skipCoachDecision: (request) => run((bundle) => bundle.engine.skipCoachDecision(request)),
      resumeCoachDecision: (request, onEvent) =>
        run((bundle) => bundle.engine.resumeCoachDecision(request, onEvent)),
      resetSession: (request) => run((bundle) => bundle.engine.resetSession(request)),
      hasSession: (request) => run((bundle) => bundle.engine.hasSession(request)),
      getAthleteState: () => run((bundle) => bundle.engine.getAthleteState()),
    },
    spendMeter: {
      getSpendSummary: () => run((bundle) => bundle.spendMeter.getSpendSummary()),
      setDailySpendCap: (dailyCapUsd) =>
        run((bundle) => bundle.spendMeter.setDailySpendCap(dailyCapUsd)),
    },
    confirmations: {
      peek: (chatId) => (pendingReplacements === 0 ? active.confirmations.peek(chatId) : undefined),
      confirm: (chatId, nonce) => run((bundle) => bundle.confirmations.confirm(chatId, nonce)),
      cancel: (chatId, nonce) =>
        pendingReplacements === 0 ? active.confirmations.cancel(chatId, nonce) : "none",
    },
    getTranscriptPage: (request) =>
      run(async (bundle) => bundle.chatStore.readCurrentConversationPage("desktop", request)),
    listArchivedConversations: () =>
      run(async (bundle) => bundle.chatStore.listArchivedConversations("desktop")),
    getArchivedTranscriptPage: ({ boundaryRef, ...request }) =>
      run(async (bundle) =>
        bundle.chatStore.readArchivedConversationPage("desktop", boundaryRef, request),
      ),
    async replace(prepare, commit) {
      pendingReplacements += 1;
      const previousAdmission = admission;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      admission = previousAdmission.then(() => barrier);
      await previousAdmission;
      try {
        const prepared = await prepare();
        if (activeCalls > 0) {
          await new Promise<void>((resolve) => drainWaiters.add(resolve));
        }
        active = await commit(prepared);
      } finally {
        pendingReplacements -= 1;
        release();
      }
    },
  };
}

function readReferenceState(dataDir: string): ReferenceStateSnapshot {
  const referenceDir = join(dataDir, "data");
  const read = <T>(
    path: string,
    parse: (value: unknown) => { success: boolean; data?: T },
  ): T | null => {
    try {
      const result = parse(JSON.parse(readFileSync(path, "utf8")) as unknown);
      return result.success ? (result.data ?? null) : null;
    } catch {
      return null;
    }
  };
  return {
    errorState: read(join(referenceDir, "error_state.json"), (value) =>
      ErrorStateSchema.safeParse(value),
    ),
    latest: read(join(referenceDir, "latest.json"), (value) => LatestJsonSchema.safeParse(value)),
  };
}

function credential(value: unknown): OAuthCredential {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("OAuth profile is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.type !== "oauth" ||
    typeof candidate.access !== "string" ||
    candidate.access.length === 0 ||
    typeof candidate.refresh !== "string" ||
    candidate.refresh.length === 0 ||
    typeof candidate.expires !== "number" ||
    !Number.isFinite(candidate.expires) ||
    (candidate.accountId !== undefined && typeof candidate.accountId !== "string") ||
    (candidate.email !== undefined && typeof candidate.email !== "string")
  ) {
    throw new TypeError("OAuth profile is invalid.");
  }
  return candidate as unknown as OAuthCredential;
}

function createAccessTokenReader(configDir: string): EngineHostPorts["getAccessToken"] {
  const path = join(configDir, "auth-profiles.json");
  const queues = new Map<string, Promise<string>>();
  const delay = (milliseconds: number, signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    if (signal === undefined) {
      return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timeout);
        reject(signal.reason);
      };
      const timeout = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };
  const refresh = async (
    profileName: string,
    initial: StoredProfileSnapshot,
    current: OAuthCredential,
    signal?: AbortSignal,
  ) => {
    try {
      return {
        refreshed: await refreshCodexToken(current.refresh, signal),
        requestSnapshot: initial,
        requestProfile: current,
      };
    } catch (error) {
      signal?.throwIfAborted();
      if (classifyFailure(error) !== "reauth") throw error;
      await delay(2_000, signal);
      const requestSnapshot = loadStoredProfileSnapshot(path, profileName);
      if (requestSnapshot === null) throw new TypeError("OAuth profile is invalid.");
      const requestProfile = credential(requestSnapshot.profile);
      try {
        return {
          refreshed: await refreshCodexToken(requestProfile.refresh, signal),
          requestSnapshot,
          requestProfile,
        };
      } catch (retryError) {
        signal?.throwIfAborted();
        if (classifyFailure(retryError) === "reauth") {
          throw new RefreshTokenReusedError(profileName, retryError);
        }
        throw retryError;
      }
    }
  };
  const exclusive = async (
    profileName: string,
    signal?: AbortSignal,
    rejectedAccessToken?: string,
  ): Promise<string> => {
    const snapshot = loadStoredProfileSnapshot(path, profileName);
    if (snapshot === null) throw new TypeError("OAuth profile is invalid.");
    const current = credential(snapshot.profile);
    if (rejectedAccessToken === undefined || current.access !== rejectedAccessToken) {
      return current.access;
    }
    const { refreshed, requestSnapshot, requestProfile } = await refresh(
      profileName,
      snapshot,
      current,
      signal,
    );
    const next = {
      ...requestProfile,
      type: "oauth",
      access: refreshed.access,
      refresh: refreshed.refresh,
      expires: refreshed.expires,
      accountId: refreshed.accountId ?? requestProfile.accountId,
      email: requestProfile.email,
    } satisfies OAuthCredential;
    const saved = await compareAndSaveStoredProfile(path, profileName, requestSnapshot, next);
    if (saved.status === "missing") throw new TypeError("OAuth profile is invalid.");
    return credential(saved.profile).access;
  };
  return async (profileName, signal, rejectedAccessToken) => {
    const previous = queues.get(profileName) ?? Promise.resolve("");
    const current = previous.then(
      () => exclusive(profileName, signal, rejectedAccessToken),
      () => exclusive(profileName, signal, rejectedAccessToken),
    );
    queues.set(profileName, current);
    try {
      return await current;
    } finally {
      if (queues.get(profileName) === current) queues.delete(profileName);
    }
  };
}

function sameHome(left: AthleteHome, right: AthleteHome): boolean {
  return (
    left.root === right.root &&
    left.storeDir === right.storeDir &&
    left.archiveDir === right.archiveDir &&
    left.configDir === right.configDir
  );
}

export async function createLocalCoachComposition(
  input: LocalCoachCompositionInput,
  dependencies: LocalCoachCompositionDependencies = {},
): Promise<LocalCoachComposition> {
  if (!sameHome(input.home, input.context.home)) {
    throw new TypeError("Writer home does not match the selected athlete home.");
  }
  if (input.config.dataDir !== input.home.root) {
    throw new TypeError("Configured data directory does not match the selected athlete home.");
  }
  const projected = engineConfigFromConfig(input.config);
  if (JSON.stringify(projected) !== JSON.stringify(input.engineConfig)) {
    throw new TypeError("Ready engine configuration does not match the selected athlete home.");
  }
  const now = dependencies.now ?? Date.now;
  const ownerClock = { now, monotonicNow: () => performance.now() };
  const intervalsCredentialApprovals = createIntervalsCredentialApprovalStore({ now });
  let intervalsConfigRevision = 0;
  const ownerLookup = (intervals: Config["intervals"]) => ({
    apiKey: intervals.apiKey,
    athleteId: intervals.athleteId.length === 0 ? "0" : intervals.athleteId,
    historyNewestDate: new Date(now()).toISOString().slice(0, 10),
    clock: ownerClock,
  });
  const assertIntervalsOwner = async (
    current: Config["intervals"],
    candidate: Config["intervals"],
    signal: AbortSignal,
    claimUnownedCandidateWithoutCurrent = false,
    verificationEvidence?: IntervalsCredentialVerificationEvidence,
  ): Promise<RuntimeAthleteOwnerClaim | undefined> => {
    if (verificationEvidence !== undefined) {
      return await assertRuntimeAthleteOwnerFromEvidence(
        input.context.store,
        verificationEvidence,
        signal,
      );
    }
    const approval = await (dependencies.assertRuntimeAthleteOwner ?? assertRuntimeAthleteOwner)(
      input.context.store,
      {
        current: ownerLookup(current),
        candidate: ownerLookup(candidate),
        signal,
        ...(claimUnownedCandidateWithoutCurrent
          ? { claimUnownedCandidateWithoutCurrent: true }
          : {}),
      },
    );
    return approval ?? undefined;
  };
  let unapprovedConfig = copyConfig(input.config);
  if (
    unapprovedConfig.intervals.apiKey.length > 0 &&
    unapprovedConfig.intervals.athleteId.length === 0
  ) {
    unapprovedConfig = {
      ...unapprovedConfig,
      intervals: { ...unapprovedConfig.intervals, athleteId: "0" },
    };
  }
  const verifyIntervalsCredential = async (
    request: VerifyIntervalsCredentialRpcParams,
    signal: AbortSignal,
  ): Promise<VerifyIntervalsCredentialRpcResult> => {
    const configuredAthleteSelector = normalizeIntervalsAthleteSelector(
      unapprovedConfig.intervals.athleteId,
    );
    const configRevision = intervalsConfigRevision;
    let athleteSelector = configuredAthleteSelector;
    let usedCurrentAthleteFallback = false;
    let verification = await verifyIntervalsCredentialAtPathWithEvidence(
      join(input.home.storeDir, "store.db"),
      {
        apiKey: request.api_key,
        athleteId: athleteSelector,
        historyNewestDate: new Date(now()).toISOString().slice(0, 10),
        clock: ownerClock,
        signal,
      },
    );
    if (
      verification.status === "refused" &&
      verification.reason === "credential-rejected" &&
      configuredAthleteSelector !== "0"
    ) {
      signal.throwIfAborted();
      athleteSelector = "0";
      usedCurrentAthleteFallback = true;
      verification = await verifyIntervalsCredentialAtPathWithEvidence(
        join(input.home.storeDir, "store.db"),
        {
          apiKey: request.api_key,
          athleteId: athleteSelector,
          historyNewestDate: new Date(now()).toISOString().slice(0, 10),
          clock: ownerClock,
          signal,
        },
      );
    }
    if (verification.status === "refused") return { reason: verification.reason };
    signal.throwIfAborted();
    if (usedCurrentAthleteFallback && verification.evidence.ownerState.status === "unowned") {
      return { reason: "owner-unresolved" };
    }
    return {
      approval: intervalsCredentialApprovals.issue({
        apiKey: request.api_key,
        configuredAthleteSelector,
        athleteSelector,
        evidence: verification.evidence,
        configRevision,
      }),
    };
  };
  let runtime: LocalStoreRuntime | undefined;
  let reference: LocalReferenceRuntime | undefined;
  let initialRefreshPromise: Promise<void> | undefined;
  let initialRefreshRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let initialRefreshFailedAttempts = 0;
  const initialRefreshController = new AbortController();
  let intervalsOwnerReady = unapprovedConfig.intervals.apiKey.length === 0;
  const approvedConfig = (): Config => approvedRuntimeConfig(unapprovedConfig, intervalsOwnerReady);
  const intervalsVerificationPending = (): boolean =>
    unapprovedConfig.intervals.apiKey.length > 0 && !intervalsOwnerReady;
  let initialRefreshStarted = !input.deferInitialRefresh;
  let initialRefreshConfigCaptured = !input.deferInitialRefresh;
  let schedulerStarted = false;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  try {
    if (!input.deferInitialRefresh && unapprovedConfig.intervals.apiKey.length > 0) {
      const startupOwnerClaim = await assertIntervalsOwner(
        unapprovedConfig.intervals,
        unapprovedConfig.intervals,
        new AbortController().signal,
      );
      await startupOwnerClaim?.claim();
      intervalsOwnerReady = true;
    }
    reference = await (dependencies.bootstrap ?? bootstrapReference)({
      dataDir: input.home.root,
      intervals: approvedConfig().intervals,
      readIntervals: () => approvedConfig().intervals,
      sport: cyclingSport,
      startScheduler: false,
      attemptLedgerForRun: () => {
        if (runtime === undefined)
          throw new Error("Store runtime has not started its paired window.");
        return runtime.attemptLedgerForRun();
      },
    });
    const runtimeOptions: LocalStoreRuntimeOptions = {
      env: input.env,
      config: approvedConfig(),
      readConfig: () => approvedConfig(),
      home: input.home,
      reference,
      writerContext: input.context,
      dependencies: dependencies.runtimeDependencies,
      ...(dependencies.platform === undefined ? {} : { platform: dependencies.platform }),
    };
    runtime =
      dependencies.createRuntime === undefined
        ? createStoreRuntime({
            ...runtimeOptions,
            reference: reference as ReferenceRuntime,
          })
        : dependencies.createRuntime(runtimeOptions);
    if (!input.deferInitialRefresh) {
      await runtime.runWindow();
      if (unapprovedConfig.intervals.apiKey.length > 0) {
        runtime.startScheduler();
        schedulerStarted = true;
      }
    }
    const logger = createSubsystemLogger("agent", input.home.root);
    const getAccessToken = createAccessTokenReader(input.home.configDir);
    const repository = (dependencies.createRepository ?? createAnchorRepository)(
      input.context.store,
    );
    const cyclingFtpAnchorResolver = (
      dependencies.createResolver ?? createCyclingFtpAnchorResolver
    )(repository);
    const powerProgress = createPowerProgressStateSource({
      store: input.context.store,
      archiveRoot: input.home.archiveDir,
      now,
    });
    const canonicalActivities = createCanonicalActivityReader(input.context.store);
    const stateReader = createPersistedAthleteStateSource({
      dataDir: input.home.root,
      cyclingFtpAnchorResolver,
      now: () => new Date(now()),
      powerProgressSource: powerProgress,
      recentRidesSource: createRecentRidesSource(canonicalActivities),
      droppedActivitiesSource: () => runtime!.currentDroppedActivities(),
    });
    const buildBundle = (config: Config): RuntimeBundle => {
      const timezone = resolveUserTimezone(config.session.timezone);
      const effectiveConfig =
        timezone === config.session.timezone
          ? config
          : {
              ...config,
              session: { ...config.session, timezone },
            };
      const memory = new Memory(input.home.root, timezone, { platform: dependencies.platform });
      const conversationStore = createConversationStore(
        input.home.root,
        config.session.resetArchiveRetentionDays,
        { platform: dependencies.platform },
      );
      const projectedConfig = engineConfigFromConfig(effectiveConfig);
      const legacyClient =
        config.intervals.apiKey.length === 0
          ? null
          : makeChatClient({
              apiKey: config.intervals.apiKey,
              athleteId: config.intervals.athleteId,
            });
      const confirmations = new ConfirmationGate(now);
      const ports: EngineHostPorts = {
        config: projectedConfig,
        memory,
        chatStore: conversationStore,
        transcriptWriter: conversationStore,
        coachDecisions: conversationStore,
        secrets: { resolve: resolveSecretRef },
        platform: {
          legacyClient,
          athleteData: runtime!.athleteData,
          calendarMutations:
            legacyClient === null
              ? createMissingPlatformCalendarMutations()
              : createPlatformCalendarMutations(legacyClient),
        },
        logger,
        usage: { append: (line) => appendUsageLine(input.home.root, line) },
        stateReader,
        readReferenceState: () => readReferenceState(input.home.root),
        getAccessToken,
        classifyFailure,
        extractRetryAfterMs,
        now,
        randomId: dependencies.randomId ?? randomUUID,
        modelTransportDecorator: dependencies.modelTransportDecorator,
        onToolsAssembled: dependencies.onToolsAssembled,
        toolConfirmations: createToolConfirmationPort({
          gate: confirmations,
          summarizers: createProposalSummarizers({ intervals: legacyClient, tz: timezone }),
          requiresConfirmation: ({ chatId }) =>
            chatId !== "desktop" && chatId !== "cli" && !chatId.startsWith("cli:"),
        }),
      };
      const engineInput = { sport: cyclingSport, ports } satisfies CreateCoachEngineInput;
      const backend = (dependencies.createBackend ?? createCoachEngine)(engineInput);
      return {
        memory,
        chatStore: conversationStore,
        timezone,
        spendMeter: createSpendMeterService({
          dataDir: input.home.root,
          configDir: input.home.configDir,
          timezone,
          now,
        }),
        confirmations,
        engine: createCoachEngineAdapter({
          backend,
          getAthleteState: () => stateReader.getAthleteState(),
          cyclingFtpAnchorResolver,
          now,
        }),
      };
    };
    const initialBundle = buildBundle(approvedConfig());
    let activeTimezone = initialBundle.timezone;
    const reconfigurable = createReconfigurableRuntimeBundle(initialBundle);
    const persistConfig = dependencies.persistRuntimeConfig ?? persistRuntimeConfig;
    const ensureSchedulerStarted = (): void => {
      if (schedulerStarted || closing) return;
      runtime!.startScheduler();
      schedulerStarted = true;
    };
    const applyRuntimeConfig = async (
      request: ConfigureRuntimeRpcParams,
      signal: AbortSignal,
    ): Promise<ConfigureRuntimeRpcRefusalReason | void> => {
      signal.throwIfAborted();
      if (
        request.llm?.clear_credential === true &&
        request.llm.provider !== unapprovedConfig.llm.provider
      ) {
        return "credential-required";
      }
      if (
        request.llm?.clear_credential === true &&
        llmCredentialManagedByEnvironment(input.env, unapprovedConfig.llm.provider)
      ) {
        return "managed-by-environment";
      }
      if (
        request.intervals?.clear_credential === true &&
        nonemptyEnvironmentValue(input.env, "INTERVALS_API_KEY")
      ) {
        return "managed-by-environment";
      }
      if (
        request.intervals?.athlete_id !== undefined &&
        input.env.INTERVALS_ATHLETE_ID !== undefined
      ) {
        return "managed-by-environment";
      }
      if (request.session !== undefined) {
        const ownership = sessionConfigEnvironmentOwnership(input.env);
        for (const field of [
          "historyTokenBudgetRatio",
          "idleMinutes",
          "dailyResetHour",
          "resetArchiveRetentionDays",
          "timezone",
        ] as const) {
          if (request.session[field] !== undefined && ownership[field]) {
            throw new Error(`runtime session ${field} is controlled by the daemon environment`);
          }
        }
      }
      let effectiveRequest = request;
      let verificationEvidence: IntervalsCredentialVerificationEvidence | undefined;
      if (request.intervals?.verification_approval !== undefined) {
        const preliminaryCandidate = mergedRuntimeConfig(unapprovedConfig, request);
        let ownerState: Awaited<ReturnType<typeof readIntervalsStoreOwnerState>> | undefined;
        try {
          ownerState = await readIntervalsStoreOwnerState(input.context.store);
        } catch {}
        if (ownerState !== undefined) {
          const approval = intervalsCredentialApprovals.consume({
            approval: request.intervals.verification_approval,
            credentialDigest: digestIntervalsCredential(preliminaryCandidate.intervals.apiKey),
            configuredAthleteSelector: normalizeIntervalsAthleteSelector(
              unapprovedConfig.intervals.athleteId,
            ),
            ...(request.intervals.athlete_id === undefined
              ? {}
              : { requestedAthleteSelector: request.intervals.athlete_id }),
            ownerState,
            configRevision: intervalsConfigRevision,
          });
          if (approval !== undefined) {
            verificationEvidence = approval.evidence;
            if (
              approval.athleteSelector !==
              normalizeIntervalsAthleteSelector(preliminaryCandidate.intervals.athleteId)
            ) {
              if (input.env.INTERVALS_ATHLETE_ID !== undefined) {
                return "managed-by-environment";
              }
              effectiveRequest = {
                ...request,
                intervals: {
                  ...request.intervals,
                  athlete_id: approval.athleteSelector,
                },
              };
            }
          }
        }
      }
      const candidate = mergedRuntimeConfig(unapprovedConfig, effectiveRequest);
      const activeAthleteId =
        unapprovedConfig.intervals.athleteId.length === 0
          ? "0"
          : unapprovedConfig.intervals.athleteId;
      const candidateAthleteId =
        candidate.intervals.athleteId.length === 0 ? "0" : candidate.intervals.athleteId;
      const athleteIdChanged =
        effectiveRequest.intervals?.athlete_id !== undefined &&
        candidateAthleteId !== activeAthleteId;
      const apiKeyChanged =
        (effectiveRequest.intervals?.api_key !== undefined ||
          effectiveRequest.intervals?.clear_credential === true) &&
        candidate.intervals.apiKey !== unapprovedConfig.intervals.apiKey;
      let pendingOwnerClaim: RuntimeAthleteOwnerClaim | undefined;
      let intervalsOwnerApproved = false;
      if (
        athleteIdChanged ||
        (apiKeyChanged && effectiveRequest.intervals?.clear_credential !== true) ||
        (effectiveRequest.intervals !== undefined &&
          candidate.intervals.apiKey.length > 0 &&
          !intervalsOwnerReady)
      ) {
        if (
          apiKeyChanged &&
          input.env.INTERVALS_API_KEY !== undefined &&
          input.env.INTERVALS_API_KEY !== ""
        ) {
          throw new Error("runtime intervals credential is controlled by the daemon environment");
        }
        try {
          pendingOwnerClaim = await assertIntervalsOwner(
            unapprovedConfig.intervals,
            candidate.intervals,
            signal,
            unapprovedConfig.intervals.apiKey.length === 0 && candidate.intervals.apiKey.length > 0,
            verificationEvidence,
          );
          intervalsOwnerApproved = true;
        } catch (error) {
          if (!(error instanceof RuntimeAthleteOwnerRefusal)) throw error;
          if (error.reason === "current-credential-missing") return "credential-required";
          if (error.reason === "mismatch") return "training-account-mismatch";
          return "ownership-unavailable";
        }
      }
      if (
        request.llm !== undefined &&
        request.llm.clear_credential !== true &&
        candidate.llm.provider === "openai-codex"
      ) {
        credential(
          loadStoredProfileSnapshot(
            join(input.home.configDir, "auth-profiles.json"),
            candidate.llm.authProfile ?? "openai-codex",
          )?.profile,
        );
      }
      const chatGptProfileClear =
        request.llm?.clear_credential === true && unapprovedConfig.llm.provider === "openai-codex";
      signal.throwIfAborted();
      await reconfigurable.replace(
        () => {
          signal.throwIfAborted();
          const latestCandidate = mergedRuntimeConfig(unapprovedConfig, effectiveRequest);
          if (
            intervalsOwnerApproved &&
            (latestCandidate.intervals.apiKey !== candidate.intervals.apiKey ||
              latestCandidate.intervals.athleteId !== candidate.intervals.athleteId)
          ) {
            throw new Error("Intervals configuration changed during ownership verification.");
          }
          const latestIntervalsChanged =
            latestCandidate.intervals.apiKey !== unapprovedConfig.intervals.apiKey ||
            latestCandidate.intervals.athleteId !== unapprovedConfig.intervals.athleteId;
          const replacementOwnerReady =
            latestCandidate.intervals.apiKey.length === 0 ||
            intervalsOwnerApproved ||
            (!latestIntervalsChanged && intervalsOwnerReady);
          return {
            latestCandidate,
            latestIntervalsChanged,
            replacementOwnerReady,
            replacement: buildBundle(approvedRuntimeConfig(latestCandidate, replacementOwnerReady)),
          };
        },
        async ({ latestCandidate, latestIntervalsChanged, replacementOwnerReady, replacement }) => {
          signal.throwIfAborted();
          const previousConfigFile =
            pendingOwnerClaim === undefined && !chatGptProfileClear
              ? undefined
              : captureRuntimeConfigFile(input.home.configDir);
          try {
            persistConfig(
              input.home.configDir,
              latestCandidate,
              effectiveRequest,
              unapprovedConfig,
            );
            if (chatGptProfileClear) {
              deleteStoredProfile(join(input.home.configDir, "auth-profiles.json"), "openai-codex");
            }
            await pendingOwnerClaim?.claim();
          } catch (error) {
            if (previousConfigFile !== undefined) {
              try {
                restoreRuntimeConfigFile(input.home.configDir, previousConfigFile);
              } catch (rollbackError) {
                throw new AggregateError(
                  [error, rollbackError],
                  "Runtime account claim failed and configuration rollback was unsuccessful.",
                );
              }
            }
            throw error;
          }
          unapprovedConfig = latestCandidate;
          if (latestIntervalsChanged) intervalsConfigRevision += 1;
          intervalsOwnerReady = replacementOwnerReady;
          activeTimezone = replacement.timezone;
          return replacement;
        },
      );
      if (request.intervals !== undefined && candidate.intervals.apiKey.length > 0) {
        if (initialRefreshStarted && initialRefreshConfigCaptured && intervalsOwnerReady) {
          ensureSchedulerStarted();
          const refreshRevision = intervalsConfigRevision;
          void runtime!
            .runWindowAfter(() => Promise.resolve())
            .catch((error) =>
              logger.error("runtime_intervals_refresh_failed", undefined, {
                configRevision: refreshRevision,
                failure: serializeBoundaryError(error),
              }),
            );
        }
      }
    };
    const scheduleInitialRefreshRetry = (): void => {
      if (closing || initialRefreshRetryTimer !== undefined) return;
      initialRefreshFailedAttempts += 1;
      const delay = Math.min(
        INITIAL_REFRESH_RETRY_BASE_DELAY_MS * 2 ** (initialRefreshFailedAttempts - 1),
        INITIAL_REFRESH_RETRY_MAX_DELAY_MS,
      );
      const timer = setTimeout(() => {
        if (initialRefreshRetryTimer === timer) initialRefreshRetryTimer = undefined;
        if (!closing) void startInitialRefresh().catch(() => {});
      }, delay);
      timer.unref?.();
      initialRefreshRetryTimer = timer;
    };
    const startInitialRefresh = (): Promise<void> => {
      if (initialRefreshPromise !== undefined) return initialRefreshPromise;
      if (!input.deferInitialRefresh) {
        initialRefreshPromise = Promise.resolve();
        return initialRefreshPromise;
      }
      if (initialRefreshRetryTimer !== undefined) {
        clearTimeout(initialRefreshRetryTimer);
        initialRefreshRetryTimer = undefined;
      }
      initialRefreshStarted = true;
      const refreshRevision = intervalsConfigRevision;
      let ownerSucceeded = false;
      initialRefreshPromise = runtime!
        .runWindowAfter(async (signal) => {
          const initializationSignal = AbortSignal.any([signal, initialRefreshController.signal]);
          initializationSignal.throwIfAborted();
          initialRefreshConfigCaptured = true;
          const initialIntervals = { ...unapprovedConfig.intervals };
          if (initialIntervals.apiKey.length > 0 && !intervalsOwnerReady) {
            const ownerClaim = await assertIntervalsOwner(
              initialIntervals,
              initialIntervals,
              initializationSignal,
            );
            initializationSignal.throwIfAborted();
            await ownerClaim?.claim();
            initializationSignal.throwIfAborted();
          }
          await reconfigurable.replace(
            () => {
              initializationSignal.throwIfAborted();
              return buildBundle(approvedRuntimeConfig(unapprovedConfig, true));
            },
            (replacement) => {
              initializationSignal.throwIfAborted();
              intervalsOwnerReady = true;
              activeTimezone = replacement.timezone;
              ownerSucceeded = true;
              return replacement;
            },
          );
        })
        .then(() => undefined)
        .finally(() => {
          if (ownerSucceeded && unapprovedConfig.intervals.apiKey.length > 0) {
            ensureSchedulerStarted();
          }
        })
        .catch((error) => {
          if (!closing) {
            logger.error("initial_store_refresh_failed", undefined, {
              configRevision: refreshRevision,
              failure: serializeBoundaryError(error),
            });
            initialRefreshPromise = undefined;
            if (
              !ownerSucceeded &&
              (!(error instanceof RuntimeAthleteOwnerRefusal) || error.transient)
            ) {
              scheduleInitialRefreshRetry();
            }
          }
          throw error;
        });
      return initialRefreshPromise;
    };
    const liveIntervals = Object.freeze({
      async read() {
        return Object.freeze({ ...approvedConfig().intervals });
      },
    });
    const options = Object.freeze({ liveIntervals });
    const analysisImport = createNodeImportRuntime({
      archiveDir: input.home.archiveDir,
      store: input.context.store,
    });
    const analysisCrypto = createNodeCrypto();
    const analysisSources = createIntervalsSourceRepository(input.context.store, (fields) => {
      if (fields.length === 0) throw new TypeError("empty key tuple");
      return H(analysisCrypto, ...(fields as [string | number, ...(string | number)[]]));
    });
    const providerAccess = createProviderActivityAnalysisClientAccess({
      credentials: options.liveIntervals,
    });
    const archiveDependencies = {
      archive: analysisImport.archive,
      store: input.context.store,
      sources: analysisSources,
      runExclusive: <T>(work: () => Promise<T>) => runtime!.runExclusive(work),
      now,
    };
    const providerStreams = createProviderActivityStreamReader({
      access: providerAccess,
      archive: createProviderActivityStreamArchive({
        ...archiveDependencies,
      }),
    });
    const providerIntervals = createProviderActivityIntervalReader({
      access: providerAccess,
      archive: createProviderActivityIntervalsArchive({ ...archiveDependencies }),
    });
    const providerBestEfforts = createProviderActivityBestEffortReader({
      access: providerAccess,
      archive: createProviderActivityBestEffortsArchive({ ...archiveDependencies }),
    });
    const providerHistograms = createProviderActivityHistogramReader({
      access: providerAccess,
      archive: createProviderActivityHistogramArchive({ ...archiveDependencies }),
    });
    const providerPowerHeartRate = createProviderActivityPowerHeartRateReader({
      access: providerAccess,
      archive: createProviderActivityPowerHeartRateArchive({ ...archiveDependencies }),
    });
    const trustedActivitySources = createTrustedActivitySourceResolver(input.context.store);
    const activityAnalysis = createStoredActivityAnalysisService({
      store: input.context.store,
      activities: canonicalActivities,
      sources: trustedActivitySources,
      analyzers: {
        aerobicDrift: createAerobicDriftAnalyzer({
          activities: canonicalActivities,
          provider: providerStreams,
        }),
        intervals: createIntervalReviewAnalyzer({ provider: providerIntervals }),
        bestEfforts: createBestEffortAnalyzer({ provider: providerBestEfforts }),
        powerDistribution: createPowerDistributionAnalyzer({ provider: providerHistograms }),
        heartRateDistribution: createHeartRateDistributionAnalyzer({
          provider: providerHistograms,
        }),
        powerHeartRate: createPowerHeartRateAnalyzer({ provider: providerPowerHeartRate }),
      },
      runCacheWrite: (work) => runtime!.runExclusive(work),
      now,
    });
    const trainingExport = createTrainingExportService({
      credentials: options.liveIntervals,
      sources: trustedActivitySources,
    });
    const operations = {
      ...createCoachOperations(
        {
          home: input.home,
          context: input.context,
          runtime,
          intervalsCredentials: options.liveIntervals,
          historyNewestDate: () => new Date(now()).toISOString().slice(0, 10),
          readTranscriptPage: (request) => reconfigurable.getTranscriptPage(request),
          readArchivedConversations: (request) => reconfigurable.listArchivedConversations(request),
          readArchivedTranscriptPage: (request) =>
            reconfigurable.getArchivedTranscriptPage(request),
          applyRuntimeConfig,
          verifyIntervalsCredential,
          intervalsVerificationPending,
          readRuntimeConfig: () =>
            runtimeConfigSnapshot(
              input.home.configDir,
              unapprovedConfig,
              input.env,
              activeTimezone,
              intervalsVerificationPending(),
            ),
        },
        dependencies.operationsDependencies,
      ),
      getActivityAnalysis: (request, signal) =>
        activityAnalysis.getActivityAnalysis(request, signal),
      exportTrainingFile: (request, signal) => trainingExport.export(request, signal),
    } satisfies CoachOperations;
    return {
      engine: reconfigurable.engine,
      operations,
      spendMeter: reconfigurable.spendMeter,
      confirmations: reconfigurable.confirmations,
      startInitialRefresh,
      close() {
        closePromise ??= (async () => {
          closing = true;
          if (initialRefreshRetryTimer !== undefined) {
            clearTimeout(initialRefreshRetryTimer);
            initialRefreshRetryTimer = undefined;
          }
          initialRefreshController.abort(new Error("Coach lifecycle closed."));
          let failure: { readonly error: unknown } | undefined;
          const attempt = async (operation: () => void | Promise<void>): Promise<void> => {
            try {
              await operation();
            } catch (error) {
              failure ??= { error };
            }
          };
          await attempt(() => dependencies.closeHostAdapters?.());
          await attempt(() => reference!.scheduler.stop());
          await attempt(() => runtime!.close());
          await initialRefreshPromise?.catch(() => {});
          if (failure !== undefined) throw failure.error;
        })();
        return closePromise;
      },
    };
  } catch (error) {
    reference?.scheduler.stop();
    if (runtime !== undefined) await runtime.close();
    throw error;
  }
}
