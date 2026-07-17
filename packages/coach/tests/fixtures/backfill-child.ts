import { readFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createNodeImportRuntime } from "@enduragent/kernel-node/ingest";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import type { IntervalsIcuArtifact, IntervalsIcuSource } from "@enduragent/sync-intervals-icu";
import { runBackfillPages } from "../../src/backfill.js";

const [home, alignment = "exact", killPoint = "none"] = process.argv.slice(2);
if (!home) throw new TypeError("home is required");
await mkdir(home, { recursive: true });
const base = openSqliteStorage(join(home, "store.db")); await runMigrations(base, MIGRATIONS);
const totals: Record<string, number> = { empty: 3, exact: 4, before: 3, after: 5 };
const total = totals[alignment]; if (total === undefined) throw new TypeError("invalid alignment");
const fixtureNames = ["brick-cycling.fit", "brick-running.fit", "triathlon-multisport.fit",
  "duathlon-run-bike-run.fit", "dual-developer-index.fit"] as const;
const fixtureBytes = await Promise.all(fixtureNames.map((name) => readFile(join(process.cwd(), "packages/kernel-node/tests/fixtures/ingest", name))));
const fixtureEpochs = [899_585_600, 899_588_900, 899_565_600, 899_575_600, 899_625_600] as const;
let boundaryUsed = false, committedRows = 0;

async function boundary(point: string): Promise<void> {
  if (boundaryUsed || killPoint !== point) return;
  boundaryUsed = true;
  process.stdout.write(`BOUNDARY ${point} rows=${committedRows}\n`);
  await new Promise<void>(() => { setInterval(() => {}, 1_000); });
}

const store: SqlStore & MigratorStore = {
  exec: (sql) => base.exec(sql),
  async run(sql, params) {
    if (sql.startsWith("INSERT INTO workout")) await boundary("after-evidence");
    if (sql.startsWith("UPDATE ingest_metadata")) await boundary("after-derived");
    await base.run(sql, params);
    if (sql.startsWith("INSERT INTO source_watermark")) await boundary("after-watermark");
  },
  get: (sql, params) => base.get(sql, params), all: (sql, params) => base.all(sql, params), close: () => base.close(),
  getUserVersion: () => base.getUserVersion(), setUserVersion: (version) => base.setUserVersion(version),
  async transaction(work) {
    await boundary("before-begin");
    const result = await base.transaction(work);
    const watermark = await base.get("SELECT watermark FROM source_watermark WHERE source='intervals-icu' AND lane='bulk-fit'");
    if (watermark !== undefined) committedRows = Number((JSON.parse(String(watermark.watermark)) as { last_key: string | null }).last_key ?? total);
    await boundary("after-commit");
    return result;
  },
};
const node = createNodeImportRuntime({ archiveDir: join(home, "archive"), store });
const cursor = (count: number, complete: boolean): string => JSON.stringify({ v: 1, cycle: 0,
  window_start: "2010-01-01", window_end: "2010-12-31", last_key: String(count), complete });
let emittedInitialEmpty = false;
const source = { id: "intervals-icu", capabilities: { activities: true, streams: true, rawFiles: true, wellness: true,
  plannedWorkoutPush: false, backfillDepth: { kind: "full-history" } },
pull(watermark) {
  return (async function* (): AsyncIterable<IntervalsIcuArtifact> {
    if (alignment === "empty" && watermark.value === null && !emittedInitialEmpty) {
      emittedInitialEmpty = true;
      yield { kind: "checkpoint", watermark: { source: "intervals-icu", lane: "bulk-fit", value: cursor(0, false) } };
      return;
    }
    const count = watermark.value === null ? 0 : Number((JSON.parse(watermark.value) as { last_key: string }).last_key);
    const end = Math.min(total, count + 4);
    for (let index = count; index < end; index += 1) {
      const bytes = new Uint8Array(fixtureBytes[index]!);
      const archiveInstant = { epochSeconds: fixtureEpochs[index]! };
      const archive = await node.archive.writeArtifact(bytes, "fit", archiveInstant);
      yield { kind: "raw-file", source: "intervals-icu", lane: "bulk-fit", externalId: `synthetic-${index}`,
        archiveInstant, archive, container: null, file: { input_path: `synthetic-${index}.fit`, bytes, ext: "fit" } };
    }
    yield { kind: "checkpoint", watermark: { source: "intervals-icu", lane: "bulk-fit", value: cursor(end, end >= total) } };
  })();
} } as IntervalsIcuSource;

await runBackfillPages({ store, node, source, clock: { now: () => 1_300_000_000_000, monotonicNow: () => 1_000 }, batchSize: 4 });
await store.close();
process.stdout.write(`COMPLETED rows=${total}\n`);
