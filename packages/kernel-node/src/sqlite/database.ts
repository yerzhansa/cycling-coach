// node:sqlite is a Node built-in (no npm dependency). Runtime floor is Node >=24
// (the bundled SQLite gains FTS5 there; JSON1 is present everywhere). The recorded
// fallback to a native driver is triggered ONLY by (a) missing FTS5/JSON1 in the
// bundled build or (b) a measured >2x backfill regression; adopting it would require
// a dual-ABI build step in the same change and is out of scope for this change.
import { DatabaseSync } from "node:sqlite";
import type { MigratorStore, Row, SqlStore } from "@enduragent/kernel/store";

export function openSqliteStorage(path: string): SqlStore & MigratorStore {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  return {
    async exec(sql) {
      db.exec(sql);
    },
    async run(sql, params) {
      db.prepare(sql).run(...(params ?? []));
    },
    async get(sql, params) {
      const r = db.prepare(sql).get(...(params ?? []));
      return r === undefined || r === null ? undefined : ({ ...r } as Row);
    },
    async all(sql, params) {
      return db.prepare(sql).all(...(params ?? [])).map((r) => ({ ...r }) as Row);
    },
    async close() {
      db.close();
    },
    async getUserVersion() {
      const r = db.prepare("PRAGMA user_version").get() as { user_version: number };
      return Number(r.user_version);
    },
    async setUserVersion(version) {
      if (!Number.isSafeInteger(version) || version < 0) {
        throw new RangeError(`user_version must be a non-negative integer, got ${String(version)}`);
      }
      db.exec(`PRAGMA user_version = ${version}`);
    },
    async transaction(fn) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}
