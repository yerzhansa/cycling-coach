// node:sqlite is a Node built-in (no npm dependency). Runtime floor is Node >=24
// (the bundled SQLite gains FTS5 there; JSON1 is present everywhere). The recorded
// fallback to a native driver is triggered ONLY by (a) missing FTS5/JSON1 in the
// bundled build or (b) a measured >2x backfill regression; adopting it would require
// a dual-ABI build step in the same change and is out of scope for this change.
import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";
import type { MigratorStore, Row, SqlReadStore, SqlStore } from "@enduragent/kernel/store";

export function openReadonlySqliteStorage(path: string): SqlReadStore {
  const db = new DatabaseSync(path, { readOnly: true });
  return {
    async get(sql, params) {
      const row = db.prepare(sql).get(...(params ?? []));
      return row === undefined || row === null ? undefined : ({ ...row } as Row);
    },
    async all(sql, params) {
      return db
        .prepare(sql)
        .all(...(params ?? []))
        .map((row) => ({ ...row }) as Row);
    },
    async close() {
      db.close();
    },
  };
}

export function openSqliteStorage(path: string): SqlStore & MigratorStore {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  const transactionContext = new AsyncLocalStorage<symbol>();
  let activeTransaction: symbol | undefined;
  let queuedTransactions = 0;
  let transactionTail = Promise.resolve();
  const pendingTransaction = (): Promise<void> | undefined => {
    const context = transactionContext.getStore();
    if (context !== undefined && context === activeTransaction) return undefined;
    return queuedTransactions === 0 ? undefined : transactionTail;
  };
  return {
    async exec(sql) {
      const pending = pendingTransaction();
      if (pending !== undefined) await pending;
      db.exec(sql);
    },
    async run(sql, params) {
      const pending = pendingTransaction();
      if (pending !== undefined) await pending;
      db.prepare(sql).run(...(params ?? []));
    },
    async get(sql, params) {
      const pending = pendingTransaction();
      if (pending !== undefined) await pending;
      const r = db.prepare(sql).get(...(params ?? []));
      return r === undefined || r === null ? undefined : ({ ...r } as Row);
    },
    async all(sql, params) {
      const pending = pendingTransaction();
      if (pending !== undefined) await pending;
      return db
        .prepare(sql)
        .all(...(params ?? []))
        .map((r) => ({ ...r }) as Row);
    },
    async close() {
      const pending = pendingTransaction();
      if (pending !== undefined) await pending;
      db.close();
    },
    async getUserVersion() {
      const pending = pendingTransaction();
      if (pending !== undefined) await pending;
      const r = db.prepare("PRAGMA user_version").get() as { user_version: number };
      return Number(r.user_version);
    },
    async setUserVersion(version) {
      if (!Number.isSafeInteger(version) || version < 0) {
        throw new RangeError(`user_version must be a non-negative integer, got ${String(version)}`);
      }
      const pending = pendingTransaction();
      if (pending !== undefined) await pending;
      db.exec(`PRAGMA user_version = ${version}`);
    },
    async transaction(fn) {
      const context = transactionContext.getStore();
      if (context !== undefined && context === activeTransaction) {
        throw new Error("nested SQLite transactions are not supported");
      }
      const previous = transactionTail;
      let release!: () => void;
      queuedTransactions += 1;
      transactionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      const transaction = Symbol();
      activeTransaction = transaction;
      try {
        return await transactionContext.run(transaction, async () => {
          db.exec("BEGIN IMMEDIATE");
          try {
            const result = await fn();
            db.exec("COMMIT");
            return result;
          } catch (err) {
            db.exec("ROLLBACK");
            throw err;
          }
        });
      } finally {
        if (activeTransaction === transaction) activeTransaction = undefined;
        queuedTransactions -= 1;
        release();
      }
    },
  };
}
