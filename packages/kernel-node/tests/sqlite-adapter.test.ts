import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqlStore, MigratorStore } from "@enduragent/kernel/store";
import { openSqliteStorage } from "../src/sqlite/index.js";

describe("openSqliteStorage adapter", () => {
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

  it("opens without changing SQLite journal or foreign-key defaults", async () => {
    const jm = await store.get("PRAGMA journal_mode");
    expect(jm).toEqual({ journal_mode: "delete" });
    const fk = await store.get("PRAGMA foreign_keys");
    expect(fk).toEqual({ foreign_keys: 0 });
  });

  it("round-trips TEXT, REAL, and BLOB values through run/get/all", async () => {
    await store.exec("CREATE TABLE t(a TEXT, n REAL, b BLOB)");
    await store.run("INSERT INTO t(a, n, b) VALUES (?,?,?)", ["x", 1.5, new Uint8Array([9])]);
    const got = await store.get("SELECT a, n, b FROM t");
    expect(got).toBeDefined();
    if (got === undefined) throw new Error("expected SQLite row");
    expect(got.a).toBe("x");
    expect(got.n).toBe(1.5);
    expect(got.b).toBeInstanceOf(Uint8Array);
    expect([...(got.b as Uint8Array)]).toEqual([9]);
    const all = await store.all("SELECT a FROM t");
    expect(all).toHaveLength(1);
    const none = await store.get("SELECT a FROM t WHERE a = ?", ["nope"]);
    expect(none).toBeUndefined();
  });

  it("reads and writes PRAGMA user_version via exec/get", async () => {
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 0 });
    await store.exec("PRAGMA user_version = 3");
    expect(await store.get("PRAGMA user_version")).toEqual({ user_version: 3 });
  });

  it("returns [] from foreign_key_check on a clean DB", async () => {
    expect(await store.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("exposes the migrator-port surface on the same connection", async () => {
    expect(await store.getUserVersion()).toBe(0);
    await store.setUserVersion(3);
    expect(await store.getUserVersion()).toBe(3);
  });

  it("rejects non-integer and negative user_version without changing state", async () => {
    await store.setUserVersion(3);
    await expect(store.setUserVersion(1.5)).rejects.toBeInstanceOf(RangeError);
    await expect(store.setUserVersion(-1)).rejects.toBeInstanceOf(RangeError);
    expect(await store.getUserVersion()).toBe(3);
  });

  it("rolls back a failing transaction and returns the result of a passing one", async () => {
    await store.exec("CREATE TABLE t(a TEXT)");
    await expect(
      store.transaction(async () => {
        await store.run("INSERT INTO t(a) VALUES (?)", ["boom"]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await store.all("SELECT a FROM t")).toEqual([]);

    const result = await store.transaction(async () => {
      await store.run("INSERT INTO t(a) VALUES (?)", ["ok"]);
      return 42;
    });
    expect(result).toBe(42);
    expect(await store.all("SELECT a FROM t")).toEqual([{ a: "ok" }]);
  });

  it("serializes concurrent transactions on one connection", async () => {
    await store.exec("CREATE TABLE t(a TEXT)");
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const continueFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = store.transaction(async () => {
      await store.run("INSERT INTO t(a) VALUES (?)", ["first"]);
      markFirstStarted();
      await continueFirst;
    });
    await firstStarted;
    const second = store.transaction(async () => {
      await store.run("INSERT INTO t(a) VALUES (?)", ["second"]);
    });
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    await expect(store.all("SELECT a FROM t ORDER BY rowid")).resolves.toEqual([
      { a: "first" },
      { a: "second" },
    ]);
  });

  it("keeps operations outside an awaited transaction out of its rollback", async () => {
    await store.exec("CREATE TABLE t(a TEXT)");
    let releaseTransaction!: () => void;
    let markTransactionStarted!: () => void;
    const transactionStarted = new Promise<void>((resolve) => {
      markTransactionStarted = resolve;
    });
    const continueTransaction = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });

    const transaction = store.transaction(async () => {
      await store.run("INSERT INTO t(a) VALUES (?)", ["rolled-back"]);
      markTransactionStarted();
      await continueTransaction;
      throw new Error("rollback");
    });
    await transactionStarted;
    const failure = expect(transaction).rejects.toThrow("rollback");
    const outsideWrite = store.run("INSERT INTO t(a) VALUES (?)", ["outside"]);
    const outsideRead = store.all("SELECT a FROM t ORDER BY rowid");
    releaseTransaction();

    await failure;
    await outsideWrite;
    await expect(outsideRead).resolves.toEqual([{ a: "outside" }]);
    await expect(store.all("SELECT a FROM t ORDER BY rowid")).resolves.toEqual([{ a: "outside" }]);
  });

  it("rejects nested transactions without leaving the connection open", async () => {
    await expect(store.transaction(() => store.transaction(async () => undefined))).rejects.toThrow(
      "nested SQLite transactions are not supported",
    );
    await expect(store.transaction(async () => 42)).resolves.toBe(42);
  });
});
