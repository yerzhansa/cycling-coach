import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DUMP_TABLES,
  createAnchorRepository,
  dumpStore,
  runMigrations,
  StoreNewerThanAppError,
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
    dir = mkdtempSync(join(realpathSync(tmpdir()), "kn-"));
    store = openSqliteStorage(join(dir, "store.db"));
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies the full migration list and advances user_version to 23", async () => {
    await runMigrations(store, MIGRATIONS);
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 23 });

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
    expect(await store.get("PRAGMA foreign_keys")).toEqual({ foreign_keys: 1 });
    await runMigrations(store, MIGRATIONS);
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 23 });
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

  it("upgrades a version-1-on-disk store to version 23", async () => {
    await runMigrations(store, [MIGRATIONS[0]!]);
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 1 });
    await runMigrations(store, MIGRATIONS);
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 23 });
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
    expect(result).toEqual({
      fromVersion: 4,
      toVersion: 23,
      applied: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23],
    });
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 23 });
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

  it("rolls back an injected migration-007 failure to version 6 without a partial table", async () => {
    await runMigrations(store, MIGRATIONS.slice(0, 6));
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 6 });
    const broken007 = {
      ...MIGRATIONS[6]!,
      sql: `${MIGRATIONS[6]!.sql}\nINSERT INTO missing_table VALUES (1);`,
    };
    await expect(runMigrations(store, [...MIGRATIONS.slice(0, 6), broken007])).rejects.toThrow();
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 6 });
    expect(
      await store.get("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_failure'"),
    ).toBeUndefined();
  });

  it("upgrades a version-6 store through the current schema and reruns as a no-op", async () => {
    await runMigrations(store, MIGRATIONS.slice(0, 6));
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 6 });
    const result = await runMigrations(store, MIGRATIONS);
    expect(result).toEqual({
      fromVersion: 6,
      toVersion: 23,
      applied: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23],
    });
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 23 });
    expect(
      await store.get("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_failure'"),
    ).toEqual({ name: "sync_failure" });
    await expect(runMigrations(store, MIGRATIONS)).resolves.toEqual({
      fromVersion: 23,
      toVersion: 23,
      applied: [],
    });
  });

  it("upgrades version 11 through 23 while preserving existing rows", async () => {
    await runMigrations(store, MIGRATIONS.slice(0, 11));
    await store.run("INSERT INTO repair_fixer_settings(fixer,enabled) VALUES(?,?)", [
      "chronoBridge",
      1,
    ]);

    await expect(runMigrations(store, MIGRATIONS)).resolves.toEqual({
      fromVersion: 11,
      toVersion: 23,
      applied: [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23],
    });
    await expect(store.get("SELECT fixer,enabled FROM repair_fixer_settings")).resolves.toEqual({
      fixer: "chronoBridge",
      enabled: 1,
    });
    await expect(store.get("SELECT count(*) AS count FROM repair_fixer_settings")).resolves.toEqual(
      { count: 1 },
    );
    await expect(store.get("PRAGMA user_version")).resolves.toEqual({ user_version: 23 });
  });

  it("rolls back a failed migration 12 without partial Planning tables", async () => {
    await runMigrations(store, MIGRATIONS.slice(0, 11));
    await store.run("INSERT INTO repair_fixer_settings(fixer,enabled) VALUES(?,?)", [
      "pulseWeave",
      1,
    ]);
    const tablesBefore = await store.all(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const broken = {
      ...MIGRATIONS[11]!,
      sql: `${MIGRATIONS[11]!.sql}\nINSERT INTO missing_table VALUES (1);`,
    };
    await expect(runMigrations(store, [...MIGRATIONS.slice(0, 11), broken])).rejects.toThrow();
    await expect(store.get("PRAGMA user_version")).resolves.toEqual({ user_version: 11 });
    await expect(
      store.all(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('plan','plan_workout')",
      ),
    ).resolves.toEqual([]);
    await expect(
      store.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"),
    ).resolves.toEqual(tablesBefore);
    await expect(store.get("SELECT fixer,enabled FROM repair_fixer_settings")).resolves.toEqual({
      fixer: "pulseWeave",
      enabled: 1,
    });
  });

  it("rolls back a failed migration 13 without partial Plan conversation tables", async () => {
    await runMigrations(store, MIGRATIONS.slice(0, 12));
    const tablesBefore = await store.all(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const broken = {
      ...MIGRATIONS[12]!,
      sql: `${MIGRATIONS[12]!.sql}\nINSERT INTO missing_table VALUES (1);`,
    };
    await expect(runMigrations(store, [...MIGRATIONS.slice(0, 12), broken])).rejects.toThrow();
    await expect(store.get("PRAGMA user_version")).resolves.toEqual({ user_version: 12 });
    await expect(
      store.all(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('plan_conversation','plan_conversation_turn','plan_draft_revision','plan_source_request') ORDER BY name",
      ),
    ).resolves.toEqual([]);
    await expect(
      store.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"),
    ).resolves.toEqual(tablesBefore);
  });

  it("rolls back a failed migration 14 without partial reconciliation tables", async () => {
    await runMigrations(store, MIGRATIONS.slice(0, 13));
    const tablesBefore = await store.all(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const broken = {
      ...MIGRATIONS[13]!,
      sql: `${MIGRATIONS[13]!.sql}\nINSERT INTO missing_table VALUES (1);`,
    };
    await expect(runMigrations(store, [...MIGRATIONS.slice(0, 13), broken])).rejects.toThrow();
    await expect(store.get("PRAGMA user_version")).resolves.toEqual({ user_version: 13 });
    await expect(
      store.all(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('plan_reconciliation_job','plan_reconciliation_item') ORDER BY name",
      ),
    ).resolves.toEqual([]);
    await expect(
      store.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"),
    ).resolves.toEqual(tablesBefore);
  });

  it("preserves an existing cursor and leaves its store owner unset", async () => {
    await runMigrations(store, MIGRATIONS.slice(0, 7));
    await store.run("INSERT INTO source_watermark(source,lane,watermark) VALUES(?,?,?)", [
      "intervals-icu",
      "bulk-fit",
      "legacy-cursor",
    ]);

    await runMigrations(store, MIGRATIONS);

    expect(await store.get("SELECT watermark FROM source_watermark")).toEqual({
      watermark: "legacy-cursor",
    });
    expect(await store.get("SELECT count(*) AS count FROM store_owner")).toEqual({ count: 0 });
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

  it("refuses a newer store without changing bytes or creating sidecars", async () => {
    const path = join(dir, "newer.db");
    const maximum = MIGRATIONS.at(-1)!.version;
    const seed = openSqliteStorage(path);
    await seed.setUserVersion(maximum + 1);
    await seed.close();
    const beforeNames = (await readdir(dir)).sort();
    const beforeHash = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");

    const refused = openSqliteStorage(path);
    const error = await runMigrations(refused, MIGRATIONS).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(StoreNewerThanAppError);
    expect(error).toMatchObject({
      storeVersion: maximum + 1,
      appMaxVersion: maximum,
      message: "store is newer than this app",
    });
    await refused.close();

    expect((await readdir(dir)).sort()).toEqual(beforeNames);
    expect(
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    ).toBe(beforeHash);
    expect(beforeNames).not.toContain("newer.db-wal");
    expect(beforeNames).not.toContain("newer.db-shm");
  });
});
