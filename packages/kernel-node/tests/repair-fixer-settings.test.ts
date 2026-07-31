import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REPAIR_FIXERS } from "@enduragent/kernel/ingest";
import {
  DERIVED_TABLES,
  DUMP_TABLES,
  dumpStore,
  runMigrations,
  type MigratorStore,
  type Row,
  type SqlStore,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { importFilesWithReport, setRepairFixerEnabled } from "../src/ingest/import-files.js";
import { openSqliteStorage } from "../src/sqlite/index.js";

type Store = SqlStore & MigratorStore;

const roots = new Set<string>();
const stores = new Set<Store>();
const fixture = resolve("packages/kernel-node/tests/fixtures/ingest/triathlon-multisport.fit");

afterEach(async () => {
  for (const store of stores) await store.close();
  stores.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

async function fresh(label: string) {
  const root = mkdtempSync(join(tmpdir(), `${label}-`));
  roots.add(root);
  const store = openSqliteStorage(join(root, "store.db"));
  stores.add(store);
  await runMigrations(store, MIGRATIONS);
  return { root, store, archiveDir: join(root, "archive") };
}

const importFixture = (value: Awaited<ReturnType<typeof fresh>>) => importFilesWithReport({
  inputPaths: [fixture],
  archiveDir: value.archiveDir,
  store: value.store,
});

const settings = (store: Store) => store.all("SELECT fixer,enabled FROM repair_fixer_settings ORDER BY fixer COLLATE BINARY ASC");
const streams = (store: Store) => store.all("SELECT * FROM stream ORDER BY stream_key COLLATE BINARY ASC");
const logs = (store: Store) => store.all("SELECT * FROM repair_log ORDER BY repair_key COLLATE BINARY ASC");
const metadata = (store: Store) => store.get("SELECT singleton,ingest_version FROM ingest_metadata WHERE singleton=1");

async function derivedSnapshot(store: Store): Promise<Readonly<Record<string, readonly Row[]>>> {
  const result: Record<string, readonly Row[]> = {};
  for (const { table, orderBy } of DUMP_TABLES) {
    if ((DERIVED_TABLES as readonly string[]).includes(table)) {
      result[table] = await store.all(`SELECT * FROM ${table} ORDER BY ${orderBy} COLLATE BINARY ASC`);
    }
  }
  return result;
}

describe("repair fixer settings", () => {
  it("defaults all fixers off and ingests zero repair rows", async () => {
    const value = await fresh("repair-default-off");
    expect(await settings(value.store)).toEqual([]);
    await importFixture(value);
    expect((await streams(value.store)).length).toBeGreaterThan(0);
    expect(await logs(value.store)).toEqual([]);
    expect(await settings(value.store)).toEqual([]);
    expect(await metadata(value.store)).toEqual({ singleton: 1, ingest_version: 4 });
  });

  it("enables and disables each fixer through a global rebuild", async () => {
    const value = await fresh("repair-toggle");
    await importFixture(value);
    const offDump = await dumpStore(value.store);
    const offStreams = await streams(value.store);
    const offLogs = await logs(value.store);
    const rawCount = await value.store.get("SELECT count(*) AS count FROM raw_file");
    expect(offLogs).toEqual([]);
    for (const fixer of REPAIR_FIXERS) {
      await expect(setRepairFixerEnabled({ fixer, enabled: true, archiveDir: value.archiveDir, store: value.store }))
        .resolves.toEqual({ changed: true, rebuilt: true, from: false, to: true, ingest_version: 4 });
      expect(await settings(value.store)).toEqual([{ fixer, enabled: 1 }]);
      const enabledLogs = await logs(value.store);
      expect(enabledLogs.length).toBeGreaterThan(0);
      expect(new Set(enabledLogs.map((row) => row.fixer))).toEqual(new Set([fixer]));
      expect(enabledLogs).not.toEqual(offLogs);
      expect(await value.store.get("SELECT count(*) AS count FROM raw_file")).toEqual(rawCount);
      expect(await metadata(value.store)).toEqual({ singleton: 1, ingest_version: 4 });
      await expect(setRepairFixerEnabled({ fixer, enabled: false, archiveDir: value.archiveDir, store: value.store }))
        .resolves.toEqual({ changed: true, rebuilt: true, from: true, to: false, ingest_version: 4 });
      expect(await settings(value.store)).toEqual([]);
      expect(await streams(value.store)).toEqual(offStreams);
      expect(await logs(value.store)).toEqual(offLogs);
      expect(await dumpStore(value.store)).toBe(offDump);
    }
  });

  it("all-on transition matches fresh all-on ingest byte for byte", async () => {
    const transitioned = await fresh("repair-transitioned");
    const freshOn = await fresh("repair-fresh-on");
    await importFixture(transitioned);
    for (const fixer of REPAIR_FIXERS) {
      await setRepairFixerEnabled({ fixer, enabled: true, archiveDir: transitioned.archiveDir, store: transitioned.store });
      await setRepairFixerEnabled({ fixer, enabled: true, archiveDir: freshOn.archiveDir, store: freshOn.store });
    }
    await importFixture(freshOn);
    expect(await dumpStore(transitioned.store)).toBe(await dumpStore(freshOn.store));
    expect(await streams(transitioned.store)).toEqual(await streams(freshOn.store));
    expect(await logs(transitioned.store)).toEqual(await logs(freshOn.store));
  });

  it("rolls back the setting and derived state when rebuild fails", async () => {
    const value = await fresh("repair-rollback");
    await importFixture(value);
    const before = await dumpStore(value.store);
    const beforeStreams = await streams(value.store);
    const beforeLogs = await logs(value.store);
    const beforeRaw = await value.store.get("SELECT count(*) AS count FROM raw_file");
    const originalRun = value.store.run.bind(value.store);
    let failed = false;
    value.store.run = async (sql, params) => {
      if (!failed && sql.startsWith("INSERT INTO session")) {
        failed = true;
        throw new Error("injected session failure");
      }
      return originalRun(sql, params);
    };
    await expect(setRepairFixerEnabled({
      fixer: "chronoBridge",
      enabled: true,
      archiveDir: value.archiveDir,
      store: value.store,
    })).rejects.toThrow("injected session failure");
    value.store.run = originalRun;
    expect(await dumpStore(value.store)).toBe(before);
    expect(await settings(value.store)).toEqual([]);
    expect(await metadata(value.store)).toEqual({ singleton: 1, ingest_version: 4 });
    expect(await streams(value.store)).toEqual(beforeStreams);
    expect(await logs(value.store)).toEqual(beforeLogs);
    expect(await value.store.get("SELECT count(*) AS count FROM raw_file")).toEqual(beforeRaw);
  });

  it("current-version setting no-op performs no rebuild", async () => {
    const value = await fresh("repair-current-noop");
    await importFixture(value);
    const before = await dumpStore(value.store);
    const parkedArchive = `${value.archiveDir}-parked`;
    renameSync(value.archiveDir, parkedArchive);
    let transactions = 0;
    const originalTransaction = value.store.transaction.bind(value.store);
    value.store.transaction = async (fn) => { transactions += 1; return originalTransaction(fn); };
    await expect(setRepairFixerEnabled({
      fixer: "chronoBridge",
      enabled: false,
      archiveDir: value.archiveDir,
      store: value.store,
    })).resolves.toEqual({ changed: false, rebuilt: false, from: false, to: false, ingest_version: 4 });
    expect(existsSync(value.archiveDir)).toBe(false);
    expect(transactions).toBe(0);
    expect(await dumpStore(value.store)).toBe(before);
    renameSync(parkedArchive, value.archiveDir);
  });

  it("stale-version setting no-op still performs one rebuild", async () => {
    const value = await fresh("repair-stale-noop");
    let transactions = 0;
    const originalTransaction = value.store.transaction.bind(value.store);
    value.store.transaction = async (fn) => { transactions += 1; return originalTransaction(fn); };
    await expect(setRepairFixerEnabled({
      fixer: "chronoBridge",
      enabled: false,
      archiveDir: value.archiveDir,
      store: value.store,
    })).resolves.toEqual({ changed: false, rebuilt: true, from: false, to: false, ingest_version: 4 });
    expect(existsSync(value.archiveDir)).toBe(false);
    expect(transactions).toBe(1);
    expect(await metadata(value.store)).toEqual({ singleton: 1, ingest_version: 4 });
    expect(await value.store.all("SELECT * FROM raw_file")).toEqual([]);
    expect(await settings(value.store)).toEqual([]);
    for (const table of DERIVED_TABLES) expect(await value.store.all(`SELECT * FROM ${table}`)).toEqual([]);
    expect(await dumpStore(value.store)).toContain("# repair_fixer_settings");
  });

  it("rejects a concurrent settings change before mutation", async () => {
    const value = await fresh("repair-race");
    await importFixture(value);
    await value.store.close();
    stores.delete(value.store);
    const databasePath = join(value.root, "store.db");
    const primary = openSqliteStorage(databasePath);
    const competing = openSqliteStorage(databasePath);
    stores.add(primary);
    stores.add(competing);
    const beforeDerived = await derivedSnapshot(primary);
    let reached!: () => void;
    let release!: () => void;
    const planningComplete = new Promise<void>((resolveReached) => { reached = resolveReached; });
    const continueTransaction = new Promise<void>((resolveRelease) => { release = resolveRelease; });
    const originalTransaction = primary.transaction.bind(primary);
    primary.transaction = async (fn) => {
      reached();
      await continueTransaction;
      return originalTransaction(fn);
    };
    const stale = setRepairFixerEnabled({
      fixer: "chronoBridge",
      enabled: true,
      archiveDir: value.archiveDir,
      store: primary,
    });
    await planningComplete;
    await competing.run("INSERT INTO repair_fixer_settings (fixer, enabled) VALUES (?, 1)", ["summitGuard"]);
    release();
    await expect(stale).rejects.toThrow(new Error("ingest inputs changed during planning"));
    expect(await settings(primary)).toEqual([{ fixer: "summitGuard", enabled: 1 }]);
    expect(await derivedSnapshot(primary)).toEqual(beforeDerived);
  });
});
