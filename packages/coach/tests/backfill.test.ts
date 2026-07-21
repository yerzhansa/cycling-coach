import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSyncStateRepository,
  runMigrations,
  type SourceArtifact,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createNodeImportRuntime } from "@enduragent/kernel-node/ingest";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import type { IntervalsIcuSource } from "@enduragent/sync-intervals-icu";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import {
  createIntervalsBackfillSource,
  runBackfillPages,
  runIntervalsBackfill,
  runIntervalsBackfillInWriter,
} from "../src/backfill.js";
import { createCoachOperations } from "../src/operations.js";
import type { CoachStoreWriterContext } from "../src/runtime.js";

const complete = JSON.stringify({
  v: 1,
  cycle: 0,
  window_start: "2010-12-05",
  window_end: "2010-12-31",
  last_key: null,
  complete: true,
});
const clock = { now: () => 1_300_000_000_000, monotonicNow: () => 1_000 };

describe("incremental backfill pages", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  async function fresh() {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "backfill-page-"));
    roots.push(root);
    const store = openSqliteStorage(join(root, "store.db"));
    await runMigrations(store, MIGRATIONS);
    const node = createNodeImportRuntime({ archiveDir: join(root, "archive"), store });
    return { root, store, node };
  }
  async function raw(
    node: ReturnType<typeof createNodeImportRuntime>,
    name = "one.fit",
  ): Promise<Extract<SourceArtifact, { kind: "raw-file" }>> {
    const bytes = new Uint8Array(
      readFileSync("packages/kernel-node/tests/fixtures/ingest/brick-cycling.fit"),
    );
    const archiveInstant = { epochSeconds: 899_585_600 };
    const archive = await node.archive.writeArtifact(bytes, "fit", archiveInstant);
    return {
      kind: "raw-file",
      source: "intervals-icu",
      lane: "bulk-fit",
      externalId: name,
      archiveInstant,
      archive,
      container: null,
      file: { input_path: name, bytes, ext: "fit" },
    } as Extract<SourceArtifact, { kind: "raw-file" }>;
  }
  function source(
    pulls: (watermark: string | null, call: number) => AsyncIterable<SourceArtifact>,
  ): IntervalsIcuSource {
    let call = 0;
    return {
      id: "intervals-icu",
      capabilities: {
        activities: true,
        streams: true,
        rawFiles: true,
        wellness: true,
        plannedWorkoutPush: false,
        backfillDepth: { kind: "full-history" },
      },
      pull(watermark) {
        return pulls(watermark.value, call++);
      },
    } as IntervalsIcuSource;
  }

  it("commits each page checkpoint atomically and finishes with one terminal no-op", async () => {
    const value = await fresh();
    try {
      const item = await raw(value.node);
      const fake = source((_watermark, call) =>
        (async function* () {
          if (call === 0) yield item;
          yield {
            kind: "checkpoint",
            watermark: { source: "intervals-icu", lane: "bulk-fit", value: complete },
          };
        })(),
      );
      const result = await runBackfillPages({
        store: value.store,
        node: value.node,
        source: fake,
        clock,
      });
      expect(result).toMatchObject({ pages: 2, artifacts: 1 });
      expect(
        await value.store.get(
          "SELECT watermark FROM source_watermark WHERE source='intervals-icu' AND lane='bulk-fit'",
        ),
      ).toEqual({ watermark: complete });
      expect(
        await value.store.all(
          "SELECT artifacts_seen,completion_kind FROM sync_operation ORDER BY operation_id",
        ),
      ).toEqual([
        { artifacts_seen: 1, completion_kind: "applied" },
        { artifacts_seen: 0, completion_kind: "no-op" },
      ]);
      expect(await value.store.get("SELECT count(*) AS n FROM raw_file")).toEqual({ n: 1 });
    } finally {
      await value.store.close();
    }
  });

  it.each([
    [
      "wrong checkpoint",
      () =>
        source(() =>
          (async function* () {
            yield {
              kind: "checkpoint",
              watermark: { source: "file-import", lane: "bulk-fit", value: complete },
            } as SourceArtifact;
          })(),
        ),
    ],
    [
      "multiple checkpoint",
      () =>
        source(() =>
          (async function* () {
            const checkpoint = {
              kind: "checkpoint",
              watermark: { source: "intervals-icu", lane: "bulk-fit", value: complete },
            } as SourceArtifact;
            yield checkpoint;
            yield checkpoint;
          })(),
        ),
    ],
    [
      "nonterminal invalid checkpoint",
      () =>
        source(() =>
          (async function* () {
            yield {
              kind: "checkpoint",
              watermark: { source: "intervals-icu", lane: "bulk-fit", value: "{}" },
            } as SourceArtifact;
          })(),
        ),
    ],
  ])("rejects %s and commits nothing", async (_name, makeSource) => {
    const value = await fresh();
    try {
      await expect(
        runBackfillPages({ store: value.store, node: value.node, source: makeSource(), clock }),
      ).rejects.toThrow();
      expect(await value.store.get("SELECT count(*) AS n FROM sync_operation")).toEqual({ n: 0 });
      expect(await value.store.get("SELECT count(*) AS n FROM raw_file")).toEqual({ n: 0 });
    } finally {
      await value.store.close();
    }
  });

  it("deduplicates an over-yielded immutable artifact within a page", async () => {
    const value = await fresh();
    try {
      const one = await raw(value.node, "one"),
        two = {
          ...one,
          externalId: "two",
          file: { ...one.file, input_path: "two.fit" },
        } as SourceArtifact;
      const fake = source((_watermark, call) =>
        (async function* () {
          if (call === 0) {
            yield one;
            yield two;
          }
          yield {
            kind: "checkpoint",
            watermark: { source: "intervals-icu", lane: "bulk-fit", value: complete },
          };
        })(),
      );
      const result = await runBackfillPages({
        store: value.store,
        node: value.node,
        source: fake,
        clock,
        batchSize: 2,
      });
      expect(result.artifacts).toBe(2);
      expect(await value.store.get("SELECT count(*) AS n FROM raw_file")).toEqual({ n: 1 });
      expect(await value.store.get("SELECT count(*) AS n FROM source_artifact")).toEqual({ n: 2 });
    } finally {
      await value.store.close();
    }
  });

  it("constructs the backfill source with the fixed full-history floor", () => {
    const archive = {
      writeArtifact: async () => {
        throw new Error("unused");
      },
    } as never;
    const created = createIntervalsBackfillSource({
      apiKey: String.fromCharCode(116, 101, 115, 116),
      athleteId: "test-athlete",
      historyNewestDate: "2010-12-31",
      minRequestIntervalMs: 250,
      archive,
      clock,
      sleep: async () => {},
      baseFetch: async () => {
        throw new Error("unused");
      },
    });
    expect(created.id).toBe("intervals-icu");
    expect(created.capabilities.backfillDepth).toEqual({ kind: "full-history" });
  });

  it("issues a request after the UTC date advances within one operations process", async () => {
    const value = await fresh();
    const home: AthleteHome = {
      root: value.root,
      storeDir: join(value.root, "store"),
      archiveDir: join(value.root, "archive"),
      configDir: join(value.root, "config"),
    };
    const context: CoachStoreWriterContext = {
      home,
      store: value.store,
      listener: {} as CoachStoreWriterContext["listener"],
    };
    let now = Date.UTC(1900, 0, 1);
    const requests: string[] = [];
    const baseFetch: typeof globalThis.fetch = vi.fn(async (input) => {
      requests.push(input instanceof Request ? input.url : input.toString());
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    });
    const rollingClock = { now: () => now, monotonicNow: () => 1_000 };
    const operations = createCoachOperations(
      {
        home,
        context,
        runtime: {
          async runWindowAfter(work) {
            await work(new AbortController().signal);
            return {
              published: true,
              legacySucceeded: true,
              counts: {
                storeRequests: 0,
                legacyRequests: 0,
                totalRequests: 0,
                byTag: {
                  "store:activities": 0,
                  "store:wellness": 0,
                  "store:settings": 0,
                  "store:streams": 0,
                  "legacy:reference": 0,
                },
              },
            };
          },
        },
        intervalsCredentials: {
          read: async () => ({ apiKey: String.fromCharCode(116, 101, 115, 116), athleteId: "synthetic-athlete" }),
        },
        historyNewestDate: () => new Date(now).toISOString().slice(0, 10),
        applyRuntimeConfig: async () => {},
      },
      {
        backfill: (options) => runIntervalsBackfillInWriter({
          ...options,
          clock: rollingClock,
          sleep: async () => {},
          baseFetch,
        }),
      },
    );
    try {
      await expect(operations.sync({})).resolves.toMatchObject({ schemaVersion: 1 });
      await expect(createSyncStateRepository(value.store).readWatermark("intervals-icu", "bulk-fit")).resolves.toEqual({
        source: "intervals-icu",
        lane: "bulk-fit",
        value: JSON.stringify({ v: 1, cycle: 0, window_start: "1900-01-01", window_end: "1900-01-01",
          last_key: null, complete: true }),
      });
      now = Date.UTC(1900, 0, 2);
      await expect(operations.sync({})).resolves.toMatchObject({ schemaVersion: 1 });

      expect(requests).toHaveLength(2);
      const reopened = new URL(requests[1]!);
      expect([...reopened.searchParams]).toEqual([["oldest", "1900-01-01"], ["newest", "1900-01-02"]]);
    } finally {
      await value.store.close();
    }
  });

  it("keeps the public writer wrapper equivalent to the supplied-writer entry", async () => {
    const makeHome = async (): Promise<{
      home: AthleteHome;
      store: ReturnType<typeof openSqliteStorage>;
    }> => {
      const root = mkdtempSync(join(realpathSync(tmpdir()), "backfill-writer-"));
      roots.push(root);
      const home = {
        root,
        storeDir: join(root, "store"),
        archiveDir: join(root, "archive"),
        configDir: join(root, "config"),
      };
      mkdirSync(home.storeDir, { recursive: true, mode: 0o700 });
      const store = openSqliteStorage(join(home.storeDir, "store.db"));
      await runMigrations(store, MIGRATIONS);
      await store.transaction(async () => {
        await createSyncStateRepository(store).recordCompletionInTransaction({
          source: "intervals-icu",
          lane: "bulk-fit",
          watermarkBefore: null,
          watermarkAfter: complete,
          artifactsSeen: 0,
          sourceChanges: 0,
        });
      });
      return { home, store };
    };
    const direct = await makeHome();
    const wrapped = await makeHome();
    const directPages: unknown[] = [];
    const wrappedPages: unknown[] = [];
    const baseFetch = vi.fn(async () => {
      throw new Error("completed watermark performed a request");
    });
    const close = vi.spyOn(direct.store, "close");
    try {
      const directResult = await runIntervalsBackfillInWriter({
        home: direct.home,
        store: direct.store,
        apiKey: String.fromCharCode(116, 101, 115, 116),
        athleteId: "synthetic-athlete",
        historyNewestDate: "2010-12-31",
        clock,
        sleep: async () => {},
        baseFetch,
        onPageCommitted: (page) => directPages.push(page),
      });
      await wrapped.store.close();
      const wrappedResult = await runIntervalsBackfill({
        env: { ENDURAGENT_HOME: wrapped.home.root },
        apiKey: String.fromCharCode(116, 101, 115, 116),
        athleteId: "synthetic-athlete",
        historyNewestDate: "2010-12-31",
        clock,
        sleep: async () => {},
        baseFetch,
        onPageCommitted: (page) => wrappedPages.push(page),
      });
      expect(wrappedResult).toEqual(directResult);
      expect(wrappedPages).toEqual(directPages);
      expect(directResult).toMatchObject({ pages: 2, artifacts: 0, reports: [] });
      expect(baseFetch).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      await expect(
        direct.store.get("SELECT count(*) AS count FROM source_watermark"),
      ).resolves.toEqual({ count: 1 });
    } finally {
      close.mockRestore();
      await direct.store.close();
    }
  });

  it("preserves in-writer bounds and leaves the caller store open after rejection", async () => {
    const value = await fresh();
    const home: AthleteHome = {
      root: value.root,
      storeDir: join(value.root, "store"),
      archiveDir: join(value.root, "archive"),
      configDir: join(value.root, "config"),
    };
    const close = vi.spyOn(value.store, "close");
    try {
      await expect(
        runIntervalsBackfillInWriter({
          home,
          store: value.store,
          apiKey: String.fromCharCode(116, 101, 115, 116),
          athleteId: "synthetic-athlete",
          historyNewestDate: "2010-12-31",
          batchSize: 0,
        }),
      ).rejects.toThrow("invalid batch size");
      expect(close).not.toHaveBeenCalled();
      await expect(
        value.store.get("SELECT count(*) AS count FROM source_watermark"),
      ).resolves.toEqual({ count: 0 });
    } finally {
      close.mockRestore();
      await value.store.close();
    }
  });
});
