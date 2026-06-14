import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncMutex } from "../src/concurrency/mutex.js";
import { Cooldown } from "../src/concurrency/cooldown.js";
import {
  createRunSync,
  type FetchedReference,
  BODY_AFTER_TIMEOUT_LOG_PREFIX,
} from "../src/reference/sync/run-sync.js";
import { SCHEDULED_SYNC_INTERVAL_MS } from "../src/reference/freshness.js";
import { LATEST_SCHEMA_VERSION } from "../src/reference/schemas/latest.js";
import { emptyFetched } from "./helpers/reference-fixtures.js";

describe("createRunSync", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reference-run-sync-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns kind:skipped reason:cooldown without acquiring the mutex or fetching when the /sync caller is within the cooldown window", async () => {
    let now = 1_000_000;
    const cooldown = new Cooldown(() => now);
    cooldown.record("telegram:123");
    now += 5_000;

    const fetchSpy = vi.fn();
    const mutex = new AsyncMutex();

    const runSync = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      now: () => new Date(now),
    });

    const result = await runSync({ caller: "/sync", chatId: "telegram:123" });

    expect(result).toEqual({
      kind: "skipped",
      reason: "cooldown",
      retryAfterMs: 25_000,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mutex.isHeld()).toBe(false);
  });

  it("writes 5 cache files first then .scheduler.json (commit-marker) and returns kind:ran with the refreshed list", async () => {
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown();
    const now = new Date("2026-05-09T14:00:00Z");

    const fetchSpy = vi.fn().mockResolvedValue({
      ...emptyFetched,
      latest: { ...emptyFetched.latest, athlete_profile: { id: "test-athlete" } },
    });

    const runSync = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      now: () => now,
    });

    const result = await runSync({ caller: "scheduled" });

    expect(result).toEqual({
      kind: "ran",
      lastSyncAt: now.toISOString(),
      refreshed: ["latest", "history", "intervals", "routes", "ftp_history"],
    });

    const latest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf-8"));
    expect(latest.metadata.schema_version).toBe(LATEST_SCHEMA_VERSION);
    expect(latest.metadata.last_updated).toBe(now.toISOString());
    expect(latest.metadata.freshness).toBe("fresh");
    expect(latest.athlete_profile).toEqual({ id: "test-athlete" });

    const scheduler = JSON.parse(readFileSync(join(dir, ".scheduler.json"), "utf-8"));
    expect(scheduler.last_sync_at).toBe(now.toISOString());
    expect(scheduler.next_sync_at).toBe(
      new Date(now.getTime() + SCHEDULED_SYNC_INTERVAL_MS).toISOString(),
    );

    expect(mutex.isHeld()).toBe(false);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("returns kind:skipped reason:mutex_held when a second concurrent runSync waits past acquireTimeoutMs", async () => {
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown();
    const now = new Date("2026-05-09T14:00:00Z");

    let resolveSlow!: () => void;
    const slowFetch = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveSlow = resolve;
      });
      return emptyFetched;
    });
    const fastFetch = vi.fn().mockResolvedValue(emptyFetched);

    const runSyncSlow = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: slowFetch,
      now: () => now,
      timing: { acquireTimeoutMs: 5_000, hotWarnMs: 1_000 },
    });
    const runSyncFast = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: fastFetch,
      now: () => now,
      timing: { acquireTimeoutMs: 30, hotWarnMs: 10 },
    });

    const p1 = runSyncSlow({ caller: "scheduled" });
    const p2 = runSyncFast({ caller: "scheduled" });

    const r2 = await p2;
    expect(r2).toEqual({ kind: "skipped", reason: "mutex_held" });
    expect(fastFetch).not.toHaveBeenCalled();

    resolveSlow();
    const r1 = await p1;
    expect(r1.kind).toBe("ran");
    expect(slowFetch).toHaveBeenCalledOnce();
  });

  it("times out at outerTimeoutMs: aborts the controller, writes error_state.json with phase, releases mutex, returns kind:failed", async () => {
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown();
    const now = new Date("2026-05-09T14:00:00Z");

    let capturedSignal: AbortSignal | null = null;
    const hangingFetch = vi.fn(async (signal: AbortSignal): Promise<FetchedReference> => {
      capturedSignal = signal;
      return await new Promise<FetchedReference>(() => {});
    });

    const runSync = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: hangingFetch,
      now: () => now,
      timing: { outerTimeoutMs: 30 },
    });

    const result = await runSync({ caller: "scheduled" });

    expect(result).toEqual({ kind: "failed", reason: "outer_timeout", failures: [] });
    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal!.aborted).toBe(true);
    expect(mutex.isHeld()).toBe(false);

    const errorState = JSON.parse(
      readFileSync(join(dir, "error_state.json"), "utf-8"),
    );
    expect(errorState.step).toBe("outer_timeout");
    expect(errorState.phase).toBe("fetching");

    // No cache files were written
    expect(() => readFileSync(join(dir, "latest.json"), "utf-8")).toThrow();
    expect(() => readFileSync(join(dir, ".scheduler.json"), "utf-8")).toThrow();
  });

  it("on gate rejection writes error_state.json with step=gate_rejected (no phase) and returns kind:failed reason:gate_rejected", async () => {
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown();
    const now = new Date("2026-05-09T14:00:00Z");

    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);
    const rejectingGate = vi.fn().mockReturnValue({
      ok: false,
      failures: [
        { step: "ftp_source_check", detail: "FTP source missing on athlete profile" },
      ],
      warnings: [],
    });

    const runSync = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      gate: rejectingGate,
      now: () => now,
    });

    const result = await runSync({ caller: "scheduled" });

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toBe("gate_rejected");
      expect(result.failures).toEqual([
        { file: "latest", reason: "ftp_source_check: FTP source missing on athlete profile" },
      ]);
    }

    const errorState = JSON.parse(
      readFileSync(join(dir, "error_state.json"), "utf-8"),
    );
    expect(errorState.step).toBe("gate_rejected");
    expect(errorState.detail).toContain("ftp_source_check");
    expect(errorState.phase).toBeUndefined();

    expect(() => readFileSync(join(dir, "latest.json"), "utf-8")).toThrow();
    expect(() => readFileSync(join(dir, ".scheduler.json"), "utf-8")).toThrow();
    expect(mutex.isHeld()).toBe(false);
  });

  it("when outer timeout fires during writing_scheduler phase, error_state.phase reflects it and caches survive", async () => {
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown();
    const now = new Date("2026-05-09T14:00:00Z");
    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);

    const { atomicWriteJson: realAtomicWrite } = await import(
      "../src/io/atomic-write-json.js"
    );

    // The scheduler write parks on schedulerGate, so the body sits inside the
    // .scheduler.json write (phase === "writing_scheduler") until the hand-fired
    // outer timer wins the race — no wall-clock dependence. `arrivedAtGate`
    // resolves the instant the body reaches the parked scheduler write, so the
    // test fires the timer at exactly the right phase regardless of how long the
    // upstream cache writes take.
    let releaseScheduler!: () => void;
    const schedulerGate = new Promise<void>((resolve) => {
      releaseScheduler = resolve;
    });
    let signalArrived!: () => void;
    const arrivedAtGate = new Promise<void>((resolve) => {
      signalArrived = resolve;
    });
    const pendingWrites: Array<Promise<unknown>> = [];
    const latchedSchedulerWrite = vi.fn(
      async (path: string, value: unknown): Promise<void> => {
        if (path.endsWith(".scheduler.json")) {
          signalArrived();
          await schedulerGate;
        }
        const w = realAtomicWrite(path, value);
        pendingWrites.push(w);
        await w;
      },
    );

    let capturedTimeoutFn!: () => void;
    const setTimeoutFn = vi.fn((fn: () => void) => {
      capturedTimeoutFn = fn;
      return 1;
    });
    const clearTimeoutFn = vi.fn();

    // Suppress the expected body-after-timeout warn from the dangling
    // scheduler write that completes after the orchestrator returns.
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const runSync = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      atomicWrite: latchedSchedulerWrite,
      clock: { setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn },
      now: () => now,
      timing: { outerTimeoutMs: 300 },
    });

    const p = runSync({ caller: "scheduled" });

    // Synchronize on the body parking at the scheduler write (phase ===
    // "writing_scheduler"), then fire the captured outer-timer callback by hand.
    await arrivedAtGate;
    await Promise.resolve();

    capturedTimeoutFn();
    const result = await p;

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toBe("outer_timeout");
    }

    const errorState = JSON.parse(
      readFileSync(join(dir, "error_state.json"), "utf-8"),
    );
    expect(errorState.step).toBe("outer_timeout");
    expect(errorState.phase).toBe("writing_scheduler");

    // All 5 cache files survived the partial commit; only .scheduler.json never landed.
    expect(() => readFileSync(join(dir, "latest.json"), "utf-8")).not.toThrow();
    expect(() => readFileSync(join(dir, "history.json"), "utf-8")).not.toThrow();
    expect(() => readFileSync(join(dir, "intervals.json"), "utf-8")).not.toThrow();
    expect(() => readFileSync(join(dir, "routes.json"), "utf-8")).not.toThrow();
    expect(() => readFileSync(join(dir, "ftp_history.json"), "utf-8")).not.toThrow();
    expect(() => readFileSync(join(dir, ".scheduler.json"), "utf-8")).toThrow();

    expect(mutex.isHeld()).toBe(false);

    // Let the dangling scheduler write settle before afterEach removes the dir.
    releaseScheduler();
    await schedulerGate;
    await Promise.resolve();
    await Promise.allSettled(pendingWrites);
  });

  // ── A1: body must NOT proceed past writing_cache once outer timeout fired ──

  it("A1: when outer timeout fires during writing_cache, body bails before writing .scheduler.json", async () => {
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown();
    const now = new Date("2026-05-09T14:00:00Z");
    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);

    const { atomicWriteJson: realAtomicWrite } = await import(
      "../src/io/atomic-write-json.js"
    );

    // Every cache write parks on cacheGate, so the body sits at
    // phase === "writing_cache" until the hand-fired outer timer wins; abort
    // then runs while in writing_cache, so the A1 guard bails the body before
    // the scheduler write. `arrivedAtGate` resolves the instant the first cache
    // write reaches the gate, so the timer fires at exactly the writing_cache
    // phase regardless of upstream timing.
    let releaseCache!: () => void;
    const cacheGate = new Promise<void>((resolve) => {
      releaseCache = resolve;
    });
    let signalArrived: (() => void) | null = () => {};
    const arrivedAtGate = new Promise<void>((resolve) => {
      signalArrived = resolve;
    });
    const pendingWrites: Array<Promise<unknown>> = [];
    const latchedCacheWrite = vi.fn(
      async (path: string, value: unknown): Promise<void> => {
        if (!path.endsWith(".scheduler.json")) {
          if (signalArrived !== null) {
            signalArrived();
            signalArrived = null;
          }
          await cacheGate;
        }
        const w = realAtomicWrite(path, value);
        pendingWrites.push(w);
        await w;
      },
    );

    let capturedTimeoutFn!: () => void;
    const setTimeoutFn = vi.fn((fn: () => void) => {
      capturedTimeoutFn = fn;
      return 1;
    });
    const clearTimeoutFn = vi.fn();

    const runSync = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      atomicWrite: latchedCacheWrite,
      clock: { setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn },
      now: () => now,
      timing: { outerTimeoutMs: 30 },
    });

    const p = runSync({ caller: "scheduled" });

    // Synchronize on the body parking inside the held cache writes (phase ===
    // "writing_cache"), then fire the captured outer-timer callback by hand.
    await arrivedAtGate;
    await Promise.resolve();

    capturedTimeoutFn();
    const result = await p;

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toBe("outer_timeout");
    }

    const errorState = JSON.parse(
      readFileSync(join(dir, "error_state.json"), "utf-8"),
    );
    expect(errorState.step).toBe("outer_timeout");
    expect(errorState.phase).toBe("writing_cache");

    // The 5 cache files COMPLETED (they were already in flight when abort fired —
    // filesystem writes aren't cancellable). Without the A1 fix, .scheduler.json
    // would also have been written, contradicting the error_state.json marker.
    // With A1: scheduler.json must NOT exist.
    expect(() => readFileSync(join(dir, ".scheduler.json"), "utf-8")).toThrow();

    expect(mutex.isHeld()).toBe(false);

    // Let the held cache writes finish, then drain microtasks so the body runs
    // through its aborted-guard and returns, all before afterEach removes the dir.
    releaseCache();
    await cacheGate;
    await Promise.allSettled(pendingWrites);
    await Promise.resolve();
    await Promise.resolve();
  });

  // ── A2: body throws after timeout — error must NOT be silently swallowed ──

  it("A2: a body throw after outer timeout fired is logged via console.warn (not silently swallowed)", async () => {
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown();
    const now = new Date("2026-05-09T14:00:00Z");
    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // atomicWrite that throws (simulating disk-full or fs error) AFTER a 200ms
    // delay. With outerTimeoutMs: 20, the outer race wins ("timeout") at ~20ms;
    // the body's await of this write rejects at ~200ms. The 10× gap keeps the
    // test deterministic on slow CI runners.
    const failingWrite = vi.fn(async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      throw new Error("simulated disk-full mid-write");
    });

    const runSync = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      atomicWrite: failingWrite,
      now: () => now,
      timing: { outerTimeoutMs: 20 },
    });

    const result = await runSync({ caller: "scheduled" });

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toBe("outer_timeout");
    }

    // The body throws ~200ms AFTER the orchestrator returned. Its error reaches
    // the bodySettled handler, which logs via console.warn. Wait explicitly with
    // a generous timeout so a slow CI runner doesn't false-fail.
    await vi.waitFor(
      () => {
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining(BODY_AFTER_TIMEOUT_LOG_PREFIX),
        );
      },
      { timeout: 1_000, interval: 10 },
    );

    expect(mutex.isHeld()).toBe(false);
  });

  // Records cooldown only on success (kind:ran), never on skipped/failed.
  it("records cooldown for /sync only after a successful kind:ran result", async () => {
    let nowMs = 1_000_000;
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown(() => nowMs);
    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);

    const runSync = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      now: () => new Date(nowMs),
    });

    // First /sync — succeeds, records cooldown.
    const r1 = await runSync({ caller: "/sync", chatId: "chat-1" });
    expect(r1.kind).toBe("ran");

    // Second /sync within window — gated by cooldown.
    nowMs += 5_000;
    const r2 = await runSync({ caller: "/sync", chatId: "chat-1" });
    expect(r2).toEqual({
      kind: "skipped",
      reason: "cooldown",
      retryAfterMs: 25_000,
    });
  });

  it("soft-fail path: gate warnings → latest.json + .scheduler.json written, error_state mitigation:warn_only, kind:ran", async () => {
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown();
    const now = new Date("2026-05-09T14:00:00Z");

    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);
    const warningGate = vi.fn().mockReturnValue({
      ok: true,
      failures: [],
      warnings: [{ step: "step6_freshness_24h", detail: "data freshness=stale" }],
      freshness: "stale",
    });

    const runSync = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      gate: warningGate,
      now: () => now,
    });

    const result = await runSync({ caller: "scheduled" });
    expect(result.kind).toBe("ran");

    const latest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf-8"));
    expect(latest.metadata.freshness).toBe("stale");

    expect(() => readFileSync(join(dir, ".scheduler.json"), "utf-8")).not.toThrow();

    const errorState = JSON.parse(readFileSync(join(dir, "error_state.json"), "utf-8"));
    expect(errorState.step).toBe("gate_warnings");
    expect(errorState.mitigation).toBe("warn_only");
    expect(errorState.detail).toContain("step6_freshness_24h");
  });

  it("clear-on-success: a clean sync removes a pre-existing error_state.json, only after the commit marker", async () => {
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown();
    const now = new Date("2026-05-09T14:00:00Z");
    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);

    // Pre-create a stale error_state.json from a prior failed run.
    const { writeErrorState } = await import("../src/reference/sync/error-state-writer.js");
    await writeErrorState(dir, { step: "outer_timeout", detail: "prior failure" });
    expect(() => readFileSync(join(dir, "error_state.json"), "utf-8")).not.toThrow();

    const runSync = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      now: () => now,
    });

    const result = await runSync({ caller: "scheduled" });
    expect(result.kind).toBe("ran");

    expect(() => readFileSync(join(dir, "error_state.json"), "utf-8")).toThrow();
    expect(() => readFileSync(join(dir, ".scheduler.json"), "utf-8")).not.toThrow();
  });

  it("freshness wiring: gate's freshness band lands on latest.json.metadata.freshness (not hardcoded fresh)", async () => {
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown();
    const now = new Date("2026-05-09T14:00:00Z");
    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);

    const flaggingGate = vi.fn().mockReturnValue({
      ok: true,
      failures: [],
      warnings: [],
      freshness: "flag",
    });

    const runSync = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      gate: flaggingGate,
      now: () => now,
    });

    const result = await runSync({ caller: "scheduled" });
    expect(result.kind).toBe("ran");

    const latest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf-8"));
    expect(latest.metadata.freshness).toBe("flag");
  });

  it("uses the injected clock.setTimeout/clearTimeout for the outer timer with the configured ms", async () => {
    const mutex = new AsyncMutex();
    const cooldown = new Cooldown();
    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);

    const setSpy = vi.fn((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clearSpy = vi.fn((handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    );

    const runSync = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      clock: { setTimeout: setSpy, clearTimeout: clearSpy },
      timing: { outerTimeoutMs: 7_777 },
    });

    const result = await runSync({ caller: "scheduled" });

    expect(result.kind).toBe("ran");
    // The outer-timeout race calls setTimeoutFn with the configured ms.
    // Asserting the ms argument prevents a regression where someone calls
    // global setTimeout directly while still touching the spy elsewhere.
    expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 7_777);
    // clearTimeoutFn must receive the handle that setTimeoutFn returned.
    const expectedHandle = setSpy.mock.results[0]?.value;
    expect(clearSpy).toHaveBeenCalledWith(expectedHandle);
  });
});
