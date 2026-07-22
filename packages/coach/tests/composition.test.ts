import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import type { AthleteState, CoachEngine } from "@enduragent/coach-contract";
import {
  RefreshTokenReusedError,
  engineConfigFromConfig,
  loadConfig,
  saveStoredProfile,
  type Config,
} from "@enduragent/core";
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
import { checkHomeReadiness } from "../src/readiness.js";
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
  configOverride?: Config,
) {
  const coreConfig = configOverride ?? config(home, intervals);
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

function codexAccessToken(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `${header}.${payload}.synthetic-signature`;
}

function tokenResponse(access: string, refresh = "synthetic-rotated-refresh"): Response {
  return new Response(
    JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: 3600 }),
    { status: 200 },
  );
}

async function writeExpiredOAuthProfile(home: AthleteHome): Promise<void> {
  await writeFile(
    join(home.configDir, "auth-profiles.json"),
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: "synthetic-expired-access",
        refresh: "synthetic-refresh",
        expires: 0,
        accountId: "synthetic-account",
      },
    }),
    { mode: 0o600 },
  );
}

async function composeWithCapturedEngineInput(home: AthleteHome, now = 1_000) {
  let engineInput: CreateCoachEngineInput | undefined;
  const lifecycle = await compose(home, {
    bootstrap: async () => reference(),
    createRuntime: () => runtime(),
    createBackend: (input) => {
      engineInput = input;
      return backend();
    },
    createRepository: () => ({
      insertIfAbsent: async () => false,
      readCurrent: async () => undefined,
    }),
    createResolver: () => missingResolver(),
    now: () => now,
  });
  if (engineInput === undefined) throw new Error("Expected a captured engine input.");
  return { engineInput, lifecycle };
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
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

  it("carries an explicit refresh rejection through the composed desktop ports", async () => {
    const home = await freshHome();
    await writeExpiredOAuthProfile(home);
    const fetchStub = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })),
      );
    let received: CreateCoachEngineInput | undefined;
    const lifecycle = await compose(home, {
      bootstrap: async () => reference(),
      createRuntime: () => runtime(),
      createBackend: (input) => {
        received = input;
        return backend();
      },
      createRepository: () => ({
        insertIfAbsent: async () => false,
        readCurrent: async () => undefined,
      }),
      createResolver: () => missingResolver(),
      now: () => 1_000,
    });

    vi.useFakeTimers();
    const settled = received!.ports.getAccessToken("openai-codex").then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    const failure = await settled;

    expect(failure).toBeInstanceOf(RefreshTokenReusedError);
    expect(failure).toMatchObject({ refreshFailureReason: "reauth" });
    expect(received!.ports.classifyFailure(failure)).toBe("reauth");
    expect(fetchStub).toHaveBeenCalledTimes(2);
    await lifecycle.close();
  });

  it("carries a server refresh failure through the composed desktop ports", async () => {
    const home = await freshHome();
    await writeExpiredOAuthProfile(home);
    const fetchStub = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 503 }));
    let received: CreateCoachEngineInput | undefined;
    const lifecycle = await compose(home, {
      bootstrap: async () => reference(),
      createRuntime: () => runtime(),
      createBackend: (input) => {
        received = input;
        return backend();
      },
      createRepository: () => ({
        insertIfAbsent: async () => false,
        readCurrent: async () => undefined,
      }),
      createResolver: () => missingResolver(),
      now: () => 1_000,
    });

    const failure = await received!.ports.getAccessToken("openai-codex").catch((error) => error);

    expect(received!.ports.classifyFailure(failure)).toBe("server_error");
    expect(failure).toMatchObject({ refreshFailureReason: "server_error" });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    await lifecycle.close();
  });

  it("refreshes once while preserving queued readers, metadata, and a concurrent profile", async () => {
    const home = await freshHome();
    const profilesPath = join(home.configDir, "auth-profiles.json");
    await writeFile(
      profilesPath,
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "synthetic-expired-access",
          refresh: "synthetic-refresh",
          expires: 0,
          accountId: "synthetic-old-account",
          email: "synthetic@example.test",
          future: { nested: { generation: 1, retained: true } },
        },
        unrelated: { kind: "future-provider", retained: true },
      }),
      { mode: 0o600 },
    );
    const refreshedAccess = codexAccessToken("synthetic-new-account");
    const fetchStub = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      saveStoredProfile(profilesPath, "concurrent-provider", {
        kind: "concurrent-login",
        retained: true,
      });
      return tokenResponse(refreshedAccess);
    });
    const { engineInput, lifecycle } = await composeWithCapturedEngineInput(home);

    await expect(
      Promise.all([
        engineInput.ports.getAccessToken("openai-codex"),
        engineInput.ports.getAccessToken("openai-codex"),
      ]),
    ).resolves.toEqual([refreshedAccess, refreshedAccess]);

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(profilesPath, "utf8"))).toMatchObject({
      "openai-codex": {
        type: "oauth",
        access: refreshedAccess,
        refresh: "synthetic-rotated-refresh",
        accountId: "synthetic-new-account",
        email: "synthetic@example.test",
        future: { nested: { generation: 1, retained: true } },
      },
      unrelated: { kind: "future-provider", retained: true },
      "concurrent-provider": { kind: "concurrent-login", retained: true },
    });
    await lifecycle.close();
  });

  it("retries a first reauthentication rejection with the current shared refresh token", async () => {
    const home = await freshHome();
    await writeExpiredOAuthProfile(home);
    const profilesPath = join(home.configDir, "auth-profiles.json");
    const refreshedAccess = codexAccessToken("synthetic-confirmed-account");
    const requestBodies: string[] = [];
    const fetchStub = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requestBodies.push(String(init?.body));
      if (requestBodies.length === 1) {
        saveStoredProfile(profilesPath, "openai-codex", {
          type: "oauth",
          access: "synthetic-shared-access",
          refresh: "synthetic-shared-refresh",
          expires: 0,
          accountId: "synthetic-shared-account",
          future: { source: "concurrent-login" },
        });
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      return tokenResponse(refreshedAccess, "synthetic-confirmed-refresh");
    });
    const { engineInput, lifecycle } = await composeWithCapturedEngineInput(home);

    vi.useFakeTimers();
    const pending = engineInput.ports.getAccessToken("openai-codex");
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toBe(refreshedAccess);

    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(requestBodies[0]).toContain("refresh_token=synthetic-refresh");
    expect(requestBodies[1]).toContain("refresh_token=synthetic-shared-refresh");
    expect(JSON.parse(await readFile(profilesPath, "utf8"))["openai-codex"]).toMatchObject({
      access: refreshedAccess,
      refresh: "synthetic-confirmed-refresh",
      future: { source: "concurrent-login" },
    });
    await lifecycle.close();
  });

  it("does not retry or resurrect a profile deleted before reauthentication confirmation", async () => {
    const home = await freshHome();
    await writeExpiredOAuthProfile(home);
    const profilesPath = join(home.configDir, "auth-profiles.json");
    const fetchStub = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      unlinkSync(profilesPath);
      return Promise.resolve(
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
      );
    });
    const { engineInput, lifecycle } = await composeWithCapturedEngineInput(home);

    vi.useFakeTimers();
    const settled = engineInput.ports.getAccessToken("openai-codex").then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(settled).resolves.toMatchObject({ message: "OAuth profile is invalid." });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    await expect(readFile(profilesPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await lifecycle.close();
  });

  it("does not resurrect a profile deleted during the confirmation request", async () => {
    const home = await freshHome();
    await writeExpiredOAuthProfile(home);
    const profilesPath = join(home.configDir, "auth-profiles.json");
    const fetchStub = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
      )
      .mockImplementationOnce(() => {
        unlinkSync(profilesPath);
        return Promise.resolve(tokenResponse(codexAccessToken("synthetic-stale-confirmation")));
      });
    const { engineInput, lifecycle } = await composeWithCapturedEngineInput(home);

    vi.useFakeTimers();
    const settled = engineInput.ports.getAccessToken("openai-codex").then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(settled).resolves.toMatchObject({ message: "OAuth profile is invalid." });

    expect(fetchStub).toHaveBeenCalledTimes(2);
    await expect(readFile(profilesPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await lifecycle.close();
  });

  it("aborts the reauthentication delay without a second request or commit", async () => {
    const home = await freshHome();
    await writeExpiredOAuthProfile(home);
    const profilesPath = join(home.configDir, "auth-profiles.json");
    const originalBytes = await readFile(profilesPath, "utf8");
    const fetchStub = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    const { engineInput, lifecycle } = await composeWithCapturedEngineInput(home);
    const controller = new AbortController();
    const abortReason = new Error("synthetic caller abort");

    vi.useFakeTimers();
    const settled = engineInput.ports.getAccessToken("openai-codex", controller.signal).then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    controller.abort(abortReason);

    await expect(settled).resolves.toBe(abortReason);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(await readFile(profilesPath, "utf8")).toBe(originalBytes);
    expect(vi.getTimerCount()).toBe(0);
    await lifecycle.close();
  });

  it("commits a successful token rotation despite a late abort", async () => {
    const home = await freshHome();
    await writeExpiredOAuthProfile(home);
    const profilesPath = join(home.configDir, "auth-profiles.json");
    const controller = new AbortController();
    const abortReason = new DOMException("Cancelled after endpoint success", "AbortError");
    const refreshedAccess = codexAccessToken("synthetic-late-abort-account");
    const response = tokenResponse(refreshedAccess, "synthetic-late-abort-refresh");
    const decodeResponse = response.json.bind(response);
    vi.spyOn(response, "json").mockImplementation(async () => {
      const body = await decodeResponse();
      controller.abort(abortReason);
      return body;
    });
    const fetchStub = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const { engineInput, lifecycle } = await composeWithCapturedEngineInput(home);

    await expect(engineInput.ports.getAccessToken("openai-codex", controller.signal)).resolves.toBe(
      refreshedAccess,
    );

    expect(controller.signal.reason).toBe(abortReason);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(profilesPath, "utf8"))["openai-codex"]).toMatchObject({
      access: refreshedAccess,
      refresh: "synthetic-late-abort-refresh",
      accountId: "synthetic-late-abort-account",
    });
    await lifecycle.close();
  });

  it("returns a concurrently replaced profile instead of overwriting the newer login", async () => {
    const home = await freshHome();
    await writeExpiredOAuthProfile(home);
    const profilesPath = join(home.configDir, "auth-profiles.json");
    const fetchStub = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      saveStoredProfile(profilesPath, "openai-codex", {
        type: "oauth",
        access: "synthetic-concurrent-access",
        refresh: "synthetic-concurrent-refresh",
        expires: 4_102_444_800_000,
        accountId: "synthetic-concurrent-account",
        email: "concurrent@example.test",
      });
      return tokenResponse(codexAccessToken("synthetic-stale-account"));
    });
    const { engineInput, lifecycle } = await composeWithCapturedEngineInput(home);

    await expect(engineInput.ports.getAccessToken("openai-codex")).resolves.toBe(
      "synthetic-concurrent-access",
    );

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(profilesPath, "utf8"))["openai-codex"]).toEqual({
      type: "oauth",
      access: "synthetic-concurrent-access",
      refresh: "synthetic-concurrent-refresh",
      expires: 4_102_444_800_000,
      accountId: "synthetic-concurrent-account",
      email: "concurrent@example.test",
    });
    await lifecycle.close();
  });

  it("rejects without resurrecting a profile deleted during refresh", async () => {
    const home = await freshHome();
    await writeExpiredOAuthProfile(home);
    const profilesPath = join(home.configDir, "auth-profiles.json");
    const fetchStub = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await rm(profilesPath);
      return tokenResponse(codexAccessToken("synthetic-stale-account"));
    });
    const { engineInput, lifecycle } = await composeWithCapturedEngineInput(home);

    await expect(engineInput.ports.getAccessToken("openai-codex")).rejects.toThrow(
      "OAuth profile is invalid.",
    );

    expect(fetchStub).toHaveBeenCalledTimes(1);
    await expect(readFile(profilesPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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

  it("passes reference bootstrap a live intervals reader updated by runtime configuration", async () => {
    const home = await freshHome();
    let referenceOptions:
      | Parameters<NonNullable<LocalCoachCompositionDependencies["bootstrap"]>>[0]
      | undefined;
    const lifecycle = await compose(
      home,
      {
        bootstrap: async (options) => {
          referenceOptions = options;
          return reference();
        },
        createRuntime: () => runtime(),
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      { apiKey: "", athleteId: "fake-initial-athlete" },
    );

    await lifecycle.operations.configureRuntime({
      intervals: {
        api_key: "placeholder",
        athlete_id: "fake-configured-athlete",
      },
    });

    expect(referenceOptions?.readIntervals?.()).toEqual({
      apiKey: "placeholder",
      athleteId: "fake-configured-athlete",
    });
    await lifecycle.close();
  });

  it("persists a keyless Codex selection that reloads as ready with a valid profile", async () => {
    const home = await freshHome();
    await writeFile(
      join(home.configDir, "auth-profiles.json"),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "obviously-fake-access",
          refresh: "obviously-fake-refresh",
          expires: 4_102_444_800_000,
          accountId: "obviously-fake-account",
        },
      }),
      { mode: 0o600 },
    );
    const received: CreateCoachEngineInput[] = [];
    const lifecycle = await compose(home, {
      bootstrap: async () => reference(),
      createRuntime: () => runtime(),
      createBackend: (input) => {
        received.push(input);
        return backend();
      },
      createRepository: () => ({
        insertIfAbsent: async () => false,
        readCurrent: async () => undefined,
      }),
      createResolver: () => missingResolver(),
    });
    await lifecycle.operations.configureRuntime({
      llm: { provider: "openai-codex", model: "gpt-5.5" },
    });
    expect(received.at(-1)?.ports.config.llm).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.5",
      apiKey: "",
      authProfile: "openai-codex",
    });
    const persisted = await readFile(join(home.configDir, "config.yaml"), "utf8");
    expect(persisted).toContain("provider: openai-codex");
    expect(persisted).not.toContain("api_key");
    expect(loadConfig(home.configDir).llm).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.5",
      apiKey: "",
      authProfile: "openai-codex",
    });
    await expect(checkHomeReadiness(home)).resolves.toMatchObject({ status: "ready" });
    await lifecycle.close();
  });

  it("activates the default Codex profile for an explicit same-provider selection", async () => {
    const home = await freshHome();
    await writeFile(
      join(home.configDir, "auth-profiles.json"),
      JSON.stringify({
        "test-profile": {
          type: "oauth",
          access: "obviously-fake-custom-access",
          refresh: "obviously-fake-custom-refresh",
          expires: 4_102_444_800_000,
        },
        "openai-codex": {
          type: "oauth",
          access: "obviously-fake-default-access",
          refresh: "obviously-fake-default-refresh",
          expires: 4_102_444_800_000,
        },
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(home.configDir, "config.yaml"),
      toYaml({
        llm: {
          provider: "openai-codex",
          model: "custom-chat-model",
          auth_profile: "test-profile",
        },
      }),
      { mode: 0o600 },
    );
    const initial: Config = {
      ...config(home),
      llm: {
        provider: "openai-codex",
        model: "custom-chat-model",
        apiKey: "",
        authProfile: "test-profile",
        compactModel: "custom-chat-model",
      },
    };
    expect(loadConfig(home.configDir).llm).toMatchObject({
      provider: "openai-codex",
      model: "custom-chat-model",
      authProfile: "test-profile",
    });
    const received: CreateCoachEngineInput[] = [];
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend: (input) => {
          received.push(input);
          return backend();
        },
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      undefined,
      initial,
    );
    expect(received[0]?.ports.config.llm.authProfile).toBe("test-profile");
    await expect(received[0]?.ports.getAccessToken("test-profile")).resolves.toBe(
      "obviously-fake-custom-access",
    );

    await lifecycle.operations.configureRuntime({ llm: { provider: "openai-codex" } });

    expect(loadConfig(home.configDir).llm).toMatchObject({
      provider: "openai-codex",
      model: "custom-chat-model",
      authProfile: "openai-codex",
      compactModel: "custom-chat-model",
    });
    expect(received).toHaveLength(2);
    expect(received.at(-1)?.ports.config.llm.authProfile).toBe("openai-codex");
    await expect(received.at(-1)?.ports.getAccessToken("openai-codex")).resolves.toBe(
      "obviously-fake-default-access",
    );
    expect(parseYaml(await readFile(join(home.configDir, "config.yaml"), "utf8"))).toMatchObject({
      llm: { auth_profile: "openai-codex" },
    });
    const snapshot = await lifecycle.operations.getRuntimeConfig({});
    expect(snapshot.llm).toEqual({
      provider: "openai-codex",
      model: "custom-chat-model",
      credential_configured: true,
    });
    expect(JSON.stringify(snapshot)).not.toContain("test-profile");
    expect(JSON.stringify(snapshot)).not.toContain(home.configDir);
    expect(JSON.stringify(snapshot)).not.toContain("obviously-fake-default-access");
    await rm(join(home.configDir, "auth-profiles.json"));
    await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
      llm: { provider: "openai-codex", credential_configured: false },
    });
    await lifecycle.close();
  });

  it("preserves a custom Codex profile when a live LLM patch omits provider", async () => {
    const home = await freshHome();
    await writeFile(
      join(home.configDir, "auth-profiles.json"),
      JSON.stringify({
        "test-profile": {
          type: "oauth",
          access: "obviously-fake-custom-access",
          refresh: "obviously-fake-custom-refresh",
          expires: 4_102_444_800_000,
        },
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(home.configDir, "config.yaml"),
      toYaml({
        llm: {
          provider: "openai-codex",
          model: "custom-chat-model",
          auth_profile: "test-profile",
        },
      }),
      { mode: 0o600 },
    );
    const initial: Config = {
      ...config(home),
      llm: {
        provider: "openai-codex",
        model: "custom-chat-model",
        apiKey: "",
        authProfile: "test-profile",
        compactModel: "custom-chat-model",
      },
    };
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      undefined,
      initial,
    );

    await lifecycle.operations.configureRuntime({ llm: { model: "new-chat-model" } });

    expect(loadConfig(home.configDir).llm).toMatchObject({
      provider: "openai-codex",
      model: "new-chat-model",
      authProfile: "test-profile",
      compactModel: "new-chat-model",
    });
    const snapshot = await lifecycle.operations.getRuntimeConfig({});
    expect(snapshot.llm).toEqual({
      provider: "openai-codex",
      model: "new-chat-model",
      credential_configured: true,
    });
    expect(JSON.stringify(snapshot)).not.toContain("test-profile");
    await lifecycle.close();
  });

  it("preserves an implicit-provider YAML key across a model-only patch and reload", async () => {
    const home = await freshHome();
    await writeFile(
      join(home.configDir, "config.yaml"),
      toYaml({
        data_source: "store",
        data_dir: home.root,
        llm: {
          model: "old-model",
          api_key: "obviously-fake-implicit-provider-key",
          retained_llm_field: true,
        },
      }),
      { mode: 0o600 },
    );
    const initial = loadConfig(home.configDir);
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      undefined,
      initial,
    );

    await lifecycle.operations.configureRuntime({ llm: { model: "new-model" } });

    expect(parseYaml(await readFile(join(home.configDir, "config.yaml"), "utf8"))).toEqual({
      data_source: "store",
      data_dir: home.root,
      llm: {
        provider: "anthropic",
        model: "new-model",
        api_key: "obviously-fake-implicit-provider-key",
        compact_model: "claude-haiku-4-5-20251001",
        retained_llm_field: true,
      },
    });
    expect(loadConfig(home.configDir).llm).toMatchObject({
      provider: "anthropic",
      model: "new-model",
      apiKey: "obviously-fake-implicit-provider-key",
    });
    const snapshot = await lifecycle.operations.getRuntimeConfig({});
    expect(snapshot.llm).toMatchObject({
      provider: "anthropic",
      model: "new-model",
      credential_configured: true,
    });
    expect(JSON.stringify(snapshot)).not.toContain("obviously-fake-implicit-provider-key");
    await lifecycle.close();
  });

  it("starts and snapshots the Desktop seeded blank athlete ID", async () => {
    const home = await freshHome();
    const initial = config(home, { apiKey: "", athleteId: "" });
    let runtimeOptions:
      | Parameters<NonNullable<LocalCoachCompositionDependencies["createRuntime"]>>[0]
      | undefined;
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: (options) => {
          runtimeOptions = options;
          return runtime();
        },
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      undefined,
      initial,
    );

    await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
      llm: { credential_configured: false },
      intervals: { athlete_id: "" },
    });
    expect(() =>
      lifecycle.operations.configureRuntime({ intervals: { athlete_id: "" } } as never),
    ).toThrow("Too small");

    await lifecycle.operations.configureRuntime({
      intervals: { api_key: "obviously-fake-intervals-key" },
    });

    expect(runtimeOptions?.readConfig?.().intervals).toEqual({
      apiKey: "obviously-fake-intervals-key",
      athleteId: "0",
    });
    await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
      intervals: { athlete_id: "0" },
    });
    expect(parseYaml(await readFile(join(home.configDir, "config.yaml"), "utf8"))).toMatchObject({
      intervals: { athlete_id: "0" },
    });
    expect(loadConfig(home.configDir).intervals.athleteId).toBe("0");
    await lifecycle.close();
  });

  it.each([
    ["ordinary custom endpoint", "https://api.example.invalid/tenant/opaque-access-segment/v1"],
    ["path-bearing opaque value", "opaque-endpoint/tenant/opaque-access-segment/v1"],
  ])("omits a configured %s from runtime snapshots", async (_case, baseUrl) => {
    const home = await freshHome();
    const initial: Config = {
      ...config(home),
      llm: {
        provider: "anthropic",
        model: "synthetic",
        apiKey: "",
        baseUrl,
      },
    };
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      undefined,
      initial,
    );

    const snapshot = await lifecycle.operations.getRuntimeConfig({});
    expect(snapshot.llm).toEqual({
      provider: "anthropic",
      model: "synthetic",
      credential_configured: false,
    });
    expect(JSON.stringify(snapshot)).not.toContain(baseUrl);
    await lifecycle.close();
  });

  it.each([
    ["newline", "https://api.example.invalid/v1\nobviously-fake-marker"],
    ["tab", "https://api.example.invalid/v1\tobviously-fake-marker"],
    ["leading whitespace", " https://api.example.invalid/obviously-fake-marker"],
    ["trailing whitespace", "https://api.example.invalid/obviously-fake-marker "],
    ["empty query", "https://api.example.invalid/obviously-fake-marker?"],
    ["empty fragment", "https://api.example.invalid/obviously-fake-marker#"],
    ["backslashes", "https:\\api.example.invalid\\obviously-fake-marker"],
    ["host case normalization", "https://API.EXAMPLE.INVALID/obviously-fake-marker"],
    ["default port normalization", "https://api.example.invalid:443/obviously-fake-marker"],
    ["userinfo", "https://obviously-fake-marker:synthetic-pass@api.example.invalid/v1"],
    ["query", "https://api.example.invalid/v1?signature=obviously-fake-marker"],
    ["fragment", "https://api.example.invalid/v1#obviously-fake-marker"],
    ["non-HTTP protocol", "ftp://api.example.invalid/obviously-fake-marker"],
    ["invalid", "not-a-url-obviously-fake-marker"],
  ])("omits a legacy %s base URL from runtime snapshots", async (_case, baseUrl) => {
    const home = await freshHome();
    const initial: Config = {
      ...config(home),
      llm: { provider: "anthropic", model: "synthetic", apiKey: "", baseUrl },
    };
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend: () => backend(),
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      undefined,
      initial,
    );

    const snapshot = await lifecycle.operations.getRuntimeConfig({});
    expect(snapshot.llm).toEqual({
      provider: "anthropic",
      model: "synthetic",
      credential_configured: false,
    });
    expect(JSON.stringify(snapshot)).not.toContain("obviously-fake-marker");
    await lifecycle.close();
  });

  it("preserves custom same-provider settings and the athlete ID for credential-only patches", async () => {
    const home = await freshHome();
    await writeFile(
      join(home.configDir, "config.yaml"),
      toYaml({
        retained_top_level: true,
        llm: {
          provider: "openrouter",
          model: "previous-model",
          auth_profile: "openai-codex",
          api_key: "obviously-fake-persisted-llm-key",
          base_url: "https://invalid.example.test/v1",
          flush_model: "previous-flush-model",
          compact_model: "previous-compact-model",
          retained_llm_field: true,
        },
        intervals: {
          athlete_id: "previous-athlete",
          api_key: "obviously-fake-persisted-intervals-key",
          retained_intervals_field: true,
        },
      }),
      { mode: 0o600 },
    );
    const received: CreateCoachEngineInput[] = [];
    const initial: Config = {
      ...config(home),
      llm: {
        provider: "openrouter",
        model: "previous-model",
        apiKey: "obviously-fake-active-llm-key",
        baseUrl: "https://invalid.example.test/v1",
        flushModel: "previous-flush-model",
        compactModel: "previous-compact-model",
      },
      intervals: {
        apiKey: "obviously-fake-active-intervals-key",
        athleteId: "previous-athlete",
      },
      contextWindowTokens: 200_000,
    };
    let runtimeOptions:
      | Parameters<NonNullable<LocalCoachCompositionDependencies["createRuntime"]>>[0]
      | undefined;
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: (options) => {
          runtimeOptions = options;
          return runtime();
        },
        createBackend: (input) => {
          received.push(input);
          return backend();
        },
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      undefined,
      initial,
    );
    await lifecycle.operations.configureRuntime({
      llm: {
        provider: "openrouter",
        api_key: "obviously-fake-request-llm-key",
      },
      intervals: {
        api_key: "obviously-fake-request-intervals-key",
      },
    });
    const persisted = parseYaml(
      await readFile(join(home.configDir, "config.yaml"), "utf8"),
    ) as Record<string, unknown>;
    expect(persisted).toEqual({
      retained_top_level: true,
      llm: {
        provider: "openrouter",
        model: "previous-model",
        api_key: "obviously-fake-persisted-llm-key",
        base_url: "https://invalid.example.test/v1",
        flush_model: "previous-flush-model",
        compact_model: "previous-compact-model",
        retained_llm_field: true,
      },
      intervals: {
        athlete_id: "previous-athlete",
        api_key: "obviously-fake-persisted-intervals-key",
        retained_intervals_field: true,
      },
    });
    expect(JSON.stringify(persisted)).not.toContain("obviously-fake-request");
    expect(loadConfig(home.configDir)).toMatchObject({
      llm: {
        provider: "openrouter",
        model: "previous-model",
        apiKey: "obviously-fake-persisted-llm-key",
        baseUrl: "https://invalid.example.test/v1",
        flushModel: "previous-flush-model",
        compactModel: "previous-compact-model",
      },
      intervals: {
        athleteId: "previous-athlete",
        apiKey: "obviously-fake-persisted-intervals-key",
      },
    });
    expect(received.at(-1)?.ports.config.llm).toMatchObject({
      provider: "openrouter",
      model: "previous-model",
      apiKey: "obviously-fake-request-llm-key",
      baseUrl: "https://invalid.example.test/v1",
      flushModel: "previous-flush-model",
      compactModel: "previous-compact-model",
    });
    expect(runtimeOptions?.readConfig?.()).toMatchObject({
      llm: {
        provider: "openrouter",
        model: "previous-model",
        baseUrl: "https://invalid.example.test/v1",
        flushModel: "previous-flush-model",
        compactModel: "previous-compact-model",
      },
      intervals: { athleteId: "previous-athlete" },
    });
    await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toEqual({
      schemaVersion: 1,
      llm: {
        provider: "openrouter",
        model: "previous-model",
        credential_configured: true,
      },
      intervals: { athlete_id: "previous-athlete" },
      session: initial.session,
    });
    await lifecycle.close();
  });

  it("applies canonical defaults when switching from a one-million to a 200k context", async () => {
    const home = await freshHome();
    const received: CreateCoachEngineInput[] = [];
    const initial: Config = {
      ...config(home),
      llm: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        apiKey: "obviously-fake-anthropic-key",
        baseUrl: "https://invalid.example.test/old",
        flushModel: "old-flush-model",
        compactModel: "old-compact-model",
      },
      contextWindowTokens: 1_000_000,
    };
    const lifecycle = await compose(
      home,
      {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend: (input) => {
          received.push(input);
          return backend();
        },
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
      },
      fakeContext(home),
      undefined,
      initial,
    );

    await lifecycle.operations.configureRuntime({
      llm: { provider: "zai", api_key: "obviously-fake-zai-key" },
    });

    expect(received.at(-1)?.ports.config).toMatchObject({
      contextWindowTokens: 200_000,
      llm: {
        provider: "zai",
        model: "glm-4.7",
        apiKey: "obviously-fake-zai-key",
        baseUrl: "https://api.z.ai/api/openai/v1",
        flushModel: undefined,
        compactModel: "glm-4.7",
      },
    });
    expect(parseYaml(await readFile(join(home.configDir, "config.yaml"), "utf8"))).toEqual({
      llm: {
        provider: "zai",
        model: "glm-4.7",
        base_url: "https://api.z.ai/api/openai/v1",
        compact_model: "glm-4.7",
      },
    });
    await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
      llm: {
        provider: "zai",
        model: "glm-4.7",
      },
    });
    await lifecycle.close();
  });

  it("drops provider-scoped fields on switches and updates Codex auth profile ownership", async () => {
    const home = await freshHome();
    await writeFile(
      join(home.configDir, "config.yaml"),
      toYaml({
        retained_top_level: true,
        llm: {
          provider: "openai-codex",
          model: "previous-model",
          auth_profile: "openai-codex",
          api_key: "obviously-fake-stale-key",
          base_url: "https://invalid.example.test/v1",
          flush_model: "previous-flush-model",
          compact_model: "previous-compact-model",
          retained_llm_field: true,
        },
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(home.configDir, "auth-profiles.json"),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "obviously-fake-access",
          refresh: "obviously-fake-refresh",
          expires: 4_102_444_800_000,
        },
      }),
      { mode: 0o600 },
    );
    const lifecycle = await compose(home, {
      bootstrap: async () => reference(),
      createRuntime: () => runtime(),
      createBackend: () => backend(),
      createRepository: () => ({
        insertIfAbsent: async () => false,
        readCurrent: async () => undefined,
      }),
      createResolver: () => missingResolver(),
    });
    await lifecycle.operations.configureRuntime({
      llm: {
        provider: "google",
        model: "replacement-model",
        api_key: "obviously-fake-request-key",
      },
    });
    let persisted = parseYaml(
      await readFile(join(home.configDir, "config.yaml"), "utf8"),
    ) as Record<string, unknown>;
    expect(persisted).toEqual({
      retained_top_level: true,
      llm: {
        provider: "google",
        model: "replacement-model",
        compact_model: "replacement-model",
      },
    });
    expect(loadConfig(home.configDir).llm).toMatchObject({
      provider: "google",
      model: "replacement-model",
      apiKey: "",
      authProfile: undefined,
    });
    await lifecycle.operations.configureRuntime({
      llm: { provider: "openai-codex", model: "gpt-5.5" },
    });
    persisted = parseYaml(await readFile(join(home.configDir, "config.yaml"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(persisted).toEqual({
      retained_top_level: true,
      llm: {
        provider: "openai-codex",
        model: "gpt-5.5",
        auth_profile: "openai-codex",
        compact_model: "gpt-5.5",
      },
    });
    expect(loadConfig(home.configDir).llm).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.5",
      apiKey: "",
      authProfile: "openai-codex",
    });
    await lifecycle.close();
  });

  it("rejects a Codex runtime selection before replacement when its profile is invalid", async () => {
    const home = await freshHome();
    await writeFile(
      join(home.configDir, "auth-profiles.json"),
      JSON.stringify({ "openai-codex": { type: "oauth" } }),
      { mode: 0o600 },
    );
    const received: CreateCoachEngineInput[] = [];
    const lifecycle = await compose(home, {
      bootstrap: async () => reference(),
      createRuntime: () => runtime(),
      createBackend: (input) => {
        received.push(input);
        return backend();
      },
      createRepository: () => ({
        insertIfAbsent: async () => false,
        readCurrent: async () => undefined,
      }),
      createResolver: () => missingResolver(),
    });
    await expect(
      lifecycle.operations.configureRuntime({
        llm: { provider: "openai-codex", model: "gpt-5.5" },
      }),
    ).rejects.toThrow("OAuth profile is invalid.");
    expect(received).toHaveLength(1);
    await expect(readFile(join(home.configDir, "config.yaml"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await lifecycle.close();
  });

  it.each(["build", "persist"] as const)(
    "does not publish or overwrite YAML after a failed candidate %s",
    async (failurePoint) => {
      const home = await freshHome();
      const originalYaml = toYaml({
        retained_top_level: true,
        llm: { provider: "anthropic", model: "synthetic" },
      });
      await writeFile(join(home.configDir, "config.yaml"), originalYaml, { mode: 0o600 });
      let builds = 0;
      const lifecycle = await compose(home, {
        bootstrap: async () => reference(),
        createRuntime: () => runtime(),
        createBackend: (input) => {
          builds += 1;
          if (failurePoint === "build" && builds === 2) {
            throw new Error("synthetic candidate build failure");
          }
          return backend({
            chat: async () => ({ text: input.ports.config.llm.model }),
          });
        },
        createRepository: () => ({
          insertIfAbsent: async () => false,
          readCurrent: async () => undefined,
        }),
        createResolver: () => missingResolver(),
        ...(failurePoint === "persist"
          ? {
              persistRuntimeConfig: () => {
                throw new Error("synthetic persistence failure");
              },
            }
          : {}),
      });

      await expect(
        lifecycle.operations.configureRuntime({
          llm: { model: "candidate-model", api_key: "obviously-fake-candidate-key" },
        }),
      ).rejects.toThrow(
        failurePoint === "build"
          ? "synthetic candidate build failure"
          : "synthetic persistence failure",
      );
      await expect(
        lifecycle.engine.chat({ chatId: "atomic", message: "active model" }),
      ).resolves.toEqual({ text: "synthetic" });
      await expect(lifecycle.operations.getRuntimeConfig({})).resolves.toMatchObject({
        llm: { provider: "anthropic", model: "synthetic" },
      });
      expect(await readFile(join(home.configDir, "config.yaml"), "utf8")).toBe(originalYaml);
      await lifecycle.close();
    },
  );

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
