import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import type { CoachStoreWriterContext } from "../src/runtime.js";
import { createCoachOperations } from "../src/operations.js";

const home: AthleteHome = {
  root: "/synthetic/athlete",
  storeDir: "/synthetic/athlete/store",
  archiveDir: "/synthetic/athlete/archive",
  configDir: "/synthetic/athlete/config",
};

function context(): CoachStoreWriterContext {
  return {
    home,
    store: {} as CoachStoreWriterContext["store"],
    listener: {} as CoachStoreWriterContext["listener"],
  };
}

function requestCounts(storeRequests: number, legacyRequests: number) {
  return {
    storeRequests,
    legacyRequests,
    totalRequests: storeRequests + legacyRequests,
    byTag: {
      "store:activities": 0,
      "store:wellness": 0,
      "store:settings": 0,
      "store:streams": 0,
      "legacy:reference": 0,
    },
  };
}

function intervalsCredentials(apiKey = "", athleteId = "0") {
  return {
    read: vi.fn(async () => ({ apiKey, athleteId })),
  };
}

describe("coach operations", () => {
  it("imports synthetic activity files through the live store and deduplicates reruns", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "coach-operations-"));
    const liveHome: AthleteHome = {
      root,
      storeDir: join(root, "store"),
      archiveDir: join(root, "archive"),
      configDir: join(root, "config"),
    };
    const store = openSqliteStorage(join(root, "coach.db"));
    try {
      await runMigrations(store, MIGRATIONS);
      const liveContext: CoachStoreWriterContext = {
        home: liveHome,
        store,
        listener: {} as CoachStoreWriterContext["listener"],
      };
      const operations = createCoachOperations({
        home: liveHome,
        context: liveContext,
        runtime: { runWindowAfter: vi.fn() },
        intervalsCredentials: intervalsCredentials(),
        historyNewestDate: () => "1998-07-18",
        applyRuntimeConfig: async () => {},
      });
      const paths = ["brick-cycling.fit", "fallback-cycling.tcx", "fallback-cycling.gpx"].map(
        (name) => resolve("packages/kernel-node/tests/fixtures/ingest", name),
      );
      const first = await operations.importFiles({ paths });
      expect(first.files).toEqual({ total: 3, imported: 3, quarantined: 0 });
      expect(first.changes.rawFilesInserted).toBe(3);
      expect(Number((await store.get("SELECT count(*) AS count FROM raw_file"))?.count)).toBe(3);
      expect(
        (await readdir(liveHome.archiveDir, { recursive: true })).filter((entry) =>
          /\.(fit|tcx|gpx)$/u.test(entry),
        ),
      ).toHaveLength(3);
      const second = await operations.importFiles({ paths });
      expect(second.changes.rawFilesInserted).toBe(0);
      expect(Number((await store.get("SELECT count(*) AS count FROM raw_file"))?.count)).toBe(3);
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("idempotently replaces one daemon-authored intake row", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "coach-intake-"));
    const liveHome: AthleteHome = {
      root,
      storeDir: join(root, "store"),
      archiveDir: join(root, "archive"),
      configDir: join(root, "config"),
    };
    const store = openSqliteStorage(join(root, "coach.db"));
    try {
      await runMigrations(store, MIGRATIONS);
      const operations = createCoachOperations({
        home: liveHome,
        context: {
          home: liveHome,
          store,
          listener: {} as CoachStoreWriterContext["listener"],
        },
        runtime: { runWindowAfter: vi.fn() },
        intervalsCredentials: intervalsCredentials(),
        historyNewestDate: () => "1998-07-18",
        applyRuntimeConfig: async () => {},
      });
      await expect(
        operations.saveIntake({
          swim_skill_floor: null,
          continuous_distance_capable: null,
          open_water_comfort: null,
          prior_bsi: false,
          clinician_cleared: null,
          injury_status: "none",
        }),
      ).resolves.toEqual({ schemaVersion: 1, saved: true });
      const first = await store.get("SELECT * FROM intake_flags");
      await operations.saveIntake({
        swim_skill_floor: null,
        continuous_distance_capable: null,
        open_water_comfort: null,
        prior_bsi: true,
        clinician_cleared: false,
        injury_status: "managing",
      });
      const second = await store.get("SELECT * FROM intake_flags");
      expect(await store.all("SELECT id FROM intake_flags")).toHaveLength(1);
      expect(second).toMatchObject({
        prior_bsi: 1,
        clinician_cleared: 0,
        injury_status: "managing",
        device_id: first?.device_id,
      });
      expect(second?.id).not.toBe(first?.id);
      expect(Number(second?.hlc_counter)).toBeGreaterThanOrEqual(Number(first?.hlc_counter));
      await expect(async () =>
        operations.saveIntake({
          swim_skill_floor: null,
          continuous_distance_capable: null,
          open_water_comfort: null,
          prior_bsi: false,
          clinician_cleared: null,
          injury_status: "none",
          extra: true,
        } as never),
      ).rejects.toThrow();
      await expect(async () =>
        operations.saveIntake({
          swim_skill_floor: null,
          continuous_distance_capable: null,
          open_water_comfort: null,
          prior_bsi: true,
          clinician_cleared: null,
          injury_status: "returning",
        }),
      ).rejects.toThrow();
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps canonical import and sync reports with exact progress", async () => {
    const importFiles = vi.fn(async () => ({
      files: [{ outcome: "imported" }, { outcome: "quarantined" }],
      inserts: { raw_file: 1, source_record: 2 },
      updates: { source_record: 3, relinked_source_records: 4 },
    })) as unknown as Parameters<typeof createCoachOperations>[1] extends infer D
      ? D extends { importFiles: infer F }
        ? F
        : never
      : never;
    const runWindowAfter = vi.fn(async (work: (signal: AbortSignal) => Promise<void>) => {
      await work(new AbortController().signal);
      return {
        published: true,
        legacySucceeded: false,
        counts: requestCounts(2, 1),
      };
    });
    const operations = createCoachOperations(
      {
        home,
        context: context(),
        runtime: { runWindowAfter },
        intervalsCredentials: intervalsCredentials(),
        historyNewestDate: () => "1998-07-18",
        applyRuntimeConfig: async () => {},
      },
      { importFiles },
    );
    const importEvents: unknown[] = [];
    await expect(
      operations.importFiles({ paths: ["/synthetic/a.fit", "/synthetic/b.tcx"] }, (event) =>
        importEvents.push(event),
      ),
    ).resolves.toEqual({
      schemaVersion: 1,
      files: { total: 2, imported: 1, quarantined: 1 },
      changes: {
        rawFilesInserted: 1,
        sourceRecordsInserted: 2,
        sourceRecordsUpdated: 3,
        relinkedSourceRecords: 4,
      },
    });
    expect(importEvents).toEqual([
      { phase: "started", completed: 0, total: 2 },
      { phase: "completed", completed: 2, total: 2 },
    ]);
    await expect(
      operations.sync({}, () => {
        throw new Error("advisory");
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      published: true,
      referenceSucceeded: false,
      requests: { store: 2, reference: 1, total: 3 },
    });
    expect(importFiles).toHaveBeenCalledTimes(1);
    expect(runWindowAfter).toHaveBeenCalledTimes(1);
  });

  it("serializes both methods in admission order and recovers after rejection", async () => {
    let release!: () => void;
    const latch = new Promise<void>((resolve) => {
      release = resolve;
    });
    const trace: string[] = [];
    const importFiles = vi.fn(async () => {
      trace.push("import-start");
      await latch;
      trace.push("import-end");
      throw new Error("synthetic failure");
    }) as unknown as Parameters<typeof createCoachOperations>[1] extends infer D
      ? D extends { importFiles: infer F }
        ? F
        : never
      : never;
    const runWindowAfter = vi.fn(async (work: (signal: AbortSignal) => Promise<void>) => {
      await work(new AbortController().signal);
      trace.push("sync");
      return {
        published: false,
        legacySucceeded: true,
        counts: requestCounts(0, 0),
      };
    });
    const operations = createCoachOperations(
      {
        home,
        context: context(),
        runtime: { runWindowAfter },
        intervalsCredentials: intervalsCredentials(),
        historyNewestDate: () => "1998-07-18",
        applyRuntimeConfig: async () => {},
      },
      { importFiles },
    );
    const first = operations.importFiles({ paths: ["/synthetic/a.fit"] });
    const second = operations.sync({});
    await Promise.resolve();
    expect(trace).toEqual(["import-start"]);
    release();
    await expect(first).rejects.toThrow("synthetic failure");
    await expect(second).resolves.toMatchObject({ schemaVersion: 1 });
    expect(trace).toEqual(["import-start", "import-end", "sync"]);
  });

  it("reads live credentials after admission and orders backfill before refresh and completion", async () => {
    const trace: string[] = [];
    const selectedContext = context();
    const credentials = {
      read: vi.fn(async () => {
        trace.push("credentials");
        return {
          apiKey: String.fromCharCode(116, 101, 115, 116),
          athleteId: "synthetic-athlete",
        };
      }),
    };
    const backfill = vi.fn(async () => {
      trace.push("backfill");
      return { pages: 1, artifacts: 1, reports: [] };
    });
    const runWindowAfter = vi.fn(async (work: (signal: AbortSignal) => Promise<void>) => {
      trace.push("admitted");
      await work(new AbortController().signal);
      trace.push("window");
      return {
        published: true,
        legacySucceeded: true,
        counts: requestCounts(3, 2),
      };
    });
    const operations = createCoachOperations(
      {
        home,
        context: selectedContext,
        runtime: { runWindowAfter },
        intervalsCredentials: credentials,
        historyNewestDate: () => "1998-07-18",
        applyRuntimeConfig: async () => {},
      },
      { backfill },
    );
    const result = await operations.sync({}, (event) => trace.push(event.phase));
    trace.push("terminal");
    expect(trace).toEqual([
      "started",
      "admitted",
      "credentials",
      "backfill",
      "window",
      "completed",
      "terminal",
    ]);
    expect(credentials.read).toHaveBeenCalledTimes(1);
    expect(backfill).toHaveBeenCalledWith({
      home,
      store: selectedContext.store,
      apiKey: String.fromCharCode(116, 101, 115, 116),
      athleteId: "synthetic-athlete",
      historyNewestDate: "1998-07-18",
      signal: expect.any(AbortSignal),
    });
    expect(result).toEqual({
      schemaVersion: 1,
      published: true,
      referenceSucceeded: true,
      requests: { store: 3, reference: 2, total: 5 },
    });
    const terminal = JSON.stringify(result);
    for (const privateValue of [
      String.fromCharCode(116, 101, 115, 116),
      "synthetic-athlete",
      "1998-07-18",
      home.archiveDir,
      "cursor",
      "payload",
      "cause",
    ]) {
      expect(terminal).not.toContain(privateValue);
    }
  });

  it("skips backfill for every empty-key state and defaults an empty athlete id", async () => {
    const pairs = [
      { apiKey: "", athleteId: "", outcome: "skip" },
      { apiKey: "", athleteId: "0", outcome: "skip" },
      { apiKey: "", athleteId: "synthetic-athlete", outcome: "skip" },
      { apiKey: String.fromCharCode(116, 101, 115, 116), athleteId: "0", outcome: "backfill" },
      {
        apiKey: String.fromCharCode(116, 101, 115, 116),
        athleteId: "synthetic-athlete",
        outcome: "backfill",
      },
      { apiKey: String.fromCharCode(116, 101, 115, 116), athleteId: "", outcome: "backfill" },
    ] as const;
    for (const options of pairs) {
      const events: unknown[] = [];
      const backfill = vi.fn(async () => ({ pages: 1, artifacts: 0, reports: [] }));
      const refresh = vi.fn();
      const runtime = {
        credentials: intervalsCredentials(options.apiKey, options.athleteId),
        async runWindowAfter(work: (signal: AbortSignal) => Promise<void>) {
          await work(new AbortController().signal);
          refresh();
          return {
            published: true,
            legacySucceeded: true,
            counts: requestCounts(0, 0),
          };
        },
      };
      const operations = createCoachOperations(
        {
          home,
          context: context(),
          runtime,
          intervalsCredentials: runtime.credentials,
          historyNewestDate: () => "1998-07-18",
          applyRuntimeConfig: async () => {},
        },
        { backfill },
      );
      await expect(operations.sync({}, (event) => events.push(event))).resolves.toMatchObject({
        schemaVersion: 1,
      });
      expect(events).toEqual([
        { phase: "started", completed: 0, total: 1 },
        { phase: "completed", completed: 1, total: 1 },
      ]);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(backfill).toHaveBeenCalledTimes(options.outcome === "backfill" ? 1 : 0);
      if (options.outcome === "backfill") {
        expect(backfill).toHaveBeenCalledWith(
          expect.objectContaining({
            apiKey: options.apiKey,
            athleteId: options.athleteId === "" ? "0" : options.athleteId,
          }),
        );
      }
    }
  });

  it("emits no false completion when backfill or the following refresh fails", async () => {
    for (const failurePoint of ["backfill", "window"] as const) {
      const events: unknown[] = [];
      const refresh = vi.fn();
      const backfill = vi.fn(async () => {
        if (failurePoint === "backfill") throw new Error("synthetic backfill failure");
        return { pages: 1, artifacts: 1, reports: [] };
      });
      const runtime = {
        intervals: intervalsCredentials(
          String.fromCharCode(116, 101, 115, 116),
          "synthetic-athlete",
        ),
        async runWindowAfter(work: (signal: AbortSignal) => Promise<void>) {
          await work(new AbortController().signal);
          refresh();
          if (failurePoint === "window") throw new Error("synthetic window failure");
          return {
            published: true,
            legacySucceeded: true,
            counts: requestCounts(0, 0),
          };
        },
      };
      const operations = createCoachOperations(
        {
          home,
          context: context(),
          runtime,
          intervalsCredentials: runtime.intervals,
          historyNewestDate: () => "1998-07-18",
          applyRuntimeConfig: async () => {},
        },
        { backfill },
      );
      await expect(operations.sync({}, (event) => events.push(event))).rejects.toThrow(
        `synthetic ${failurePoint} failure`,
      );
      expect(events).toEqual([{ phase: "started", completed: 0, total: 1 }]);
      expect(refresh).toHaveBeenCalledTimes(failurePoint === "window" ? 1 : 0);
    }
  });

  it("resumes a committed synthetic backfill step without duplicating input rows", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "coach-sync-resume-"));
    const liveHome: AthleteHome = {
      root,
      storeDir: join(root, "store"),
      archiveDir: join(root, "archive"),
      configDir: join(root, "config"),
    };
    const store = openSqliteStorage(join(root, "coach.db"));
    try {
      await runMigrations(store, MIGRATIONS);
      await store.exec("CREATE TABLE synthetic_backfill_checkpoint (id TEXT PRIMARY KEY NOT NULL)");
      let attempt = 0;
      const backfill = vi.fn(async () => {
        await store.run("INSERT OR IGNORE INTO synthetic_backfill_checkpoint (id) VALUES (?)", [
          "page-1",
        ]);
        attempt += 1;
        if (attempt === 1) throw new Error("synthetic interruption");
        return { pages: 1, artifacts: 0, reports: [] };
      });
      const runtime = {
        intervals: intervalsCredentials(
          String.fromCharCode(116, 101, 115, 116),
          "synthetic-athlete",
        ),
        async runWindowAfter(work: (signal: AbortSignal) => Promise<void>) {
          await work(new AbortController().signal);
          return {
            published: true,
            legacySucceeded: true,
            counts: requestCounts(0, 0),
          };
        },
      };
      const operations = createCoachOperations(
        {
          home: liveHome,
          context: {
            home: liveHome,
            store,
            listener: {} as CoachStoreWriterContext["listener"],
          },
          runtime,
          intervalsCredentials: runtime.intervals,
          historyNewestDate: () => "1998-07-18",
          applyRuntimeConfig: async () => {},
        },
        { backfill },
      );
      await expect(operations.sync({})).rejects.toThrow("synthetic interruption");
      await expect(operations.sync({})).resolves.toMatchObject({ schemaVersion: 1 });
      expect(
        await store.get("SELECT count(*) AS count FROM synthetic_backfill_checkpoint"),
      ).toEqual({ count: 1 });
      expect(backfill).toHaveBeenCalledTimes(2);
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies llm-only, intervals-only, both, and superseding runtime requests without echo", async () => {
    const applied: unknown[] = [];
    const applyRuntimeConfig = vi.fn(async (request) => {
      applied.push(request);
    });
    const operations = createCoachOperations({
      home,
      context: context(),
      runtime: { runWindowAfter: vi.fn() },
      intervalsCredentials: intervalsCredentials(),
      historyNewestDate: () => "1998-07-18",
      applyRuntimeConfig,
      readRuntimeConfig: () => ({
        schemaVersion: 1,
        llm: { provider: "google", model: "third", credential_configured: true },
        intervals: { athlete_id: "athlete-b" },
        session: {
          historyTokenBudgetRatio: 0.3,
          idleMinutes: 0,
          dailyResetHour: 4,
          resetArchiveRetentionDays: 0,
          timezone: "UTC",
        },
      }),
    });
    const llmFirst = {
      llm: { provider: "anthropic" as const, model: "first", api_key: "placeholder" },
    };
    const intervalsOnly = {
      intervals: { api_key: "placeholder", athlete_id: "athlete-a" },
    };
    const both = {
      llm: { provider: "openrouter" as const, model: "second", api_key: "placeholder" },
      intervals: { api_key: "placeholder", athlete_id: "athlete-b" },
    };
    const results = [
      await operations.configureRuntime(llmFirst),
      await operations.configureRuntime(intervalsOnly),
      await operations.configureRuntime(both),
      await operations.configureRuntime({
        llm: { provider: "google", model: "third", api_key: "placeholder" },
      }),
    ];
    expect(results).toEqual([
      { schemaVersion: 1, applied: { llm: true, intervals: false } },
      { schemaVersion: 1, applied: { llm: false, intervals: true } },
      { schemaVersion: 1, applied: { llm: true, intervals: true } },
      { schemaVersion: 1, applied: { llm: true, intervals: false } },
    ]);
    expect(applied).toEqual([
      llmFirst,
      intervalsOnly,
      both,
      {
        llm: { provider: "google", model: "third", api_key: "placeholder" },
      },
    ]);
    const serializedResults = JSON.stringify(results);
    for (const value of ["first", "second", "third", "placeholder", "athlete"]) {
      expect(serializedResults).not.toContain(value);
    }
    await expect(operations.getRuntimeConfig({})).resolves.toEqual({
      schemaVersion: 1,
      llm: { provider: "google", model: "third", credential_configured: true },
      intervals: { athlete_id: "athlete-b" },
      session: {
        historyTokenBudgetRatio: 0.3,
        idleMinutes: 0,
        dailyResetHour: 4,
        resetArchiveRetentionDays: 0,
        timezone: "UTC",
      },
    });
  });

  it("serializes persisted units reads and writes through the same operation FIFO", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "coach-units-"));
    const liveHome: AthleteHome = {
      root,
      storeDir: join(root, "store"),
      archiveDir: join(root, "archive"),
      configDir: join(root, "config"),
    };
    const store = openSqliteStorage(join(root, "coach.db"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    try {
      await runMigrations(store, MIGRATIONS);
      const operations = createCoachOperations({
        home: liveHome,
        context: {
          home: liveHome,
          store,
          listener: {} as CoachStoreWriterContext["listener"],
        },
        runtime: {
          async runWindowAfter(work) {
            order.push("sync-start");
            await gate;
            await work(new AbortController().signal);
            order.push("sync-end");
            return {
              published: true,
              legacySucceeded: true,
              counts: requestCounts(0, 0),
            };
          },
        },
        intervalsCredentials: intervalsCredentials(),
        historyNewestDate: () => "1998-07-18",
        applyRuntimeConfig: async () => {},
      });
      const sync = operations.sync({});
      const write = operations.setUnitsPreference!({ value: "imperial" }).then((result) => {
        order.push("write");
        return result;
      });
      const read = operations.getUnitsPreference!({}).then((result) => {
        order.push("read");
        return result;
      });
      await Promise.resolve();
      expect(order).toEqual(["sync-start"]);
      release();
      await expect(sync).resolves.toMatchObject({ schemaVersion: 1 });
      await expect(write).resolves.toEqual({ value: "imperial", source: "cycling" });
      await expect(read).resolves.toEqual({ value: "imperial", source: "cycling" });
      expect(order).toEqual(["sync-start", "sync-end", "write", "read"]);
      await expect(
        store.get("SELECT preferred_units, device_id FROM sport_settings"),
      ).resolves.toMatchObject({
        preferred_units: "imperial",
        device_id: expect.stringMatching(/^desktop:[0-9A-HJKMNP-TV-Z]{26}$/u),
      });
    } finally {
      release();
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
