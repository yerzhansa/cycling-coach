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
        runtime: { runWindow: vi.fn() },
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
    const runWindow = vi.fn(async () => ({
      published: true,
      legacySucceeded: false,
      counts: requestCounts(2, 1),
    }));
    const operations = createCoachOperations(
      { home, context: context(), runtime: { runWindow } },
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
    expect(runWindow).toHaveBeenCalledTimes(1);
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
    const runWindow = vi.fn(async () => {
      trace.push("sync");
      return {
        published: false,
        legacySucceeded: true,
        counts: requestCounts(0, 0),
      };
    });
    const operations = createCoachOperations(
      { home, context: context(), runtime: { runWindow } },
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
});
