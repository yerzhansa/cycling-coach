import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ImportReport } from "@enduragent/kernel/ingest";
import type { SourceId, SyncSource } from "@enduragent/kernel/store";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import { importFilesWithReport } from "@enduragent/kernel-node/ingest";
import { LOCKFILE_NAME, PORT_FILE_NAME } from "@enduragent/kernel-node/lock";
import {
  type CoachDevWriterFailureStage,
  type CoachDevWriterResult,
  type RunCoachDevWriterOptions,
} from "@enduragent/kernel-node/coach-dev";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import {
  CoachStoreWriterError,
  withCoachStoreWriter,
  type CoachStoreWriterContext,
} from "../src/runtime.js";
import { runCoachSync, type CoachSourceBinding, type RunCoachSyncOptions } from "../src/sync.js";

const capabilities = Object.freeze({
  activities: false,
  streams: false,
  rawFiles: false,
  wellness: false,
  plannedWorkoutPush: false,
  backfillDepth: Object.freeze({ kind: "none" as const }),
});

function syncSource(id: SourceId): SyncSource {
  return {
    id,
    capabilities,
    async *pull() {},
  };
}

function syntheticHome(root = "synthetic-root"): AthleteHome {
  return {
    root,
    storeDir: join(root, "store"),
    archiveDir: join(root, "archive"),
    configDir: join(root, "config"),
  };
}

function syntheticStore(): CoachStoreWriterContext["store"] {
  return {
    async exec() {},
    async run() {},
    async get() {
      return undefined;
    },
    async all() {
      return [];
    },
    async close() {},
    async getUserVersion() {
      return 0;
    },
    async setUserVersion() {},
    async transaction<T>(operation: () => Promise<T>) {
      return operation();
    },
  };
}

function syntheticContext(root?: string): CoachStoreWriterContext {
  return { home: syntheticHome(root), store: syntheticStore() };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const importReport = { report: "synthetic" } as unknown as ImportReport;

describe("coach sync composition", () => {
  it("runtime delegates to the exact writer version and returns the operation value", async () => {
    const context = syntheticContext();
    const value = { outcome: "exact-value" } as const;
    const observed: { options?: RunCoachDevWriterOptions<unknown>; calls: number } = {
      calls: 0,
    };
    const runWriter = async <T>(
      options: RunCoachDevWriterOptions<T>,
    ): Promise<CoachDevWriterResult<T>> => {
      observed.calls += 1;
      observed.options = options as RunCoachDevWriterOptions<unknown>;
      return { status: "completed", value: await options.operation(context) };
    };
    const operation = async (received: CoachStoreWriterContext) => {
      expect(received).toBe(context);
      return value;
    };

    await expect(
      withCoachStoreWriter({ ENDURAGENT_HOME: "synthetic-root" }, operation, { runWriter }),
    ).resolves.toBe(value);
    expect(observed.calls).toBe(1);
    expect(observed.options).toMatchObject({
      env: { ENDURAGENT_HOME: "synthetic-root" },
      writerVersion: "coach-sync/1",
      operation,
    });

    await expect(withCoachStoreWriter({}, undefined as never, { runWriter })).rejects.toThrow(
      new TypeError("invalid coach writer operation"),
    );
    expect(observed.calls).toBe(1);
  });

  it("runtime maps contention and every lifecycle failure without private error data", async () => {
    const privateValue = "private dependency data";
    const operation = async () => privateValue;
    const contentionWriter = async <T>(): Promise<CoachDevWriterResult<T>> => ({
      status: "writer-lock-held",
    });
    await expect(
      withCoachStoreWriter({}, operation, { runWriter: contentionWriter }),
    ).rejects.toEqual(new CoachStoreWriterError("writer-lock-held", null));

    const stages: readonly CoachDevWriterFailureStage[] = [
      "resolve home",
      "acquire lock",
      "create store directory",
      "secure store directory",
      "open store",
      "run migrations",
      "invoke operation",
      "close store",
      "release lock",
    ];
    for (const stage of stages) {
      const failedWriter = async <T>(): Promise<CoachDevWriterResult<T>> => ({
        status: "failed",
        stage,
      });
      let caught: unknown;
      try {
        await withCoachStoreWriter({}, operation, { runWriter: failedWriter });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CoachStoreWriterError);
      expect(caught).toMatchObject({
        name: "CoachStoreWriterError",
        code: "writer-failed",
        stage,
        message: `coach store writer failed at ${stage}`,
      });
      expect(JSON.stringify(caught)).not.toContain(privateValue);
    }
  });

  it("validates the complete request before acquiring the writer", async () => {
    let writerCalls = 0;
    let sourceCalls = 0;
    let importCalls = 0;
    const context = syntheticContext();
    const withWriter: typeof withCoachStoreWriter = async <T>(
      _env: Record<string, string | undefined>,
      operation: (value: CoachStoreWriterContext) => Promise<T>,
    ): Promise<T> => {
      writerCalls += 1;
      return operation(context);
    };
    const importFiles: typeof importFilesWithReport = async () => {
      importCalls += 1;
      return importReport;
    };
    const validBinding: CoachSourceBinding = {
      source: syncSource("intervals-icu"),
      async run() {
        sourceCalls += 1;
      },
    };
    const dependencies = { withWriter, importFiles };
    const invalidCases: readonly { value: unknown; message: string }[] = [
      { value: null, message: "invalid coach sync options" },
      { value: [], message: "invalid coach sync options" },
      { value: {}, message: "invalid coach sync options" },
      { value: { env: null, sources: [] }, message: "invalid coach sync options" },
      { value: { env: [], sources: [] }, message: "invalid coach sync options" },
      { value: { env: {}, sources: {} }, message: "invalid coach sync options" },
      { value: { env: {}, sources: [null] }, message: "invalid coach source binding" },
      {
        value: { env: {}, sources: [{ source: null, run() {} }] },
        message: "invalid coach source binding",
      },
      {
        value: { env: {}, sources: [{ source: { id: "other" }, run() {} }] },
        message: "invalid coach source binding",
      },
      {
        value: { env: {}, sources: [{ source: syncSource("file-import"), run: null }] },
        message: "invalid coach source binding",
      },
      {
        value: { env: {}, sources: [validBinding, { source: null, run() {} }] },
        message: "invalid coach source binding",
      },
      {
        value: { env: {}, sources: [validBinding, validBinding] },
        message: "duplicate coach sync source",
      },
      {
        value: { env: {}, sources: [], importPaths: "input.fit" },
        message: "invalid coach import paths",
      },
      { value: { env: {}, sources: [], importPaths: [""] }, message: "invalid coach import paths" },
      { value: { env: {}, sources: [], importPaths: [1] }, message: "invalid coach import paths" },
      {
        value: { env: {}, sources: [], importPaths: ["input.fit", "input.fit"] },
        message: "invalid coach import paths",
      },
    ];

    for (const { value, message } of invalidCases) {
      await expect(runCoachSync(value as RunCoachSyncOptions, dependencies)).rejects.toThrow(
        new TypeError(message),
      );
    }
    expect(writerCalls).toBe(0);
    expect(sourceCalls).toBe(0);
    expect(importCalls).toBe(0);
  });

  it("runs sources sequentially and continues with a safe failure", async () => {
    const context = syntheticContext();
    const order: string[] = [];
    let running = 0;
    let maximumRunning = 0;
    const withWriter: typeof withCoachStoreWriter = async <T>(
      _env: Record<string, string | undefined>,
      operation: (value: CoachStoreWriterContext) => Promise<T>,
    ): Promise<T> => operation(context);
    const importFiles: typeof importFilesWithReport = async () => importReport;
    const binding = (id: SourceId, shouldFail: boolean): CoachSourceBinding => ({
      source: syncSource(id),
      async run(received) {
        expect(Object.isFrozen(received)).toBe(true);
        running += 1;
        maximumRunning = Math.max(maximumRunning, running);
        order.push(`start:${id}`);
        await Promise.resolve();
        order.push(`end:${id}`);
        running -= 1;
        if (shouldFail) throw new Error("private source failure");
      },
    });

    const report = await runCoachSync(
      {
        env: {},
        sources: [binding("intervals-icu", true), binding("file-import", false)],
      },
      { withWriter, importFiles },
    );
    expect(order).toEqual([
      "start:intervals-icu",
      "end:intervals-icu",
      "start:file-import",
      "end:file-import",
    ]);
    expect(maximumRunning).toBe(1);
    expect(report).toEqual({
      schema_version: 1,
      sources: [
        {
          source_id: "intervals-icu",
          status: "failed",
          message: "source synchronization failed",
        },
        { source_id: "file-import", status: "completed", message: null },
      ],
      import_report: null,
    });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.sources)).toBe(true);
    expect(report.sources.every(Object.isFrozen)).toBe(true);
    expect(JSON.stringify(report)).not.toContain("private source failure");
  });

  it("imports one nonempty path batch exactly once after sources", async () => {
    const context = syntheticContext();
    const order: string[] = [];
    const originalPaths = ["z.fit", "a.fit"];
    let observedImport: Parameters<typeof importFilesWithReport>[0] | undefined;
    let importCalls = 0;
    const withWriter: typeof withCoachStoreWriter = async <T>(
      _env: Record<string, string | undefined>,
      operation: (value: CoachStoreWriterContext) => Promise<T>,
    ): Promise<T> => operation(context);
    const importFiles: typeof importFilesWithReport = async (options) => {
      importCalls += 1;
      order.push("import");
      observedImport = options;
      return importReport;
    };
    const report = await runCoachSync(
      {
        env: {},
        sources: [
          {
            source: syncSource("intervals-icu"),
            async run() {
              order.push("source");
            },
          },
        ],
        importPaths: originalPaths,
      },
      { withWriter, importFiles },
    );

    expect(order).toEqual(["source", "import"]);
    expect(importCalls).toBe(1);
    expect(observedImport).toEqual({
      inputPaths: originalPaths,
      archiveDir: context.home.archiveDir,
      store: context.store,
    });
    expect(observedImport?.inputPaths).not.toBe(originalPaths);
    expect(Object.isFrozen(observedImport?.inputPaths)).toBe(true);
    expect(observedImport?.store).toBe(context.store);
    expect(report.import_report).toBe(importReport);
    expect(Object.isFrozen(importReport)).toBe(false);
  });

  it("skips file import for an empty path list", async () => {
    const context = syntheticContext();
    let importCalls = 0;
    const withWriter: typeof withCoachStoreWriter = async <T>(
      _env: Record<string, string | undefined>,
      operation: (value: CoachStoreWriterContext) => Promise<T>,
    ): Promise<T> => operation(context);
    const importFiles: typeof importFilesWithReport = async () => {
      importCalls += 1;
      return importReport;
    };
    const dependencies = { withWriter, importFiles };

    await expect(
      runCoachSync({ env: {}, sources: [], importPaths: [] }, dependencies),
    ).resolves.toMatchObject({ import_report: null });
    await expect(runCoachSync({ env: {}, sources: [] }, dependencies)).resolves.toMatchObject({
      import_report: null,
    });
    expect(importCalls).toBe(0);
  });

  it("real writer lifecycle migrates closes and releases an isolated store", async () => {
    const root = await mkdtemp(join(tmpdir(), "coach-runtime-"));
    const home = syntheticHome(root);
    try {
      const value = await withCoachStoreWriter(
        { ENDURAGENT_HOME: root },
        async ({ home: receivedHome, store }) => {
          expect(receivedHome).toEqual(home);
          return store.get("PRAGMA user_version");
        },
      );
      expect(value).toEqual({ user_version: 5 });
      expect(await pathExists(join(home.storeDir, "store.db"))).toBe(true);
      expect(await pathExists(join(home.configDir, LOCKFILE_NAME))).toBe(false);
      expect(await pathExists(join(home.configDir, PORT_FILE_NAME))).toBe(false);

      const reopened = openSqliteStorage(join(home.storeDir, "store.db"));
      try {
        await expect(reopened.get("PRAGMA user_version")).resolves.toEqual({
          user_version: 5,
        });
      } finally {
        await reopened.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("isolates concurrent writers for two athlete homes", async () => {
    const leftRoot = await mkdtemp(join(tmpdir(), "coach-left-"));
    const rightRoot = await mkdtemp(join(tmpdir(), "coach-right-"));
    const leftHome = syntheticHome(leftRoot);
    const rightHome = syntheticHome(rightRoot);
    const seenHomes: string[] = [];
    const binding = (home: AthleteHome, marker: string): CoachSourceBinding => ({
      source: syncSource("intervals-icu"),
      async run(context) {
        expect(context.home).toEqual(home);
        seenHomes.push(context.home.root);
        await context.store.run(
          "INSERT INTO source_watermark (source,lane,watermark) VALUES (?,?,?)",
          ["intervals-icu", "activities", marker],
        );
      },
    });
    try {
      const [leftReport, rightReport] = await Promise.all([
        runCoachSync({
          env: { ENDURAGENT_HOME: leftRoot },
          sources: [binding(leftHome, "left-marker")],
        }),
        runCoachSync({
          env: { ENDURAGENT_HOME: rightRoot },
          sources: [binding(rightHome, "right-marker")],
        }),
      ]);
      expect(leftReport.sources).toEqual([
        { source_id: "intervals-icu", status: "completed", message: null },
      ]);
      expect(rightReport.sources).toEqual([
        { source_id: "intervals-icu", status: "completed", message: null },
      ]);
      expect(leftReport.import_report).toBeNull();
      expect(rightReport.import_report).toBeNull();
      expect(new Set(seenHomes)).toEqual(new Set([leftRoot, rightRoot]));

      const leftStore = openSqliteStorage(join(leftHome.storeDir, "store.db"));
      const rightStore = openSqliteStorage(join(rightHome.storeDir, "store.db"));
      try {
        await expect(leftStore.all("SELECT watermark FROM source_watermark")).resolves.toEqual([
          { watermark: "left-marker" },
        ]);
        await expect(rightStore.all("SELECT watermark FROM source_watermark")).resolves.toEqual([
          { watermark: "right-marker" },
        ]);
      } finally {
        await leftStore.close();
        await rightStore.close();
      }

      let releaseHold!: () => void;
      let markEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve;
      });
      const hold = new Promise<void>((resolve) => {
        releaseHold = resolve;
      });
      const first = runCoachSync({
        env: { ENDURAGENT_HOME: leftRoot },
        sources: [
          {
            source: syncSource("file-import"),
            async run() {
              markEntered();
              await hold;
            },
          },
        ],
      });
      await entered;
      await expect(
        runCoachSync({ env: { ENDURAGENT_HOME: leftRoot }, sources: [] }),
      ).rejects.toMatchObject({
        name: "CoachStoreWriterError",
        code: "writer-lock-held",
        stage: null,
      });
      releaseHold();
      await expect(first).resolves.toMatchObject({ schema_version: 1 });
      expect(await pathExists(join(leftHome.configDir, LOCKFILE_NAME))).toBe(false);
      expect(await pathExists(join(leftHome.configDir, PORT_FILE_NAME))).toBe(false);
      expect(await pathExists(join(rightHome.configDir, LOCKFILE_NAME))).toBe(false);
      expect(await pathExists(join(rightHome.configDir, PORT_FILE_NAME))).toBe(false);
    } finally {
      await rm(leftRoot, { recursive: true, force: true });
      await rm(rightRoot, { recursive: true, force: true });
    }
  });
});
