import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations, type MigratorStore, type SourceArtifact, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createNodeImportRuntime } from "@enduragent/kernel-node/ingest";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import type { IntervalsIcuSource } from "@enduragent/sync-intervals-icu";
import { createIntervalsBackfillSource, runBackfillPages } from "../src/backfill.js";

const complete = JSON.stringify({ v: 1, cycle: 0, window_start: "2010-01-01", window_end: "2010-12-31", last_key: null, complete: true });
const clock = { now: () => 1_300_000_000_000, monotonicNow: () => 1_000 };

describe("incremental backfill pages", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  async function fresh() {
    const root = mkdtempSync(join(tmpdir(), "backfill-page-")); roots.push(root);
    const store = openSqliteStorage(join(root, "store.db")); await runMigrations(store, MIGRATIONS);
    const node = createNodeImportRuntime({ archiveDir: join(root, "archive"), store });
    return { root, store, node };
  }
  async function raw(node: ReturnType<typeof createNodeImportRuntime>, name = "one.fit"): Promise<Extract<SourceArtifact, { kind: "raw-file" }>> {
    const bytes = new Uint8Array(readFileSync("packages/kernel-node/tests/fixtures/ingest/brick-cycling.fit"));
    const archiveInstant = { epochSeconds: 899_585_600 };
    const archive = await node.archive.writeArtifact(bytes, "fit", archiveInstant);
    return { kind: "raw-file", source: "intervals-icu", lane: "bulk-fit", externalId: name,
      archiveInstant, archive, container: null, file: { input_path: name, bytes, ext: "fit" } } as Extract<SourceArtifact, { kind: "raw-file" }>;
  }
  function source(pulls: (watermark: string | null, call: number) => AsyncIterable<SourceArtifact>): IntervalsIcuSource {
    let call = 0;
    return { id: "intervals-icu", capabilities: { activities: true, streams: true, rawFiles: true, wellness: true,
      plannedWorkoutPush: false, backfillDepth: { kind: "full-history" } },
    pull(watermark) { return pulls(watermark.value, call++); } } as IntervalsIcuSource;
  }

  it("commits each page checkpoint atomically and finishes with one terminal no-op", async () => {
    const value = await fresh();
    try {
      const item = await raw(value.node);
      const fake = source((_watermark, call) => (async function* () {
        if (call === 0) yield item;
        yield { kind: "checkpoint", watermark: { source: "intervals-icu", lane: "bulk-fit", value: complete } };
      })());
      const result = await runBackfillPages({ store: value.store, node: value.node, source: fake, clock });
      expect(result).toMatchObject({ pages: 2, artifacts: 1 });
      expect(await value.store.get("SELECT watermark FROM source_watermark WHERE source='intervals-icu' AND lane='bulk-fit'")).toEqual({ watermark: complete });
      expect(await value.store.all("SELECT artifacts_seen,completion_kind FROM sync_operation ORDER BY operation_id")).toEqual([
        { artifacts_seen: 1, completion_kind: "applied" }, { artifacts_seen: 0, completion_kind: "no-op" },
      ]);
      expect(await value.store.get("SELECT count(*) AS n FROM raw_file")).toEqual({ n: 1 });
    } finally { await value.store.close(); }
  });

  it.each([
    ["wrong checkpoint", () => source(() => (async function* () { yield { kind: "checkpoint", watermark: { source: "file-import", lane: "bulk-fit", value: complete } } as SourceArtifact; })())],
    ["multiple checkpoint", () => source(() => (async function* () { const checkpoint = { kind: "checkpoint", watermark: { source: "intervals-icu", lane: "bulk-fit", value: complete } } as SourceArtifact; yield checkpoint; yield checkpoint; })())],
    ["nonterminal invalid checkpoint", () => source(() => (async function* () { yield { kind: "checkpoint", watermark: { source: "intervals-icu", lane: "bulk-fit", value: "{}" } } as SourceArtifact; })())],
  ])("rejects %s and commits nothing", async (_name, makeSource) => {
    const value = await fresh();
    try {
      await expect(runBackfillPages({ store: value.store, node: value.node, source: makeSource(), clock })).rejects.toThrow();
      expect(await value.store.get("SELECT count(*) AS n FROM sync_operation")).toEqual({ n: 0 });
      expect(await value.store.get("SELECT count(*) AS n FROM raw_file")).toEqual({ n: 0 });
    } finally { await value.store.close(); }
  });

  it("deduplicates an over-yielded immutable artifact within a page", async () => {
    const value = await fresh();
    try {
      const one = await raw(value.node, "one"), two = { ...one, externalId: "two", file: { ...one.file, input_path: "two.fit" } } as SourceArtifact;
      const fake = source((_watermark, call) => (async function* () {
        if (call === 0) { yield one; yield two; }
        yield { kind: "checkpoint", watermark: { source: "intervals-icu", lane: "bulk-fit", value: complete } };
      })());
      const result = await runBackfillPages({ store: value.store, node: value.node, source: fake, clock, batchSize: 2 });
      expect(result.artifacts).toBe(2);
      expect(await value.store.get("SELECT count(*) AS n FROM raw_file")).toEqual({ n: 1 });
      expect(await value.store.get("SELECT count(*) AS n FROM source_artifact")).toEqual({ n: 2 });
    } finally { await value.store.close(); }
  });

  it("constructs the backfill source with the fixed full-history floor", () => {
    const archive = { writeArtifact: async () => { throw new Error("unused"); } } as never;
    const created = createIntervalsBackfillSource({ apiKey: String.fromCharCode(116, 101, 115, 116), athleteId: "test-athlete", historyNewestDate: "2010-12-31",
      minRequestIntervalMs: 250, archive, clock, sleep: async () => {}, baseFetch: async () => { throw new Error("unused"); } });
    expect(created.id).toBe("intervals-icu");
    expect(created.capabilities.backfillDepth).toEqual({ kind: "full-history" });
  });
});
