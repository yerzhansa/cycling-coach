import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { importFilesWithReport } from "../src/ingest/import-files.js";
import { openSqliteStorage } from "../src/sqlite/index.js";

const fixture = (name: string) => resolve(`packages/kernel-node/tests/fixtures/ingest/${name}`);

describe("global file import runner", () => {
  let dir: string, archiveDir: string, store: SqlStore & MigratorStore;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "global-import-")); archiveDir = join(dir, "archive");
    store = openSqliteStorage(join(dir, "store.db")); await runMigrations(store, MIGRATIONS);
  });
  afterEach(async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); });

  it("quarantines structural failures without SQL rows", async () => {
    const path = join(dir, "bad.fit"); writeFileSync(path, new Uint8Array([1]));
    const result = await importFilesWithReport({ inputPaths: [path], archiveDir, store });
    expect(result.files[0]).toMatchObject({ outcome: "quarantined", raw_file_inserted: false });
    expect((await store.get("SELECT count(*) c FROM raw_file"))?.c).toBe(0);
  });
  it("imports through one global planner and writes no file source_record", async () => {
    const result = await importFilesWithReport({ inputPaths: [fixture("triathlon-multisport.fit")], archiveDir, store });
    expect(result.files[0]).toMatchObject({ outcome: "imported", raw_file_inserted: true });
    expect(result.inserts).toEqual({ raw_file: 1, source_record: 0 });
    expect((await store.get("SELECT count(*) c FROM source_record"))?.c).toBe(0);
    expect((await store.get("SELECT ingest_version FROM ingest_metadata"))?.ingest_version).toBe(4);
  });
  it("sorts planning deterministically while retaining exact input paths", async () => {
    const inputPaths = [fixture("brick-running.fit"), fixture("brick-cycling.fit")];
    const forward = await importFilesWithReport({ inputPaths, archiveDir, store });
    expect(forward.files.map((file) => file.input_path).sort()).toEqual([...inputPaths].sort());
    expect(forward.clusters).toHaveLength(1);
  });
  it("uses file creation time for deterministic archive placement", async () => {
    const result = await importFilesWithReport({ inputPaths: [fixture("triathlon-multisport.fit")], archiveDir, store });
    const address = "bcaaea4ea68261cb76411669b4188fc928631bb1e0ced32efa9fe4040d6f208c";
    const relativePath = `1998/07/${address}.fit`;
    expect(result.files[0]).toMatchObject({ address, outcome: "imported" });
    expect(await store.get("SELECT path,file_id_time_created_utc FROM raw_file WHERE sha256=?", [address]))
      .toEqual({ path: relativePath, file_id_time_created_utc: 899565600 });
    expect(readFileSync(join(archiveDir, relativePath))).toEqual(readFileSync(fixture("triathlon-multisport.fit")));
  });
  it("reimports exactly with zero new raw rows", async () => {
    const inputPaths = [fixture("brick-cycling.fit")];
    expect((await importFilesWithReport({ inputPaths, archiveDir, store })).inserts.raw_file).toBe(1);
    const second = await importFilesWithReport({ inputPaths, archiveDir, store });
    expect(second.inserts.raw_file).toBe(0); expect(second.files[0]).toMatchObject({ archive_deduped: true, raw_file_inserted: false });
  });
  it("assigns one canonical raw insertion for same bytes under two paths", async () => {
    const a = join(dir, "a.fit"), z = join(dir, "z.fit"); cpSync(fixture("brick-cycling.fit"), a); cpSync(a, z);
    const result = await importFilesWithReport({ inputPaths: [z, a], archiveDir, store });
    expect(result.files.map((file) => [file.input_path, file.raw_file_inserted])).toEqual([[a, true], [z, false]]);
  });
  it("rejects duplicate paths and unsupported extensions before work", async () => {
    const path = fixture("brick-cycling.fit");
    await expect(importFilesWithReport({ inputPaths: [path, path], archiveDir, store })).rejects.toThrow();
    const txt = join(dir, "a.txt"); writeFileSync(txt, "x");
    await expect(importFilesWithReport({ inputPaths: [txt], archiveDir, store })).rejects.toThrow("unsupported input extension");
  });
  it("refuses a newer stored version before archive side effects", async () => {
    await store.run("UPDATE ingest_metadata SET ingest_version=5");
    await expect(importFilesWithReport({ inputPaths: [fixture("brick-cycling.fit")], archiveDir, store })).rejects.toThrow("newer ingest semantics");
    expect(existsSync(archiveDir)).toBe(false);
  });
  it("retires the isolated writer and standalone version-upgrade exports", async () => {
    const exports = await import("../src/ingest/index.js");
    expect(exports).not.toHaveProperty("importFitArtifact"); expect(exports).not.toHaveProperty("importFitBatch");
    expect(exports).not.toHaveProperty("ensureCurrentIngestVersion"); expect(exports).not.toHaveProperty("createArchivedArtifactReconstructor");
  });
});
