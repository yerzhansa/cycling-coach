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

  it("constructs and starts once without awaiting the long-running poll", async () => {
    const harness = runtimeHarness();
    const controller = createDesktopTelegramController({
      createRuntime: harness.createRuntime,
    });

    await controller.enable("123456:very-secret-token");

    expect(harness.createRuntime).toHaveBeenCalledOnce();
    expect(harness.runtime.start).toHaveBeenCalledOnce();
    expect(controller.getStatus()).toEqual({
      desiredState: "enabled",
      state: "starting",
    });

    await controller.enable("different-token-must-not-create-a-second-runtime");
    expect(harness.createRuntime).toHaveBeenCalledOnce();
    expect(harness.runtime.start).toHaveBeenCalledOnce();

    harness.callbacks()?.onStarted();
    expect(controller.getStatus()).toEqual({
      desiredState: "enabled",
      state: "online",
    });

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

      await controller.enable("123456:secret-token");
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

    await expect(controller.enable("123456:secret-token")).resolves.toBeUndefined();

    expect(controller.getStatus()).toEqual({
      desiredState: "enabled",
      errorCode: "telegram-start-failed",
      state: "failed",
    });
    expect(JSON.stringify(controller.getStatus())).not.toContain("secret-token");
    expect(JSON.stringify(controller.getStatus())).not.toContain("api.telegram.org");
  });

  it("disables idempotently and ignores a late start rejection", async () => {
    const harness = runtimeHarness();
    const controller = createDesktopTelegramController({
      createRuntime: harness.createRuntime,
    });

    await controller.enable("secret-token");
    await Promise.all([controller.disable(), controller.disable(), controller.close()]);

    expect(harness.runtime.stop).toHaveBeenCalledOnce();
    expect(harness.runtime.drainPending).toHaveBeenCalledOnce();
    expect(controller.getStatus()).toEqual({
      desiredState: "disabled",
      state: "disabled",
    });

    harness.start.reject({ error_code: 401, description: "secret-token" });
    await settle();

    expect(controller.getStatus()).toEqual({
      desiredState: "disabled",
      state: "disabled",
    });
  });

  it("supports ordered polling stop and pending-work drain", async () => {
    const harness = runtimeHarness();
    const controller = createDesktopTelegramController({
      createRuntime: harness.createRuntime,
    });
    await controller.enable("secret-token");

    await controller.stopPolling();
    expect(harness.trace).toEqual(["stop"]);
    expect(controller.getStatus()).toEqual({
      desiredState: "enabled",
      state: "starting",
    });

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

  it("ignores spurious resume calls and waits for an in-flight stop before restarting", async () => {
    const stop = deferred<void>();
    const starts = [deferred<void>(), deferred<void>()];
    let startIndex = 0;
    const runtime: DesktopTelegramRuntime = {
      start: vi.fn(() => starts[startIndex++]!.promise),
      stop: vi.fn(() => stop.promise),
      drainPending: vi.fn(async () => undefined),
    };
    const controller = createDesktopTelegramController({ createRuntime: () => runtime });
    await controller.enable("secret-token");

    await controller.resumePolling();
    expect(runtime.start).toHaveBeenCalledOnce();

    const stopping = controller.stopPolling();
    await settle();
    await controller.resumePolling();
    expect(runtime.start).toHaveBeenCalledOnce();

    stop.resolve();
    await stopping;
    await settle();
    expect(runtime.start).toHaveBeenCalledTimes(2);

    await controller.resumePolling();
    expect(runtime.start).toHaveBeenCalledTimes(2);
  });

  it("keeps teardown failures channel-local and can enable a fresh runtime later", async () => {
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

    await controller.enable("first-secret-token");
    await expect(controller.disable()).resolves.toBeUndefined();
    await controller.enable("second-secret-token");

    expect(createRuntime).toHaveBeenCalledTimes(2);
    expect(runtimes[0]!.stop).toHaveBeenCalledOnce();
    expect(runtimes[0]!.drainPending).toHaveBeenCalledOnce();
    expect(runtimes[1]!.start).toHaveBeenCalledOnce();
    expect(controller.getStatus()).toEqual({
      desiredState: "enabled",
      state: "starting",
    });
  });
});
