import { createHash } from "node:crypto";
import { canonicalJson } from "@enduragent/kernel/archive";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPlanChangeRepository,
  createPlanCreationRepository,
  createPlanLifecycleRepository,
  type PlanCreationCommandStamp,
} from "@enduragent/kernel/planning";
import {
  dumpStore,
  runMigrations,
  type MigratorStore,
  type SqlStore,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/index.js";

const id = (value: string) => value.padStart(26, "0");
const nowMs = 883_612_800_000;
const planId = id("11");
const fingerprint = "f".repeat(64);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const stamp = (commandId: string, offset: number): PlanCreationCommandStamp => ({
  commandId,
  requestDigest: "a".repeat(64),
  nowMs: nowMs + offset,
  deviceId: "test-device-1998",
  hlcPhysicalMs: nowMs + offset,
  hlcCounter: 0,
});
const keptWorkout = {
  id: "kept",
  name: "Endurance ride",
  kind: "easy",
  date: "1998-01-01",
  minutes: 60,
};
const removedWorkout = {
  id: "removed",
  name: "Long ride",
  kind: "long",
  date: "1998-01-02",
  minutes: 120,
};
const addedWorkout = {
  id: "added",
  name: "Easy ride",
  kind: "easy",
  date: "1998-01-03",
  minutes: 30,
};
const poolWorkout = { id: "pool", name: "Flexible ride", kind: "easy", date: null, minutes: 30 };
const draft = {
  outputFingerprint: fingerprint,
  weeks: [{ number: 1, minutes: 180, workouts: [keptWorkout, removedWorkout, poolWorkout] }],
};
const after = {
  ...draft,
  weeks: [{ number: 1, minutes: 90, workouts: [keptWorkout, addedWorkout, poolWorkout] }],
};
const envelope = {
  title: "Limit weekly duration",
  intent: { kind: "weekly-duration", hours: 1.5 },
  diff: [
    { workoutId: "removed", before: removedWorkout, after: null },
    { workoutId: "added", before: null, after: addedWorkout },
  ],
  totals: {
    before: { plan: 180, weeks: [{ number: 1, minutes: 180 }] },
    after: { plan: 90, weeks: [{ number: 1, minutes: 90 }] },
  },
  supersedes: null,
  confidence:
    "Moderate confidence. Based on your confirmed limits and the available training record.",
  premises: [
    {
      id: "confirmed-limits",
      label: "Confirmed Plan limits",
      source: "Your confirmed answers",
      value: { kind: "weekly-duration", hours: 1.5 },
    },
  ],
};
const build = (_snapshotJson: string) => ({ afterSnapshotJson: JSON.stringify(after), envelope });

describe("Plan Change repository", () => {
  let store: SqlStore & MigratorStore;
  let repository: ReturnType<typeof createPlanChangeRepository>;
  let sequence: number;
  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    sequence = 100;
    repository = createPlanChangeRepository(store, { newId: () => id(String(++sequence)), sha256 });
  });
  afterEach(async () => store.close());

  const activate = async () => {
    const creation = createPlanCreationRepository(store);
    await creation.start({
      command: stamp("start", 1),
      creationId: id("1"),
      seed: { schemaVersion: 1, eventCandidates: [] },
    });
    await creation.recordDraft({
      command: stamp("draft", 2),
      creationId: id("1"),
      expectedVersion: 1,
      draftId: id("2"),
      inputSnapshotJson: "{}",
      inputFingerprint: "e".repeat(64),
      outputSnapshotJson: JSON.stringify(draft),
      builderId: "cycling",
      builderVersion: "1",
      activationFingerprint: fingerprint,
    });
    const command = stamp("activate", 3);
    await creation.activate({
      command,
      creationId: id("1"),
      expectedVersion: 2,
      activatedAt: "1998-01-01",
      revisionId: id("3"),
      materialize: () => ({
        plan: {
          id: planId,
          originId: null,
          name: "Improve fitness",
          primaryGoal: "Ride well",
          startDateKey: 19980101,
          targetDateKey: 19980107,
          status: "active",
          kind: "short_race_preparation",
          totalWeeks: 1,
          weekStartDay: 4,
          structureJson: "{}",
          createdAtMs: command.nowMs,
          updatedAtMs: command.nowMs,
          deviceId: command.deviceId,
          hlcPhysicalMs: command.hlcPhysicalMs,
          hlcCounter: command.hlcCounter,
        },
        workouts: [keptWorkout, removedWorkout].map((workout, index) => ({
          id: id(String(31 + index)),
          planId,
          dateKey: 19980101 + index,
          sport: "Ride",
          name: workout.name,
          durationS: workout.minutes * 60,
          structureJson: JSON.stringify(workout),
          origin: "coach",
          deviceId: command.deviceId,
          hlcPhysicalMs: command.hlcPhysicalMs,
          hlcCounter: command.hlcCounter,
        })),
      }),
    });
  };
  const previewInput = (offset = 10) => ({
    command: stamp(`preview-${offset}`, offset),
    planId,
    expectedVersion: 1,
    nowMs: nowMs + offset,
    changeId: id(String(80 + offset)),
    build,
  });
  const applyInput = (decision: "apply" | "cancel" = "apply") => ({
    command: stamp(decision, 30),
    planId,
    changeId: id("90"),
    expectedVersion: 1,
    decision,
    nowMs: nowMs + 30,
    materialize: (
      snapshotJson: string,
      current: Parameters<Parameters<typeof repository.apply>[0]["materialize"]>[1],
    ) => {
      expect(JSON.parse(snapshotJson)).toEqual(after);
      const kept = current.find((row) => row.id === id("31"));
      if (kept === undefined) throw new Error("Expected kept Workout");
      return {
        insert: [
          {
            ...kept,
            id: id("33"),
            dateKey: 19980103,
            name: addedWorkout.name,
            durationS: 1800,
            structureJson: JSON.stringify(addedWorkout),
          },
        ],
        update: [],
        delete: [id("32")],
      };
    },
  });

  it("previews the current revision without changing training or Plan version", async () => {
    await activate();
    const workouts = await store.all("SELECT * FROM plan_workout");
    const revisions = await store.all("SELECT * FROM plan_revision");
    const builder = vi.fn(build);
    const result = await repository.preview({ ...previewInput(), build: builder });
    expect(builder).toHaveBeenCalledTimes(1);
    expect(JSON.parse(builder.mock.calls[0]?.[0] ?? "null")).toEqual(draft);
    expect(result).toMatchObject({
      status: "previewed",
      version: 1,
      change: {
        changeId: id("90"),
        planId,
        baseRevisionNumber: 1,
        status: "pending",
        title: envelope.title,
        intent: envelope.intent,
        diff: envelope.diff,
        totals: envelope.totals,
        supersedes: null,
        resultRevisionNumber: null,
      },
    });
    expect(await store.get("SELECT status,version,base_revision_number FROM plan_change")).toEqual({
      status: "preview",
      version: 1,
      base_revision_number: 1,
    });
    expect(await store.get("SELECT diff_json FROM plan_change")).toEqual({
      diff_json: canonicalJson(envelope),
    });
    expect(await store.get("SELECT version,current_revision_number FROM planning_plan")).toEqual({
      version: 1,
      current_revision_number: 1,
    });
    expect(await store.all("SELECT * FROM plan_workout")).toEqual(workouts);
    expect(await store.all("SELECT * FROM plan_revision")).toEqual(revisions);
    expect(
      await store.get(
        "SELECT command_name,aggregate_refs_json FROM planning_command WHERE command_id='preview-10'",
      ),
    ).toMatchObject({ command_name: "plan_change.preview" });
    await expect(repository.listChanges(planId)).resolves.toMatchObject([
      { changeId: id("90"), status: "pending" },
    ]);
    await expect(repository.listChanges(id("88"))).resolves.toEqual([]);
  });

  it("supersedes the previous preview and lists history oldest first with pending last", async () => {
    await activate();
    await repository.preview(previewInput());
    const original = await store.get("SELECT diff_json FROM plan_change WHERE id=?", [id("90")]);
    const result = await repository.preview(previewInput(20));
    expect(result).toMatchObject({ status: "previewed", change: { supersedes: id("90") } });
    expect(
      await store.all("SELECT id,status,version FROM plan_change ORDER BY created_at_ms"),
    ).toEqual([
      { id: id("90"), status: "discarded", version: 2 },
      { id: id("100"), status: "preview", version: 1 },
    ]);
    await expect(repository.listChanges(planId)).resolves.toMatchObject([
      { changeId: id("90"), status: "superseded", supersededBy: id("100") },
      { changeId: id("100"), status: "pending", supersedes: id("90") },
    ]);
    expect(await store.get("SELECT diff_json FROM plan_change WHERE id=?", [id("90")])).toEqual(
      original,
    );
    await repository.apply({ ...applyInput("cancel"), changeId: id("100") });
    const reopened = createPlanChangeRepository(store, { newId: () => id("200"), sha256 });
    await expect(reopened.listChanges(planId)).resolves.toMatchObject([
      { changeId: id("90"), status: "superseded", supersededBy: id("100") },
      { changeId: id("100"), status: "cancelled", supersedes: id("90"), supersededBy: null },
    ]);
  });

  it("rejects missing active Plans and stale versions before building", async () => {
    const builder = vi.fn(build);
    await expect(repository.preview({ ...previewInput(), build: builder })).resolves.toEqual({
      status: "rejected",
      reason: "no-active-plan",
    });
    await activate();
    const before = await dumpStore(store);
    for (const input of [
      { ...previewInput(), expectedVersion: 2 },
      { ...previewInput(), planId: id("88") },
    ]) {
      await expect(repository.preview({ ...input, build: builder })).resolves.toEqual({
        status: "rejected",
        reason: "stale-version",
      });
    }
    expect(builder).not.toHaveBeenCalled();
    expect(await dumpStore(store)).toBe(before);
  });

  it("rejects invalid intent without retiring a pending preview", async () => {
    await activate();
    await repository.preview(previewInput());
    const before = await dumpStore(store);
    await expect(
      repository.preview({
        ...previewInput(20),
        build: () => ({ status: "rejected", reason: "invalid-intent" }),
      }),
    ).resolves.toEqual({ status: "rejected", reason: "invalid-intent" });
    expect(await dumpStore(store)).toBe(before);
  });

  it("replays preview byte-identically after supersession and rejects command conflicts", async () => {
    await activate();
    const result = await repository.preview(previewInput());
    await repository.preview(previewInput(20));
    const before = await dumpStore(store);
    const builder = vi.fn(build);
    expect(JSON.stringify(await repository.preview({ ...previewInput(), build: builder }))).toBe(
      JSON.stringify(result),
    );
    expect(builder).not.toHaveBeenCalled();
    await expect(
      repository.preview({
        ...previewInput(),
        command: { ...previewInput().command, requestDigest: "b".repeat(64) },
      }),
    ).resolves.toEqual({ status: "rejected", reason: "command-conflict" });
    expect(await dumpStore(store)).toBe(before);
  });

  it("applies one new revision and atomically preserves, adds and removes Workout rows", async () => {
    await activate();
    await repository.preview(previewInput());
    const oldRow = await store.get("SELECT * FROM plan_workout WHERE id=?", [id("31")]);
    await expect(repository.apply(applyInput())).resolves.toEqual({
      status: "applied",
      changeId: id("90"),
      revisionNumber: 2,
      version: 2,
    });
    expect(await store.get("SELECT * FROM plan_workout WHERE id=?", [id("31")])).toEqual(oldRow);
    expect(await store.all("SELECT id FROM plan_workout ORDER BY id")).toEqual([
      { id: id("31") },
      { id: id("33") },
    ]);
    expect(
      await store.get("SELECT status,result_revision_number,version FROM plan_change"),
    ).toEqual({ status: "applied", result_revision_number: 2, version: 2 });
    expect(await store.get("SELECT version,current_revision_number FROM planning_plan")).toEqual({
      version: 2,
      current_revision_number: 2,
    });
    const revision = await store.get(
      "SELECT revision_number,parent_revision_number,source_kind,source_id,fingerprint FROM plan_revision WHERE revision_number=2",
    );
    const change = await store.get("SELECT preview_fingerprint FROM plan_change");
    expect(change?.preview_fingerprint).toBe(sha256(canonicalJson(after)));
    expect(revision).toEqual({
      revision_number: 2,
      parent_revision_number: 1,
      source_kind: "plan-change",
      source_id: id("90"),
      fingerprint: change?.preview_fingerprint,
    });
    expect(await store.get("SELECT updated_at_ms FROM plan")).toEqual({
      updated_at_ms: nowMs + 30,
    });
    await expect(repository.listChanges(planId)).resolves.toMatchObject([
      { status: "applied", resultRevisionNumber: 2 },
    ]);
    const builder = vi.fn(build);
    await repository.preview({ ...previewInput(40), expectedVersion: 2, build: builder });
    expect(JSON.parse(builder.mock.calls[0]?.[0] ?? "null")).toEqual(after);
  });

  it("preserves an unchanged Workout's full row after an athlete edit", async () => {
    await activate();
    await repository.preview(previewInput());
    await store.run(
      "UPDATE plan_workout SET name=?,duration_s=?,structure_json=?,origin=?,hlc_counter=? WHERE id=?",
      [
        "Athlete's ride",
        4500,
        JSON.stringify({ ...keptWorkout, minutes: 75 }),
        "athlete",
        7,
        id("31"),
      ],
    );
    const before = await store.get("SELECT * FROM plan_workout WHERE id=?", [id("31")]);
    await expect(repository.apply(applyInput())).resolves.toMatchObject({ status: "applied" });
    expect(await store.get("SELECT * FROM plan_workout WHERE id=?", [id("31")])).toEqual(before);
  });

  it.each(
    (["changed", "removed"] as const).flatMap((operation) =>
      (["structure", "name", "duration", "name-and-duration", "date"] as const).map((field) => ({
        operation,
        field,
      })),
    ),
  )(
    "rejects $field drift on a $operation Draft Workout before materialization without any writes",
    async ({ operation, field }) => {
      await activate();
      const changedWorkout = { ...removedWorkout, minutes: 90 };
      await repository.preview({
        ...previewInput(),
        build: () => ({
          afterSnapshotJson: JSON.stringify(
            operation === "removed"
              ? after
              : {
                  ...draft,
                  weeks: [
                    { ...draft.weeks[0], workouts: [keptWorkout, changedWorkout, poolWorkout] },
                  ],
                },
          ),
          envelope:
            operation === "removed"
              ? envelope
              : {
                  ...envelope,
                  diff: [
                    { workoutId: removedWorkout.id, before: removedWorkout, after: changedWorkout },
                  ],
                },
        }),
      });
      const edits = {
        structure: {
          sql: "UPDATE plan_workout SET structure_json=? WHERE id=?",
          values: [JSON.stringify({ ...removedWorkout, minutes: 100 }), id("32")],
        },
        name: {
          sql: "UPDATE plan_workout SET name=? WHERE id=?",
          values: ["Athlete accepted edit", id("32")],
        },
        duration: {
          sql: "UPDATE plan_workout SET duration_s=? WHERE id=?",
          values: [5400, id("32")],
        },
        "name-and-duration": {
          sql: "UPDATE plan_workout SET name=?,duration_s=? WHERE id=?",
          values: ["Athlete accepted edit", 5400, id("32")],
        },
        date: {
          sql: "UPDATE plan_workout SET date_key=? WHERE id=?",
          values: [19980103, id("32")],
        },
      };
      await store.run(edits[field].sql, edits[field].values);
      const before = await dumpStore(store);
      const materialize = vi.fn(applyInput().materialize);
      await expect(repository.apply({ ...applyInput(), materialize })).resolves.toEqual({
        status: "rejected",
        reason: "stale-version",
      });
      expect(materialize).not.toHaveBeenCalled();
      expect(await dumpStore(store)).toBe(before);
    },
  );

  it("rejects a host mutation outside the Change diff without writes", async () => {
    await activate();
    await repository.preview(previewInput());
    const before = await dumpStore(store);
    const input = applyInput();
    await expect(
      repository.apply({
        ...input,
        materialize: (snapshotJson, current) => ({
          ...input.materialize(snapshotJson, current),
          update: current.filter((row) => row.id === id("31")),
        }),
      }),
    ).rejects.toThrow();
    expect(await dumpStore(store)).toBe(before);
  });

  it.each(["apply", "cancel"] as const)(
    "replays %s without invoking materialization again",
    async (decision) => {
      await activate();
      await repository.preview(previewInput());
      const input = applyInput(decision);
      const result = await repository.apply(input);
      const before = await dumpStore(store);
      const materialize = vi.fn(input.materialize);
      expect(JSON.stringify(await repository.apply({ ...input, materialize }))).toBe(
        JSON.stringify(result),
      );
      expect(materialize).not.toHaveBeenCalled();
      await expect(
        repository.apply({
          ...input,
          command: { ...input.command, requestDigest: "b".repeat(64) },
        }),
      ).resolves.toEqual({ status: "rejected", reason: "command-conflict" });
      expect(await dumpStore(store)).toBe(before);
    },
  );

  it("cancels without changing training or revision and rejects a later apply", async () => {
    await activate();
    await repository.preview(previewInput());
    const original = await store.get("SELECT diff_json FROM plan_change");
    const workouts = await store.all("SELECT * FROM plan_workout");
    const revisions = await store.all("SELECT * FROM plan_revision");
    const plan = await store.all("SELECT * FROM planning_plan");
    const materialize = vi.fn(applyInput().materialize);
    await expect(repository.apply({ ...applyInput("cancel"), materialize })).resolves.toEqual({
      status: "cancelled",
      changeId: id("90"),
      version: 1,
    });
    expect(materialize).not.toHaveBeenCalled();
    expect(await store.all("SELECT * FROM plan_workout")).toEqual(workouts);
    expect(await store.all("SELECT * FROM plan_revision")).toEqual(revisions);
    expect(await store.all("SELECT * FROM planning_plan")).toEqual(plan);
    expect(await store.get("SELECT diff_json FROM plan_change")).toEqual(original);
    await expect(repository.listChanges(planId)).resolves.toMatchObject([
      { status: "cancelled", resultRevisionNumber: null, supersededBy: null },
    ]);
    await expect(repository.apply(applyInput())).resolves.toEqual({
      status: "rejected",
      reason: "not-pending",
    });
  });

  it("rejects apply with no active Plan, stale version or a missing Change", async () => {
    await expect(repository.apply(applyInput())).resolves.toEqual({
      status: "rejected",
      reason: "no-active-plan",
    });
    await activate();
    await repository.preview(previewInput());
    const before = await dumpStore(store);
    await expect(repository.apply({ ...applyInput(), expectedVersion: 2 })).resolves.toEqual({
      status: "rejected",
      reason: "stale-version",
    });
    await expect(repository.apply({ ...applyInput(), planId: id("88") })).resolves.toEqual({
      status: "rejected",
      reason: "stale-version",
    });
    await expect(repository.apply({ ...applyInput(), changeId: id("88") })).resolves.toEqual({
      status: "rejected",
      reason: "not-pending",
    });
    expect(await dumpStore(store)).toBe(before);
  });

  it.each(["preview", "apply", "cancel"] as const)(
    "rolls back every %s write if recording the command fails",
    async (operation) => {
      await activate();
      await repository.preview(previewInput());
      await store.exec(
        `CREATE TRIGGER fail_change_ledger BEFORE INSERT ON planning_command WHEN NEW.command_name LIKE 'plan_change.%' BEGIN SELECT RAISE(ABORT,'Synthetic ledger failure'); END;`,
      );
      const before = await dumpStore(store);
      await expect(
        operation === "preview"
          ? repository.preview(previewInput(20))
          : repository.apply(applyInput(operation)),
      ).rejects.toThrow("Synthetic ledger failure");
      expect(await dumpStore(store)).toBe(before);
    },
  );

  it("rolls back revision and trigger changes when materialization fails", async () => {
    await activate();
    await repository.preview(previewInput());
    const before = await dumpStore(store);
    await expect(
      repository.apply({
        ...applyInput(),
        materialize: () => {
          throw new Error("Synthetic materialization failure");
        },
      }),
    ).rejects.toThrow("Synthetic materialization failure");
    expect(await dumpStore(store)).toBe(before);
  });

  it("rejects re-keying an existing Draft Workout and rolls back the revision", async () => {
    await activate();
    await repository.preview(previewInput());
    const before = await dumpStore(store);
    const input = applyInput();
    await expect(
      repository.apply({
        ...input,
        materialize: (snapshotJson, current) => {
          const changes = input.materialize(snapshotJson, current);
          const kept = current.find((row) => row.id === id("31"));
          if (kept === undefined) throw new Error("Expected kept Workout");
          return {
            insert: [...changes.insert, { ...kept, id: id("34") }],
            update: [],
            delete: [...changes.delete, kept.id],
          };
        },
      }),
    ).rejects.toThrow();
    expect(await dumpStore(store)).toBe(before);
  });

  it("rejects materialization that omits a dated Draft Workout", async () => {
    await activate();
    await repository.preview(previewInput());
    const before = await dumpStore(store);
    await expect(
      repository.apply({
        ...applyInput(),
        materialize: () => ({ insert: [], update: [], delete: [id("32")] }),
      }),
    ).rejects.toThrow();
    expect(await dumpStore(store)).toBe(before);
  });

  it("stales the pending preview when the Plan closes and keeps replay available", async () => {
    await activate();
    const result = await repository.preview(previewInput());
    const lifecycle = createPlanLifecycleRepository(store, { newId: () => id("200") });
    await lifecycle.close({
      command: stamp("close", 40),
      planId,
      expectedVersion: 1,
      closedAtMs: nowMs + 40,
      todayDateKey: 19980103,
      cleanupJobId: id("201"),
    });
    await expect(repository.listChanges(planId)).resolves.toMatchObject([
      { changeId: id("90"), status: "stale" },
    ]);
    await expect(
      repository.apply({ ...applyInput(), command: stamp("apply-closed", 50), nowMs: nowMs + 50 }),
    ).resolves.toEqual({ status: "rejected", reason: "no-active-plan" });
    await expect(repository.preview(previewInput())).resolves.toEqual(result);
  });
});
