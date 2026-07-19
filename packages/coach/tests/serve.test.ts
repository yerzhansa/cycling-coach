import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  EXIT_SUCCESS,
  type AthleteState,
  type CoachEngine,
  type CoachOperations,
  type SpendSummary,
} from "@enduragent/coach-contract";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import type {
  WriterProtocolBinding,
  WriterProtocolHandlers,
  WriterProtocolListener,
} from "@enduragent/kernel-node/lock";
import { runCoachServe, type CoachServeDependencies } from "../src/serve.js";
import type { LocalCoachLifecycle } from "../src/local-runner.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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
};

const spendSummary = {
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
} satisfies SpendSummary;

const home: AthleteHome = {
  root: "/synthetic/athlete",
  storeDir: "/synthetic/athlete/store",
  archiveDir: "/synthetic/athlete/archive",
  configDir: "/synthetic/athlete/config",
};

function harness(
  options: {
    readonly token?: Promise<{ readonly path: string; readonly value: string }>;
    readonly bind?: Promise<WriterProtocolBinding>;
    readonly shutdownRequested?: Promise<void>;
    readonly onCreateRpc?: () => void;
  } = {},
) {
  const trace: string[] = [];
  let handlers: WriterProtocolHandlers | undefined;
  const binding: WriterProtocolBinding = {
    port: 42_001,
    async close() {
      trace.push("protocol-stop");
      await Promise.resolve();
      trace.push("protocol-closed");
    },
  };
  const listener: WriterProtocolListener = {
    async bind(value) {
      trace.push("protocol-bind");
      handlers = value;
      return options.bind ?? binding;
    },
  };
  const lifecycle: LocalCoachLifecycle = {
    engine,
    operations,
    spendMeter: {
      getSpendSummary: vi.fn(async () => spendSummary),
      setDailySpendCap: vi.fn(async () => spendSummary),
    },
    listener,
    async close() {
      trace.push("lifecycle-close");
    },
  };
  const ensureToken = vi.fn(async () => {
    trace.push("token-ready");
    return options.token ?? { path: `${home.configDir}/daemon.token`, value: "x".repeat(43) };
  });
  const rpcClose = vi.fn(async () => {
    trace.push("rpc-drained");
  });
  const createRpcServer = vi.fn(() => {
    trace.push("rpc-created");
    options.onCreateRpc?.();
    return {
      handleUpgrade: vi.fn(),
      shutdownRequested: options.shutdownRequested ?? new Promise<void>(() => {}),
      close: rpcClose,
    };
  });
  const createHealthzHandler = vi.fn(() => {
    trace.push("health-handler-created");
    return vi.fn() as unknown as (request: IncomingMessage, response: ServerResponse) => void;
  });
  const dependencies = {
    ensureToken,
    createRpcServer,
    createHealthzHandler,
    createHealthState: () => ({ healthy: true, setHealthy: vi.fn() }),
  } as unknown as CoachServeDependencies;
  return {
    input: { lifecycle, home, appVersion: "0.1.0", signal: new AbortController().signal },
    lifecycle,
    dependencies,
    binding,
    trace,
    handlers: () => handlers,
    ensureToken,
    createRpcServer,
    createHealthzHandler,
    rpcClose,
  };
}

describe("runCoachServe", () => {
  it("does no private setup for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("synthetic secret reason"));
    const test = harness();
    await expect(
      runCoachServe({ ...test.input, signal: controller.signal }, test.dependencies),
    ).resolves.toBe(EXIT_SUCCESS);
    expect(test.ensureToken).not.toHaveBeenCalled();
    expect(test.createRpcServer).not.toHaveBeenCalled();
    expect(test.trace).toEqual([]);
  });

  it("publishes the handler pair only at bind and drains protocol before RPC completion", async () => {
    const controller = new AbortController();
    const test = harness();
    const result = runCoachServe({ ...test.input, signal: controller.signal }, test.dependencies);
    await vi.waitFor(() => expect(test.handlers()).toBeDefined());
    expect(test.trace).toEqual([
      "token-ready",
      "rpc-created",
      "health-handler-created",
      "protocol-bind",
    ]);
    expect(test.handlers()?.upgrade).toBe(
      test.createRpcServer.mock.results[0]?.value.handleUpgrade,
    );
    expect(test.createRpcServer).toHaveBeenCalledWith(
      expect.objectContaining({
        selfTestOperations: { selfTest: expect.any(Function) },
      }),
    );
    controller.abort();
    await expect(result).resolves.toBe(EXIT_SUCCESS);
    expect(test.trace).toEqual([
      "token-ready",
      "rpc-created",
      "health-handler-created",
      "protocol-bind",
      "protocol-stop",
      "rpc-drained",
      "protocol-closed",
    ]);
  });

  it("stops before RPC construction when abort arrives during token setup", async () => {
    const controller = new AbortController();
    const token = deferred<{ path: string; value: string }>();
    const test = harness({ token: token.promise });
    const result = runCoachServe({ ...test.input, signal: controller.signal }, test.dependencies);
    await vi.waitFor(() => expect(test.ensureToken).toHaveBeenCalledTimes(1));
    controller.abort();
    token.resolve({ path: `${home.configDir}/daemon.token`, value: "x".repeat(43) });
    await expect(result).resolves.toBe(EXIT_SUCCESS);
    expect(test.createRpcServer).not.toHaveBeenCalled();
    expect(test.createHealthzHandler).not.toHaveBeenCalled();
  });

  it("closes RPC without binding when abort arrives immediately before bind", async () => {
    const controller = new AbortController();
    const test = harness({ onCreateRpc: () => controller.abort() });
    await expect(
      runCoachServe({ ...test.input, signal: controller.signal }, test.dependencies),
    ).resolves.toBe(EXIT_SUCCESS);
    expect(test.rpcClose).toHaveBeenCalledTimes(1);
    expect(test.createHealthzHandler).not.toHaveBeenCalled();
    expect(test.trace).toEqual(["token-ready", "rpc-created", "rpc-drained"]);
  });

  it("awaits an asynchronous bind raced by abort before complete shutdown", async () => {
    const controller = new AbortController();
    const bind = deferred<WriterProtocolBinding>();
    const test = harness({ bind: bind.promise });
    const result = runCoachServe({ ...test.input, signal: controller.signal }, test.dependencies);
    await vi.waitFor(() => expect(test.createHealthzHandler).toHaveBeenCalledTimes(1));
    controller.abort();
    expect(test.rpcClose).not.toHaveBeenCalled();
    bind.resolve(test.binding);
    await expect(result).resolves.toBe(EXIT_SUCCESS);
    expect(test.rpcClose).toHaveBeenCalledTimes(1);
  });

  it("returns from the local operation only after the upgrade response flush signal", async () => {
    const shutdown = deferred<void>();
    const test = harness({ shutdownRequested: shutdown.promise });
    const result = runCoachServe(test.input, test.dependencies);
    await vi.waitFor(() => expect(test.handlers()).toBeDefined());
    shutdown.resolve();
    await expect(result).resolves.toBe(EXIT_SUCCESS);
    expect(test.trace.slice(-3)).toEqual(["protocol-stop", "rpc-drained", "protocol-closed"]);
  });

  it("rethrows bind failure only after closing the constructed RPC server", async () => {
    const failure = new Error("bind failed");
    const bind = deferred<WriterProtocolBinding>();
    bind.reject(failure);
    const test = harness({ bind: bind.promise });
    await expect(runCoachServe(test.input, test.dependencies)).rejects.toBe(failure);
    expect(test.trace).toEqual([
      "token-ready",
      "rpc-created",
      "health-handler-created",
      "protocol-bind",
      "rpc-drained",
    ]);
  });
});
