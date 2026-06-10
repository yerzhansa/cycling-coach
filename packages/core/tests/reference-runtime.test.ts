import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapReference,
  INITIAL_SYNC_FAILED_LOG_PREFIX,
} from "../src/reference/runtime.js";
import { ReferenceConfigError } from "../src/reference/errors.js";
import type { ReferenceSportAdapter } from "../src/reference/sport-adapter.js";
import type { Sport } from "../src/sport.js";
import { Scheduler } from "../src/reference/sync/scheduler.js";
import { emptyFetched } from "./helpers/reference-fixtures.js";

// A real `cyclingSport` import would create a core→sport-cycling dependency
// cycle (core declares no such dep), so every call site uses a minimal fake.
const fakeSport = (
  overrides: Partial<Pick<Sport, "intervalsActivityTypes" | "referenceAdapters">> = {},
): Sport =>
  ({
    intervalsActivityTypes: [],
    referenceAdapters: undefined,
    ...overrides,
  }) as unknown as Sport;

// Source-anchor checks for run-binary.ts's outer init order live in
// `run-binary-init-order.test.ts` — different test category, different
// invalidation profile. This file is purely behavioral.

const fetchedWithAthlete = (id: string) => ({
  ...emptyFetched,
  latest: { ...emptyFetched.latest, athlete_profile: { id } },
});

describe("bootstrapReference (behavioral)", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "reference-runtime-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("creates the reference data directory under dataDir/data with owner-only 0o700", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);

    const runtime = await bootstrapReference({
      dataDir,
      intervals: { apiKey: "test-key" },
      sport: fakeSport(),
      fetchReferenceData: fetchSpy,
    });

    expect(existsSync(join(dataDir, "data"))).toBe(true);
    expect(statSync(join(dataDir, "data")).mode & 0o777).toBe(0o700);
    runtime.scheduler.stop();
  });

  it("calls fetchReferenceData exactly once during bootstrap (the initial sync)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);

    const runtime = await bootstrapReference({
      dataDir,
      intervals: { apiKey: "test-key" },
      sport: fakeSport(),
      fetchReferenceData: fetchSpy,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    runtime.scheduler.stop();
  });

  it("writes the 5 cache files + .scheduler.json after the initial sync resolves", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);

    const runtime = await bootstrapReference({
      dataDir,
      intervals: { apiKey: "test-key" },
      sport: fakeSport(),
      fetchReferenceData: fetchSpy,
    });

    const referenceData = join(dataDir, "data");
    expect(existsSync(join(referenceData, "latest.json"))).toBe(true);
    expect(existsSync(join(referenceData, "history.json"))).toBe(true);
    expect(existsSync(join(referenceData, "intervals.json"))).toBe(true);
    expect(existsSync(join(referenceData, "routes.json"))).toBe(true);
    expect(existsSync(join(referenceData, "ftp_history.json"))).toBe(true);
    expect(existsSync(join(referenceData, ".scheduler.json"))).toBe(true);

    runtime.scheduler.stop();
  });

  it("does not throw when the initial fetch fails (best-effort init)", async () => {
    const failingFetch = vi.fn().mockRejectedValue(new Error("intervals.icu unreachable"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const runtime = await bootstrapReference({
      dataDir,
      intervals: { apiKey: "test-key" },
      sport: fakeSport(),
      fetchReferenceData: failingFetch,
    });

    expect(runtime).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(INITIAL_SYNC_FAILED_LOG_PREFIX),
    );
    runtime.scheduler.stop();
  });

  it("scheduler.start() fires AFTER the initial fetch resolves (two-phase per ADR-0011)", async () => {
    const events: string[] = [];

    let releaseFetch!: () => void;
    const slowFetch = vi.fn(async () => {
      events.push("fetch-start");
      await new Promise<void>((resolve) => {
        releaseFetch = resolve;
      });
      events.push("fetch-end");
      return emptyFetched;
    });

    const startSpy = vi
      .spyOn(Scheduler.prototype, "start")
      .mockImplementation(function (this: Scheduler) {
        events.push("scheduler-start");
        // Do not actually register the timer (avoid leaking across tests).
      });

    const bootstrapPromise = bootstrapReference({
      dataDir,
      intervals: { apiKey: "test-key" },
      sport: fakeSport(),
      fetchReferenceData: slowFetch,
    });

    // Drain microtasks until the fetch spy has been entered. Avoids a
    // 10ms wall-clock delay that can flake under CI runner pressure.
    while (events.length === 0) {
      await new Promise(setImmediate);
    }
    expect(events).toEqual(["fetch-start"]);
    expect(startSpy).not.toHaveBeenCalled();

    releaseFetch();
    const runtime = await bootstrapPromise;

    expect(events).toEqual(["fetch-start", "fetch-end", "scheduler-start"]);
    expect(runtime.scheduler).toBeInstanceOf(Scheduler);
  });

  it("services.runSync accepts the narrowed RunSyncRequest (no caller / forceFresh exposed)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);

    const runtime = await bootstrapReference({
      dataDir,
      intervals: { apiKey: "test-key" },
      sport: fakeSport(),
      fetchReferenceData: fetchSpy,
    });

    // Type-narrowing assertion: services.runSync's parameter is RunSyncRequest
    // (just `chatId`). If the type widens to RunSyncOpts in a future refactor,
    // the test below would still pass at runtime — but TypeScript would let
    // operator/curator-mode flags through. Keep the test focused on behavior
    // that IS observable: a /sync call with chatId works.
    const result = await runtime.services.runSync({ chatId: "telegram:99999" });

    expect(result.kind).toBe("ran");
    // Two fetches: bootstrap's `caller: scheduled` + this services.runSync's
    // `caller: /sync` (different cooldown key, so not gated).
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    runtime.scheduler.stop();
  });

  it("services.loadLatest returns the cached LatestJson after a successful sync", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(fetchedWithAthlete("test-athlete"));

    const runtime = await bootstrapReference({
      dataDir,
      intervals: { apiKey: "test-key" },
      sport: fakeSport(),
      fetchReferenceData: fetchSpy,
    });

    const latest = runtime.services.loadLatest();
    expect(latest).not.toBeNull();
    expect(latest!.athlete_profile).toEqual({ id: "test-athlete" });
    expect(latest!.metadata.freshness).toBe("fresh");

    runtime.scheduler.stop();
  });

  it("services.loadLatest returns null when no cache exists (first run, fetch failed)", async () => {
    const failingFetch = vi.fn().mockRejectedValue(new Error("network down"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const runtime = await bootstrapReference({
      dataDir,
      intervals: { apiKey: "test-key" },
      sport: fakeSport(),
      fetchReferenceData: failingFetch,
    });

    expect(runtime.services.loadLatest()).toBeNull();
    runtime.scheduler.stop();
  });

  it("services.maybeRefreshIfStale stub does not trigger a sync (body lands later)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);

    const runtime = await bootstrapReference({
      dataDir,
      intervals: { apiKey: "test-key" },
      sport: fakeSport(),
      fetchReferenceData: fetchSpy,
    });

    const result = await runtime.services.maybeRefreshIfStale();
    expect(result.kind).toBe("fresh");
    // The stub MUST NOT trigger an extra fetch — only the bootstrap sync ran.
    // This assertion survives the future body landing (a real
    // maybeRefreshIfStale MAY fire syncs based on freshness band; this test
    // will need a re-shape then).
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    runtime.scheduler.stop();
  });
});

describe("bootstrapReference (fail-fast on misconfigured adapters)", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "reference-runtime-failfast-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const rideAdapter = (): ReferenceSportAdapter => ({
    activityTypes: ["Ride"],
    zoneBasis: "power",
    decouplingBasis: "power",
    sustainabilityAnchors: [],
    dfaValidated: true,
  });

  it("rejects with ReferenceConfigError when two adapters overlap, before any IO", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);
    const overlappingSport = fakeSport({
      intervalsActivityTypes: ["Ride"],
      referenceAdapters: () => [rideAdapter(), rideAdapter()],
    });

    await expect(
      bootstrapReference({
        dataDir,
        intervals: { apiKey: "test-key" },
        sport: overlappingSport,
        fetchReferenceData: fetchSpy,
      }),
    ).rejects.toBeInstanceOf(ReferenceConfigError);

    expect(existsSync(join(dataDir, "data"))).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects with ReferenceConfigError when an adapter claims a type outside the sport, before any IO", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(emptyFetched);
    const strayingSport = fakeSport({
      intervalsActivityTypes: [],
      referenceAdapters: () => [rideAdapter()],
    });

    await expect(
      bootstrapReference({
        dataDir,
        intervals: { apiKey: "test-key" },
        sport: strayingSport,
        fetchReferenceData: fetchSpy,
      }),
    ).rejects.toBeInstanceOf(ReferenceConfigError);

    expect(existsSync(join(dataDir, "data"))).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

