import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AthleteState, CoachEngine } from "@enduragent/coach-contract";
import { engineConfigFromConfig, type Config } from "@enduragent/core";
import type {
  AthleteDataReaderPort,
  CreateCoachEngineInput,
  ModelTransportDecorator,
} from "@enduragent/engine";
import { createPhysicalRequestLedger, runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import type { ReferenceCaptureManifest } from "@enduragent/kernel/reference/capture";
import type { ProducedLocalBundle } from "@enduragent/kernel/reference/local-bundle";
import type { CyclingFtpAnchorResolver } from "@enduragent/kernel/anchors";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import { inertWriterProtocolListener } from "@enduragent/kernel-node/lock";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import {
  createLocalCoachComposition,
  type LocalCoachCompositionDependencies,
  type LocalReferenceRuntime,
  type LocalStoreRuntime,
} from "../src/composition.js";
import type { CoachStoreWriterContext } from "../src/runtime.js";

const roots: string[] = [];
const stores: CoachStoreWriterContext["store"][] = [];

const state: AthleteState = {
  schemaVersion: "3",
  lastUpdated: "2026-07-18T00:00:00.000Z",
  freshness: "fresh",
  degraded: true,
  lastSynced: "2026-07-18T00:00:00.000Z",
  athleteProfile: { name: "Synthetic Athlete" },
  currentStatus: { summary: "current" },
  derivedMetrics: { eftp: 260, future_metric: 1 },
  derivedMetricsMeta: {
    sportFamily: "cycling",
    prescriptionBasis: "power",
    anchorType: "ftp",
    analysisBasis: "power",
  },
  recentActivities: [{ id: "activity-1" }],
  plannedWorkouts: [{ id: "workout-1" }],
  wellness: { restingHr: 45 },
  trainingContext: {
    anchorZones: { kind: "unknown", reason: "missing-anchor" },
    cyclingLoad: { kind: "unknown", reason: "no-platform-load" },
    plan: { kind: "unknown", reason: "no-plan" },
    adherence: { kind: "unknown", reason: "insufficient-data" },
    wellnessTrend: { kind: "unknown", reason: "no-wellness" },
  },
};

function latest() {
  return {
    metadata: {
      schema_version: "3",
      last_updated: state.lastUpdated,
      freshness: state.freshness,
    },
    athlete_profile: state.athleteProfile,
    current_status: state.currentStatus,
    derived_metrics: state.derivedMetrics,
    derived_metrics_meta: state.derivedMetricsMeta,
    recent_activities: state.recentActivities,
    planned_workouts: state.plannedWorkouts,
    wellness_data: state.wellness,
  };
}

async function freshHome(): Promise<AthleteHome> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "coach-composition-"));
  roots.push(root);
  const home = {
    root,
    storeDir: join(root, "store"),
    archiveDir: join(root, "archive"),
    configDir: join(root, "config"),
  };
  await mkdir(join(root, "data"), { recursive: true });
  await mkdir(home.configDir, { recursive: true });
  await writeFile(join(root, "data", "latest.json"), JSON.stringify(latest()));
  await writeFile(
    join(root, "data", "error_state.json"),
    JSON.stringify({
      schema_version: "1",
      step: "synthetic",
      detail: "synthetic outage",
      ts: "2026-07-18T01:00:00.000Z",
      mitigation: "block_coaching",
    }),
  );
  return home;
}

function config(
  home: AthleteHome,
  intervals: Config["intervals"] = { apiKey: "", athleteId: "synthetic" },
): Config {
  return {
    dataSource: "store",
    llm: { provider: "anthropic", model: "synthetic", apiKey: "" },
    intervals,
    telegram: { botToken: "" },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "UTC",
    },
    contextWindowTokens: 1000,
    dataDir: home.root,
  };
}

function athleteData(): AthleteDataReaderPort {
  return {
    async getAthlete() {
      return { ok: false, error: "not_found", message: "synthetic" };
    },
    async listWellness() {
      return { ok: true, value: [] };
    },
    async listActivities() {
      return { ok: true, value: [] };
    },
    async getActivity() {
      return { ok: false, error: "not_found", message: "synthetic" };
    },
    async getStreams() {
      return { ok: false, error: "not_found", message: "synthetic" };
    },
    async listCalendar() {
      return { ok: true, value: [] };
    },
    freshness() {
      return undefined;
    },
  };
}

function reference(trace: string[] = []): LocalReferenceRuntime {
  return {
    scheduler: {
      stop: () => {
        trace.push("reference-stop");
      },
    },
    async runScheduledOnce() {
      return { kind: "skipped", reason: "cooldown" };
    },
  };
}

function runtime(
  trace: string[] = [],
  options: {
    runWindow?: () => Promise<{
      published: boolean;
      counts: ReturnType<ReturnType<typeof createPhysicalRequestLedger>["snapshot"]>;
      legacySucceeded: boolean;
    }>;
    close?: () => Promise<void>;
  } = {},
): LocalStoreRuntime {
  const ledger = createPhysicalRequestLedger({ storeLimit: 64, legacyLimit: 15, totalLimit: 79 });
  const runWindow =
    options.runWindow ??
    (async () => {
      trace.push("run-window");
      return { published: true, counts: ledger.snapshot(), legacySucceeded: true };
    });
  return {
    athleteData: athleteData(),
    attemptLedgerForRun: () => ledger,
    runWindow,
    async runWindowAfter(work) {
      await work(new AbortController().signal);
      return runWindow();
    },
    startScheduler() {
      trace.push("start-scheduler");
    },
    close:
      options.close ??
      (async () => {
        trace.push("runtime-close");
      }),
  };
}

function backend(overrides: Partial<CoachEngine> = {}): CoachEngine {
  return {
    chat: async () => ({ text: "ok" }),
    resetSession: async () => ({ memoryFlushed: true }),
    hasSession: async () => ({ hasSession: false }),
    getAthleteState: async () => state,
    ...overrides,
  };
}

function missingResolver(): CyclingFtpAnchorResolver {
  return { resolve: async () => ({ kind: "missing", refusal: "missing-cycling-ftp-anchor" }) };
}

function fakeContext(home: AthleteHome): CoachStoreWriterContext {
  return {
    home,
    listener: inertWriterProtocolListener,
    store: {
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
    },
  };
}

async function compose(
  home: AthleteHome,
  dependencies: LocalCoachCompositionDependencies,
  context = fakeContext(home),
  intervals?: Config["intervals"],
) {
  const coreConfig = config(home, intervals);
  return createLocalCoachComposition(
    {
      env: { ENDURAGENT_HOME: home.root },
      home,
      context,
      config: coreConfig,
      engineConfig: engineConfigFromConfig(coreConfig),
    },
    dependencies,
  );
}

function generation(text: string) {
  return {
    text,
    toolCalls: [],
    finishReason: "stop" as const,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
    },
    steps: 1,
  };
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local coach composition", () => {
  it("reuses the lifecycle writer in the first store window without nested acquisition", async () => {
    const home = await freshHome();
    const context = fakeContext(home);
    const nestedWriterAcquisition = vi.fn(() => {
      throw new Error("nested writer acquisition");
    });
    const manifest = {
      capture_id: "12345678-1234-4123-8123-123456789abc",
      plan: { frozenNow: "1998-07-18T12:00:00.000Z" },
    } as ReferenceCaptureManifest;
    const produced: ProducedLocalBundle = {
      captureId: manifest.capture_id,
      frozenNow: manifest.plan.frozenNow,
      bundle: { activities: [], wellness: [], ftpHistory: [] },
    };
    const capture = vi.fn(
      async (options: Parameters<typeof import("../src/capture.js").runReferenceCapture>[0]) => {
        if (options.writerContext === undefined) nestedWriterAcquisition();
        expect(options.writerContext).toBe(context);
        return manifest;
      },
    );
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        runtimeDependencies: {
          capture,
          produce: async () => produced,
          now: () => new Date("1998-07-18T12:00:00.000Z"),
          monotonicNow: () => 1,
        },
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      context,
      { apiKey: "dummy", athleteId: "synthetic" },
    );
    expect(capture).toHaveBeenCalledTimes(1);
    expect(nestedWriterAcquisition).not.toHaveBeenCalled();
    await lifecycle.close();
  });

  it("constructs the complete object-shaped engine input from named host owners", async () => {
    const home = await freshHome();
    const selectedRuntime = runtime();
    let received: CreateCoachEngineInput | undefined;
    const lifecycle = await compose(home, {
      bootstrap: async () => reference(),
      createRuntime: () => selectedRuntime,
      createBackend: (input) => {
        received = input;
        return backend();
      },
      createRepository: () => ({
        insertIfAbsent: async () => false,
        readCurrent: async () => undefined,
      }),
      createResolver: () => missingResolver(),
      now: () => 1000,
      randomId: () => "synthetic-id",
    });
    expect(received?.sport.id).toBe("cycling");
    expect(Object.keys(received!.ports).sort()).toEqual([
      "chatStore",
      "classifyFailure",
      "config",
      "extractRetryAfterMs",
      "getAccessToken",
      "logger",
      "memory",
      "modelTransportDecorator",
      "now",
      "onToolsAssembled",
      "platform",
      "randomId",
      "readReferenceState",
      "secrets",
      "stateReader",
      "usage",
    ]);
    expect(received?.ports.platform.legacyClient).toBeNull();
    expect(received?.ports.platform.athleteData).toBe(selectedRuntime.athleteData);
    expect(received?.ports.config).toEqual(engineConfigFromConfig(config(home)));
    await expect(lifecycle.spendMeter.getSpendSummary()).resolves.toMatchObject({
      timezone: "UTC",
      dailyCapUsd: 0.5,
    });
    await lifecycle.close();
  });

  it("binds one persisted source to both state paths while keeping tool and disclosure readers separate", async () => {
    const home = await freshHome();
    const selectedRuntime = runtime();
    let received: CreateCoachEngineInput | undefined;
    const lifecycle = await compose(home, {
      bootstrap: async () => reference(),
      createRuntime: () => selectedRuntime,
      createBackend: (input) => {
        received = input;
        return backend({ getAthleteState: () => input.ports.stateReader.getAthleteState() });
      },
      createRepository: () => ({
        insertIfAbsent: async () => false,
        readCurrent: async () => undefined,
      }),
      createResolver: () => missingResolver(),
    });
    await expect(received!.ports.stateReader.getAthleteState()).resolves.toEqual(state);
    await expect(lifecycle.engine.getAthleteState()).resolves.toEqual(state);
    expect(received!.ports.platform.athleteData).toBe(selectedRuntime.athleteData);
    expect(received!.ports.readReferenceState).not.toBe(
      received!.ports.stateReader.getAthleteState,
    );
    expect(received!.ports.readReferenceState().latest?.metadata?.last_updated).toBe(
      state.lastUpdated,
    );
    await lifecycle.close();
  });

  it("awaits cold start before scheduling and exposes no engine after cold-start failure", async () => {
    const home = await freshHome();
    await rm(join(home.root, "data", "latest.json"));
    const failure = { kind: "cold-start" };
    const trace: string[] = [];
    const createBackend = vi.fn<(input: CreateCoachEngineInput) => CoachEngine>(() => backend());
    await expect(
      compose(home, {
        bootstrap: async () => reference(trace),
        createRuntime: () =>
          runtime(trace, {
            runWindow: async () => {
              trace.push("run-window");
              throw failure;
            },
          }),
        createBackend,
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      }),
    ).rejects.toBe(failure);
    expect(createBackend).not.toHaveBeenCalled();
    expect(trace).toEqual(["run-window", "reference-stop", "runtime-close"]);
  });

  it("backs all four methods with a real writer store, repository, resolver, and persisted render", async () => {
    const home = await freshHome();
    await mkdir(home.storeDir, { recursive: true });
    const store = openSqliteStorage(join(home.storeDir, "store.db"));
    stores.push(store);
    await runMigrations(store, MIGRATIONS);
    await store.run(
      "INSERT INTO anchor_history (id, sport, anchor_type, value, unit, valid_from, source, confidence, note, provenance, device_id, hlc_physical_ms, hlc_counter) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        "anchor-1",
        "cycling",
        "ftp",
        275,
        "W",
        1_752_796_000,
        "synthetic",
        "manual",
        null,
        "manual",
        null,
        null,
        null,
      ],
    );
    let chatRequest: Parameters<CoachEngine["chat"]>[0] | undefined;
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend: (input) =>
          backend({
            chat: async (request) => {
              chatRequest = request;
              return { text: "anchored" };
            },
            getAthleteState: () => input.ports.stateReader.getAthleteState(),
            hasSession: async () => ({ hasSession: true }),
            resetSession: async () => ({ memoryFlushed: true }),
          }),
        now: () => 1_752_796_800_000,
      },
      { home, store, listener: inertWriterProtocolListener },
    );
    await expect(lifecycle.engine.chat({ chatId: "x", message: "status" })).resolves.toEqual({
      text: "anchored",
    });
    expect(chatRequest?.turn?.resolvedCs).toMatchObject({ kind: "ftp", watts: 275 });
    await expect(lifecycle.engine.hasSession({ chatId: "x" })).resolves.toEqual({
      hasSession: true,
    });
    await expect(lifecycle.engine.resetSession({ chatId: "x" })).resolves.toEqual({
      memoryFlushed: true,
    });
    await expect(lifecycle.engine.getAthleteState()).resolves.toMatchObject({
      currentStatus: state.currentStatus,
      derivedMetrics: state.derivedMetrics,
      plannedWorkouts: state.plannedWorkouts,
      degraded: true,
    });
    await lifecycle.close();
  });

  it("uses the extracted engine FIFO per chat id while allowing different ids to overlap", async () => {
    const home = await freshHome();
    let generateCalls = 0;
    let releaseFirst!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const decorator: ModelTransportDecorator = () => ({
      generate: async () => {
        generateCalls += 1;
        if (generateCalls === 1) {
          markEntered();
          await firstGate;
        }
        return generation(`reply-${generateCalls}`);
      },
    });
    const lifecycle = await compose(home, {
      bootstrap: async () => reference(),
      createRuntime: () => runtime(),
      createRepository: () => ({
        insertIfAbsent: async () => false,
        readCurrent: async () => undefined,
      }),
      createResolver: () => missingResolver(),
      modelTransportDecorator: decorator,
    });
    const completion: string[] = [];
    const first = lifecycle.engine.chat({ chatId: "same", message: "first" }).then((value) => {
      completion.push("first");
      return value;
    });
    await entered;
    const second = lifecycle.engine.chat({ chatId: "same", message: "second" }).then((value) => {
      completion.push("second");
      return value;
    });
    await Promise.resolve();
    expect(generateCalls).toBe(1);
    const other = lifecycle.engine.chat({ chatId: "other", message: "other" }).then((value) => {
      completion.push("other");
      return value;
    });
    while (generateCalls < 2) await Promise.resolve();
    expect(generateCalls).toBe(2);
    releaseFirst();
    await Promise.all([first, second, other]);
    expect(completion.indexOf("first")).toBeLessThan(completion.indexOf("second"));
    await lifecycle.close();
  });

  it("atomically supersedes the in-memory runtime overlay for later turns and store windows", async () => {
    const home = await freshHome();
    const received: CreateCoachEngineInput[] = [];
    let runtimeOptions:
      | Parameters<NonNullable<LocalCoachCompositionDependencies["createRuntime"]>>[0]
      | undefined;
    const lifecycle = await compose(home, {
      bootstrap: async () => reference(),
      createRuntime: (options) => {
        runtimeOptions = options;
        return runtime();
      },
      createBackend: (input) => {
        received.push(input);
        const selected = `${input.ports.config.llm.provider}:${input.ports.config.llm.model}`;
        return backend({ chat: async () => ({ text: selected }) });
      },
      createRepository: () => ({
        insertIfAbsent: async () => false,
        readCurrent: async () => undefined,
      }),
      createResolver: () => missingResolver(),
    });

    await expect(lifecycle.engine.chat({ chatId: "runtime", message: "initial" })).resolves.toEqual(
      {
        text: "anthropic:synthetic",
      },
    );
    await lifecycle.operations.configureRuntime({
      llm: { provider: "openrouter", model: "model-first", api_key: "placeholder" },
    });
    await expect(
      lifecycle.engine.chat({ chatId: "runtime", message: "after-first" }),
    ).resolves.toEqual({
      text: "openrouter:model-first",
    });
    await lifecycle.operations.configureRuntime({
      intervals: { api_key: "placeholder", athlete_id: "athlete-a" },
    });
    await lifecycle.operations.configureRuntime({
      llm: { provider: "google", model: "model-second", api_key: "placeholder" },
      intervals: { api_key: "placeholder", athlete_id: "athlete-b" },
    });
    await expect(
      lifecycle.engine.chat({ chatId: "runtime", message: "after-second" }),
    ).resolves.toEqual({
      text: "google:model-second",
    });

    expect(
      received.map((input) => ({
        provider: input.ports.config.llm.provider,
        model: input.ports.config.llm.model,
        apiKey: input.ports.config.llm.apiKey,
        intervals: input.ports.platform.legacyClient === null,
      })),
    ).toEqual([
      { provider: "anthropic", model: "synthetic", apiKey: "", intervals: true },
      { provider: "openrouter", model: "model-first", apiKey: "placeholder", intervals: true },
      { provider: "openrouter", model: "model-first", apiKey: "placeholder", intervals: false },
      { provider: "google", model: "model-second", apiKey: "placeholder", intervals: false },
    ]);
    expect(runtimeOptions?.readConfig?.().intervals).toEqual({
      apiKey: "placeholder",
      athleteId: "athlete-b",
    });
    await lifecycle.close();
  });

  it("passes the live intervals authority and one deterministic UTC history date into sync", async () => {
    const home = await freshHome();
    const context = fakeContext(home);
    const selectedRuntime = runtime();
    const backfill = vi.fn(async () => ({ pages: 1, artifacts: 0, reports: [] }));
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => selectedRuntime,
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
        now: () => Date.parse("1998-07-18T23:59:59.000Z"),
        operationsDependencies: { backfill },
      },
      context,
      { apiKey: String.fromCharCode(111, 108, 100), athleteId: "stale-athlete" },
    );
    await lifecycle.operations.configureRuntime({
      intervals: { api_key: String.fromCharCode(110, 101, 119), athlete_id: "live-athlete" },
    });
    await expect(lifecycle.operations.sync({})).resolves.toMatchObject({
      published: true,
      referenceSucceeded: true,
    });
    expect(backfill).toHaveBeenCalledTimes(1);
    expect(backfill).toHaveBeenCalledWith({
      home,
      store: context.store,
      apiKey: String.fromCharCode(110, 101, 119),
      athleteId: "live-athlete",
      historyNewestDate: "1998-07-18",
      signal: expect.any(AbortSignal),
    });
    expect(backfill).not.toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: String.fromCharCode(111, 108, 100) }),
    );
    expect(JSON.stringify(backfill.mock.calls)).not.toContain("stale-athlete");
    await lifecycle.close();
  });

  it("closes host adapters, reference scheduling, and an active store runtime once in order", async () => {
    const home = await freshHome();
    const trace: string[] = [];
    const hostFailure = { kind: "host-close" };
    let releaseClose!: () => void;
    let markCloseStarted!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const closeStarted = new Promise<void>((resolve) => {
      markCloseStarted = resolve;
    });
    let runtimeCloseCalls = 0;
    const lifecycle = await compose(home, {
      bootstrap: async () => reference(trace),
      createRuntime: () =>
        runtime(trace, {
          close: async () => {
            runtimeCloseCalls += 1;
            trace.push("runtime-close-start");
            markCloseStarted();
            await closeGate;
            trace.push("runtime-close-end");
          },
        }),
      createBackend: () => backend(),
      createRepository: () => ({
        insertIfAbsent: async () => false,
        readCurrent: async () => undefined,
      }),
      createResolver: () => missingResolver(),
      closeHostAdapters: async () => {
        trace.push("host-close");
        throw hostFailure;
      },
    });
    const first = lifecycle.close();
    const second = lifecycle.close();
    await closeStarted;
    expect(trace.slice(-3)).toEqual(["host-close", "reference-stop", "runtime-close-start"]);
    releaseClose();
    await expect(first).rejects.toBe(hostFailure);
    await expect(second).rejects.toBe(hostFailure);
    expect(runtimeCloseCalls).toBe(1);
    expect(trace.at(-1)).toBe("runtime-close-end");
  });
});
