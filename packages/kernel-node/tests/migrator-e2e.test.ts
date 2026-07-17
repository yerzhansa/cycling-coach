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

  it("applies the full migration list and advances user_version to 5", async () => {
    await runMigrations(store, MIGRATIONS);
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 5 });

    const tables = await store.all("SELECT name FROM sqlite_master WHERE type='table'");
    const names = new Set(tables.map((r) => r.name as string));
    for (const { table } of DUMP_TABLES) {
      expect(names.has(table)).toBe(true);
    }

    expect(await store.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(
      await store.all("SELECT fixer,enabled FROM repair_fixer_settings ORDER BY fixer"),
    ).toEqual([]);
    expect(
      await store.get(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_dedup_confirmation_effective'",
      ),
    ).toEqual({ name: "idx_dedup_confirmation_effective" });
    expect(await store.get("PRAGMA journal_mode")).toEqual({ journal_mode: "wal" });
    await runMigrations(store, MIGRATIONS);
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 5 });
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

  it("upgrades a version-1-on-disk store to version 5", async () => {
    await runMigrations(store, [MIGRATIONS[0]!]);
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 1 });
    await runMigrations(store, MIGRATIONS);
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 5 });
    expect(await store.get("SELECT singleton,ingest_version FROM ingest_metadata")).toEqual({
      singleton: 1,
      ingest_version: 0,
    });
    expect(
      await store.all("SELECT fixer,enabled FROM repair_fixer_settings ORDER BY fixer"),
    ).toEqual([]);
    expect(await store.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("upgrades an existing version-4 store and backfills legacy source records", async () => {
    await runMigrations(store, MIGRATIONS.slice(0, 4));
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 4 });
    await store.run(
      "INSERT INTO source_record(id,workout_key,session_key,source,external_id,raw_sha256,quality_rank,payload_json) VALUES(?,?,?,?,?,?,?,?)",
      ["legacy-source", null, null, "intervals-icu", "42", null, 300, '{"v":1}'],
    );

    const result = await runMigrations(store, MIGRATIONS);
    expect(result).toEqual({ fromVersion: 4, toVersion: 5, applied: [5] });
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 5 });
    expect(
      await store.get("SELECT revision_id,source_record_id FROM source_record_revision"),
    ).toEqual({
      revision_id: "legacy-source",
      source_record_id: "legacy-source",
    });
    expect(
      await store.get("SELECT source_record_id,revision_id FROM source_record_current"),
    ).toEqual({
      source_record_id: "legacy-source",
      revision_id: "legacy-source",
    });
    expect(await store.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("rolls back an injected migration-005 failure to version 4 without 005 objects", async () => {
    await runMigrations(store, MIGRATIONS.slice(0, 4));
    const broken005 = {
      ...MIGRATIONS[4]!,
      sql: `${MIGRATIONS[4]!.sql}\nINSERT INTO missing_table VALUES (1);`,
    };
    await expect(runMigrations(store, [...MIGRATIONS.slice(0, 4), broken005])).rejects.toThrow();

    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 4 });
    const objects = await store.all(
      "SELECT name FROM sqlite_master WHERE name IN ('source_artifact','source_record_revision','source_record_current','source_watermark','sync_operation')",
    );
    expect(objects).toEqual([]);
    const columns = await store.all("PRAGMA table_info(source_record)");
    expect(columns.some((row) => row.name === "artifact_key")).toBe(false);
  });

  it("shares one real transaction for exec + version bump (atomic rollback)", async () => {
    const migrations = [
      { version: 1, sql: "CREATE TABLE first_ok (a TEXT);" },
      {
        version: 2,
        sql: "CREATE TABLE second_partial (a TEXT); INSERT INTO nonexistent VALUES (1);",
      },
    ];
    await expect(runMigrations(store, migrations)).rejects.toThrow();

    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 1 });
    const tables = await store.all("SELECT name FROM sqlite_master WHERE type='table'");
    const names = new Set(tables.map((r) => r.name as string));
    expect(names.has("first_ok")).toBe(true);
    expect(names.has("second_partial")).toBe(false);
  });
});
