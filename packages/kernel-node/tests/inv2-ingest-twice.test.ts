import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DERIVED_TABLES, dumpStore, runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { REPAIR_FIXERS } from "@enduragent/kernel/ingest";
import { importFilesWithReport, setRepairFixerEnabled } from "../src/ingest/import-files.js";
import { openSqliteStorage } from "../src/sqlite/index.js";

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

describe("INV-2 ingest twice", () => {
  async function ingestTwice(allOn: boolean) {
    expect(DERIVED_TABLES.join(",")).toBe("metric_snapshot,mean_max_cache,ingest_cluster_state,ingest_dedup_session_state,ingest_dedup_pair_state,ingest_candidate_index,repair_log,stream,swim_length,lap,session,workout");
    dir = mkdtempSync(join(tmpdir(), "fit-inv2-"));
    const store = openSqliteStorage(join(dir, "store.db"));
    try {
      await runMigrations(store, MIGRATIONS);
      const options = { inputPaths: [resolve("packages/kernel-node/tests/fixtures/ingest/triathlon-multisport.fit")],
        archiveDir: join(dir, "archive"), store };
      if (allOn) for (const fixer of REPAIR_FIXERS) {
        await setRepairFixerEnabled({ fixer, enabled: true, archiveDir: options.archiveDir, store });
      }
      const first = await importFilesWithReport(options); expect(first.inserts.raw_file).toBe(1);
      const dump1 = await dumpStore(store), streams1 = await store.all("SELECT * FROM stream ORDER BY stream_key"),
        logs1 = await store.all("SELECT * FROM repair_log ORDER BY repair_key");
      const second = await importFilesWithReport(options); expect(second.inserts).toEqual({ raw_file: 0, source_record: 0 });
      expect(second.files.every((file) => !file.raw_file_inserted && file.archive_deduped)).toBe(true);
      expect(await store.all("SELECT * FROM stream ORDER BY stream_key")).toEqual(streams1);
      expect(await store.all("SELECT * FROM repair_log ORDER BY repair_key")).toEqual(logs1);
      expect(await dumpStore(store)).toBe(dump1);
      expect(await store.get("SELECT singleton,ingest_version FROM ingest_metadata")).toEqual({ singleton: 1, ingest_version: 4 });
      expect(streams1.length).toBeGreaterThan(0);
      if (allOn) expect(logs1.length).toBeGreaterThan(0);
      else expect(logs1).toEqual([]);
    } finally { await store.close(); }
  }

  it("keeps default-off dumps byte-identical across repeated ingest", async () => {
    await ingestTwice(false);
  });

  it("keeps explicit-all-on dumps byte-identical across repeated ingest", async () => {
    await ingestTwice(true);
  });
});
