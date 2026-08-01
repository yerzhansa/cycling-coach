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
  RefreshTokenReusedError,
  appendUsageLine,
  bootstrapReference,
  classifyFailure,
  compareAndSaveStoredProfile,
  createConversationStore,
  createMissingPlatformCalendarMutations,
  createPlatformCalendarMutations,
  createSubsystemLogger,
  deleteStoredProfile,
  engineConfigFromConfig,
  extractRetryAfterMs,
  loadStoredProfileSnapshot,
  makeChatClient,
  refreshCodexToken,
  resolveRuntimeConfig,
  resolveSecretRef,
  sessionConfigEnvironmentOwnership,
  type ClaudeCliRuntimeConfigPatch,
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
import { createAnchorRepository, type AnchorRepository } from "@enduragent/kernel/store";
import { ErrorStateSchema, LatestJsonSchema } from "@enduragent/kernel/reference/schemas";
import type { AthleteHome } from "@enduragent/kernel-node/home";
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
} from "@enduragent/coach-contract";
import { cyclingSport } from "@enduragent/sport-cycling";
import { createPersistedAthleteStateSource } from "./athlete-state-reader.js";
import {
  assertRuntimeAthleteOwner,
  RuntimeAthleteOwnerRefusal,
  type RuntimeAthleteOwnerClaim,
} from "./backfill.js";
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
  close(): Promise<void>;
}

export interface LocalCoachCompositionInput {
  readonly env: Record<string, string | undefined>;
  readonly home: AthleteHome;
  readonly context: CoachStoreWriterContext;
  readonly config: Config;
  readonly engineConfig: EngineConfig;
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
  runScheduledOnce(): ReturnType<ReferenceRuntime["runScheduledOnce"]>;
}

export interface LocalStoreRuntime {
  readonly athleteData: StoreRuntime["athleteData"];
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

function copyConfig(config: Config): Config {
  return {
    ...config,
    llm: { ...config.llm },
    intervals: { ...config.intervals },
    telegram: { ...config.telegram },
    session: { ...config.session },
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
    (provider !== "openai-codex" &&
      provider !== "claude-cli" &&
      nonemptyEnvironmentValue(environment, "LLM_API_KEY"))
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
    next.session = session;
  }
  replacePrivateFile(path, toYaml(next));
}

function runtimeCredentialConfigured(configDir: string, config: Config): boolean {
  if (config.llm.provider !== "openai-codex") return config.llm.apiKey.length > 0;
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

function runtimeConfigSnapshot(
  configDir: string,
  config: Config,
  environment: Readonly<Record<string, string | undefined>>,
  timezone: string,
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
}

function createReconfigurableRuntimeBundle(initial: RuntimeBundle): {
  readonly engine: CoachEngine;
  readonly spendMeter: SpendMeterService;
  readonly getTranscriptPage: (
    request: GetTranscriptPageRpcParams,
  ) => Promise<GetTranscriptPageRpcResult>;
  readonly listArchivedConversations: (
    request: ListArchivedConversationsRpcParams,
  ) => Promise<ListArchivedConversationsRpcResult>;
  readonly getArchivedTranscriptPage: (
    request: GetArchivedTranscriptPageRpcParams,
  ) => Promise<GetArchivedTranscriptPageRpcResult>;
  replace(create: () => RuntimeBundle | Promise<RuntimeBundle>): Promise<void>;
} {
  let active = initial;
  let admission = Promise.resolve();
  let activeCalls = 0;
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
      resetSession: (request) => run((bundle) => bundle.engine.resetSession(request)),
      hasSession: (request) => run((bundle) => bundle.engine.hasSession(request)),
      getAthleteState: () => run((bundle) => bundle.engine.getAthleteState()),
    },
    spendMeter: {
      getSpendSummary: () => run((bundle) => bundle.spendMeter.getSpendSummary()),
      setDailySpendCap: (dailyCapUsd) =>
        run((bundle) => bundle.spendMeter.setDailySpendCap(dailyCapUsd)),
    },
    getTranscriptPage: (request) =>
      run(async (bundle) => bundle.chatStore.readCurrentConversationPage("desktop", request)),
    listArchivedConversations: () =>
      run(async (bundle) => bundle.chatStore.listArchivedConversations("desktop")),
    getArchivedTranscriptPage: ({ boundaryRef, ...request }) =>
      run(async (bundle) =>
        bundle.chatStore.readArchivedConversationPage("desktop", boundaryRef, request),
      ),
    async replace(create) {
      const previousAdmission = admission;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      admission = previousAdmission.then(() => barrier);
      await previousAdmission;
      try {
        if (activeCalls > 0) {
          await new Promise<void>((resolve) => drainWaiters.add(resolve));
        }
        active = await create();
      } finally {
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

function createAccessTokenReader(
  configDir: string,
  now: () => number,
): EngineHostPorts["getAccessToken"] {
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
  const exclusive = async (profileName: string, signal?: AbortSignal): Promise<string> => {
    const snapshot = loadStoredProfileSnapshot(path, profileName);
    if (snapshot === null) throw new TypeError("OAuth profile is invalid.");
    const current = credential(snapshot.profile);
    if (Number.isFinite(current.expires) && now() <= current.expires - 300_000) {
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
  return async (profileName, signal) => {
    const previous = queues.get(profileName) ?? Promise.resolve("");
    const current = previous.then(
      () => exclusive(profileName, signal),
      () => exclusive(profileName, signal),
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
  ): Promise<RuntimeAthleteOwnerClaim | undefined> => {
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
  let activeConfig = copyConfig(input.config);
  if (activeConfig.intervals.apiKey.length > 0 && activeConfig.intervals.athleteId.length === 0) {
    activeConfig = {
      ...activeConfig,
      intervals: { ...activeConfig.intervals, athleteId: "0" },
    };
  }
  let runtime: LocalStoreRuntime | undefined;
  let reference: LocalReferenceRuntime | undefined;
  let closePromise: Promise<void> | undefined;
  try {
    if (activeConfig.intervals.apiKey.length > 0) {
      const startupOwnerClaim = await assertIntervalsOwner(
        activeConfig.intervals,
        activeConfig.intervals,
        new AbortController().signal,
      );
      await startupOwnerClaim?.claim();
    }
    reference = await (dependencies.bootstrap ?? bootstrapReference)({
      dataDir: input.home.root,
      intervals: activeConfig.intervals,
      readIntervals: () => activeConfig.intervals,
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
      config: activeConfig,
      readConfig: () => activeConfig,
      home: input.home,
      reference,
      writerContext: input.context,
      dependencies: dependencies.runtimeDependencies,
    };
    runtime =
      dependencies.createRuntime === undefined
        ? createStoreRuntime({
            ...runtimeOptions,
            reference: reference as ReferenceRuntime,
          })
        : dependencies.createRuntime(runtimeOptions);
    await runtime.runWindow();
    runtime.startScheduler();
    const logger = createSubsystemLogger("agent", input.home.root);
    const getAccessToken = createAccessTokenReader(input.home.configDir, now);
    const repository = (dependencies.createRepository ?? createAnchorRepository)(
      input.context.store,
    );
    const cyclingFtpAnchorResolver = (
      dependencies.createResolver ?? createCyclingFtpAnchorResolver
    )(repository);
    const stateReader = createPersistedAthleteStateSource({
      dataDir: input.home.root,
      cyclingFtpAnchorResolver,
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
      const memory = new Memory(input.home.root, timezone);
      const conversationStore = createConversationStore(
        input.home.root,
        config.session.resetArchiveRetentionDays,
      );
      const projectedConfig = engineConfigFromConfig(effectiveConfig);
      const legacyClient =
        config.intervals.apiKey.length === 0
          ? null
          : makeChatClient({
              apiKey: config.intervals.apiKey,
              athleteId: config.intervals.athleteId,
            });
      const ports: EngineHostPorts = {
        config: projectedConfig,
        memory,
        chatStore: conversationStore,
        transcriptWriter: conversationStore,
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
        engine: createCoachEngineAdapter({
          backend,
          getAthleteState: () => stateReader.getAthleteState(),
          cyclingFtpAnchorResolver,
          now,
        }),
      };
    };
    const initialBundle = buildBundle(activeConfig);
    let activeTimezone = initialBundle.timezone;
    const reconfigurable = createReconfigurableRuntimeBundle(initialBundle);
    const persistConfig = dependencies.persistRuntimeConfig ?? persistRuntimeConfig;
    const applyRuntimeConfig = async (
      request: ConfigureRuntimeRpcParams,
      signal: AbortSignal,
    ): Promise<ConfigureRuntimeRpcRefusalReason | void> => {
      signal.throwIfAborted();
      if (
        request.llm?.clear_credential === true &&
        request.llm.provider !== activeConfig.llm.provider
      ) {
        return "credential-required";
      }
      if (
        request.llm?.clear_credential === true &&
        llmCredentialManagedByEnvironment(input.env, activeConfig.llm.provider)
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
      const candidate = mergedRuntimeConfig(activeConfig, request);
      const activeAthleteId =
        activeConfig.intervals.athleteId.length === 0 ? "0" : activeConfig.intervals.athleteId;
      const candidateAthleteId =
        candidate.intervals.athleteId.length === 0 ? "0" : candidate.intervals.athleteId;
      const athleteIdChanged =
        request.intervals?.athlete_id !== undefined && candidateAthleteId !== activeAthleteId;
      const apiKeyChanged =
        (request.intervals?.api_key !== undefined ||
          request.intervals?.clear_credential === true) &&
        candidate.intervals.apiKey !== activeConfig.intervals.apiKey;
      let pendingOwnerClaim: RuntimeAthleteOwnerClaim | undefined;
      if (athleteIdChanged || (apiKeyChanged && request.intervals?.clear_credential !== true)) {
        if (
          apiKeyChanged &&
          input.env.INTERVALS_API_KEY !== undefined &&
          input.env.INTERVALS_API_KEY !== ""
        ) {
          throw new Error("runtime intervals credential is controlled by the daemon environment");
        }
        try {
          pendingOwnerClaim = await assertIntervalsOwner(
            activeConfig.intervals,
            candidate.intervals,
            signal,
            activeConfig.intervals.apiKey.length === 0 && candidate.intervals.apiKey.length > 0,
          );
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
      const replacement = buildBundle(candidate);
      const chatGptProfileClear =
        request.llm?.clear_credential === true && activeConfig.llm.provider === "openai-codex";
      signal.throwIfAborted();
      await reconfigurable.replace(async () => {
        signal.throwIfAborted();
        const previousConfigFile =
          pendingOwnerClaim === undefined && !chatGptProfileClear
            ? undefined
            : captureRuntimeConfigFile(input.home.configDir);
        try {
          persistConfig(input.home.configDir, candidate, request, activeConfig);
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
        activeConfig = candidate;
        activeTimezone = replacement.timezone;
        return replacement;
      });
      if (request.intervals !== undefined && candidate.intervals.apiKey.length > 0) {
        void runtime!.runWindowAfter(() => Promise.resolve()).catch(() => {});
      }
    };
    const liveIntervals = Object.freeze({
      async read() {
        return Object.freeze({ ...activeConfig.intervals });
      },
    });
    const options = Object.freeze({ liveIntervals });
    const operations = createCoachOperations(
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
        readRuntimeConfig: () =>
          runtimeConfigSnapshot(input.home.configDir, activeConfig, input.env, activeTimezone),
      },
      dependencies.operationsDependencies,
    );
    return {
      engine: reconfigurable.engine,
      operations,
      spendMeter: reconfigurable.spendMeter,
      close() {
        closePromise ??= (async () => {
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
