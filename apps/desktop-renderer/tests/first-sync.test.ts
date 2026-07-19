import { readFile } from "node:fs/promises";
import { CoachClientDisconnectedError, CoachClientProtocolError } from "@enduragent/coach-client";
import type {
  CoachOperationProgressNotificationEnvelope,
  SyncRpcResult,
} from "@enduragent/coach-contract";
import { describe, expect, it, vi, type Mock } from "vitest";
import {
  createFirstSyncController,
  type FirstSyncCallOptions,
  type FirstSyncPorts,
  type FirstSyncState,
} from "../src/first-sync.js";

const completion = {
  providerConfigured: true,
  trainingDataConfigured: true,
  intakeSaved: true,
} as const;

const success: SyncRpcResult = {
  schemaVersion: 1,
  published: true,
  referenceSucceeded: true,
  requests: { store: 1, reference: 1, total: 2 },
};

function envelope(
  phase: "started" | "completed",
  completed: number,
  total = 1,
  requestId = 1,
): CoachOperationProgressNotificationEnvelope {
  return {
    jsonrpc: "2.0",
    method: "coach.operationProgress",
    params: { requestId, requestMethod: "sync", event: { phase, completed, total } },
  };
}

function fakePorts(callSync: FirstSyncPorts["callSync"]): FirstSyncPorts & {
  readonly states: FirstSyncState[];
  readonly focusComposer: Mock<() => void>;
} {
  const states: FirstSyncState[] = [];
  return {
    states,
    callSync,
    focusComposer: vi.fn<() => void>(),
    render: (state) => states.push(state),
  };
}

function completedCall(result: SyncRpcResult = success): FirstSyncPorts["callSync"] {
  return async (options) => {
    options.onNotificationEnvelope(envelope("started", 0));
    options.onNotificationEnvelope(envelope("completed", 1));
    return result;
  };
}

describe("first sync controller", () => {
  it("strictly validates completion and starts one synchronous single-flight call", async () => {
    let resolve!: (result: SyncRpcResult) => void;
    let options!: FirstSyncCallOptions;
    const callSync = vi.fn(
      (selected: FirstSyncCallOptions) =>
        new Promise<SyncRpcResult>((done) => {
          options = selected;
          resolve = done;
        }),
    );
    const ports = fakePorts(callSync);
    const controller = createFirstSyncController(ports);
    for (const invalid of [
      {},
      { ...completion, intakeSaved: false },
      { ...completion, extra: true },
      null,
    ]) {
      await expect(controller.start(invalid as never)).rejects.toBeInstanceOf(TypeError);
    }
    expect(callSync).not.toHaveBeenCalled();
    const first = controller.start(completion);
    const second = controller.start(completion);
    expect(first).toBe(second);
    expect(ports.states).toEqual([{ status: "syncing" }]);
    expect(callSync).toHaveBeenCalledTimes(1);
    options.onNotificationEnvelope(envelope("started", 0));
    options.onNotificationEnvelope(envelope("completed", 1));
    resolve(success);
    await expect(first).resolves.toBeUndefined();
    expect(ports.states.at(-1)).toEqual({ status: "ready" });
    expect(ports.focusComposer).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["reversed", [envelope("completed", 1), envelope("started", 0)]],
    ["duplicate", [envelope("started", 0), envelope("started", 0)]],
    ["wrong total", [envelope("started", 0, 2), envelope("completed", 1)]],
    ["skipped", [envelope("started", 0)]],
    ["cross request", [envelope("started", 0, 1, 1), envelope("completed", 1, 1, 2)]],
  ])("latches %s progress as a protocol failure without observer throws", async (_name, events) => {
    const ports = fakePorts(async (options) => {
      for (const event of events) {
        expect(() => options.onNotificationEnvelope(event)).not.toThrow();
      }
      return success;
    });
    const controller = createFirstSyncController(ports);
    await controller.start(completion);
    expect(ports.states.at(-1)).toEqual({
      status: "failed",
      kind: "protocol",
      retryable: false,
    });
    expect(ports.focusComposer).not.toHaveBeenCalled();
    await controller.retry();
    expect(ports.states).toHaveLength(2);
  });

  it("turns a late current-epoch envelope into a non-retryable protocol failure", async () => {
    let notify!: FirstSyncCallOptions["onNotificationEnvelope"];
    const ports = fakePorts(async (options) => {
      notify = options.onNotificationEnvelope;
      notify(envelope("started", 0));
      notify(envelope("completed", 1));
      return success;
    });
    const controller = createFirstSyncController(ports);
    await controller.start(completion);
    expect(() => notify(envelope("completed", 1))).not.toThrow();
    expect(ports.states.at(-1)).toEqual({
      status: "failed",
      kind: "protocol",
      retryable: false,
    });
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
  ])(
    "maps published %s and Reference success %s to a retryable operation failure",
    async (published, referenceSucceeded) => {
      const ports = fakePorts(completedCall({ ...success, published, referenceSucceeded }));
      await createFirstSyncController(ports).start(completion);
      expect(ports.states.at(-1)).toEqual({
        status: "failed",
        kind: "operation",
        retryable: true,
      });
      expect(ports.focusComposer).not.toHaveBeenCalled();
    },
  );

  it.each([
    [new Error("private operation failure"), "operation", true],
    [new CoachClientDisconnectedError(1006, "private close reason"), "disconnected", true],
    [new CoachClientProtocolError(), "protocol", false],
  ] as const)("maps fixed failure state for %s", async (failure, kind, retryable) => {
    const ports = fakePorts(async () => {
      throw failure;
    });
    await createFirstSyncController(ports).start(completion);
    expect(ports.states.at(-1)).toEqual({ status: "failed", kind, retryable });
    expect(JSON.stringify(ports.states)).not.toContain(failure.message);
  });

  it("retries once on a new epoch and ignores callbacks from the detached epoch", async () => {
    const calls: FirstSyncCallOptions[] = [];
    let resolveRetry!: (result: SyncRpcResult) => void;
    const ports = fakePorts(
      vi.fn(async (options) => {
        calls.push(options);
        if (calls.length === 1) throw new CoachClientDisconnectedError(1006, "detached");
        return new Promise<SyncRpcResult>((resolve) => {
          resolveRetry = resolve;
        });
      }),
    );
    const controller = createFirstSyncController(ports);
    await controller.start(completion);
    const retry = controller.retry();
    expect(calls).toHaveLength(2);
    calls[0]!.onNotificationEnvelope(envelope("started", 0));
    calls[0]!.onNotificationEnvelope(envelope("completed", 1));
    calls[1]!.onNotificationEnvelope(envelope("started", 0, 1, 2));
    calls[1]!.onNotificationEnvelope(envelope("completed", 1, 1, 2));
    resolveRetry(success);
    await retry;
    expect(ports.states.at(-1)).toEqual({ status: "ready" });
    expect(ports.focusComposer).toHaveBeenCalledTimes(1);
    expect(ports.callSync).toHaveBeenCalledTimes(2);
  });

  it("makes pending callbacks and completion inert after disposal", async () => {
    let options!: FirstSyncCallOptions;
    let resolve!: (result: SyncRpcResult) => void;
    const ports = fakePorts(
      (selected) =>
        new Promise<SyncRpcResult>((done) => {
          options = selected;
          resolve = done;
        }),
    );
    const controller = createFirstSyncController(ports);
    const call = controller.start(completion);
    controller.dispose();
    options.onNotificationEnvelope(envelope("started", 0));
    options.onNotificationEnvelope(envelope("completed", 1));
    resolve(success);
    await call;
    await controller.retry();
    await controller.start(completion);
    expect(ports.states).toEqual([{ status: "syncing" }]);
    expect(ports.focusComposer).not.toHaveBeenCalled();
  });

  it("rechecks sync after a later onboarding completion without refocusing twice", async () => {
    const callSync = vi.fn(completedCall());
    const ports = fakePorts(callSync);
    const controller = createFirstSyncController(ports);
    await controller.start(completion);
    await controller.start(completion);
    expect(callSync).toHaveBeenCalledTimes(2);
    expect(ports.states).toEqual([
      { status: "syncing" },
      { status: "ready" },
      { status: "syncing" },
      { status: "ready" },
    ]);
    expect(ports.focusComposer).toHaveBeenCalledTimes(1);
  });

  it("keeps the controller free of chat or transcript ports and ships the exact status surface", async () => {
    const ports = fakePorts(completedCall());
    await createFirstSyncController(ports).start(completion);
    expect(Object.keys(ports).sort()).toEqual(["callSync", "focusComposer", "render", "states"]);
    const [host, controller, styles] = await Promise.all([
      readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/first-sync.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    ]);
    for (const copy of [
      "Getting your coach ready",
      "Syncing your training history…",
      "You can keep Enduragent open while rides, wellness, and calendar data are added.",
      "Training history is ready",
      "Your coach is ready when you are.",
      "We couldn’t finish syncing",
      "Your saved progress is safe.",
      "Retry sync",
      "Enduragent needs to reconnect safely",
      "Quit and reopen Enduragent.",
    ]) {
      expect(host).toContain(copy);
    }
    expect(host).toContain('section.className = "first-sync"');
    expect(host).toContain("section.dataset.state = state.status");
    expect(host).toContain('section.setAttribute("aria-labelledby", "first-sync-title")');
    expect(host).toContain('track.setAttribute("role", "progressbar")');
    expect(host).toContain('track.setAttribute("aria-label", "Syncing training history")');
    expect(host).toContain(
      "onComplete: (completion) => void firstSyncController.start(completion)",
    );
    expect(host).toContain("message.focus()");
    expect(controller).not.toMatch(/chat|prompt|transcript|sessionStore/u);
    expect(styles).toContain("width: min(680px, calc(100% - 48px))");
    expect(styles).toContain("padding: 20px");
    expect(styles).toContain("border-radius: 16px");
    expect(styles).toContain("animation: first-sync-sweep 1.2s");
    expect(styles).toContain("@media (max-width: 760px)");
    expect(styles).toContain("width: calc(100% - 32px)");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain("animation: none");
    expect(styles).toContain("width: 40%");
  });
});
