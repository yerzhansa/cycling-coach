import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dumpStore, runMigrations, sortKeys, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { canonicalJson, type ArchiveManager } from "@enduragent/kernel/archive";
import { canonicalPick, createMaterializeClusterInTransaction, importArtifactsWithReport,
  type ConcernValue, type PlatformImportArtifact } from "@enduragent/kernel/ingest";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { importFilesWithReport } from "../src/ingest/import-files.js";
import { openSqliteStorage } from "../src/sqlite/index.js";

describe("global version and overlay recompute", () => {
  let dir: string, store: SqlStore & MigratorStore, archiveDir: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "global-recompute-")); archiveDir = join(dir, "archive");
    store = openSqliteStorage(join(dir, "store.db")); await runMigrations(store, MIGRATIONS);
  });
  afterEach(async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); });
  const path = (name: string) => resolve(`packages/kernel-node/tests/fixtures/ingest/${name}`);
  function countTransactions(target = store): () => number {
    let count = 0;
    const original = target.transaction.bind(target);
    target.transaction = async (fn) => { count += 1; return original(fn); };
    return () => count;
  }

  it("upgrades stored versions zero through three to four through the global planner", async () => {
    for (const version of [0, 1, 2, 3]) {
      await store.run("UPDATE ingest_metadata SET ingest_version=?", [version]);
      const result = await importFilesWithReport({ inputPaths: [path("brick-cycling.fit")], archiveDir, store });
      expect(result.ingest_version).toBe(4);
      expect((await store.get("SELECT ingest_version FROM ingest_metadata"))?.ingest_version).toBe(4);
    }
  });
  it("keeps current version four through the operational incremental path", async () => {
    await importFilesWithReport({ inputPaths: [path("brick-cycling.fit")], archiveDir, store });
    const transactions = countTransactions();
    const result = await importFilesWithReport({ inputPaths: [path("brick-cycling.fit")], archiveDir, store });
    expect(result.ingest_version).toBe(4);
    expect(transactions()).toBe(1);
    expect((await store.get("SELECT ingest_version FROM ingest_metadata"))?.ingest_version).toBe(4);
  });
  it("refuses version five before archive and SQL side effects", async () => {
    await store.run("UPDATE ingest_metadata SET ingest_version=5");
    await expect(importFilesWithReport({ inputPaths: [path("brick-cycling.fit")], archiveDir, store })).rejects.toThrow("newer ingest semantics");
    expect(existsSync(archiveDir)).toBe(false); expect((await store.get("SELECT count(*) c FROM raw_file"))?.c).toBe(0);
  });
  it("retains and reapplies an effective pool correction through the retained full oracle", async () => {
    const options = { inputPaths: [path("pool-size-correction.fit")], archiveDir, store };
    await importFilesWithReport(options);
    const sessionKey = (await store.get("SELECT session_key FROM session"))!.session_key as string;
    expect(await store.get("SELECT distance_m FROM session WHERE session_key=?", [sessionKey])).toEqual({ distance_m: 100 });
    expect((await store.all("SELECT distance_m FROM swim_length ORDER BY length_key")).map((row) => row.distance_m)).toEqual([25, 25, 25, 25]);
    const beforeOverlay = await dumpStore(store);
    await importFilesWithReport(options);
    expect(await dumpStore(store)).toBe(beforeOverlay);
    await store.run("INSERT INTO pool_size_correction_overlay(id,target_session_key,corrected_pool_length_m,device_id,hlc_physical_ms,hlc_counter) VALUES(?,?,?,?,?,?)",
      ["overlay", sessionKey, 50, "device", 2, 1]);
    const overlay = await store.get("SELECT * FROM pool_size_correction_overlay");
    await store.run("UPDATE ingest_incremental_state SET initialized=0 WHERE singleton=1");
    await importFilesWithReport(options);
    expect(await store.get("SELECT * FROM pool_size_correction_overlay")).toEqual(overlay);
    expect(await store.get("SELECT distance_m FROM session WHERE session_key=?", [sessionKey])).toEqual({ distance_m: 200 });
    expect((await store.all("SELECT distance_m FROM swim_length ORDER BY length_key")).map((row) => row.distance_m)).toEqual([50, 50, 50, 50]);
  });
  it("retains an authored overlay while incrementally materializing an unrelated cluster", async () => {
    const options = { inputPaths: [path("pool-size-correction.fit")], archiveDir, store };
    await importFilesWithReport(options);
    const sessionKey = String((await store.get("SELECT session_key FROM session"))!.session_key);
    await store.run("INSERT INTO pool_size_correction_overlay(id,target_session_key,corrected_pool_length_m,device_id,hlc_physical_ms,hlc_counter) VALUES(?,?,?,?,?,?)",
      ["incremental-overlay", sessionKey, 50, "device", 2, 1]);
    const overlay = await store.get("SELECT * FROM pool_size_correction_overlay WHERE id='incremental-overlay'");
    const report = await importFilesWithReport({ inputPaths: [path("brick-cycling.fit")], archiveDir, store });
    expect(report.clusters).toHaveLength(2);
    expect(await store.get("SELECT distance_m FROM session WHERE session_key=?", [sessionKey])).toEqual({ distance_m: 100 });
    expect(await store.get("SELECT * FROM pool_size_correction_overlay WHERE id='incremental-overlay'")).toEqual(overlay);
    expect(report.orphaned_overlays).not.toContainEqual(expect.objectContaining({ id: "incremental-overlay" }));
  });
  it("revision preserves authored overlay at the unchanged session key", async () => {
    const values = new Map<string, unknown>();
    const archive: ArchiveManager = {
      async writeSnapshot(value, when) {
        const address = createHash("sha256").update(canonicalJson(value)).digest("hex"), relPath = `${when.epochSeconds}/${address}.json.gz`;
        values.set(relPath, structuredClone(value)); return { address, relPath, deduped: false };
      },
      async readSnapshot(pathValue) { return structuredClone(values.get(pathValue)); },
      async has(pathValue) { return values.has(pathValue); },
      async writeArtifact() { throw new Error("unused"); }, async readArtifact() { throw new Error("unused"); },
      async quarantine() { throw new Error("unused"); },
    };
    const hashKey = async (fields: readonly (string | number)[]) => createHash("sha256").update(fields.join("\u001f")).digest("hex");
    const makePlatform = async (name: string): Promise<PlatformImportArtifact> => {
      const activity = { id: "overlay-activity", name }, instant = { epochSeconds: 884_000_000 };
      const archived = await archive.writeSnapshot(activity, instant);
      const concerns: Record<string, ConcernValue> = { "session.sport": "cycling", "session.start_utc": instant.epochSeconds,
        "session.local_date_key": 19980105, "session.elapsed_s": 100, "session.is_transition": false,
        "session.summary_json": JSON.stringify(sortKeys(activity)), "stream:time": { timestamps: [884_000_000, 884_000_100], values: [884_000_000, 884_000_100] } };
      return { source: "intervals-icu", activity_id: activity.id, activity, concerns,
        dedup: { sport_family: "cycling", is_transition: false, start_utc: instant.epochSeconds, duration_s: 100, distance_m: null },
        raw_snapshot_address: archived.address, raw_snapshot_rel_path: archived.relPath,
        sourceEvidence: { source: "intervals-icu", lane: "activities", externalId: activity.id,
          archiveInstant: instant, archive: archived, normalizedActivityJson: canonicalJson(activity) } };
    };
    const deps = { store, archive, hashKey, canonicalPick, prepareFile: async () => { throw new Error("unused"); },
      materializeClusterInTransaction: createMaterializeClusterInTransaction(hashKey), ingestVersion: 4 as const };
    await importArtifactsWithReport({ files: [], platform_records: [await makePlatform("first")] }, deps);
    const sessionKey = String((await store.get("SELECT session_key FROM session"))!.session_key);
    await store.run("INSERT INTO field_merge_override_overlay(id,target_table,target_key,field_name,override_value_json,device_id,hlc_physical_ms,hlc_counter) VALUES(?,?,?,?,?,?,?,?)",
      ["authored-overlay", "session", sessionKey, "name", '"preferred"', "device", 1, 0]);
    const before = await store.get("SELECT * FROM field_merge_override_overlay WHERE id='authored-overlay'");
    const report = await importArtifactsWithReport({ files: [], platform_records: [await makePlatform("renamed")] }, deps);
    expect((await store.get("SELECT session_key FROM session"))!.session_key).toBe(sessionKey);
    expect(await store.get("SELECT * FROM field_merge_override_overlay WHERE id='authored-overlay'")).toEqual(before);
    expect(report.orphaned_overlays).not.toContainEqual(expect.objectContaining({ id: "authored-overlay" }));
    expect(report.updates.source_record).toBe(1);
  });
  it("rolls back derived replacement when materialization fails", async () => {
    const options = { inputPaths: [path("brick-cycling.fit")], archiveDir, store };
    await importFilesWithReport(options);
    await store.run("UPDATE ingest_incremental_state SET initialized=0 WHERE singleton=1");
    const before = await dumpStore(store);
    const transactions = countTransactions();
    const original = store.run.bind(store); let failed = false;
    store.run = async (sql, params) => {
      if (!failed && sql.startsWith("INSERT INTO session")) { failed = true; throw new Error("injected session failure"); }
      return original(sql, params);
    };
    await expect(importFilesWithReport(options)).rejects.toThrow("injected session failure");
    store.run = original;
    expect(transactions()).toBe(1);
    expect(await dumpStore(store)).toBe(before);
  });
  it("orders archive side effects by path and owns duplicate-byte insertion once", async () => {
    const a = join(dir, "a.fit"), z = join(dir, "z.fit");
    copyFileSync(path("brick-cycling.fit"), a);
    copyFileSync(path("brick-cycling.fit"), z);
    const transactions = countTransactions();
    const result = await importFilesWithReport({ inputPaths: [z, a], archiveDir, store });
    expect(result.files.map((file) => [file.input_path, file.archive_deduped, file.raw_file_inserted])).toEqual([
      [a, false, true],
      [z, true, false],
    ]);
    expect(transactions()).toBe(1);
    expect((await store.get("SELECT count(*) AS count FROM raw_file"))?.count).toBe(1);
  });
  it("prevents a stale global plan from deleting a concurrently committed import", async () => {
    await store.close();
    const databasePath = join(dir, "race.db");
    store = openSqliteStorage(databasePath);
    await runMigrations(store, MIGRATIONS);
    const competing = openSqliteStorage(databasePath);
    await runMigrations(competing, MIGRATIONS);
    try {
      await importFilesWithReport({ inputPaths: [path("brick-cycling.fit")], archiveDir, store });
      let reached!: () => void;
      let release!: () => void;
      const planningComplete = new Promise<void>((resolveReached) => { reached = resolveReached; });
      const continueTransaction = new Promise<void>((resolveRelease) => { release = resolveRelease; });
      const original = store.transaction.bind(store);
      store.transaction = async (fn) => {
        reached();
        await continueTransaction;
        return original(fn);
      };
      const stale = importFilesWithReport({ inputPaths: [path("brick-cycling.fit")], archiveDir, store });
      await planningComplete;
      await importFilesWithReport({ inputPaths: [path("brick-running.fit")], archiveDir, store: competing });
      const beforeStaleTransaction = await dumpStore(competing);
      release();
      await expect(stale).rejects.toThrow("ingest inputs changed during planning");
      expect(await dumpStore(competing)).toBe(beforeStaleTransaction);
      expect((await competing.get("SELECT count(*) AS count FROM raw_file"))?.count).toBe(2);
    } finally {
      await competing.close();
    }
  });
});
