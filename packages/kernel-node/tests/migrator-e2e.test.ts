import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DUMP_TABLES,
  createAnchorRepository,
  dumpStore,
  runMigrations,
  type AnchorHistoryRow,
  type MigratorStore,
  type SqlStore,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/index.js";

describe("migrator end-to-end over node:sqlite", () => {
  let dir: string;
  let store: SqlStore & MigratorStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kn-"));
    store = openSqliteStorage(join(dir, "store.db"));
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies the full migration list and advances user_version to 4", async () => {
    await runMigrations(store, MIGRATIONS);
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 4 });

    const tables = await store.all("SELECT name FROM sqlite_master WHERE type='table'");
    const names = new Set(tables.map((r) => r.name as string));
    for (const { table } of DUMP_TABLES) {
      expect(names.has(table)).toBe(true);
    }

    expect(await store.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(await store.all("SELECT fixer,enabled FROM repair_fixer_settings ORDER BY fixer")).toEqual([]);
    expect(await store.get("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_dedup_confirmation_effective'")).toEqual({ name: "idx_dedup_confirmation_effective" });
    expect(await store.get("PRAGMA journal_mode")).toEqual({ journal_mode: "wal" });
    await runMigrations(store, MIGRATIONS);
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 4 });
  });

  it("produces a deterministic INV-2 dump of a fixed state", async () => {
    await runMigrations(store, MIGRATIONS);
    const repo = createAnchorRepository(store);
    const row: AnchorHistoryRow = {
      id: "anchor-e2e",
      sport: "cycling",
      anchor_type: "ftp",
      value: 250.5,
      unit: "W",
      valid_from: 1000,
      source: "manual",
      confidence: "manual",
      note: null,
      provenance: "manual",
      device_id: null,
      hlc_physical_ms: null,
      hlc_counter: null,
    };
    await repo.insertIfAbsent(row);

    const dump = await dumpStore(store);
    expect(dump).toContain("# anchor_history");
    expect(dump).toContain("anchor-e2e");
    expect(await dumpStore(store)).toBe(dump);
  });

  it("upgrades a version-1-on-disk store to version 4", async () => {
    await runMigrations(store, [MIGRATIONS[0]!]);
    expect(await store.get("PRAGMA user_version")).toEqual({user_version:1});
    await runMigrations(store, MIGRATIONS);
    expect(await store.get("PRAGMA user_version")).toEqual({user_version:4});
    expect(await store.get("SELECT singleton,ingest_version FROM ingest_metadata")).toEqual({singleton:1,ingest_version:0});
    expect(await store.all("SELECT fixer,enabled FROM repair_fixer_settings ORDER BY fixer")).toEqual([]);
    expect(await store.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("shares one real transaction for exec + version bump (atomic rollback)", async () => {
    const migrations = [
      { version: 1, sql: "CREATE TABLE first_ok (a TEXT);" },
      { version: 2, sql: "CREATE TABLE second_partial (a TEXT); INSERT INTO nonexistent VALUES (1);" },
    ];
    await expect(runMigrations(store, migrations)).rejects.toThrow();

    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 1 });
    const tables = await store.all("SELECT name FROM sqlite_master WHERE type='table'");
    const names = new Set(tables.map((r) => r.name as string));
    expect(names.has("first_ok")).toBe(true);
    expect(names.has("second_partial")).toBe(false);
  });
});
