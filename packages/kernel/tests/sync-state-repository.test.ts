import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/store/migrations/index.js";
import type { Row, SqlStore, SqlValue } from "../src/store/ports.js";
import { createSyncStateRepository } from "../src/store/sync-state-repository.js";
import type { SyncCompletion } from "../src/store/sync-source.js";

interface Call {
  readonly method: "get" | "run";
  readonly sql: string;
  readonly params: readonly SqlValue[];
}

class FakeStore implements SqlStore {
  readonly calls: Call[] = [];
  readonly gets: Array<Row | undefined> = [];

  async exec(sql: string): Promise<void> {
    throw new Error(`unexpected exec: ${sql}`);
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<void> {
    if (/\b(?:BEGIN|COMMIT|ROLLBACK)\b|transaction\s*\(/i.test(sql)) {
      throw new Error("transaction control forbidden");
    }
    this.calls.push({ method: "run", sql, params });
  }

  async get(sql: string, params: readonly SqlValue[] = []): Promise<Row | undefined> {
    if (/\b(?:BEGIN|COMMIT|ROLLBACK)\b|transaction\s*\(/i.test(sql)) {
      throw new Error("transaction control forbidden");
    }
    this.calls.push({ method: "get", sql, params });
    return this.gets.shift();
  }

  async all(): Promise<Row[]> {
    throw new Error("unexpected all");
  }

  async close(): Promise<void> {}
}

const readSql = `SELECT watermark
FROM source_watermark
WHERE source = ? AND lane = ?`;
const insertSql = `INSERT INTO sync_operation (
  source,
  lane,
  watermark_before,
  watermark_after,
  artifacts_seen,
  source_changes,
  completion_kind
) VALUES (?, ?, ?, ?, ?, ?, ?)
RETURNING operation_id`;
const upsertSql = `INSERT INTO source_watermark (source, lane, watermark)
VALUES (?, ?, ?)
ON CONFLICT(source, lane) DO UPDATE
SET watermark = excluded.watermark`;

const baseCompletion: SyncCompletion = {
  source: "intervals-icu",
  lane: "activities",
  watermarkBefore: null,
  watermarkAfter: "opaque-next",
  artifactsSeen: 2,
  sourceChanges: 1,
};

describe("sync state repository", () => {
  it("reads absent, present, and long opaque watermarks with exact SQL", async () => {
    const store = new FakeStore();
    store.gets.push(undefined, { watermark: "cursor:" + "x".repeat(4_096) });
    const repository = createSyncStateRepository(store);

    const absent = await repository.readWatermark("intervals-icu", "activities");
    const present = await repository.readWatermark("intervals-icu", "activities");
    expect(absent).toEqual({ source: "intervals-icu", lane: "activities", value: null });
    expect(present.value).toBe("cursor:" + "x".repeat(4_096));
    expect(Object.isFrozen(absent)).toBe(true);
    expect(Object.isFrozen(present)).toBe(true);
    expect(store.calls).toEqual([
      { method: "get", sql: readSql, params: ["intervals-icu", "activities"] },
      { method: "get", sql: readSql, params: ["intervals-icu", "activities"] },
    ]);
  });

  it("validates watermark keys and selected row shapes", async () => {
    const store = new FakeStore();
    const repository = createSyncStateRepository(store);
    for (const [source, lane] of [
      ["unknown", "activities"],
      ["intervals-icu", "file-discovery"],
      ["file-import", "activities"],
      ["file-import", "unknown"],
    ] as const) {
      await expect(repository.readWatermark(source as never, lane as never)).rejects.toThrowError(
        new TypeError("invalid sync watermark key"),
      );
    }
    expect(store.calls).toEqual([]);

    const malformedRows: Row[] = [
      { watermark: "", extra: null },
      { watermark: "" },
      { watermark: null },
      { other: "x" },
    ];
    for (const malformed of malformedRows) {
      store.gets.push(malformed);
      await expect(repository.readWatermark("file-import", "file-discovery")).rejects.toThrow(
        "invalid sync watermark row",
      );
    }
  });

  it("records applied and no-op completions without transaction control", async () => {
    const store = new FakeStore();
    store.gets.push(undefined, { operation_id: 7 }, { watermark: "opaque-next" });
    const repository = createSyncStateRepository(store);
    const applied = await repository.recordCompletionInTransaction(baseCompletion);

    expect(applied).toEqual({ operationId: 7, completionKind: "applied" });
    expect(Object.isFrozen(applied)).toBe(true);
    expect(store.calls).toEqual([
      { method: "get", sql: readSql, params: ["intervals-icu", "activities"] },
      {
        method: "get",
        sql: insertSql,
        params: ["intervals-icu", "activities", null, "opaque-next", 2, 1, "applied"],
      },
      { method: "run", sql: upsertSql, params: ["intervals-icu", "activities", "opaque-next"] },
      { method: "get", sql: readSql, params: ["intervals-icu", "activities"] },
    ]);
    expect(
      store.calls.every(({ sql }) => !/\b(?:BEGIN|COMMIT|ROLLBACK)\b|transaction\s*\(/i.test(sql)),
    ).toBe(true);

    store.calls.length = 0;
    store.gets.push({ watermark: "same" }, { operation_id: 8 }, { watermark: "same" });
    const noOp = await repository.recordCompletionInTransaction({
      ...baseCompletion,
      watermarkBefore: "same",
      watermarkAfter: "same",
      artifactsSeen: 0,
      sourceChanges: 0,
    });
    expect(noOp).toEqual({ operationId: 8, completionKind: "no-op" });
    expect(store.calls.some(({ method }) => method === "run")).toBe(false);
    expect(store.calls[1]).toEqual({
      method: "get",
      sql: insertSql,
      params: ["intervals-icu", "activities", "same", "same", 0, 0, "no-op"],
    });
  });

  it("rejects stale planning, watermark clearing, invalid counts, and malformed insert results", async () => {
    const invalidInputs = [
      { ...baseCompletion, source: "unknown" },
      { ...baseCompletion, source: "file-import", lane: "activities" },
      { ...baseCompletion, watermarkBefore: "" },
      { ...baseCompletion, watermarkBefore: "set", watermarkAfter: null },
      { ...baseCompletion, artifactsSeen: -1 },
      { ...baseCompletion, artifactsSeen: 1.5 },
      { ...baseCompletion, sourceChanges: -1 },
      { ...baseCompletion, sourceChanges: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const input of invalidInputs) {
      const store = new FakeStore();
      await expect(
        createSyncStateRepository(store).recordCompletionInTransaction(input as SyncCompletion),
      ).rejects.toThrowError(new TypeError("invalid sync completion"));
      expect(store.calls).toEqual([]);
    }

    const staleStore = new FakeStore();
    staleStore.gets.push({ watermark: "changed" });
    await expect(
      createSyncStateRepository(staleStore).recordCompletionInTransaction({
        ...baseCompletion,
        watermarkBefore: "planned",
      }),
    ).rejects.toThrow("sync watermark changed during planning");
    expect(staleStore.calls).toHaveLength(1);

    const malformedInsertRows: Array<Row | undefined> = [
      undefined,
      {},
      { operation_id: 0 },
      { operation_id: 1.5 },
      { operation_id: 1, extra: 2 },
    ];
    for (const row of malformedInsertRows) {
      const store = new FakeStore();
      store.gets.push(undefined, row);
      await expect(
        createSyncStateRepository(store).recordCompletionInTransaction(baseCompletion),
      ).rejects.toThrow("sync operation insert failed");
    }

    const updateStore = new FakeStore();
    updateStore.gets.push(undefined, { operation_id: 1 }, undefined);
    await expect(
      createSyncStateRepository(updateStore).recordCompletionInTransaction(baseCompletion),
    ).rejects.toThrow("sync watermark update failed");
  });
});

describe("sync state repository with SQLite", () => {
  let db: DatabaseSync | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function openStore(): { store: SqlStore; database: DatabaseSync } {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    for (const migration of MIGRATIONS) database.exec(migration.sql);
    const store: SqlStore = {
      async exec(sql) {
        database.exec(sql);
      },
      async run(sql, params = []) {
        database.prepare(sql).run(...params);
      },
      async get(sql, params = []) {
        const row = database.prepare(sql).get(...params);
        return row === undefined ? undefined : ({ ...row } as Row);
      },
      async all(sql, params = []) {
        return database
          .prepare(sql)
          .all(...params)
          .map((row) => ({ ...row }) as Row);
      },
      async close() {
        database.close();
      },
    };
    return { store, database };
  }

  it("commits batch data, operation, and watermark atomically and rolls all back", async () => {
    const opened = openStore();
    db = opened.database;
    const repository = createSyncStateRepository(opened.store);
    const address = "a".repeat(64);

    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO source_artifact VALUES(?,?,?,?,?,?,?,?)").run(
      "artifact-commit",
      "intervals-icu",
      "activities",
      "42",
      "snapshot",
      address,
      "1998/01/a.json.gz",
      883_612_800,
    );
    const result = await repository.recordCompletionInTransaction(baseCompletion);
    db.exec("COMMIT");

    expect(result).toEqual({ operationId: 1, completionKind: "applied" });
    expect(db.prepare("SELECT artifact_key FROM source_artifact").all()).toEqual([
      { artifact_key: "artifact-commit" },
    ]);
    expect(db.prepare("SELECT source,lane,watermark FROM source_watermark").all()).toEqual([
      { source: "intervals-icu", lane: "activities", watermark: "opaque-next" },
    ]);
    expect(db.prepare("SELECT operation_id,completion_kind FROM sync_operation").all()).toEqual([
      { operation_id: 1, completion_kind: "applied" },
    ]);

    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO source_artifact VALUES(?,?,?,?,?,?,?,?)").run(
      "artifact-rollback",
      "intervals-icu",
      "activities",
      "43",
      "snapshot",
      address,
      "1998/01/b.json.gz",
      883_612_801,
    );
    await repository.recordCompletionInTransaction({
      ...baseCompletion,
      watermarkBefore: "opaque-next",
      watermarkAfter: "opaque-rollback",
    });
    db.exec("ROLLBACK");

    expect(
      db.prepare("SELECT artifact_key FROM source_artifact ORDER BY artifact_key").all(),
    ).toEqual([{ artifact_key: "artifact-commit" }]);
    expect(db.prepare("SELECT watermark FROM source_watermark").get()).toEqual({
      watermark: "opaque-next",
    });
    expect(db.prepare("SELECT count(*) AS count FROM sync_operation").get()).toEqual({ count: 1 });
  });

  it("records each no-op and enforces append-only operation and artifact history", async () => {
    const opened = openStore();
    db = opened.database;
    const repository = createSyncStateRepository(opened.store);
    const noOp = {
      source: "file-import",
      lane: "file-discovery",
      watermarkBefore: null,
      watermarkAfter: null,
      artifactsSeen: 0,
      sourceChanges: 0,
    } as const;
    await repository.recordCompletionInTransaction(noOp);
    await repository.recordCompletionInTransaction(noOp);
    expect(
      db
        .prepare("SELECT operation_id,completion_kind FROM sync_operation ORDER BY operation_id")
        .all(),
    ).toEqual([
      { operation_id: 1, completion_kind: "no-op" },
      { operation_id: 2, completion_kind: "no-op" },
    ]);
    expect(() =>
      db!.prepare("UPDATE sync_operation SET artifacts_seen=1 WHERE operation_id=1").run(),
    ).toThrow(/append-only/);
    expect(() => db!.prepare("DELETE FROM sync_operation WHERE operation_id=1").run()).toThrow(
      /append-only/,
    );

    db.prepare("INSERT INTO source_artifact VALUES(?,?,?,?,?,?,?,?)").run(
      "artifact-key",
      "file-import",
      "file-discovery",
      null,
      "raw_file",
      "b".repeat(64),
      "1998/01/b.fit",
      883_612_800,
    );
    expect(() => db!.prepare("UPDATE source_artifact SET archive_epoch_s=1").run()).toThrow(
      /append-only/,
    );
    expect(() => db!.prepare("DELETE FROM source_artifact").run()).toThrow(/append-only/);
  });
});
