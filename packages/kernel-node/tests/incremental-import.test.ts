import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dumpStore, runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createNodeImportRuntime } from "../src/ingest/import-files.js";
import { openSqliteStorage } from "../src/sqlite/index.js";

const fixture = (name: string): string => join("packages/kernel-node/tests/fixtures/ingest", name);
const artifact = (name: string) => ({ input_path: name, bytes: new Uint8Array(readFileSync(fixture(name))), ext: name.endsWith(".fit") ? "fit" as const : "tcx" as const });

describe("operational incremental Node import", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  async function fresh(): Promise<{ root: string; store: SqlStore & MigratorStore; runtime: ReturnType<typeof createNodeImportRuntime> }> {
    const root = mkdtempSync(join(tmpdir(), "incremental-node-")); roots.push(root);
    const store = openSqliteStorage(join(root, "store.db")); await runMigrations(store, MIGRATIONS);
    return { root, store, runtime: createNodeImportRuntime({ archiveDir: join(root, "archive"), store }) };
  }

  it("uses one runtime and converges across batch partitions", async () => {
    const left = await fresh(), right = await fresh();
    try {
      await left.runtime.importBatchWithReport({ files: [artifact("brick-cycling.fit")], platform_records: [] });
      await left.runtime.importBatchWithReport({ files: [artifact("brick-running.fit")], platform_records: [] });
      await right.runtime.importBatchWithReport({ files: [artifact("brick-running.fit"), artifact("brick-cycling.fit")], platform_records: [] });
      expect(await dumpStore(left.store)).toBe(await dumpStore(right.store));
      expect(await left.store.get("SELECT initialized FROM ingest_incremental_state")).toEqual({ initialized: 1 });
      expect((await left.store.all("SELECT candidate_id FROM ingest_candidate_index")).length).toBeGreaterThan(0);
    } finally { await left.store.close(); await right.store.close(); }
  });

  it("commits data and progress together and performs no write after finalizer", async () => {
    const value = await fresh();
    try {
      await expect(value.runtime.importBatchWithReport({ files: [artifact("brick-cycling.fit")], platform_records: [] }, {
        finalizeBatchInTransaction: async () => { throw new Error("injected finalizer failure"); },
      })).rejects.toThrow("injected finalizer failure");
      expect(await value.store.get("SELECT count(*) AS n FROM raw_file")).toEqual({ n: 0 });
      expect(await value.store.get("SELECT count(*) AS n FROM workout")).toEqual({ n: 0 });
      expect(await value.store.get("SELECT initialized FROM ingest_incremental_state")).toEqual({ initialized: 0 });
      let finalized = false;
      const original = value.store.run.bind(value.store);
      value.store.run = async (sql, params) => { if (finalized) throw new Error("write after finalizer"); return original(sql, params); };
      await value.runtime.importBatchWithReport({ files: [artifact("brick-cycling.fit")], platform_records: [] }, {
        finalizeBatchInTransaction: async () => { finalized = true; },
      });
      expect(finalized).toBe(true);
    } finally { await value.store.close(); }
  });

  it("bootstraps a legacy initialized cache exactly once", async () => {
    const value = await fresh();
    try {
      await value.runtime.importBatchWithReport({ files: [artifact("brick-cycling.fit")], platform_records: [] });
      await value.store.run("UPDATE ingest_incremental_state SET initialized=0");
      await value.runtime.importBatchWithReport({ files: [artifact("brick-running.fit")], platform_records: [] });
      expect(await value.store.get("SELECT initialized FROM ingest_incremental_state")).toEqual({ initialized: 1 });
      const before = await dumpStore(value.store);
      const replay = await value.runtime.importBatchWithReport({ files: [artifact("brick-running.fit")], platform_records: [] });
      expect(replay.inserts).toEqual({ raw_file: 0, source_record: 0 });
      expect(await dumpStore(value.store)).toBe(before);
    } finally { await value.store.close(); }
  });

  it("rejects cache disagreement before committing new input", async () => {
    const value = await fresh();
    try {
      await value.runtime.importBatchWithReport({ files: [artifact("brick-cycling.fit")], platform_records: [] });
      const row = await value.store.get("SELECT candidate_id,candidate_summary_json FROM ingest_candidate_index LIMIT 1");
      const parsed = JSON.parse(String(row!.candidate_summary_json)); parsed.duration_s += 1;
      await value.store.run("UPDATE ingest_candidate_index SET candidate_summary_json=? WHERE candidate_id=?", [JSON.stringify(parsed), row!.candidate_id]);
      await expect(value.runtime.importBatchWithReport({ files: [artifact("brick-running.fit")], platform_records: [] })).rejects.toThrow("candidate cache disagreement");
      expect(await value.store.get("SELECT count(*) AS n FROM raw_file")).toEqual({ n: 1 });
    } finally { await value.store.close(); }
  });
});
