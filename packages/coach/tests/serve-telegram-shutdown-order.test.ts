import { describe, expect, it, vi } from "vitest";
import { EXIT_SUCCESS } from "@enduragent/coach-contract";
import {
  DaemonAdmissionClosedError,
  createInvocationCoordinator,
  type AdmissionFence,
  type InvocationCoordinator,
} from "../src/daemon/invocation-coordinator.js";
import type { CoachRpcServerInput } from "../src/daemon/rpc-server.js";
import type { LocalCoachLifecycle } from "../src/local-runner.js";
import { runCoachServe, type CoachServeDependencies } from "../src/serve.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function expectInOrder(trace: readonly string[], expected: readonly string[]): void {
  let cursor = -1;
  for (const entry of expected) {
    cursor = trace.indexOf(entry, cursor + 1);
    expect(
      cursor,
      `${entry} missing or out of order in ${trace.join(", ")}`,
    ).toBeGreaterThanOrEqual(0);
  }
}

function harness(
  options: {
    readonly stopGate?: Deferred<void>;
    readonly failStage?: "stop" | "drain";
  } = {},
) {
  const trace: string[] = [];
  const bound = deferred<void>();
  const stopStarted = deferred<void>();
  const baseInvocations = createInvocationCoordinator();
  const rawFences = new Set<AdmissionFence>();
  const wrappedFences = new Map<AdmissionFence, AdmissionFence>();
  let reopenCalls = 0;

  const invocations: InvocationCoordinator = {
    canAdmit: baseInvocations.canAdmit,
    reserve: baseInvocations.reserve,
    invoke: baseInvocations.invoke,
    closeAdmission() {
      const raw = baseInvocations.closeAdmission();
      rawFences.add(raw);
      trace.push(`admission-close:${rawFences.size}`);
      const existing = wrappedFences.get(raw);
      if (existing !== undefined) return existing;
      const wrapped: AdmissionFence = {
        async drain() {
          trace.push("shared-drain:start");
          await raw.drain();
          trace.push("shared-drain:end");
        },
        reopen() {
          reopenCalls += 1;
          trace.push("admission-reopen");
          return raw.reopen();
        },
        seal() {
          trace.push("admission-seal");
          raw.seal();
        },
      };
      wrappedFences.set(raw, wrapped);
      return wrapped;
    },
  };

  let healthy = true;
  const healthState = {
    get healthy() {
      return healthy;
    },
    setHealthy(value: boolean) {
      healthy = value;
      trace.push(`health:${String(value)}`);
    },
  };

  const acknowledged = new Set<number>();
  const processed = new Set<number>();
  const replayable = new Set<number>();
  const admissionRejected = new Set<number>();
  const updateTasks = new Set<Promise<void>>();
  let transportAdmitted = true;

  const captureFetchedUpdate = (
    updateId: number,
    release: Deferred<void>,
    operation: Deferred<void>,
  ): Promise<void> | undefined => {
    if (!transportAdmitted || !invocations.canAdmit()) {
      replayable.add(updateId);
      trace.push(`update:${updateId}:replayable`);
      return undefined;
    }
    const task = (async () => {
      await release.promise;
      if (!transportAdmitted || !invocations.canAdmit()) {
        replayable.add(updateId);
        trace.push(`update:${updateId}:replayable`);
        return;
      }
      acknowledged.add(updateId);
      trace.push(`update:${updateId}:offset`);
      try {
        const reservation = invocations.reserve({ key: "telegram:73" });
        trace.push(`update:${updateId}:reserved`);
        await reservation.run(async () => {
          await operation.promise;
          processed.add(updateId);
          trace.push(`update:${updateId}:processed`);
        });
      } catch (error) {
        if (!(error instanceof DaemonAdmissionClosedError)) throw error;
        admissionRejected.add(updateId);
        trace.push(`update:${updateId}:admission-rejected`);
      }
    })();
    updateTasks.add(task);
    void task.finally(() => updateTasks.delete(task));
    return task;
  };

  const snapshot = {
    channel: { desiredState: "enabled" as const, state: "suspended" as const },
    bot: { state: "ready" as const, username: "synthetic_bot" },
    pairing: { state: "paired" as const },
  };
  let stopCalls = 0;
  let drainCalls = 0;
  const stopPolling = vi.fn(async () => {
    stopCalls += 1;
    trace.push(`telegram-stop:${stopCalls}:start`);
    stopStarted.resolve();
    await options.stopGate?.promise;
    transportAdmitted = false;
    if (options.failStage === "stop" && stopCalls === 1) {
      trace.push("telegram-stop:1:error");
      throw failures.stop;
    }
    trace.push(`telegram-stop:${stopCalls}:end`);
    return snapshot;
  });
  const drainPending = vi.fn(async () => {
    drainCalls += 1;
    trace.push(`telegram-drain:${drainCalls}:start`);
    if (options.failStage === "drain" && drainCalls === 1) {
      trace.push("telegram-drain:1:error");
      throw failures.drain;
    }
    await Promise.all(updateTasks);
    trace.push(`telegram-drain:${drainCalls}:end`);
    return snapshot;
  });
  const resumePolling = vi.fn(async () => {
    transportAdmitted = true;
    trace.push("telegram-resume");
    return snapshot;
  });
  const telegramClose = vi.fn(async () => {
    trace.push("telegram-close");
    return snapshot;
  });
  const telegram = {
    stopPolling,
    drainPending,
    resumePolling,
    close: telegramClose,
  };

  const bindingClose = vi.fn(async () => {
    trace.push("binding-close");
  });
  const listener = {
    async bind() {
      trace.push("binding-open");
      bound.resolve();
      return { port: 42_001, close: bindingClose };
    },
  };
  const lifecycle = {
    home: {
      root: "/synthetic/athlete",
      storeDir: "/synthetic/athlete/store",
      archiveDir: "/synthetic/athlete/archive",
      configDir: "/synthetic/athlete/config",
    },
    engine: {},
    operations: {},
    spendMeter: {
      getSpendSummary: vi.fn(),
      setDailySpendCap: vi.fn(),
    },
    confirmations: {},
    listener,
    close: vi.fn(async () => undefined),
  } as unknown as LocalCoachLifecycle;

  let rpcInput: CoachRpcServerInput | undefined;
  const rpcClose = vi.fn(async () => {
    trace.push("rpc-close:start");
    const input = rpcInput!;
    const fence = input.invocations!.closeAdmission();
    fence.seal();
    input.healthState?.setHealthy(false);
    await input.beforeInvocationDrain?.();
    await fence.drain();
    trace.push("rpc-close:end");
  });
  const dependencies = {
    ensureToken: vi.fn(async () => ({
      path: "/synthetic/athlete/config/daemon.token",
      value: "x".repeat(43),
    })),
    createRpcServer: vi.fn((input: CoachRpcServerInput) => {
      rpcInput = input;
      return {
        handleUpgrade: vi.fn(),
        shutdownRequested: new Promise<void>(() => {}),
        close: rpcClose,
      };
    }),
    createHealthzHandler: vi.fn(() => vi.fn()),
    createHealthState: vi.fn(() => healthState),
    createInvocations: vi.fn(() => invocations),
    createTelegramController: vi.fn(() => telegram),
    createTelegramRuntimeFactory: vi.fn(() => vi.fn()),
  } as unknown as CoachServeDependencies;

  return {
    input: { lifecycle, appVersion: "1.2.3" },
    dependencies,
    trace,
    bound,
    stopStarted,
    captureFetchedUpdate,
    acknowledged,
    processed,
    replayable,
    admissionRejected,
    baseInvocations,
    rawFences,
    reopenCalls: () => reopenCalls,
    healthState,
    rpcInput: () => rpcInput,
    rpcClose,
    bindingClose,
    stopPolling,
    drainPending,
    resumePolling,
    telegramClose,
  };
}

const failures = {
  stop: new Error("synthetic Telegram stop failure"),
  drain: new Error("synthetic Telegram drain failure"),
} as const;

describe("runCoachServe Telegram shutdown ordering", () => {
  it("drains admitted work but leaves updates crossing the shutdown fence replayable", async () => {
    const stopGate = deferred<void>();
    const admittedRelease = deferred<void>();
    const admittedOperation = deferred<void>();
    const crossingRelease = deferred<void>();
    const crossingOperation = deferred<void>();
    const controller = new AbortController();
    const test = harness({ stopGate });
    const result = runCoachServe({ ...test.input, signal: controller.signal }, test.dependencies);
    await test.bound.promise;

    admittedRelease.resolve();
    const admitted = test.captureFetchedUpdate(100, admittedRelease, admittedOperation);
    expect(admitted).toBeDefined();
    await vi.waitFor(() => expect(test.trace).toContain("update:100:reserved"));
    const crossing = test.captureFetchedUpdate(101, crossingRelease, crossingOperation);
    expect(crossing).toBeDefined();
    controller.abort();
    await test.stopStarted.promise;

    expect(test.captureFetchedUpdate(102, crossingRelease, crossingOperation)).toBeUndefined();
    crossingRelease.resolve();
    await expect(crossing).resolves.toBeUndefined();
    expect(test.acknowledged).toEqual(new Set([100]));
    expect(test.replayable).toEqual(new Set([101, 102]));
    expect(test.trace).not.toContain("update:101:offset");
    expect(test.trace).not.toContain("update:101:admission-rejected");

    stopGate.resolve();
    await vi.waitFor(() => expect(test.trace).toContain("telegram-drain:1:start"));
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    admittedOperation.resolve();

    await expect(admitted).resolves.toBeUndefined();
    await expect(result).resolves.toBe(EXIT_SUCCESS);
    expect(test.processed).toEqual(new Set([100]));
    expect(test.admissionRejected).toEqual(new Set());
    expect(test.resumePolling).not.toHaveBeenCalled();
    expect(test.rawFences.size).toBe(1);
    expect(test.reopenCalls()).toBe(0);
    expect(test.healthState.healthy).toBe(false);
    expect(() => test.baseInvocations.reserve()).toThrow(DaemonAdmissionClosedError);
    expectInOrder(test.trace, [
      "update:100:offset",
      "update:100:reserved",
      "admission-close:1",
      "admission-seal",
      "health:false",
      "telegram-stop:1:start",
      "update:102:replayable",
      "update:101:replayable",
      "telegram-stop:1:end",
      "telegram-drain:1:start",
      "update:100:processed",
      "telegram-drain:1:end",
      "shared-drain:start",
      "shared-drain:end",
      "binding-close",
      "rpc-close:start",
      "admission-close:1",
      "admission-seal",
      "health:false",
      "telegram-stop:2:start",
      "telegram-stop:2:end",
      "telegram-drain:2:start",
      "telegram-drain:2:end",
      "shared-drain:start",
      "shared-drain:end",
      "rpc-close:end",
      "telegram-close",
    ]);
  });

  it.each(["stop", "drain"] as const)(
    "seals shared admission and finishes cleanup when Telegram %s fails",
    async (failStage) => {
      const controller = new AbortController();
      const test = harness({ failStage });
      const result = runCoachServe({ ...test.input, signal: controller.signal }, test.dependencies);
      await test.bound.promise;
      controller.abort();

      await expect(result).rejects.toBe(failures[failStage]);
      expect(test.stopPolling).toHaveBeenCalledTimes(2);
      expect(test.drainPending).toHaveBeenCalledTimes(2);
      expect(test.rpcClose).toHaveBeenCalledOnce();
      expect(test.bindingClose).toHaveBeenCalledOnce();
      expect(test.telegramClose).toHaveBeenCalledOnce();
      expect(test.resumePolling).not.toHaveBeenCalled();
      expect(test.rawFences.size).toBe(1);
      expect(test.reopenCalls()).toBe(0);
      expect(test.healthState.healthy).toBe(false);
      expect(() => test.baseInvocations.reserve()).toThrow(DaemonAdmissionClosedError);
      expectInOrder(test.trace, [
        "admission-close:1",
        "admission-seal",
        "health:false",
        "telegram-stop:1:start",
        "telegram-drain:1:start",
        "shared-drain:start",
        "shared-drain:end",
        "binding-close",
        "rpc-close:start",
        "admission-close:1",
        "admission-seal",
        "health:false",
        "telegram-stop:2:start",
        "telegram-stop:2:end",
        "telegram-drain:2:start",
        "telegram-drain:2:end",
        "shared-drain:start",
        "shared-drain:end",
        "rpc-close:end",
        "telegram-close",
      ]);
    },
  );
});
