import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/index.js";

type SqlValue = string | number | null;

interface WriteOperation {
  readonly sql: string;
  readonly params: readonly SqlValue[];
}

interface CandidateWrite {
  readonly operations: readonly WriteOperation[];
}

interface RaceOutcome {
  readonly state: "committed" | "rejected";
  readonly message: string | null;
  readonly errcode: number | null;
}

type WorkerMessage =
  | { readonly type: "ready" }
  | { readonly type: "attempting" }
  | { readonly type: "inserted" }
  | { readonly type: "finished"; readonly outcome: RaceOutcome };

const FIRST_PLAN_ID = "00000000000000000000000001";
const SECOND_PLAN_ID = "00000000000000000000000002";
const FIRST_REVISION_ID = "00000000000000000000000101";
const SECOND_REVISION_ID = "00000000000000000000000102";
const FIRST_CREATION_ID = "00000000000000000000000201";
const SECOND_CREATION_ID = "00000000000000000000000202";
const FIRST_CHANGE_ID = "00000000000000000000000301";
const SECOND_CHANGE_ID = "00000000000000000000000302";
const FIRST_1998_MS = 903_945_600_000;
const SECOND_1998_MS = 903_949_200_000;
const DEVICE_ID = "independent-writer-1998";

const INDEPENDENT_WRITER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");

const db = new DatabaseSync(workerData.path);
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");
parentPort.postMessage({ type: "ready" });

parentPort.once("message", async (message) => {
  let began = false;
  try {
    if (message === null || message.type !== "start") throw new Error("expected start");
    parentPort.postMessage({ type: "attempting" });
    db.exec("BEGIN IMMEDIATE");
    began = true;
    for (const operation of workerData.operations) {
      db.prepare(operation.sql).run(...operation.params);
    }
    parentPort.postMessage({ type: "inserted" });
    await new Promise((resolve, reject) => {
      parentPort.once("message", (release) => {
        if (release !== null && release.type === "release") resolve();
        else reject(new Error("expected release"));
      });
    });
    db.exec("COMMIT");
    began = false;
    parentPort.postMessage({
      type: "finished",
      outcome: { state: "committed", message: null, errcode: null },
    });
  } catch (error) {
    if (began) {
      try {
        db.exec("ROLLBACK");
      } catch {}
    }
    parentPort.postMessage({
      type: "finished",
      outcome: {
        state: "rejected",
        message: error instanceof Error ? error.message : String(error),
        errcode:
          typeof error === "object" && error !== null && Number.isInteger(error.errcode)
            ? error.errcode
            : null,
      },
    });
  } finally {
    db.close();
    parentPort.close();
  }
});
`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function raceIndependentWriters(
  path: string,
  candidates: readonly [CandidateWrite, CandidateWrite],
): Promise<readonly [RaceOutcome, RaceOutcome]> {
  const firstInserted = deferred<number>();
  const workers = candidates.map((candidate, index) => {
    const ready = deferred<void>();
    const attempting = deferred<void>();
    const finished = deferred<RaceOutcome>();
    const worker = new Worker(INDEPENDENT_WRITER_SOURCE, {
      eval: true,
      workerData: { path, operations: candidate.operations },
    });
    const fail = (error: unknown) => {
      ready.reject(error);
      attempting.reject(error);
      finished.reject(error);
      firstInserted.reject(error);
    };
    worker.on("message", (value: unknown) => {
      const message = value as WorkerMessage;
      if (message.type === "ready") ready.resolve();
      else if (message.type === "attempting") attempting.resolve();
      else if (message.type === "inserted") firstInserted.resolve(index);
      else if (message.type === "finished") finished.resolve(message.outcome);
      else fail(new Error("unexpected worker message"));
    });
    worker.on("error", fail);
    worker.on("exit", (code) => {
      if (code !== 0) fail(new Error(`independent writer exited with code ${code}`));
    });
    return { worker, ready, attempting, finished };
  });

  try {
    await Promise.all(workers.map(({ ready }) => ready.promise));
    for (const { worker } of workers) worker.postMessage({ type: "start" });
    const [winnerIndex] = await Promise.all([
      firstInserted.promise,
      ...workers.map(({ attempting }) => attempting.promise),
    ]);
    workers[winnerIndex]!.worker.postMessage({ type: "release" });
    const outcomes = await Promise.all(workers.map(({ finished }) => finished.promise));
    return outcomes as [RaceOutcome, RaceOutcome];
  } finally {
    await Promise.all(workers.map(({ worker }) => worker.terminate()));
  }
}

function legacyPlanOperation(planId: string): WriteOperation {
  return {
    sql: `INSERT INTO plan (
id,origin_id,name,primary_goal,start_date_key,target_date_key,status,kind,total_weeks,
week_start_day,structure_json,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    params: [
      planId,
      null,
      "Synthetic 1998 Plan",
      "Build steady endurance",
      19980824,
      null,
      "active",
      "full_plan",
      12,
      1,
      "{}",
      FIRST_1998_MS,
      FIRST_1998_MS,
      DEVICE_ID,
      FIRST_1998_MS,
      0,
    ],
  };
}

function activePlanOperations(planId: string, revisionId: string): readonly WriteOperation[] {
  return [
    {
      sql: `INSERT INTO planning_plan (
plan_id,status,version,current_revision_number,activated_at_ms,closed_at_ms,close_reason,
close_actor,updated_at_ms,device_id,hlc_physical_ms,hlc_counter
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        planId,
        "active",
        1,
        1,
        FIRST_1998_MS,
        null,
        null,
        null,
        FIRST_1998_MS,
        DEVICE_ID,
        FIRST_1998_MS,
        0,
      ],
    },
    {
      sql: `INSERT INTO plan_revision (
id,plan_id,revision_number,parent_revision_number,source_kind,source_id,snapshot_json,
fingerprint,created_at_ms,device_id,hlc_physical_ms,hlc_counter
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        revisionId,
        planId,
        1,
        null,
        "migration",
        null,
        JSON.stringify({ planId, revisionNumber: 1 }),
        "a".repeat(64),
        FIRST_1998_MS,
        DEVICE_ID,
        FIRST_1998_MS,
        0,
      ],
    },
  ];
}

function creationOperation(creationId: string, createdAtMs: number): WriteOperation {
  return {
    sql: `INSERT INTO plan_creation (
id,status,version,seed_json,current_draft_revision_number,activated_plan_id,created_at_ms,
updated_at_ms,terminal_at_ms,device_id,hlc_physical_ms,hlc_counter
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    params: [
      creationId,
      "in-progress",
      1,
      JSON.stringify({ goalDate: "1998-10-04" }),
      null,
      null,
      createdAtMs,
      createdAtMs,
      null,
      DEVICE_ID,
      createdAtMs,
      0,
    ],
  };
}

function previewOperation(changeId: string, createdAtMs: number): WriteOperation {
  return {
    sql: `INSERT INTO plan_change (
id,plan_id,status,version,base_revision_number,result_revision_number,diff_json,rationale,
premises_json,preview_fingerprint,reconciliation_effect_json,created_at_ms,updated_at_ms,
terminal_at_ms,device_id,hlc_physical_ms,hlc_counter
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    params: [
      changeId,
      FIRST_PLAN_ID,
      "preview",
      1,
      1,
      null,
      JSON.stringify({ schemaVersion: 1, operations: [] }),
      "Synthetic 1998 availability changed.",
      JSON.stringify({ schemaVersion: 1, premises: [] }),
      (changeId === FIRST_CHANGE_ID ? "c" : "d").repeat(64),
      JSON.stringify({ schemaVersion: 1, affectedWorkouts: [] }),
      createdAtMs,
      createdAtMs,
      null,
      DEVICE_ID,
      createdAtMs,
      0,
    ],
  };
}

function expectUniqueRace(outcomes: readonly RaceOutcome[]): void {
  expect(outcomes.filter(({ state }) => state === "committed")).toHaveLength(1);
  const rejected = outcomes.filter(({ state }) => state === "rejected");
  expect(rejected).toHaveLength(1);
  expect(rejected[0]).toMatchObject({ errcode: 2067 });
  expect(rejected[0]?.message).toContain("UNIQUE constraint failed");
}

describe("planning uniqueness with independent SQLite writers", () => {
  let directory: string;
  let path: string;
  let store: (SqlStore & MigratorStore) | undefined;

  beforeEach(async () => {
    directory = mkdtempSync(join(realpathSync(tmpdir()), "planning-writers-"));
    path = join(directory, "store.db");
    store = openSqliteStorage(path);
    await runMigrations(store, MIGRATIONS);
  });

  afterEach(async () => {
    if (store !== undefined) await store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const closeSeedConnection = async (): Promise<void> => {
    if (store === undefined) throw new Error("expected seed connection");
    await store.close();
    store = undefined;
  };

  const reopenForVerification = (): SqlStore & MigratorStore => {
    store = openSqliteStorage(path);
    return store;
  };

  it("allows only one active Plan across two overlapping writers", async () => {
    if (store === undefined) throw new Error("expected seed connection");
    await store.transaction(async () => {
      const first = legacyPlanOperation(FIRST_PLAN_ID);
      const second = legacyPlanOperation(SECOND_PLAN_ID);
      await store!.run(first.sql, first.params);
      await store!.run(second.sql, second.params);
    });
    await closeSeedConnection();

    const outcomes = await raceIndependentWriters(path, [
      { operations: activePlanOperations(FIRST_PLAN_ID, FIRST_REVISION_ID) },
      { operations: activePlanOperations(SECOND_PLAN_ID, SECOND_REVISION_ID) },
    ]);

    expectUniqueRace(outcomes);
    const verification = reopenForVerification();
    await expect(
      verification.get("SELECT COUNT(*) AS count FROM planning_plan WHERE status='active'"),
    ).resolves.toEqual({ count: 1 });
    await expect(verification.get("SELECT COUNT(*) AS count FROM plan_revision")).resolves.toEqual({
      count: 1,
    });
    await expect(verification.all("PRAGMA foreign_key_check")).resolves.toEqual([]);
  });

  it("allows only one unfinished Plan Creation across two overlapping writers", async () => {
    await closeSeedConnection();

    const outcomes = await raceIndependentWriters(path, [
      { operations: [creationOperation(FIRST_CREATION_ID, FIRST_1998_MS)] },
      { operations: [creationOperation(SECOND_CREATION_ID, SECOND_1998_MS)] },
    ]);

    expectUniqueRace(outcomes);
    const verification = reopenForVerification();
    await expect(
      verification.get(
        "SELECT COUNT(*) AS count FROM plan_creation WHERE status IN ('in-progress','review')",
      ),
    ).resolves.toEqual({ count: 1 });
    await expect(verification.all("PRAGMA foreign_key_check")).resolves.toEqual([]);
  });

  it("allows only one preview Plan Change across two overlapping writers", async () => {
    if (store === undefined) throw new Error("expected seed connection");
    await store.transaction(async () => {
      const legacyPlan = legacyPlanOperation(FIRST_PLAN_ID);
      await store!.run(legacyPlan.sql, legacyPlan.params);
      for (const operation of activePlanOperations(FIRST_PLAN_ID, FIRST_REVISION_ID)) {
        await store!.run(operation.sql, operation.params);
      }
    });
    await closeSeedConnection();

    const outcomes = await raceIndependentWriters(path, [
      { operations: [previewOperation(FIRST_CHANGE_ID, SECOND_1998_MS)] },
      { operations: [previewOperation(SECOND_CHANGE_ID, SECOND_1998_MS + 1)] },
    ]);

    expectUniqueRace(outcomes);
    const verification = reopenForVerification();
    await expect(
      verification.get(
        "SELECT COUNT(*) AS count FROM plan_change WHERE plan_id=? AND status='preview'",
        [FIRST_PLAN_ID],
      ),
    ).resolves.toEqual({ count: 1 });
    await expect(verification.all("PRAGMA foreign_key_check")).resolves.toEqual([]);
  });
});
