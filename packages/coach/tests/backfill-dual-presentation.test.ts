import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dumpStore, runMigrations, type SourceArtifact } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createNodeImportRuntime } from "@enduragent/kernel-node/ingest";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { mapActivityLanding, type IntervalsIcuSource } from "@enduragent/sync-intervals-icu";
import { runActivityAuditPages, runBackfillPages } from "../src/backfill.js";

const complete = (lane: "activities" | "bulk-fit") => ({ kind: "checkpoint" as const,
  watermark: { source: "intervals-icu" as const, lane,
    value: JSON.stringify({ v: 1, cycle: 0, window_start: "2010-01-01", window_end: "2010-12-31", last_key: null, complete: true }) } });
const clock = { now: () => 1_300_000_000_000, monotonicNow: () => 1_000 };

describe("dual-presentation audit", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  async function fresh(name: string) {
    const root = mkdtempSync(join(tmpdir(), `${name}-`)); roots.push(root);
    const store = openSqliteStorage(join(root, "store.db")); await runMigrations(store, MIGRATIONS);
    return { store, node: createNodeImportRuntime({ archiveDir: join(root, "archive"), store }) };
  }

  it("persists API activity, merges original FIT, and surfaces stable rerun near misses", async () => {
    const probe = await fresh("dual-probe"), target = await fresh("dual-target");
    const bytes = new Uint8Array(readFileSync("packages/kernel-node/tests/fixtures/ingest/brick-cycling.fit"));
    try {
      await probe.node.importBatchWithReport({ files: [{ input_path: "probe.fit", bytes, ext: "fit" }], platform_records: [] });
      const session = await probe.store.get("SELECT sport,start_utc,elapsed_s,distance_m FROM session");
      const raw = await probe.store.get("SELECT file_id_serial FROM raw_file");
      expect(raw?.file_id_serial).not.toBeNull();
      expect(session).toBeDefined();
      const start = Number(session!.start_utc), elapsed = Number(session!.elapsed_s);
      const activity = { id: "synthetic-activity", start_date: new Date(start * 1_000).toISOString(),
        start_date_local: "2010-01-01T00:00:00", type: session!.sport === "running" ? "Run" : "Ride",
        moving_time: elapsed, elapsed_time: elapsed, distance: session!.distance_m };
      const archiveInstant = { epochSeconds: start };
      const snapshot = await target.node.archive.writeSnapshot(activity, archiveInstant);
      const platform = await mapActivityLanding({ normalized: activity, archiveInstant, archive: snapshot });
      const fitArchive = await target.node.archive.writeArtifact(bytes, "fit", archiveInstant);
      const activityArtifact = { kind: "snapshot", source: "intervals-icu", lane: "activities", externalId: "synthetic-activity",
        archiveInstant, archive: snapshot, payload: activity, landing: { kind: "activity", platform } } as const;
      const fitArtifact = { kind: "raw-file", source: "intervals-icu", lane: "bulk-fit", externalId: "synthetic-fit",
        archiveInstant, archive: fitArchive, container: null,
        file: { input_path: "synthetic.fit", bytes, ext: "fit" } } as const;
      let bulkPulls = 0;
      const source = { id: "intervals-icu", capabilities: { activities: true, streams: true, rawFiles: true, wellness: true,
        plannedWorkoutPush: false, backfillDepth: { kind: "full-history" } },
      pull(watermark) {
        return (async function* (): AsyncIterable<SourceArtifact> {
          if (watermark.lane === "activities") { yield activityArtifact; yield complete("activities"); return; }
          if (bulkPulls++ === 0) yield fitArtifact;
          yield complete("bulk-fit");
        })();
      } } as IntervalsIcuSource;

      const activities = await runActivityAuditPages({ store: target.store, node: target.node, source, clock });
      const fit = await runBackfillPages({ store: target.store, node: target.node, source, clock });
      expect(activities.artifacts).toBe(1);
      expect(fit.artifacts).toBe(1);
      expect(await target.store.get("SELECT count(*) AS n FROM source_artifact WHERE lane='activities'")).toEqual({ n: 1 });
      expect(await target.store.get("SELECT count(*) AS n FROM workout")).toEqual({ n: 1 });
      const before = await dumpStore(target.store);
      const rerun = await target.node.importBatchWithReport({ files: [{ input_path: "archive:synthetic.fit", bytes, ext: "fit" }], platform_records: [] });
      const after = await dumpStore(target.store);
      expect(rerun.inserts).toEqual({ raw_file: 0, source_record: 0 });
      expect(after).toBe(before);
      expect(Array.isArray(rerun.threshold_near_misses)).toBe(true);
    } finally { await probe.store.close(); await target.store.close(); }
  });
});
