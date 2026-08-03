import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AthleteState, CoachEngine, CoachOperations } from "@enduragent/coach-contract";
import type { Config } from "@enduragent/core";
import type { EngineConfig } from "@enduragent/engine";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import { inertWriterProtocolListener } from "@enduragent/kernel-node/lock";
import type { CoachStoreWriterContext, CoachStoreWriterPlan } from "../src/runtime.js";

const mocks = vi.hoisted(() => ({
  withWriter: vi.fn(),
  migrate: vi.fn(),
  readiness: vi.fn(),
  composition: vi.fn(),
}));

vi.mock("../src/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/runtime.js")>()),
  withCoachStoreWriter: mocks.withWriter,
}));
vi.mock("../src/legacy-migration.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/legacy-migration.js")>()),
  migrateLegacyHomeUnderLock: mocks.migrate,
}));
vi.mock("../src/readiness.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/readiness.js")>()),
  checkHomeReadiness: mocks.readiness,
}));
vi.mock("../src/composition.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/composition.js")>()),
  createLocalCoachComposition: mocks.composition,
}));
import { CoachStoreWriterError } from "../src/runtime.js";
import { withLocalCoach, type LocalCoachLifecycle } from "../src/local-runner.js";

const state: AthleteState = {
  schemaVersion: "3",
  lastUpdated: "2026-07-18T00:00:00.000Z",
  freshness: "fresh",
  degraded: false,
  lastSynced: "2026-07-18T00:00:00.000Z",
  athleteProfile: {},
  currentStatus: {},
  derivedMetrics: {},
  recentActivities: [],
  plannedWorkouts: [],
  wellness: {},
};

const engine: CoachEngine = {
  chat: async () => ({ text: "ok" }),
  resetSession: async () => ({ memoryFlushed: true }),
  hasSession: async () => ({ hasSession: false }),
  getAthleteState: async () => state,
};

const operations: CoachOperations = {
  importFiles: async ({ paths }) => ({
    schemaVersion: 2,
    files: { total: paths.length, imported: paths.length, quarantined: 0 },
    changes: {
      rawFilesInserted: paths.length,
      sourceRecordsInserted: paths.length,
      sourceRecordsUpdated: 0,
      relinkedSourceRecords: 0,
    },
    publication: { scope: "activities-and-streams", status: "available" },
  }),
  sync: async () => ({
    schemaVersion: 1,
    published: true,
    referenceSucceeded: true,
    requests: { store: 0, reference: 0, total: 0 },
  }),
  saveIntake: async () => ({ schemaVersion: 1, saved: true }),
  getTranscriptPage: async () => ({
    schemaVersion: 1,
    status: "page",
    turns: [],
    nextCursor: null,
  }),
  listArchivedConversations: async () => ({
    schemaVersion: 1,
    conversations: [],
    truncated: false,
  }),
  getArchivedTranscriptPage: async () => ({
    schemaVersion: 1,
    status: "page",
    turns: [],
    nextCursor: null,
  }),
  configureRuntime: async ({ llm, intervals, session }) => ({
    schemaVersion: 3,
    status: "applied",
    applied: {
      llm: llm !== undefined,
      intervals: intervals !== undefined,
      session: session !== undefined,
    },
  }),
  getRuntimeConfig: async () => ({
    schemaVersion: 3,
    llm: { provider: "anthropic", model: "synthetic-model", credential_configured: false },
    intervals: {
      athlete_id: "synthetic-athlete",
      credential_configured: false,
      managedByEnvironment: { athleteId: false },
    },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "UTC",
      managedByEnvironment: {
        historyTokenBudgetRatio: false,
        idleMinutes: false,
        dailyResetHour: false,
        resetArchiveRetentionDays: false,
        timezone: false,
      },
    },
  }),
};

const spendMeter = {
  getSpendSummary: vi.fn(),
  setDailySpendCap: vi.fn(),
};

const config = {
  dataSource: "store",
  llm: { provider: "anthropic", model: "synthetic", apiKey: "" },
  intervals: { apiKey: "", athleteId: "synthetic" },
  telegram: { botToken: "" },
  session: {
    historyTokenBudgetRatio: 0.3,
    idleMinutes: 0,
    dailyResetHour: 4,
    resetArchiveRetentionDays: 0,
    timezone: "UTC",
  },
  contextWindowTokens: 1000,
  dataDir: "",
} satisfies Config;

const engineConfig: EngineConfig = {
  dataSource: "store",
  llm: { provider: "anthropic", model: "synthetic", apiKey: "" },
  session: config.session,
  contextWindowTokens: 1000,
  compactContextWindowTokens: 1000,
};

const roots: string[] = [];
let selectedHome: AthleteHome;
let context: CoachStoreWriterContext;
let trace: string[];
let closeImplementation: () => Promise<void>;
let readyConfig: Config;

async function freshHome(): Promise<AthleteHome> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "coach-local-runner-"));
  roots.push(root);
  return {
    root,
    storeDir: join(root, "store"),
    archiveDir: join(root, "archive"),
    configDir: join(root, "config"),
  };
}

function store(): CoachStoreWriterContext["store"] {
  return {
    async exec() {},
    async run() {},
    async get() {
      return undefined;
    },
    async all() {
      return [];
    },
    async close() {},
    async getUserVersion() {
      return 0;
    },
    async setUserVersion() {},
    async transaction<T>(operation: () => Promise<T>) {
      return operation();
    },
  };
}

function notNeeded() {
  return {
    status: "not-needed" as const,
    exitCode: 0 as const,
    journalPath: join(selectedHome.root, "migration.json"),
    manifestDigest: null,
  };
}

function input(operation: (lifecycle: LocalCoachLifecycle) => Promise<unknown>) {
  return {
    env: { SYNTHETIC: "1" },
    home: selectedHome,
    sourceRoot: join(selectedHome.root, "legacy-source"),
    action: { kind: "resume" as const, isTTY: false },
    operation,
  };
}

beforeEach(async () => {
  selectedHome = await freshHome();
  context = {
    home: selectedHome,
    store: store(),
    listener: inertWriterProtocolListener,
  };
  trace = [];
  closeImplementation = async () => {
    trace.push("lifecycle-close");
  };
  mocks.withWriter.mockReset();
  mocks.migrate.mockReset();
  mocks.readiness.mockReset();
  mocks.composition.mockReset();
  mocks.migrate.mockImplementation(async () => {
    trace.push("legacy-migration");
    return notNeeded();
  });
  readyConfig = { ...config, dataDir: selectedHome.root };
  mocks.readiness.mockImplementation(async () => {
    trace.push("readiness");
    return { status: "ready", config: readyConfig, engineConfig };
  });
  mocks.composition.mockImplementation(async () => {
    trace.push("engine-open");
    return { engine, operations, spendMeter, close: () => closeImplementation() };
  });
  mocks.withWriter.mockImplementation(
    async (env: Record<string, string | undefined>, plan: CoachStoreWriterPlan<unknown>) => {
      expect(env).toEqual({ SYNTHETIC: "1", ENDURAGENT_HOME: selectedHome.root });
      trace.push("writer-acquired");
      try {
        await plan.beforeStoreOpen(selectedHome);
        trace.push("store-open", "schema-migrations");
        return await plan.operation(context);
      } finally {
        trace.push("store-close", "writer-release");
      }
    },
  );
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local coach runner", () => {
  it("runs the exact successful lock, migration, store, engine, operation, and cleanup order", async () => {
    trace.push("resolve-supplied-home");
    await expect(
      withLocalCoach(
        input(async (lifecycle) => {
          expect(lifecycle.listener).toBe(inertWriterProtocolListener);
          expect(lifecycle.operations).toBe(operations);
          expect(lifecycle.spendMeter).toBe(spendMeter);
          trace.push("operation");
          return "done";
        }),
      ),
    ).resolves.toEqual({ status: "completed", value: "done" });
    expect(trace).toEqual([
      "resolve-supplied-home",
      "writer-acquired",
      "legacy-migration",
      "store-open",
      "schema-migrations",
      "readiness",
      "engine-open",
      "operation",
      "lifecycle-close",
      "store-close",
      "writer-release",
    ]);
    expect(mocks.composition).toHaveBeenCalledWith(
      expect.objectContaining({
        config: readyConfig,
        engineConfig,
      }),
    );
    const compositionInput = mocks.composition.mock.calls[0]![0];
    expect(compositionInput.config).toBe(readyConfig);
    expect(compositionInput.engineConfig).toBe(engineConfig);
  });

  it("uses one physical athlete-home identity throughout a root-alias lifecycle", async () => {
    const physicalHome = selectedHome;
    const aliasRoot = join(physicalHome.root, "athlete-home-alias");
    await symlink(physicalHome.root, aliasRoot, "dir");
    selectedHome = {
      root: aliasRoot,
      storeDir: join(aliasRoot, "store"),
      archiveDir: join(aliasRoot, "archive"),
      configDir: join(aliasRoot, "config"),
    };
    context = { ...context, home: physicalHome };
    readyConfig = { ...readyConfig, dataDir: aliasRoot };
    mocks.withWriter.mockImplementation(
      async (env: Record<string, string | undefined>, plan: CoachStoreWriterPlan<unknown>) => {
        expect(env).toEqual({ SYNTHETIC: "1", ENDURAGENT_HOME: physicalHome.root });
        await plan.beforeStoreOpen(physicalHome);
        return plan.operation(context);
      },
    );

    await expect(withLocalCoach(input(async () => "done"))).resolves.toEqual({
      status: "completed",
      value: "done",
    });

    expect(mocks.migrate).toHaveBeenCalledWith(
      expect.objectContaining({ targetRoot: physicalHome.root }),
    );
    expect(mocks.readiness).toHaveBeenCalledExactlyOnceWith(physicalHome);
    expect(mocks.composition).toHaveBeenCalledWith(
      expect.objectContaining({ home: physicalHome, context }),
    );
    expect(mocks.composition.mock.calls[0]![0].config).toEqual({
      ...readyConfig,
      dataDir: physicalHome.root,
    });
  });

  it("releases the writer after migration throws without opening later stages", async () => {
    const failure = { kind: "migration-failure" };
    mocks.migrate.mockRejectedValue(failure);
    await expect(withLocalCoach(input(async () => "unused"))).rejects.toBe(failure);
    expect(trace).toEqual(["writer-acquired", "store-close", "writer-release"]);
    expect(mocks.readiness).not.toHaveBeenCalled();
    expect(mocks.composition).not.toHaveBeenCalled();
  });

  it("carries refused and discarded results exactly while only not-needed and done open the store", async () => {
    const refused = {
      status: "refused" as const,
      exitCode: 3 as const,
      journalPath: "synthetic-journal",
      manifestDigest: "a".repeat(64),
      reason: "source-drift" as const,
      conflictIds: ["synthetic-conflict"],
    };
    const discarded = {
      status: "discarded" as const,
      exitCode: 0 as const,
      journalPath: "synthetic-journal",
      manifestDigest: "b".repeat(64),
      archivePath: "synthetic-archive",
    };
    for (const terminal of [refused, discarded]) {
      trace.length = 0;
      mocks.migrate.mockResolvedValueOnce(terminal);
      const result = await withLocalCoach(input(async () => "unused"));
      expect(result).toEqual({
        status: terminal.status === "refused" ? "migration-refused" : "migration-discarded",
        result: terminal,
      });
      expect(trace).toEqual(["writer-acquired", "store-close", "writer-release"]);
    }
    for (const opening of [
      notNeeded(),
      {
        status: "done" as const,
        exitCode: 0 as const,
        journalPath: "synthetic-journal",
        manifestDigest: "c".repeat(64),
        completion: "complete" as const,
        copiedIds: [],
        skipVerifiedIds: [],
        skippedConflictIds: [],
        freezePoint: "synthetic-freeze",
      },
    ]) {
      trace.length = 0;
      mocks.migrate.mockResolvedValueOnce(opening);
      await expect(withLocalCoach(input(async () => "done"))).resolves.toEqual({
        status: "completed",
        value: "done",
      });
      expect(trace).toContain("store-open");
    }
  });

  it("returns not-configured with the exact path without engine construction or operation", async () => {
    const configPath = join(selectedHome.configDir, "config.yaml");
    mocks.readiness.mockResolvedValue({ status: "not-configured", configPath });
    const operation = vi.fn(async () => "unused");
    await expect(withLocalCoach(input(operation))).resolves.toEqual({
      status: "not-configured",
      configPath,
    });
    expect(mocks.composition).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
    expect(trace.slice(-2)).toEqual(["store-close", "writer-release"]);
  });

  it.each(["unreadable", "malformed"] as const)(
    "returns %s only after releasing the writer without constructing the engine",
    async (status) => {
      mocks.readiness.mockResolvedValue({ status });
      const operation = vi.fn(async () => "unused");

      await expect(withLocalCoach(input(operation))).resolves.toEqual({ status });
      expect(mocks.composition).not.toHaveBeenCalled();
      expect(operation).not.toHaveBeenCalled();
      expect(trace.slice(-2)).toEqual(["store-close", "writer-release"]);
    },
  );

  it("characterizes structural home readiness and the optional Config directory parameter", async () => {
    const actualReadiness =
      await vi.importActual<typeof import("../src/readiness.js")>("../src/readiness.js");
    const actualCore = await vi.importActual<typeof import("@enduragent/core")>("@enduragent/core");
    await mkdir(selectedHome.configDir, { recursive: true });
    const configPath = join(selectedHome.configDir, "config.yaml");
    await expect(actualReadiness.checkHomeReadiness(selectedHome)).resolves.toEqual({
      status: "not-configured",
      configPath,
    });
    await writeFile(configPath, "[");
    await expect(actualReadiness.checkHomeReadiness(selectedHome)).resolves.toEqual({
      status: "malformed",
    });
    await writeFile(
      configPath,
      "llm:\n  provider: openai-codex\ndata_dir: " + selectedHome.root + "\n",
    );
    const ready = await actualReadiness.checkHomeReadiness(selectedHome);
    expect(ready.status).toBe("ready");
    expect(actualCore.loadConfig(selectedHome.configDir).dataDir).toBe(selectedHome.root);
    expect(actualCore.loadConfig.length).toBe(0);
  });

  it("loads an absent readiness data_dir against the selected athlete root", async () => {
    const actualReadiness =
      await vi.importActual<typeof import("../src/readiness.js")>("../src/readiness.js");
    await mkdir(selectedHome.configDir, { recursive: true });
    await writeFile(
      join(selectedHome.configDir, "config.yaml"),
      "data_source: store\nllm:\n  provider: anthropic\n",
      { mode: 0o600 },
    );

    const readiness = await actualReadiness.checkHomeReadiness(selectedHome);
    expect(readiness).toMatchObject({ status: "ready" });
    if (readiness.status === "ready") expect(readiness.config.dataDir).toBe(selectedHome.root);
  });

  it("rethrows the exact operation object only after lifecycle, store, and writer cleanup", async () => {
    const failure = { kind: "operation-failure" };
    await expect(
      withLocalCoach(
        input(async () => {
          trace.push("operation");
          throw failure;
        }),
      ),
    ).rejects.toBe(failure);
    expect(trace.slice(-4)).toEqual([
      "operation",
      "lifecycle-close",
      "store-close",
      "writer-release",
    ]);
  });

  it("gives operation failure precedence over close failures and otherwise propagates cleanup failure", async () => {
    const operationFailure = { kind: "operation" };
    closeImplementation = async () => {
      trace.push("lifecycle-close");
      throw { kind: "lifecycle-close" };
    };
    await expect(
      withLocalCoach(
        input(async () => {
          throw operationFailure;
        }),
      ),
    ).rejects.toBe(operationFailure);
    const cleanupFailure = new CoachStoreWriterError("writer-failed", "invoke operation");
    closeImplementation = async () => {
      throw cleanupFailure;
    };
    await expect(withLocalCoach(input(async () => "done"))).rejects.toBe(cleanupFailure);
  });

  it("supports idempotent lifecycle close and does not resolve before writer release", async () => {
    let closerCalls = 0;
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      closerCalls += 1;
      trace.push("lifecycle-close");
    };
    mocks.composition.mockResolvedValue({ engine, operations, spendMeter, close });
    await expect(
      withLocalCoach(
        input(async (lifecycle) => {
          await lifecycle.close();
          await lifecycle.close();
          return "done";
        }),
      ),
    ).resolves.toEqual({ status: "completed", value: "done" });
    expect(closerCalls).toBe(1);
    expect(trace.at(-1)).toBe("writer-release");
  });

  it("preserves actionable healthy-holder contention without migration or engine work", async () => {
    const contention = { kind: "holder" as const, pid: 4321, port: 8765 };
    const failure = new CoachStoreWriterError("writer-lock-held", null, undefined, contention);
    mocks.withWriter.mockRejectedValue(failure);
    await expect(withLocalCoach(input(async () => "unused"))).rejects.toBe(failure);
    expect(failure).toMatchObject({ code: "writer-lock-held", stage: null, contention });
    expect(mocks.migrate).not.toHaveBeenCalled();
    expect(mocks.composition).not.toHaveBeenCalled();
  });

  it("preserves actionable foreign-port contention without migration or engine work", async () => {
    const contention = {
      kind: "foreign" as const,
      port: 8765,
      portFile: join(selectedHome.configDir, "store-writer.port"),
    };
    const failure = new CoachStoreWriterError("writer-lock-held", null, undefined, contention);
    mocks.withWriter.mockRejectedValue(failure);
    await expect(withLocalCoach(input(async () => "unused"))).rejects.toBe(failure);
    expect(failure.contention).toEqual(contention);
    expect(mocks.migrate).not.toHaveBeenCalled();
    expect(mocks.composition).not.toHaveBeenCalled();
  });
});
