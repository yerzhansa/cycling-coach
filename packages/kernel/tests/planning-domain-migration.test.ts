import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/store/migrations/index.js";

const IDS = Object.freeze({
  planA: "0".repeat(26),
  planB: "1".repeat(26),
  revisionA1: "2".repeat(26),
  revisionA2: "3".repeat(26),
  revisionB1: "4".repeat(26),
  creationA: "5".repeat(26),
  creationB: "6".repeat(26),
  answerA: "7".repeat(26),
  draftA1: "8".repeat(26),
  draftA2: "9".repeat(26),
  preferenceA: "A".repeat(26),
  restrictionA: "B".repeat(26),
  changeA: "C".repeat(26),
  changeB: "D".repeat(26),
});

const DOMAIN_TABLES = [
  "planning_plan",
  "plan_revision",
  "plan_creation",
  "plan_creation_answer",
  "plan_creation_draft_revision",
  "athlete_preference",
  "training_restriction",
  "plan_change",
  "planning_command",
] as const;

let db: DatabaseSync | undefined;

function openFull(): DatabaseSync {
  const next = new DatabaseSync(":memory:");
  next.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) next.exec(migration.sql);
  return next;
}

function insertLegacyPlan(database: DatabaseSync, planId: string): void {
  database
    .prepare(`INSERT INTO plan (
      id, origin_id, name, primary_goal, start_date_key, target_date_key, status, kind,
      total_weeks, week_start_day, structure_json, created_at_ms, updated_at_ms,
      device_id, hlc_physical_ms, hlc_counter
    ) VALUES (?, NULL, 'Synthetic Plan', 'Synthetic goal', 19980101, 19981231, 'active',
      'full_plan', 52, 1, '{}', 1, 1, 'device-1', 1, 0)`)
    .run(planId);
}

function insertPlanningPlan(
  database: DatabaseSync,
  planId: string,
  status: "active" | "closed",
): void {
  database
    .prepare(`INSERT INTO planning_plan (
      plan_id, status, version, current_revision_number, activated_at_ms, closed_at_ms,
      close_reason, close_actor, updated_at_ms, device_id, hlc_physical_ms, hlc_counter
    ) VALUES (?, ?, 1, 1, 1, ?, ?, NULL, ?, 'device-1', 1, 0)`)
    .run(
      planId,
      status,
      status === "closed" ? 2 : null,
      status === "closed" ? "legacy-unclassified" : null,
      status === "closed" ? 2 : 1,
    );
}

function insertPlanRevision(
  database: DatabaseSync,
  values: {
    readonly id: string;
    readonly planId: string;
    readonly revision: number;
    readonly parent: number | null;
    readonly sourceId?: string;
  },
): void {
  database
    .prepare(`INSERT INTO plan_revision (
      id, plan_id, revision_number, parent_revision_number, source_kind, source_id,
      snapshot_json, fingerprint, created_at_ms, device_id, hlc_physical_ms, hlc_counter
    ) VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, 'device-1', ?, 0)`)
    .run(
      values.id,
      values.planId,
      values.revision,
      values.parent,
      values.revision === 1 ? "migration" : "plan-change",
      values.revision === 1 ? null : (values.sourceId ?? values.id),
      String(values.revision).repeat(64),
      values.revision,
      values.revision,
    );
}

function insertCreation(database: DatabaseSync, id: string): void {
  database
    .prepare(`INSERT INTO plan_creation (
      id, status, version, seed_json, current_draft_revision_number, activated_plan_id,
      created_at_ms, updated_at_ms, terminal_at_ms, device_id, hlc_physical_ms, hlc_counter
    ) VALUES (?, 'in-progress', 1, '{}', NULL, NULL, 1, 1, NULL, 'device-1', 1, 0)`)
    .run(id);
}

function insertAnswer(database: DatabaseSync): void {
  database
    .prepare(`INSERT INTO plan_creation_answer (
      id, creation_id, sequence, creation_version, answer_key, value_json, scope,
      preference_id, confirmed_at_ms, device_id, hlc_physical_ms, hlc_counter
    ) VALUES (?, ?, 1, 2, 'goal', '"finish"', 'athlete-preference', ?, 1,
      'device-1', 1, 0)`)
    .run(IDS.answerA, IDS.creationA, IDS.preferenceA);
}

function insertDraftRevision(
  database: DatabaseSync,
  values: { readonly id: string; readonly revision: number; readonly parent: number | null },
): void {
  database
    .prepare(`INSERT INTO plan_creation_draft_revision (
      id, creation_id, revision_number, parent_revision_number, input_version,
      input_snapshot_json, input_fingerprint, builder_id, builder_version,
      output_snapshot_json, activation_fingerprint, created_at_ms, device_id,
      hlc_physical_ms, hlc_counter
    ) VALUES (?, ?, ?, ?, ?, '{}', ?, 'synthetic-builder', '1', '{}', ?, ?,
      'device-1', ?, 0)`)
    .run(
      values.id,
      IDS.creationA,
      values.revision,
      values.parent,
      values.revision,
      "a".repeat(64),
      "b".repeat(64),
      values.revision,
      values.revision,
    );
}

function insertPreviewChange(
  database: DatabaseSync,
  id: string,
  planId: string,
  baseRevision = 1,
  createdAtMs = 1,
): void {
  database
    .prepare(`INSERT INTO plan_change (
      id, plan_id, status, version, base_revision_number, result_revision_number,
      diff_json, rationale, premises_json, preview_fingerprint,
      reconciliation_effect_json, created_at_ms, updated_at_ms, terminal_at_ms,
      device_id, hlc_physical_ms, hlc_counter
    ) VALUES (?, ?, 'preview', 1, ?, NULL, '{}', 'Synthetic rationale', '[]', ?, '{}',
      ?, ?, NULL, 'device-1', ?, 0)`)
    .run(id, planId, baseRevision, "c".repeat(64), createdAtMs, createdAtMs, createdAtMs);
}

afterEach(() => {
  db?.close();
  db = undefined;
});

describe("planning domain migration", () => {
  it("creates nine empty STRICT authored tables with valid foreign keys", () => {
    db = openFull();
    const tables = db.prepare("PRAGMA table_list").all() as Array<{
      readonly name: string;
      readonly strict: number;
    }>;
    for (const table of DOMAIN_TABLES) {
      expect(tables.find(({ name }) => name === table)?.strict).toBe(1);
      expect(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    expect(db.prepare("PRAGMA foreign_key_list(planning_plan)").all()).toContainEqual(
      expect.objectContaining({ table: "plan", on_delete: "RESTRICT" }),
    );
    expect(db.prepare("PRAGMA foreign_key_list(plan_revision)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "planning_plan", on_delete: "RESTRICT" }),
        expect.objectContaining({ table: "plan_revision", on_delete: "RESTRICT" }),
      ]),
    );
    expect(db.prepare("PRAGMA foreign_key_list(plan_creation_answer)").all()).toContainEqual(
      expect.objectContaining({ table: "plan_creation", on_delete: "RESTRICT" }),
    );
    expect(db.prepare("PRAGMA foreign_key_list(athlete_preference)").all()).toContainEqual(
      expect.objectContaining({ table: "plan_creation_answer", on_delete: "RESTRICT" }),
    );
    expect(db.prepare("PRAGMA foreign_key_list(plan_change)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "planning_plan", on_delete: "RESTRICT" }),
        expect.objectContaining({ table: "plan_revision", on_delete: "RESTRICT" }),
      ]),
    );
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("enforces one active Plan, one unfinished creation, and one preview per Plan", () => {
    db = openFull();
    insertLegacyPlan(db, IDS.planA);
    insertLegacyPlan(db, IDS.planB);
    insertPlanningPlan(db, IDS.planA, "active");
    expect(() => insertPlanningPlan(db!, IDS.planB, "active")).toThrow();
    insertPlanningPlan(db, IDS.planB, "closed");
    insertPlanRevision(db, { id: IDS.revisionA1, planId: IDS.planA, revision: 1, parent: null });
    expect(() =>
      db!
        .prepare(`INSERT INTO plan_revision (
          id, plan_id, revision_number, parent_revision_number, source_kind, source_id,
          snapshot_json, fingerprint, created_at_ms, device_id, hlc_physical_ms, hlc_counter
        ) VALUES (?, ?, 2, 1, 'plan-change', NULL, '{}', ?, 2, 'device-1', 2, 0)`)
        .run("H".repeat(26), IDS.planA, "8".repeat(64)),
    ).toThrow();
    insertPlanRevision(db, { id: IDS.revisionB1, planId: IDS.planB, revision: 1, parent: null });
    expect(() =>
      db!
        .prepare(`INSERT INTO plan_creation (
          id, status, version, seed_json, current_draft_revision_number, activated_plan_id,
          created_at_ms, updated_at_ms, terminal_at_ms, device_id, hlc_physical_ms, hlc_counter
        ) VALUES (?, 'in-progress', 1, '{}', 1, NULL, 1, 1, NULL, 'device-1', 1, 0)`)
        .run(IDS.creationB),
    ).toThrow();
    insertCreation(db, IDS.creationA);
    expect(() => insertCreation(db!, IDS.creationB)).toThrow();
    insertPreviewChange(db, IDS.changeA, IDS.planA);
    expect(() => insertPreviewChange(db!, IDS.changeB, IDS.planA)).toThrow();
    expect(() => insertPreviewChange(db!, IDS.changeB, IDS.planB)).not.toThrow();
  });

  it("keeps revision and confirmed-answer children linear and immutable", () => {
    db = openFull();
    insertLegacyPlan(db, IDS.planA);
    insertPlanningPlan(db, IDS.planA, "active");
    insertPlanRevision(db, { id: IDS.revisionA1, planId: IDS.planA, revision: 1, parent: null });
    expect(() =>
      insertPlanRevision(db!, { id: IDS.revisionA2, planId: IDS.planA, revision: 2, parent: null }),
    ).toThrow();
    insertPlanRevision(db, { id: IDS.revisionA2, planId: IDS.planA, revision: 2, parent: 1 });
    expect(() => db!.prepare("UPDATE plan_revision SET snapshot_json='[]'").run()).toThrow(
      /immutable/,
    );
    expect(() => db!.prepare("DELETE FROM plan_revision").run()).toThrow(/immutable/);

    insertCreation(db, IDS.creationA);
    insertAnswer(db);
    expect(() =>
      db!
        .prepare(`INSERT INTO plan_creation_answer (
          id, creation_id, sequence, creation_version, answer_key, value_json, scope,
          preference_id, confirmed_at_ms, device_id, hlc_physical_ms, hlc_counter
        ) VALUES (?, ?, 2, 1, 'availability', '{}', 'athlete-preference', NULL, 1,
          'device-1', 1, 0)`)
        .run("E".repeat(26), IDS.creationA),
    ).toThrow();
    expect(() =>
      db!
        .prepare(`INSERT INTO plan_creation_answer (
          id, creation_id, sequence, creation_version, answer_key, value_json, scope,
          preference_id, confirmed_at_ms, device_id, hlc_physical_ms, hlc_counter
        ) VALUES (?, ?, 2, 2, 'availability', '{}', 'plan-creation', NULL, 1,
          'device-1', 1, 0)`)
        .run("E".repeat(26), IDS.creationA),
    ).toThrow();
    expect(() => db!.prepare("UPDATE plan_creation_answer SET value_json='null'").run()).toThrow(
      /immutable/,
    );
    expect(() => db!.prepare("DELETE FROM plan_creation_answer").run()).toThrow(/immutable/);

    insertDraftRevision(db, { id: IDS.draftA1, revision: 1, parent: null });
    expect(() =>
      insertDraftRevision(db!, { id: IDS.draftA2, revision: 2, parent: null }),
    ).toThrow();
    insertDraftRevision(db, { id: IDS.draftA2, revision: 2, parent: 1 });
    expect(() =>
      db!.prepare("UPDATE plan_creation_draft_revision SET output_snapshot_json='[]'").run(),
    ).toThrow(/immutable/);
    expect(() => db!.prepare("DELETE FROM plan_creation_draft_revision").run()).toThrow(
      /immutable/,
    );
  });

  it("advances Plan content through its preview Change and stales a preview on close", () => {
    db = openFull();
    insertLegacyPlan(db, IDS.planA);
    insertPlanningPlan(db, IDS.planA, "active");
    insertPlanRevision(db, { id: IDS.revisionA1, planId: IDS.planA, revision: 1, parent: null });
    insertPlanRevision(db, {
      id: IDS.revisionA2,
      planId: IDS.planA,
      revision: 2,
      parent: 1,
      sourceId: IDS.changeA,
    });

    expect(() =>
      db!
        .prepare(`UPDATE planning_plan SET
          version=2, current_revision_number=2, updated_at_ms=2,
          hlc_physical_ms=2 WHERE plan_id=?`)
        .run(IDS.planA),
    ).toThrow(/preview Change/);

    insertPreviewChange(db, IDS.changeA, IDS.planA);
    db.prepare(`UPDATE planning_plan SET
      version=2, current_revision_number=2, updated_at_ms=2,
      hlc_physical_ms=2 WHERE plan_id=?`).run(IDS.planA);
    expect(
      db
        .prepare(`SELECT status,version,result_revision_number,terminal_at_ms,updated_at_ms
          FROM plan_change WHERE id=?`)
        .get(IDS.changeA),
    ).toEqual({
      status: "applied",
      version: 2,
      result_revision_number: 2,
      terminal_at_ms: 2,
      updated_at_ms: 2,
    });

    insertPreviewChange(db, IDS.changeB, IDS.planA, 2, 3);
    expect(() =>
      db!
        .prepare(`UPDATE planning_plan SET
          status='closed', version=3, closed_at_ms=2, close_reason='stopped',
          close_actor='athlete', updated_at_ms=2, hlc_physical_ms=2 WHERE plan_id=?`)
        .run(IDS.planA),
    ).toThrow(/clock precedes preview Change/);
    db.prepare(`UPDATE planning_plan SET
      status='closed', version=3, closed_at_ms=3, close_reason='stopped',
      close_actor='athlete', updated_at_ms=3, hlc_physical_ms=3 WHERE plan_id=?`).run(IDS.planA);
    expect(
      db
        .prepare(`SELECT status,version,result_revision_number,terminal_at_ms,updated_at_ms
          FROM plan_change WHERE id=?`)
        .get(IDS.changeB),
    ).toEqual({
      status: "stale",
      version: 2,
      result_revision_number: null,
      terminal_at_ms: 3,
      updated_at_ms: 3,
    });
  });

  it("enforces lifecycle consistency and terminal immutability", () => {
    db = openFull();
    insertLegacyPlan(db, IDS.planA);
    insertPlanningPlan(db, IDS.planA, "active");
    insertPlanRevision(db, { id: IDS.revisionA1, planId: IDS.planA, revision: 1, parent: null });
    insertPlanRevision(db, { id: IDS.revisionA2, planId: IDS.planA, revision: 2, parent: 1 });
    insertCreation(db, IDS.creationA);
    insertAnswer(db);
    insertDraftRevision(db, { id: IDS.draftA1, revision: 1, parent: null });

    db.prepare(`UPDATE plan_creation SET
      status='discarded', version=2, updated_at_ms=2, terminal_at_ms=2
      WHERE id=?`).run(IDS.creationA);
    expect(() =>
      db!.prepare("UPDATE plan_creation SET updated_at_ms=3 WHERE id=?").run(IDS.creationA),
    ).toThrow(/immutable/);

    db.prepare(`INSERT INTO athlete_preference (
      id, preference_key, value_json, status, version, source_answer_id, created_at_ms,
      updated_at_ms, removed_at_ms, device_id, hlc_physical_ms, hlc_counter
    ) VALUES (?, 'availability', '{}', 'active', 1, ?, 1, 1, NULL, 'device-1', 1, 0)`).run(
      IDS.preferenceA,
      IDS.answerA,
    );
    expect(() =>
      db!
        .prepare(`INSERT INTO athlete_preference (
          id, preference_key, value_json, status, version, source_answer_id, created_at_ms,
          updated_at_ms, removed_at_ms, device_id, hlc_physical_ms, hlc_counter
        ) VALUES (?, 'availability', '[]', 'active', 1, NULL, 2, 2, NULL,
          'device-1', 2, 0)`)
        .run("H".repeat(26)),
    ).toThrow();
    db.prepare(`UPDATE athlete_preference SET
      status='removed', version=2, updated_at_ms=2, removed_at_ms=2
      WHERE id=?`).run(IDS.preferenceA);
    expect(() =>
      db!.prepare("UPDATE athlete_preference SET updated_at_ms=3 WHERE id=?").run(IDS.preferenceA),
    ).toThrow(/immutable/);

    db.prepare(`INSERT INTO training_restriction (
      id, kind, status, version, start_date_key, end_date_key, maximum_duration_minutes,
      confirmed_at_ms, created_at_ms, updated_at_ms, ended_at_ms, device_id,
      hlc_physical_ms, hlc_counter
    ) VALUES (?, 'maximum-duration', 'active', 1, 19980201, NULL, 60, 1, 1, 1,
      NULL, 'device-1', 1, 0)`).run(IDS.restrictionA);
    expect(() =>
      db!
        .prepare(`INSERT INTO training_restriction (
          id, kind, status, version, start_date_key, end_date_key, maximum_duration_minutes,
          confirmed_at_ms, created_at_ms, updated_at_ms, ended_at_ms, device_id,
          hlc_physical_ms, hlc_counter
        ) VALUES (?, 'no-training', 'active', 1, 19980230, NULL, 30, 1, 1, 1,
          NULL, 'device-1', 1, 0)`)
        .run("F".repeat(26)),
    ).toThrow();
    expect(() =>
      db!
        .prepare(`INSERT INTO training_restriction (
          id, kind, status, version, start_date_key, end_date_key, maximum_duration_minutes,
          confirmed_at_ms, created_at_ms, updated_at_ms, ended_at_ms, device_id,
          hlc_physical_ms, hlc_counter
        ) VALUES (?, 'no-training', 'active', 1, 19980201, NULL, NULL, 2, 1, 2,
          NULL, 'device-1', 1, 0)`)
        .run("G".repeat(26)),
    ).toThrow();
    db.prepare(`UPDATE training_restriction SET
      status='ended', version=2, end_date_key=19980202, updated_at_ms=2, ended_at_ms=2
      WHERE id=?`).run(IDS.restrictionA);
    expect(
      db
        .prepare("SELECT status, end_date_key FROM training_restriction WHERE id=?")
        .get(IDS.restrictionA),
    ).toEqual({ status: "ended", end_date_key: 19980202 });
    expect(() =>
      db!
        .prepare("UPDATE training_restriction SET updated_at_ms=3 WHERE id=?")
        .run(IDS.restrictionA),
    ).toThrow(/immutable/);

    insertPreviewChange(db, IDS.changeA, IDS.planA);
    expect(() =>
      db!
        .prepare(`UPDATE plan_change SET
          status='applied', version=2, result_revision_number=2, updated_at_ms=2,
          terminal_at_ms=2 WHERE id=?`)
        .run(IDS.changeA),
    ).toThrow(/invalid Plan Change transition/);

    expect(() =>
      db!
        .prepare(`UPDATE planning_plan SET
          status='closed', version=2, closed_at_ms=3, close_reason='completed',
          close_actor='athlete', updated_at_ms=3 WHERE plan_id=?`)
        .run(IDS.planA),
    ).toThrow();
    db.prepare(`UPDATE planning_plan SET
      status='closed', version=2, closed_at_ms=3, close_reason='stopped',
      close_actor='athlete', updated_at_ms=3 WHERE plan_id=?`).run(IDS.planA);
    expect(
      db.prepare("SELECT status,version FROM plan_change WHERE id=?").get(IDS.changeA),
    ).toEqual({ status: "stale", version: 2 });
    expect(() =>
      db!.prepare("UPDATE plan_change SET updated_at_ms=4 WHERE id=?").run(IDS.changeA),
    ).toThrow(/immutable/);
    expect(() =>
      db!.prepare("UPDATE planning_plan SET updated_at_ms=4 WHERE plan_id=?").run(IDS.planA),
    ).toThrow(/immutable/);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("permits only pending planning commands to become terminal at the next version", () => {
    db = openFull();
    const insertPending = db.prepare(`INSERT INTO planning_command (
      command_name, command_id, request_digest, status, aggregate_refs_json, result_json,
      error_code, error_json, version, created_at_ms, updated_at_ms, device_id,
      hlc_physical_ms, hlc_counter
    ) VALUES (?, ?, ?, 'pending', '{}', NULL, NULL, NULL, 1, 1, 1, 'device-1', 1, 0)`);
    insertPending.run("plan_creation.start", "command-success", "d".repeat(64));
    expect(() =>
      db!
        .prepare(
          "UPDATE planning_command SET status='succeeded', result_json='{}' WHERE command_id=?",
        )
        .run("command-success"),
    ).toThrow(/invalid planning command transition/);
    db.prepare(`UPDATE planning_command SET
      status='succeeded', result_json='{}', version=2, updated_at_ms=2,
      hlc_physical_ms=2 WHERE command_id=?`).run("command-success");
    expect(() =>
      db!
        .prepare("UPDATE planning_command SET updated_at_ms=3 WHERE command_id=?")
        .run("command-success"),
    ).toThrow(/immutable/);
    expect(() =>
      db!.prepare("DELETE FROM planning_command WHERE command_id=?").run("command-success"),
    ).toThrow(/durable/);

    insertPending.run("plan.close", "command-failure", "e".repeat(64));
    db.prepare(`UPDATE planning_command SET
      status='failed', error_code='synthetic-failure',
      error_json='{"code":"synthetic-failure","details":null}', version=2,
      updated_at_ms=2, hlc_physical_ms=2 WHERE command_id=?`).run("command-failure");
    insertPending.run("plan.close", "command-array", "a".repeat(64));
    expect(() =>
      db!
        .prepare(`UPDATE planning_command SET
          status='succeeded', result_json='[]', version=2, updated_at_ms=2,
          hlc_physical_ms=2 WHERE command_id='command-array'`)
        .run(),
    ).toThrow();
    insertPending.run("plan.close", "command-error-shape", "b".repeat(64));
    expect(() =>
      db!
        .prepare(`UPDATE planning_command SET
          status='failed', error_code='synthetic-failure', error_json='{}', version=2,
          updated_at_ms=2, hlc_physical_ms=2 WHERE command_id='command-error-shape'`)
        .run(),
    ).toThrow();
    insertPending.run("plan.close", "command-clock", "c".repeat(64));
    expect(() =>
      db!
        .prepare(`UPDATE planning_command SET
          status='succeeded', result_json='{}', version=2, updated_at_ms=2,
          hlc_physical_ms=0 WHERE command_id='command-clock'`)
        .run(),
    ).toThrow(/invalid planning command transition/);
    expect(() => insertPending.run("unknown.command", "invalid-name", "f".repeat(64))).toThrow();
    expect(() => insertPending.run("plan.close", "invalid-digest", "F".repeat(64))).toThrow();
    expect(() =>
      db!
        .prepare(`INSERT INTO planning_command (
          command_name, command_id, request_digest, status, aggregate_refs_json, result_json,
          error_code, error_json, version, created_at_ms, updated_at_ms, device_id,
          hlc_physical_ms, hlc_counter
        ) VALUES ('plan.close', 'invalid-refs', ?, 'pending', '[]', NULL, NULL, NULL,
          1, 1, 1, 'device-1', 1, 0)`)
        .run("f".repeat(64)),
    ).toThrow();
  });
});
