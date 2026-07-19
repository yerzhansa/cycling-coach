import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, ReferenceRuntime } from "@enduragent/core";
import type { ReferenceCaptureManifest } from "@enduragent/kernel/reference/capture";
import type { ProducedLocalBundle } from "@enduragent/kernel/reference/local-bundle";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStoreRuntime,
  STORE_REFRESH_INTERVAL_MS,
  type StoreRuntime,
} from "../src/store-runtime.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const config: Config = {
  dataSource: "store", llm: { provider: "openai-codex", model: "gpt-5.4", apiKey: "" },
  intervals: { apiKey: "synthetic", athleteId: "synthetic-athlete" }, telegram: { botToken: "" },
  session: { historyTokenBudgetRatio: 0.3, idleMinutes: 0, dailyResetHour: 4,
    resetArchiveRetentionDays: 0, timezone: "UTC" }, contextWindowTokens: 1000, dataDir: "unused",
};
const manifest = {
  capture_id: "12345678-1234-4123-8123-123456789abc",
  plan: { frozenNow: "1998-07-18T12:00:00.000Z" },
} as ReferenceCaptureManifest;
const produced: ProducedLocalBundle = {
  captureId: manifest.capture_id,
  frozenNow: manifest.plan.frozenNow,
  bundle: { activities: [], wellness: [], ftpHistory: [], athlete: { sportSettings: [] } },
};

async function makeRuntime(runtimeConfig: Config = config, readConfig?: () => Config) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "store-runtime-"));
  roots.push(root);
  let runtime!: StoreRuntime;
  const reference = {
    scheduler: { stop: vi.fn() },
    services: {},
    runScheduledOnce: vi.fn(async () => {
      runtime.attemptLedgerForRun().charge("legacy", "legacy:reference");
      return { kind: "ran", lastSyncAt: "1998-07-18T12:00:00.000Z", refreshed: [] } as const;
    }),
  } as unknown as ReferenceRuntime;
  const capture = vi.fn(
    async (options: Parameters<typeof import("../src/capture.js").runReferenceCapture>[0]) => {
      options.attemptLedger!.charge("store", "store:settings");
      return manifest;
    },
  );
  const produce = vi.fn(async () => produced);
  runtime = createStoreRuntime({
    env: {},
    config: runtimeConfig,
    readConfig,
    home: {
      root,
      storeDir: join(root, "store"),
      archiveDir: join(root, "archive"),
      configDir: join(root, "config"),
    },
    reference,
    dependencies: {
      capture,
      produce,
      now: () => new Date("1998-07-18T12:00:00.000Z"),
      monotonicNow: () => 1,
    },
  });
  return { runtime, capture, produce, reference };
}

describe("StoreRuntime", () => {
  it("starts both request stacks in one ledger window and publishes only after production", async () => {
    const { runtime, reference } = await makeRuntime();
    const result = await runtime.runWindow();
    expect(result.counts).toMatchObject({ storeRequests: 1, legacyRequests: 1, totalRequests: 2 });
    expect(reference.runScheduledOnce).toHaveBeenCalledTimes(1);
    expect(runtime.currentSnapshot()).toBe(produced);
    await runtime.close();
  });

  it("runs the legacy lane without capture when the intervals.icu API key is empty", async () => {
    const { runtime, capture, produce, reference } = await makeRuntime({
      ...config,
      intervals: { ...config.intervals, apiKey: "" },
    });
    const result = await runtime.runWindow();
    expect(result).toMatchObject({
      published: false,
      counts: { storeRequests: 0, legacyRequests: 1, totalRequests: 1 },
      legacySucceeded: true,
    });
    expect(capture).not.toHaveBeenCalled();
    expect(produce).not.toHaveBeenCalled();
    expect(reference.runScheduledOnce).toHaveBeenCalledTimes(1);
    expect(runtime.currentSnapshot()).toBeUndefined();
    await runtime.close();
  });

  it("reads an applied intervals overlay at the next store window", async () => {
    let activeConfig: Config = {
      ...config,
      intervals: { apiKey: "", athleteId: "unconfigured" },
    };
    const { runtime, capture } = await makeRuntime(activeConfig, () => activeConfig);
    await runtime.runWindow();
    expect(capture).not.toHaveBeenCalled();
    activeConfig = {
      ...activeConfig,
      intervals: { apiKey: "placeholder", athleteId: "new-athlete" },
    };
    await runtime.runWindow();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "placeholder", athleteId: "new-athlete" }),
    );
    await runtime.close();
  });

  it("retains the prior complete snapshot after a later capture failure", async () => {
    const { runtime, capture } = await makeRuntime();
    await runtime.runWindow();
    capture.mockRejectedValueOnce(new Error("capture failed"));
    await expect(runtime.runWindow()).rejects.toThrow("capture failed");
    expect(runtime.currentSnapshot()).toBe(produced);
    await runtime.close();
  });

  it("owns one unref'd six-hour timer, skips overlap, and closes once", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "store-runtime-timer-"));
    roots.push(root);
    const unref = vi.fn(),
      clear = vi.fn();
    let delay = 0;
    const handle = { unref } as unknown as ReturnType<typeof setTimeout>;
    let release!: () => void;
    const reference = {
      scheduler: { stop: vi.fn() },
      services: {},
      runScheduledOnce: vi.fn(async () => ({ kind: "ran", lastSyncAt: "", refreshed: [] })),
    } as unknown as ReferenceRuntime;
    const runtime = createStoreRuntime({
      env: {},
      config,
      home: {
        root,
        storeDir: join(root, "store"),
        archiveDir: join(root, "archive"),
        configDir: join(root, "config"),
      },
      reference,
      dependencies: {
        capture: vi.fn(
          () =>
            new Promise<ReferenceCaptureManifest>((resolve) => {
              release = () => resolve(manifest);
            }),
        ),
        produce: vi.fn(async () => produced),
        now: () => new Date("1998-07-18T12:00:00.000Z"),
        monotonicNow: () => 1,
        schedulerDependencies: {
          nowEpochMs: () => new Date("1998-07-18T12:00:00.000Z").getTime(),
          setTimeout: ((_: () => void, ms: number) => {
            delay = ms;
            return handle;
          }) as typeof setTimeout,
          clearTimeout: clear as unknown as typeof clearTimeout,
        },
      },
    });
    runtime.startScheduler();
    runtime.startScheduler();
    expect(delay).toBe(STORE_REFRESH_INTERVAL_MS);
    expect(unref).toHaveBeenCalledTimes(1);
    const first = runtime.runWindow(),
      second = runtime.runWindow();
    expect(first).toBe(second);
    release();
    await first;
    await runtime.close();
    await runtime.close();
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("settles an active window before exclusive work and coalesces refreshes behind it", async () => {
    const { runtime, capture, reference } = await makeRuntime();
    let releaseWindow!: () => void;
    let captureCalls = 0;
    capture.mockImplementation(async () => {
      captureCalls += 1;
      if (captureCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseWindow = resolve;
        });
      }
      return manifest;
    });
    const active = runtime.runWindow();
    while (releaseWindow === undefined) await Promise.resolve();
    let releaseWork!: () => void;
    let markWorkStarted!: () => void;
    const workStarted = new Promise<void>((resolve) => {
      markWorkStarted = resolve;
    });
    const trace: string[] = [];
    const after = runtime.runWindowAfter(async () => {
      trace.push("work");
      markWorkStarted();
      await new Promise<void>((resolve) => {
        releaseWork = resolve;
      });
    });
    await Promise.resolve();
    expect(trace).toEqual([]);
    releaseWindow();
    await active;
    await workStarted;
    const manual = runtime.runWindow();
    expect(manual).toBe(after);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(reference.runScheduledOnce).toHaveBeenCalledTimes(1);
    releaseWork();
    await expect(after).resolves.toMatchObject({ published: true });
    expect(capture).toHaveBeenCalledTimes(2);
    expect(reference.runScheduledOnce).toHaveBeenCalledTimes(2);
    await runtime.close();
  });

  it("does not let failed work poison a later exclusive admission", async () => {
    const { runtime, capture } = await makeRuntime();
    await expect(
      runtime.runWindowAfter(async () => {
        throw new Error("synthetic work failure");
      }),
    ).rejects.toThrow("synthetic work failure");
    expect(capture).not.toHaveBeenCalled();
    await expect(runtime.runWindowAfter(async () => {})).resolves.toMatchObject({
      published: true,
    });
    expect(capture).toHaveBeenCalledTimes(1);
    await expect(runtime.runWindowAfter(null as never)).rejects.toThrow(
      "Window work must be a function.",
    );
    await runtime.close();
  });

  it("aborts and drains pre-window work on close without starting the internal refresh", async () => {
    const { runtime, capture, reference } = await makeRuntime();
    let signal!: AbortSignal;
    let settlements = 0;
    const window = runtime.runWindowAfter(
      (selectedSignal) =>
        new Promise<void>((_, reject) => {
          signal = selectedSignal;
          selectedSignal.addEventListener(
            "abort",
            () => {
              settlements += 1;
              reject(selectedSignal.reason);
            },
            { once: true },
          );
        }),
    );
    while (signal === undefined) await Promise.resolve();
    const rejectedWindow = expect(window).rejects.toThrow("Store runtime closed.");
    const firstClose = runtime.close();
    const secondClose = runtime.close();
    expect(signal.aborted).toBe(true);
    await expect(firstClose).resolves.toBeUndefined();
    await expect(secondClose).resolves.toBeUndefined();
    await rejectedWindow;
    expect(settlements).toBe(1);
    expect(capture).not.toHaveBeenCalled();
    expect(reference.runScheduledOnce).not.toHaveBeenCalled();
    await expect(runtime.runWindowAfter(async () => {})).rejects.toThrow(
      "Store runtime is closed.",
    );
  });

  it("cancels an active window when closed and rejects later windows", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "store-runtime-close-"));
    roots.push(root);
    const handle = { unref: vi.fn() } as unknown as ReturnType<typeof setTimeout>;
    let signal!: AbortSignal;
    const reference = {
      scheduler: { stop: vi.fn() },
      services: {},
      runScheduledOnce: vi.fn(async () => ({ kind: "ran", lastSyncAt: "", refreshed: [] })),
    } as unknown as ReferenceRuntime;
    const runtime = createStoreRuntime({
      env: {},
      config,
      home: {
        root,
        storeDir: join(root, "store"),
        archiveDir: join(root, "archive"),
        configDir: join(root, "config"),
      },
      reference,
      dependencies: {
        capture: vi.fn(
          (options: Parameters<typeof import("../src/capture.js").runReferenceCapture>[0]) => {
            signal = options.budget!.signal;
            return new Promise<ReferenceCaptureManifest>((_, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          },
        ),
        produce: vi.fn(async () => produced),
        now: () => new Date("1998-07-18T12:00:00.000Z"),
        monotonicNow: () => 1,
        schedulerDependencies: {
          nowEpochMs: () => new Date("1998-07-18T12:00:00.000Z").getTime(),
          setTimeout: vi.fn(() => handle) as unknown as typeof setTimeout,
          clearTimeout: vi.fn() as unknown as typeof clearTimeout,
        },
      },
    });
    const window = runtime.runWindow();
    const rejectedWindow = expect(window).rejects.toThrow("Store runtime closed.");
    const close = runtime.close();
    expect(signal.aborted).toBe(true);
    await expect(close).resolves.toBeUndefined();
    await rejectedWindow;
    expect(runtime.currentSnapshot()).toBeUndefined();
    await expect(runtime.runWindow()).rejects.toThrow("Store runtime is closed.");
  });
});
