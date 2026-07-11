import { describe, it, expect } from "vitest";
import {
  runMigrations,
  StoreNewerThanAppError,
  InvalidMigrationSetError,
  type Migration,
  type MigratorStore,
} from "../src/store/migrator.js";

interface FakeStore extends MigratorStore {
  userVersion: number;
  readonly execLog: string[];
}

// A synchronous in-memory MigratorStore. `transaction` snapshots userVersion +
// execLog length and restores them if `fn` throws, modeling atomic rollback.
// `failOn` makes a chosen SQL string throw, to exercise the rollback path.
function makeFakeStore(initialVersion = 0, failOn?: string): FakeStore {
  const execLog: string[] = [];
  const store: FakeStore = {
    userVersion: initialVersion,
    execLog,
    async getUserVersion() {
      return store.userVersion;
    },
    async setUserVersion(v: number) {
      store.userVersion = v;
    },
    async exec(sql: string) {
      if (failOn !== undefined && sql === failOn) throw new Error(`exec failed: ${sql}`);
      execLog.push(sql);
    },
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      const snapVersion = store.userVersion;
      const snapLen = execLog.length;
      try {
        return await fn();
      } catch (e) {
        store.userVersion = snapVersion;
        execLog.length = snapLen;
        throw e;
      }
    },
  };
  return store;
}

const PRAGMAS = ["PRAGMA journal_mode = WAL", "PRAGMA foreign_keys = ON"];

function ddlPortion(execLog: readonly string[]): string[] {
  return execLog.filter((s) => !PRAGMAS.includes(s));
}

describe("runMigrations", () => {
  it("applies pending in ascending order", async () => {
    const store = makeFakeStore(0);
    const migrations: Migration[] = [
      { version: 2, sql: "B" },
      { version: 1, sql: "A" },
      { version: 3, sql: "C" },
    ];
    const result = await runMigrations(store, migrations);
    expect(result).toEqual({ fromVersion: 0, toVersion: 3, applied: [1, 2, 3] });
    expect(store.userVersion).toBe(3);
    expect(ddlPortion(store.execLog)).toEqual(["A", "B", "C"]);
  });

  it("partial apply from a non-zero current", async () => {
    const store = makeFakeStore(1);
    const migrations: Migration[] = [
      { version: 1, sql: "A" },
      { version: 2, sql: "B" },
      { version: 3, sql: "C" },
    ];
    const result = await runMigrations(store, migrations);
    expect(result).toEqual({ fromVersion: 1, toVersion: 3, applied: [2, 3] });
    expect(store.userVersion).toBe(3);
    expect(ddlPortion(store.execLog)).toEqual(["B", "C"]);
  });

  it("idempotence (apply twice = no-op)", async () => {
    const store = makeFakeStore(0);
    const migrations: Migration[] = [{ version: 1, sql: "A" }];
    const first = await runMigrations(store, migrations);
    expect(first).toEqual({ fromVersion: 0, toVersion: 1, applied: [1] });
    const second = await runMigrations(store, migrations);
    expect(second).toEqual({ fromVersion: 1, toVersion: 1, applied: [] });
    expect(store.userVersion).toBe(1);
    expect(store.execLog.filter((s) => s === "A").length).toBe(1);
  });

  it("issues the two connection pragmas, outside/ahead of DDL", async () => {
    const store = makeFakeStore(0);
    const migrations: Migration[] = [{ version: 1, sql: "A" }];
    await runMigrations(store, migrations);
    expect(store.execLog[0]).toBe("PRAGMA journal_mode = WAL");
    expect(store.execLog[1]).toBe("PRAGMA foreign_keys = ON");
    const firstDdlIndex = store.execLog.indexOf("A");
    expect(firstDdlIndex).toBeGreaterThan(1);
  });

  it("refuses a store newer than the app (exact named error)", async () => {
    const store = makeFakeStore(2);
    const migrations: Migration[] = [{ version: 1, sql: "A" }];
    let caught: unknown;
    await expect(
      runMigrations(store, migrations).catch((e) => {
        caught = e;
        throw e;
      }),
    ).rejects.toBeInstanceOf(StoreNewerThanAppError);
    expect(caught).toBeInstanceOf(StoreNewerThanAppError);
    const err = caught as StoreNewerThanAppError;
    expect(err.message).toBe("store is newer than this app");
    expect(err.name).toBe("StoreNewerThanAppError");
    expect(err.storeVersion).toBe(2);
    expect(err.appMaxVersion).toBe(1);
    expect(store.execLog).toEqual([]);
    expect(store.userVersion).toBe(2);
  });

  it("rolls back a failing migration's transaction", async () => {
    const store = makeFakeStore(0, "BAD");
    const migrations: Migration[] = [
      { version: 1, sql: "A" },
      { version: 2, sql: "BAD" },
      { version: 3, sql: "C" },
    ];
    await expect(runMigrations(store, migrations)).rejects.toThrow("exec failed: BAD");
    expect(store.userVersion).toBe(1);
    const ddl = ddlPortion(store.execLog);
    expect(ddl).toContain("A");
    expect(ddl).not.toContain("BAD");
    expect(ddl).not.toContain("C");
  });

  it("handles an empty migration set", async () => {
    const store = makeFakeStore(0);
    const result = await runMigrations(store, []);
    expect(result).toEqual({ fromVersion: 0, toVersion: 0, applied: [] });
    expect(store.execLog).toEqual(PRAGMAS);
    expect(ddlPortion(store.execLog)).toEqual([]);
  });

  it("rejects a malformed set with a duplicate version", async () => {
    const store = makeFakeStore(0);
    const migrations: Migration[] = [
      { version: 1, sql: "A" },
      { version: 1, sql: "B" },
    ];
    await expect(runMigrations(store, migrations)).rejects.toBeInstanceOf(
      InvalidMigrationSetError,
    );
    expect(store.execLog).toEqual([]);
    expect(store.userVersion).toBe(0);
  });

  it("rejects a non-positive or non-integer version", async () => {
    const zeroStore = makeFakeStore(0);
    await expect(
      runMigrations(zeroStore, [{ version: 0, sql: "A" }]),
    ).rejects.toBeInstanceOf(InvalidMigrationSetError);

    const fracStore = makeFakeStore(0);
    await expect(
      runMigrations(fracStore, [{ version: 1.5, sql: "A" }]),
    ).rejects.toBeInstanceOf(InvalidMigrationSetError);
  });
});
