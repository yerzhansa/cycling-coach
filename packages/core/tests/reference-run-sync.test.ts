// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncMutex } from "../src/reference/sync/mutex.js";
import { Cooldown } from "../src/reference/sync/cooldown.js";
import {
  createRunSync,
  type FetchedReference,
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

  it("returns skipped: cooldown without acquiring the mutex or fetching when the /sync caller is within the cooldown window", async () => {
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

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe("cooldown");
    expect(result.retryAfterMs).toBe(25_000);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mutex.isHeld()).toBe(false);
  });

  it("writes 5 cache files first then .scheduler.json (commit-marker) and returns ok with the refreshed list", async () => {
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

    expect(result.ok).toBe(true);
    expect(result.refreshed).toEqual([
      "latest",
      "history",
      "intervals",
      "routes",
      "ftp_history",
    ]);
    expect(result.failures).toEqual([]);
    expect(result.lastSyncAt).toBe(now.toISOString());
    expect(result.skipped).toBeUndefined();

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

  it("returns skipped: mutex_held when a second concurrent runSync waits past acquireTimeoutMs", async () => {
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
      timing: { acquireTimeoutMs: 5_000 },
    });
    const runSyncFast = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: fastFetch,
      now: () => now,
      timing: { acquireTimeoutMs: 30 },
    });

    const p1 = runSyncSlow({ caller: "scheduled" });
    const p2 = runSyncFast({ caller: "scheduled" });

    const r2 = await p2;
    expect(r2.ok).toBe(true);
    expect(r2.skipped).toBe("mutex_held");
    expect(fastFetch).not.toHaveBeenCalled();

    resolveSlow();
    const r1 = await p1;
    expect(r1.ok).toBe(true);
    expect(r1.skipped).toBeUndefined();
    expect(slowFetch).toHaveBeenCalledOnce();
  });

  it("times out at outerTimeoutMs: aborts the controller, writes error_state.json with phase, releases mutex, returns ok:false", async () => {
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

    expect(result.ok).toBe(false);
    expect(result.refreshed).toEqual([]);
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

  it("on gate rejection writes error_state.json with step=gate_rejected (no phase) and writes no cache files", async () => {
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

    expect(result.ok).toBe(false);
    expect(result.refreshed).toEqual([]);
    expect(result.failures).toEqual([
      { file: "latest", reason: "ftp_source_check: FTP source missing on athlete profile" },
    ]);

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

    // Real atomicWriteJson for cache files; injected slow write only for .scheduler.json.
    const { atomicWriteJson: realAtomicWrite } = await import(
      "../src/reference/io/atomic-write.js"
    );
    const slowSchedulerWrite = vi.fn(
      async (path: string, value: unknown): Promise<void> => {
        if (path.endsWith(".scheduler.json")) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        await realAtomicWrite(path, value);
      },
    );

    const runSync = createRunSync({
      dataDir: dir,
      mutex,
      cooldown,
      cooldownWindowMs: 30_000,
      fetchReferenceData: fetchSpy,
      atomicWrite: slowSchedulerWrite,
      now: () => now,
      timing: { outerTimeoutMs: 50 },
    });

    const result = await runSync({ caller: "scheduled" });

    expect(result.ok).toBe(false);

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
  });
});
