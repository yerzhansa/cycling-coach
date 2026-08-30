import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDesktopUsagePingController,
  DESKTOP_USAGE_PING_ENDPOINT,
  DESKTOP_USAGE_PING_TIMEOUT_MS,
  desktopUsagePingChannelForPlatform,
} from "../src/main/desktop-usage-ping.js";
import {
  createDesktopUsagePingStateStore,
  DESKTOP_USAGE_PING_INTERVAL_MS,
  DESKTOP_USAGE_PING_STATE_FILE_NAME,
  type DesktopUsagePingClaim,
  type DesktopUsagePingStateStore,
} from "../src/main/desktop-usage-ping-state.js";

const INSTANCE_ID = "10000000-0000-4000-8000-000000000001";
const temporaryRoots: string[] = [];

interface TestTimerHandle {
  unref(): void;
}

function fakeTimers() {
  const scheduled = new Map<TestTimerHandle, Readonly<{ callback: () => void; timeout: number }>>();
  const handles: TestTimerHandle[] = [];
  const setTimeout = vi.fn((callback: () => void, timeout: number): TestTimerHandle => {
    const handle = { unref: vi.fn() };
    handles.push(handle);
    scheduled.set(handle, { callback, timeout });
    return handle;
  });
  const clearTimeout = vi.fn((handle: TestTimerHandle) => {
    scheduled.delete(handle);
  });
  const latest = (timeout: number): TestTimerHandle | undefined => {
    let match: TestTimerHandle | undefined;
    for (const [handle, entry] of scheduled) {
      if (entry.timeout === timeout) match = handle;
    }
    return match;
  };
  const fire = (handle: TestTimerHandle): void => {
    const entry = scheduled.get(handle);
    if (entry === undefined) throw new Error("timer is not scheduled");
    scheduled.delete(handle);
    entry.callback();
  };
  return {
    clearTimeout,
    fireLatest(timeout: number) {
      const handle = latest(timeout);
      if (handle === undefined) throw new Error(`no timer scheduled for ${timeout}`);
      fire(handle);
    },
    handles,
    latest,
    pending: () => [...scheduled.values()],
    setTimeout,
  };
}

function stateReturning(...claims: DesktopUsagePingClaim[]): DesktopUsagePingStateStore {
  const claimAttempt = vi.fn(async () => claims.shift() ?? { status: "unavailable" as const });
  return { claimAttempt };
}

async function temporaryStateRoot(): Promise<string> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "desktop-usage-ping-controller-"));
  temporaryRoots.push(temporaryRoot);
  return join(temporaryRoot, "desktop-preferences-v1");
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("desktop usage ping controller", () => {
  it("claims durable state before sending the exact desktop payload", async () => {
    const root = await temporaryStateRoot();
    const target = join(root, DESKTOP_USAGE_PING_STATE_FILE_NAME);
    const state = createDesktopUsagePingStateStore({
      root,
      createInstanceId: () => INSTANCE_ID,
    });
    const timers = fakeTimers();
    const request = vi.fn(async (_url: string, init: RequestInit) => {
      const persisted = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>;
      expect(persisted.lastAttemptAt).toBe(12_345);
      expect(init.signal?.aborted).toBe(false);
    });
    const controller = createDesktopUsagePingController({
      releaseEligible: true,
      version: "0.1.5",
      channel: "macos",
      state,
      request,
      now: () => 12_345,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    await controller.start();

    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe(DESKTOP_USAGE_PING_ENDPOINT);
    expect(init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        product: "enduragent-desktop",
        version: "0.1.5",
        channel: "macos",
        instance: INSTANCE_ID,
      }),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    });
    expect(timers.setTimeout).toHaveBeenCalledWith(
      expect.any(Function),
      DESKTOP_USAGE_PING_TIMEOUT_MS,
    );
    expect(timers.pending()).toEqual([
      expect.objectContaining({ timeout: DESKTOP_USAGE_PING_INTERVAL_MS }),
    ]);
    expect(timers.handles.every((handle) => vi.mocked(handle.unref).mock.calls.length === 1)).toBe(
      true,
    );
    controller.close();
  });

  it("defers until the persisted daily window expires without sending", async () => {
    const state = stateReturning({ status: "deferred", retryAfterMs: 7_000 });
    const timers = fakeTimers();
    const request = vi.fn();
    const controller = createDesktopUsagePingController({
      releaseEligible: true,
      version: "0.1.5",
      channel: "macos",
      state,
      request,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    await controller.start();

    expect(request).not.toHaveBeenCalled();
    expect(timers.pending()).toEqual([expect.objectContaining({ timeout: 7_000 })]);
    controller.close();
  });

  it("waits until the next daily window after request or storage failures", async () => {
    const requestFailureState = stateReturning({ status: "claimed", instanceId: INSTANCE_ID });
    const requestFailureTimers = fakeTimers();
    const request = vi.fn(async () => {
      throw new Error("synthetic request failure");
    });
    const requestFailureController = createDesktopUsagePingController({
      releaseEligible: true,
      version: "0.1.5",
      channel: "macos",
      state: requestFailureState,
      request,
      setTimeout: requestFailureTimers.setTimeout,
      clearTimeout: requestFailureTimers.clearTimeout,
    });

    await expect(requestFailureController.start()).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledOnce();
    expect(requestFailureTimers.pending()).toEqual([
      expect.objectContaining({ timeout: DESKTOP_USAGE_PING_INTERVAL_MS }),
    ]);

    const unavailableState = stateReturning({ status: "unavailable" });
    const unavailableTimers = fakeTimers();
    const unavailableRequest = vi.fn();
    const unavailableController = createDesktopUsagePingController({
      releaseEligible: true,
      version: "0.1.5",
      channel: "macos",
      state: unavailableState,
      request: unavailableRequest,
      setTimeout: unavailableTimers.setTimeout,
      clearTimeout: unavailableTimers.clearTimeout,
    });

    await unavailableController.start();

    expect(unavailableRequest).not.toHaveBeenCalled();
    expect(unavailableTimers.pending()).toEqual([
      expect.objectContaining({ timeout: DESKTOP_USAGE_PING_INTERVAL_MS }),
    ]);
    requestFailureController.close();
    unavailableController.close();
  });

  it("aborts a request after five seconds and does not overlap starts", async () => {
    const state = stateReturning({ status: "claimed", instanceId: INSTANCE_ID });
    const timers = fakeTimers();
    let requestSignal: AbortSignal | undefined;
    const request = vi.fn(
      async (_url: string, init: RequestInit): Promise<void> =>
        new Promise((_resolve, reject) => {
          requestSignal = init.signal ?? undefined;
          requestSignal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const controller = createDesktopUsagePingController({
      releaseEligible: true,
      version: "0.1.5",
      channel: "macos",
      state,
      request,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    const firstStart = controller.start();
    await controller.start();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    timers.fireLatest(DESKTOP_USAGE_PING_TIMEOUT_MS);
    await firstStart;

    expect(requestSignal?.aborted).toBe(true);
    expect(state.claimAttempt).toHaveBeenCalledOnce();
    expect(timers.pending()).toEqual([
      expect.objectContaining({ timeout: DESKTOP_USAGE_PING_INTERVAL_MS }),
    ]);
    controller.close();
  });

  it("closes idempotently, clears the daily timer, and aborts an active request", async () => {
    const state = stateReturning({ status: "claimed", instanceId: INSTANCE_ID });
    const timers = fakeTimers();
    let requestSignal: AbortSignal | undefined;
    const request = vi.fn(
      async (_url: string, init: RequestInit): Promise<void> =>
        new Promise((_resolve, reject) => {
          requestSignal = init.signal ?? undefined;
          requestSignal?.addEventListener("abort", () => reject(new Error("closed")), {
            once: true,
          });
        }),
    );
    const controller = createDesktopUsagePingController({
      releaseEligible: true,
      version: "0.1.5",
      channel: "macos",
      state,
      request,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    const started = controller.start();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    controller.close();
    controller.close();
    await started;

    expect(requestSignal?.aborted).toBe(true);
    expect(timers.pending()).toEqual([]);
    await controller.start();
    expect(request).toHaveBeenCalledOnce();
  });

  it("does nothing when release eligibility or payload validation fails", async () => {
    for (const releaseEligible of [false, true]) {
      const state = stateReturning({ status: "claimed", instanceId: INSTANCE_ID });
      const timers = fakeTimers();
      const request = vi.fn();
      const controller = createDesktopUsagePingController({
        releaseEligible,
        version: releaseEligible ? "not-a-release-version" : "0.1.5",
        channel: "macos",
        state,
        request,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
      });

      await controller.start();

      expect(state.claimAttempt).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(timers.pending()).toEqual([]);
    }
  });
});

describe("desktop usage ping channel", () => {
  it("maps only supported desktop platforms", () => {
    expect(desktopUsagePingChannelForPlatform("darwin")).toBe("macos");
    expect(desktopUsagePingChannelForPlatform("win32")).toBe("windows");
    expect(desktopUsagePingChannelForPlatform("linux")).toBeUndefined();
  });
});
