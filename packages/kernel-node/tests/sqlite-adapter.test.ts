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
    expect(got?.a).toBe("x");
    expect(got?.n).toBe(1.5);
    expect(got?.b).toBeInstanceOf(Uint8Array);
    expect([...(got?.b as Uint8Array)]).toEqual([9]);
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
});
