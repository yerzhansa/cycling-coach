import { describe, expect, it, vi } from "vitest";
import {
  createDesktopTelegramController,
  type DesktopTelegramRuntime,
  type DesktopTelegramRuntimeFactoryInput,
} from "../src/desktop-telegram-controller.js";

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

function runtimeHarness() {
  const start = deferred<void>();
  const trace: string[] = [];
  const runtime: DesktopTelegramRuntime = {
    start: vi.fn(() => start.promise),
    stop: vi.fn(async () => {
      trace.push("stop");
    }),
    drainPending: vi.fn(async () => {
      trace.push("drain");
    }),
  };
  let callbacks: DesktopTelegramRuntimeFactoryInput | undefined;
  const createRuntime = vi.fn((input: DesktopTelegramRuntimeFactoryInput) => {
    callbacks = input;
    return runtime;
  });
  return { callbacks: () => callbacks, createRuntime, runtime, start, trace };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Desktop Telegram controller", () => {
  it("starts disabled with an exact redacted status", () => {
    const harness = runtimeHarness();
    const controller = createDesktopTelegramController({
      createRuntime: harness.createRuntime,
    });

    expect(controller.getStatus()).toEqual({
      desiredState: "disabled",
      state: "disabled",
    });
    expect(harness.createRuntime).not.toHaveBeenCalled();
  });

  it("keeps configuration separate from desired enablement", async () => {
    const harness = runtimeHarness();
    const controller = createDesktopTelegramController({
      createRuntime: harness.createRuntime,
    });

    await controller.configure("123456:very-secret-token");
    expect(controller.getStatus()).toEqual({ desiredState: "disabled", state: "disabled" });
    expect(harness.createRuntime).not.toHaveBeenCalled();

    await controller.enable();
    expect(harness.createRuntime).toHaveBeenCalledOnce();
    expect(harness.runtime.start).toHaveBeenCalledOnce();
    expect(controller.getStatus()).toEqual({ desiredState: "enabled", state: "starting" });

    await controller.configure("different-token-must-not-replace-the-active-runtime");
    expect(harness.createRuntime).toHaveBeenCalledOnce();

    harness.callbacks()?.onStarted();
    expect(controller.getStatus()).toEqual({ desiredState: "enabled", state: "online" });
  });

  it("waits for credential replay when enablement arrives first", async () => {
    const harness = runtimeHarness();
    const controller = createDesktopTelegramController({
      createRuntime: harness.createRuntime,
    });

    await controller.enable();
    expect(controller.getStatus()).toEqual({
      desiredState: "enabled",
      state: "waiting-for-credential",
    });
    expect(harness.createRuntime).not.toHaveBeenCalled();

    await controller.configure("123456:secret-token");
    expect(harness.createRuntime).toHaveBeenCalledOnce();
    expect(harness.runtime.start).toHaveBeenCalledOnce();
  });

  it.each([
    [401, "invalid-token", "telegram-invalid-token"],
    [409, "conflict", "telegram-polling-conflict"],
    [500, "failed", "telegram-start-failed"],
  ] as const)(
    "maps Telegram error_code %i to a closed redacted status",
    async (errorCode, state, statusCode) => {
      const harness = runtimeHarness();
      const controller = createDesktopTelegramController({
        createRuntime: harness.createRuntime,
      });

      await controller.configure("123456:secret-token");
      await controller.enable();
      harness.start.reject({
        error_code: errorCode,
        description: "secret-token at https://api.telegram.org/bot123456:secret-token/getUpdates",
      });
      await settle();

      expect(controller.getStatus()).toEqual({
        desiredState: "enabled",
        errorCode: statusCode,
        state,
      });
      expect(JSON.stringify(controller.getStatus())).not.toContain("secret-token");
      expect(JSON.stringify(controller.getStatus())).not.toContain("api.telegram.org");
      expect(JSON.stringify(controller.getStatus())).not.toContain("description");
    },
  );

  it("sanitizes arbitrary exceptions and synchronous factory failures", async () => {
    const controller = createDesktopTelegramController({
      createRuntime() {
        throw new Error(
          "123456:secret-token https://api.telegram.org/bot123456:secret-token/getMe",
        );
      },
    });

    await controller.configure("123456:secret-token");
    await expect(controller.enable()).resolves.toBeUndefined();

    expect(controller.getStatus()).toEqual({
      desiredState: "enabled",
      errorCode: "telegram-start-failed",
      state: "failed",
    });
    expect(JSON.stringify(controller.getStatus())).not.toContain("secret-token");
    expect(JSON.stringify(controller.getStatus())).not.toContain("api.telegram.org");
  });

  it("disables idempotently, retains configuration, and ignores a late rejection", async () => {
    const starts = [deferred<void>(), deferred<void>()];
    const runtimes: DesktopTelegramRuntime[] = starts.map((start) => ({
      start: vi.fn(() => start.promise),
      stop: vi.fn(async () => undefined),
      drainPending: vi.fn(async () => undefined),
    }));
    let runtimeIndex = 0;
    const controller = createDesktopTelegramController({
      createRuntime: () => runtimes[runtimeIndex++]!,
    });

    await controller.configure("secret-token");
    await controller.enable();
    await Promise.all([controller.disable(), controller.disable(), controller.close()]);

    expect(runtimes[0]!.stop).toHaveBeenCalledOnce();
    expect(runtimes[0]!.drainPending).toHaveBeenCalledOnce();
    expect(controller.getStatus()).toEqual({ desiredState: "disabled", state: "disabled" });

    starts[0]!.reject({ error_code: 401, description: "secret-token" });
    await settle();
    expect(controller.getStatus()).toEqual({ desiredState: "disabled", state: "disabled" });

    await controller.enable();
    expect(runtimes[1]!.start).toHaveBeenCalledOnce();
  });

  it("supports ordered polling stop, pending-work drain, and resume", async () => {
    const harness = runtimeHarness();
    const controller = createDesktopTelegramController({
      createRuntime: harness.createRuntime,
    });
    await controller.configure("secret-token");
    await controller.enable();

    await controller.stopPolling();
    expect(harness.trace).toEqual(["stop"]);
    expect(controller.getStatus()).toEqual({ desiredState: "enabled", state: "starting" });

    await controller.drainPending();
    expect(harness.trace).toEqual(["stop", "drain"]);

    await controller.resumePolling();
    expect(harness.runtime.start).toHaveBeenCalledTimes(2);

    await controller.close();
    await controller.stopPolling();
    await controller.resumePolling();
    await controller.drainPending();
    expect(harness.trace).toEqual(["stop", "drain", "stop", "drain"]);
  });

  it("waits for an in-flight poll stop before resuming", async () => {
    const stop = deferred<void>();
    const starts = [deferred<void>(), deferred<void>()];
    let startIndex = 0;
    const runtime: DesktopTelegramRuntime = {
      start: vi.fn(() => starts[startIndex++]!.promise),
      stop: vi.fn(() => stop.promise),
      drainPending: vi.fn(async () => undefined),
    };
    const controller = createDesktopTelegramController({ createRuntime: () => runtime });
    await controller.configure("secret-token");
    await controller.enable();

    await controller.resumePolling();
    expect(runtime.start).toHaveBeenCalledOnce();

    const stopping = controller.stopPolling();
    await settle();
    const resuming = controller.resumePolling();
    expect(runtime.start).toHaveBeenCalledOnce();

    stop.resolve();
    await Promise.all([stopping, resuming]);
    expect(runtime.start).toHaveBeenCalledTimes(2);

    await controller.resumePolling();
    expect(runtime.start).toHaveBeenCalledTimes(2);
  });

  it("drains the old runtime before replacement constructs or starts the new token", async () => {
    const trace: string[] = [];
    const createRuntime = vi.fn(({ token }: DesktopTelegramRuntimeFactoryInput) => {
      trace.push(`create:${token}`);
      return {
        start: vi.fn(async () => {
          trace.push(`start:${token}`);
          await new Promise<void>(() => undefined);
        }),
        stop: vi.fn(async () => {
          trace.push(`stop:${token}`);
        }),
        drainPending: vi.fn(async () => {
          trace.push(`drain:${token}`);
        }),
      } satisfies DesktopTelegramRuntime;
    });
    const controller = createDesktopTelegramController({ createRuntime });

    await controller.configure("old-token");
    await controller.enable();
    await controller.replace("new-token");

    expect(trace).toEqual([
      "create:old-token",
      "start:old-token",
      "stop:old-token",
      "drain:old-token",
      "create:new-token",
      "start:new-token",
    ]);
  });

  it("serializes replacement, disablement, enablement, and reconciliation", async () => {
    const trace: string[] = [];
    const createRuntime = vi.fn(({ token }: DesktopTelegramRuntimeFactoryInput) => ({
      start: vi.fn(async () => {
        trace.push(`start:${token}`);
        await new Promise<void>(() => undefined);
      }),
      stop: vi.fn(async () => {
        trace.push(`stop:${token}`);
      }),
      drainPending: vi.fn(async () => {
        trace.push(`drain:${token}`);
      }),
    }));
    const controller = createDesktopTelegramController({ createRuntime });
    await controller.configure("old-token");
    await controller.enable();
    trace.length = 0;

    await Promise.all([
      controller.replace("new-token"),
      controller.disable(),
      controller.enable(),
      controller.reconcile(),
    ]);

    expect(trace).toEqual([
      "stop:old-token",
      "drain:old-token",
      "start:new-token",
      "stop:new-token",
      "drain:new-token",
      "start:new-token",
    ]);
    expect(controller.getStatus()).toEqual({ desiredState: "enabled", state: "starting" });
  });

  it("keeps a successor stopped when suspension races replacement drain", async () => {
    const oldDrain = deferred<void>();
    const createdTokens: string[] = [];
    const createRuntime = vi.fn(({ token }: DesktopTelegramRuntimeFactoryInput) => {
      createdTokens.push(token);
      return {
        start: vi.fn(() => new Promise<void>(() => undefined)),
        stop: vi.fn(async () => undefined),
        drainPending: vi.fn(() => (token === "old-token" ? oldDrain.promise : Promise.resolve())),
      } satisfies DesktopTelegramRuntime;
    });
    const controller = createDesktopTelegramController({ createRuntime });
    await controller.configure("old-token");
    await controller.enable();

    const replacement = controller.replace("new-token");
    await settle();
    const suspension = controller.stopPolling();
    oldDrain.resolve();
    await Promise.all([replacement, suspension]);

    expect(createdTokens).toEqual(["old-token"]);
    expect(controller.getStatus()).toEqual({ desiredState: "enabled", state: "starting" });

    await controller.reconcile();
    expect(createdTokens).toEqual(["old-token"]);
    await controller.resumePolling();
    expect(createdTokens).toEqual(["old-token", "new-token"]);
  });

  it("keeps teardown failures channel-local and replaces with a fresh runtime", async () => {
    const firstStart = deferred<void>();
    const secondStart = deferred<void>();
    const runtimes: DesktopTelegramRuntime[] = [
      {
        start: vi.fn(() => firstStart.promise),
        stop: vi.fn(async () => {
          throw new Error("secret stop failure");
        }),
        drainPending: vi.fn(async () => {
          throw new Error("secret drain failure");
        }),
      },
      {
        start: vi.fn(() => secondStart.promise),
        stop: vi.fn(async () => undefined),
        drainPending: vi.fn(async () => undefined),
      },
    ];
    let runtimeIndex = 0;
    const createRuntime = vi.fn(() => runtimes[runtimeIndex++]!);
    const controller = createDesktopTelegramController({ createRuntime });

    await controller.configure("first-secret-token");
    await controller.enable();
    await expect(controller.replace("second-secret-token")).resolves.toBeUndefined();

    expect(createRuntime).toHaveBeenCalledTimes(2);
    expect(runtimes[0]!.stop).toHaveBeenCalledOnce();
    expect(runtimes[0]!.drainPending).toHaveBeenCalledOnce();
    expect(runtimes[1]!.start).toHaveBeenCalledOnce();
    expect(controller.getStatus()).toEqual({ desiredState: "enabled", state: "starting" });
  });
});
