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
import { parse as parseYaml, stringify as toYaml } from "yaml";
import {
  ChatStore,
  Memory,
  appendUsageLine,
  bootstrapReference,
  classifyFailure,
  createMissingPlatformCalendarMutations,
  createPlatformCalendarMutations,
  createSubsystemLogger,
  engineConfigFromConfig,
  extractRetryAfterMs,
  makeChatClient,
  refreshCodexToken,
  resolveSecretRef,
  type Config,
  type ReferenceRuntime,
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
import type {
  CoachEngine,
  CoachOperations,
  ConfigureRuntimeRpcParams,
} from "@enduragent/coach-contract";
import { cyclingSport } from "@enduragent/sport-cycling";
import { createPersistedAthleteStateSource } from "./athlete-state-reader.js";
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

interface OAuthCredential {
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

function mergedRuntimeConfig(config: Config, request: ConfigureRuntimeRpcParams): Config {
  const next = copyConfig(config);
  if (request.llm !== undefined) {
    next.llm = {
      provider: request.llm.provider,
      model: request.llm.model,
      apiKey: request.llm.provider === "openai-codex" ? "" : (request.llm.api_key ?? ""),
      authProfile: request.llm.provider === "openai-codex" ? "openai-codex" : undefined,
    };
  }
  if (request.intervals !== undefined) {
    next.intervals = {
      apiKey: request.intervals.api_key,
      athleteId: request.intervals.athlete_id,
    };
  }
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function persistRuntimeConfig(configDir: string, request: ConfigureRuntimeRpcParams): void {
  const path = join(configDir, "config.yaml");
  const parsed = existsSync(path) ? (parseYaml(readFileSync(path, "utf8")) as unknown) : {};
  if (!isRecord(parsed)) throw new TypeError("Runtime config must be a map.");
  const next = { ...parsed };
  if (request.llm !== undefined) {
    const existing = isRecord(parsed.llm) ? parsed.llm : {};
    const llm: Record<string, unknown> = {
      ...(existing.provider === request.llm.provider ? existing : {}),
      provider: request.llm.provider,
      model: request.llm.model,
    };
    if (request.llm.provider === "openai-codex") llm.auth_profile = "openai-codex";
    else delete llm.auth_profile;
    next.llm = llm;
  }
  if (request.intervals !== undefined) {
    next.intervals = {
      ...(isRecord(parsed.intervals) ? parsed.intervals : {}),
      athlete_id: request.intervals.athlete_id,
    };
  }
  const temporaryPath = `${path}.tmp.${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(temporaryPath, toYaml(next), { mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {}
    throw error;
  }
}

function createReconfigurableEngine(initial: CoachEngine): {
  readonly engine: CoachEngine;
  replace(create: () => CoachEngine): Promise<void>;
} {
  let active = initial;
  let admission = Promise.resolve();
  let activeCalls = 0;
  const drainWaiters = new Set<() => void>();

  const run = async <T>(operation: (engine: CoachEngine) => Promise<T>): Promise<T> => {
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
      chat: (request, onEvent) => run((engine) => engine.chat(request, onEvent)),
      resetSession: (request) => run((engine) => engine.resetSession(request)),
      hasSession: (request) => run((engine) => engine.hasSession(request)),
      getAthleteState: () => run((engine) => engine.getAthleteState()),
    },
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
        active = create();
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

function readProfiles(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("OAuth profiles must be a map.");
  }
  return value as Record<string, unknown>;
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

function writeProfiles(path: string, profiles: Record<string, unknown>): void {
  const temporaryPath = `${path}.tmp.${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(profiles, null, 2), { mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {}
    throw error;
  }
}

function createAccessTokenReader(
  configDir: string,
  now: () => number,
): EngineHostPorts["getAccessToken"] {
  const path = join(configDir, "auth-profiles.json");
  const queues = new Map<string, Promise<string>>();
  const exclusive = async (profileName: string, signal?: AbortSignal): Promise<string> => {
    const profiles = readProfiles(path);
    const current = credential(profiles[profileName]);
    if (Number.isFinite(current.expires) && now() <= current.expires - 300_000) {
      return current.access;
    }
    const refreshed = await refreshCodexToken(current.refresh, signal);
    profiles[profileName] = {
      type: "oauth",
      access: refreshed.access,
      refresh: refreshed.refresh,
      expires: refreshed.expires,
      accountId: refreshed.accountId ?? current.accountId,
      email: current.email,
    } satisfies OAuthCredential;
    writeProfiles(path, profiles);
    return refreshed.access;
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
  const spendMeter = createSpendMeterService({
    dataDir: input.home.root,
    configDir: input.home.configDir,
    timezone: resolveUserTimezone(input.config.session.timezone),
    now,
  });
  let activeConfig = copyConfig(input.config);
  let runtime: LocalStoreRuntime | undefined;
  let reference: LocalReferenceRuntime | undefined;
  let closePromise: Promise<void> | undefined;
  try {
    reference = await (dependencies.bootstrap ?? bootstrapReference)({
      dataDir: input.home.root,
      intervals: input.config.intervals,
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
    const memory = new Memory(input.home.root, input.config.session.timezone);
    const chatStore = new ChatStore(
      input.home.root,
      input.config.session.resetArchiveRetentionDays,
    );
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
    const buildEngine = (config: Config): CoachEngine => {
      const projectedConfig = engineConfigFromConfig(config);
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
        chatStore,
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
      return createCoachEngineAdapter({
        backend,
        getAthleteState: () => stateReader.getAthleteState(),
        cyclingFtpAnchorResolver,
        now,
      });
    };
    const reconfigurable = createReconfigurableEngine(buildEngine(activeConfig));
    const applyRuntimeConfig = async (request: ConfigureRuntimeRpcParams): Promise<void> => {
      const candidate = mergedRuntimeConfig(activeConfig, request);
      if (request.llm?.provider === "openai-codex") {
        const profiles = readProfiles(join(input.home.configDir, "auth-profiles.json"));
        credential(profiles["openai-codex"]);
      }
      const replacement = buildEngine(candidate);
      persistRuntimeConfig(input.home.configDir, request);
      await reconfigurable.replace(() => {
        activeConfig = candidate;
        return replacement;
      });
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
        historyNewestDate: new Date(now()).toISOString().slice(0, 10),
        applyRuntimeConfig,
      },
      dependencies.operationsDependencies,
    );
    return {
      engine: reconfigurable.engine,
      operations,
      spendMeter,
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
