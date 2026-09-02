import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTrainingCoverageReader,
  createTrainingCoverageRepository,
  type CoverageCommitInput,
  type Row,
  type SqlStore,
} from "../src/store/index.js";
import { MIGRATIONS } from "../src/store/migrations/index.js";

const CAPTURE_ID = "12345678-1234-4123-8123-123456789abc";

const commit: CoverageCommitInput = {
  source: "intervals-icu",
  lane: "activities",
  authorityKind: "reference-capture",
  authorityId: CAPTURE_ID,
  calendarTimeZone: "Asia/Almaty",
  coveredOldest: "1998-04-13",
  coveredNewest: "1998-07-06",
  committedEpochSeconds: 899_712_000,
  gaps: { datedLocalDates: ["1998-07-01"], undatedCount: 0 },
};

describe("training history coverage", () => {
  let database: DatabaseSync | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  function openStore(): SqlStore {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    for (const migration of MIGRATIONS) database.exec(migration.sql);
    return {
      async exec(sql) {
        database!.exec(sql);
      },
      async run(sql, params = []) {
        database!.prepare(sql).run(...params);
      },
      async get(sql, params = []) {
        const row = database!.prepare(sql).get(...params);
        return row === undefined ? undefined : ({ ...row } as Row);
      },
      async all(sql, params = []) {
        return database!
          .prepare(sql)
          .all(...params)
          .map((row) => ({ ...row }) as Row);
      },
      async close() {
        database!.close();
      },
    };
  }

  it("converges identical authority replay and exposes the original commit id", async () => {
    const store = openStore();
    const repository = createTrainingCoverageRepository();

    await expect(repository.appendCommitInTransaction(store, commit)).resolves.toEqual({
      kind: "inserted",
      commitId: 1,
    });
    await expect(repository.appendCommitInTransaction(store, commit)).resolves.toEqual({
      kind: "already-recorded",
      commitId: 1,
    });
    expect(
      database!.prepare("SELECT count(*) AS count FROM training_history_coverage_commit").get(),
    ).toEqual({ count: 1 });
  });

  it("throws authority_conflict when replay changes one stored field", async () => {
    const store = openStore();
    const repository = createTrainingCoverageRepository();
    await repository.appendCommitInTransaction(store, commit);

    await expect(
      repository.appendCommitInTransaction(store, {
        ...commit,
        coveredNewest: "1998-07-07",
      }),
    ).rejects.toEqual(
      expect.objectContaining({ name: "TrainingCoverageError", code: "authority_conflict" }),
    );
  });

  it("appends and resumes an exact backfill page checkpoint", async () => {
    const store = openStore();
    const repository = createTrainingCoverageRepository();
    const cursorAfter = JSON.stringify({
      v: 1,
      cycle: 7,
      window_start: "1998-01-01",
      window_end: "1998-07-18",
      last_key: "1998-07-17T12:00:00Z\u001fsynthetic",
      complete: false,
    });
    const checkpoint = {
      authorityId: "synthetic-backfill-cycle",
      sourceCycle: 7,
      pageOrdinal: 0,
      requestedOldest: "1998-01-01",
      requestedNewest: "1998-07-18",
      calendarTimeZone: "Asia/Almaty",
      cursorAfter,
      droppedSourceRestricted: 2,
      droppedOther: 1,
      gaps: { datedLocalDates: ["1998-07-01"], undatedCount: 1 },
      terminal: false,
    } as const;

    await expect(
      repository.appendBackfillCheckpointInTransaction(store, checkpoint),
    ).resolves.toEqual({ kind: "inserted", checkpointId: 1 });
    await expect(
      repository.appendBackfillCheckpointInTransaction(store, checkpoint),
    ).resolves.toEqual({ kind: "already-recorded", checkpointId: 1 });
    await expect(
      repository.readBackfillCheckpoint(store, { sourceCycle: 7, cursorAfter }),
    ).resolves.toEqual({ checkpointId: 1, ...checkpoint });
    await expect(
      repository.appendBackfillCheckpointInTransaction(store, {
        ...checkpoint,
        droppedOther: 2,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ name: "TrainingCoverageError", code: "authority_conflict" }),
    );
  });

  it("preserves explicit empty gap evidence across checkpoint retries", async () => {
    const store = openStore();
    const repository = createTrainingCoverageRepository();
    const cursorAfter = JSON.stringify({
      v: 1,
      cycle: 8,
      window_start: "1998-01-01",
      window_end: "1998-07-18",
      last_key: "1998-07-17T12:00:00Z\u001fsynthetic",
      complete: false,
    });
    const checkpoint = {
      authorityId: "filtered-gap-backfill-cycle",
      sourceCycle: 8,
      pageOrdinal: 0,
      requestedOldest: "1998-01-01",
      requestedNewest: "1998-07-18",
      calendarTimeZone: "Asia/Almaty",
      cursorAfter,
      droppedSourceRestricted: 2,
      droppedOther: 1,
      gaps: { datedLocalDates: [], undatedCount: 0 },
      terminal: false,
    } as const;

    await expect(
      repository.appendBackfillCheckpointInTransaction(store, checkpoint),
    ).resolves.toEqual({ kind: "inserted", checkpointId: 1 });
    await expect(
      repository.appendBackfillCheckpointInTransaction(store, checkpoint),
    ).resolves.toEqual({ kind: "already-recorded", checkpointId: 1 });
    await expect(
      repository.readBackfillCheckpoint(store, { sourceCycle: 8, cursorAfter }),
    ).resolves.toEqual({ checkpointId: 1, ...checkpoint });
  });

  it("enforces append-only commit and checkpoint rows", async () => {
    const store = openStore();
    await createTrainingCoverageRepository().appendCommitInTransaction(store, commit);
    database!
      .prepare(
        `INSERT INTO training_history_backfill_checkpoint (
  authority_id, source_cycle, page_ordinal, requested_oldest_key, requested_newest_key,
  calendar_timezone, cursor_after, dropped_source_restricted, dropped_other, terminal
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(CAPTURE_ID, 12345, 0, 19980413, 19980706, "Asia/Almaty", "cursor:12345", 0, 0, 0);

    expect(() =>
      database!
        .prepare("UPDATE training_history_coverage_commit SET gap_state='undated-dropped-rows'")
        .run(),
    ).toThrow(/append-only/);
    expect(() => database!.prepare("DELETE FROM training_history_coverage_commit").run()).toThrow(
      /append-only/,
    );
    expect(() =>
      database!.prepare("UPDATE training_history_backfill_checkpoint SET terminal=1").run(),
    ).toThrow(/append-only/);
    expect(() =>
      database!.prepare("DELETE FROM training_history_backfill_checkpoint").run(),
    ).toThrow(/append-only/);
  });

  it("lists commits by commit time and then id ascending", async () => {
    const store = openStore();
    const repository = createTrainingCoverageRepository();
    await repository.appendCommitInTransaction(store, {
      ...commit,
      authorityId: "capture-later-12345",
      committedEpochSeconds: 899_712_100,
    });
    await repository.appendCommitInTransaction(store, {
      ...commit,
      authorityKind: "activity-backfill",
      authorityId: "backfill-earlier-12345",
      committedEpochSeconds: 899_712_000,
    });
    await repository.appendCommitInTransaction(store, {
      ...commit,
      authorityId: "capture-same-time-12345",
      committedEpochSeconds: 899_712_000,
    });

    const rows = await createTrainingCoverageReader(store).listCommits({
      source: "intervals-icu",
      lane: "activities",
    });

    expect(rows.map(({ authorityId }) => authorityId)).toEqual([
      "backfill-earlier-12345",
      "capture-same-time-12345",
      "capture-later-12345",
    ]);
    expect(rows.map(({ coverageCommitId }) => coverageCommitId)).toEqual([2, 3, 1]);
    expect(rows.at(-1)?.gaps).toEqual({
      datedLocalDates: ["1998-07-01"],
      undatedCount: 0,
    });
  });

  it("maps pre-migration gap rows to conservative undated evidence", async () => {
    const store = openStore();
    database!
      .prepare(
        `INSERT INTO training_history_coverage_commit (
  source, lane, authority_kind, authority_id, calendar_timezone,
  covered_oldest_date_key, covered_newest_date_key, committed_epoch_seconds, gap_state
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "intervals-icu",
        "activities",
        "reference-capture",
        CAPTURE_ID,
        "Asia/Almaty",
        19980413,
        19980706,
        899_712_000,
        "undated-dropped-rows",
      );
    database!
      .prepare(
        `INSERT INTO training_history_backfill_checkpoint (
  authority_id, source_cycle, page_ordinal, requested_oldest_key, requested_newest_key,
  calendar_timezone, cursor_after, dropped_source_restricted, dropped_other, terminal
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-backfill-cycle",
        9,
        0,
        19980413,
        19980706,
        "Asia/Almaty",
        "legacy-cursor",
        2,
        1,
        0,
      );

    await expect(
      createTrainingCoverageReader(store).listCommits({
        source: "intervals-icu",
        lane: "activities",
      }),
    ).resolves.toMatchObject([{ gaps: { datedLocalDates: [], undatedCount: 1 } }]);
    await expect(
      createTrainingCoverageRepository().readBackfillCheckpoint(store, {
        sourceCycle: 9,
        cursorAfter: "legacy-cursor",
      }),
    ).resolves.toMatchObject({ gaps: { datedLocalDates: [], undatedCount: 3 } });
  });

  it("rejects unsorted or out-of-window dated gap evidence", async () => {
    const store = openStore();
    const repository = createTrainingCoverageRepository();

    await expect(
      repository.appendCommitInTransaction(store, {
        ...commit,
        gaps: {
          datedLocalDates: ["1998-07-02", "1998-07-01"],
          undatedCount: 0,
        },
      }),
    ).rejects.toThrow("invalid training coverage gaps");
    await expect(
      repository.appendCommitInTransaction(store, {
        ...commit,
        gaps: { datedLocalDates: ["1998-07-07"], undatedCount: 0 },
      }),
    ).rejects.toThrow("invalid training coverage gaps");
  });
});
