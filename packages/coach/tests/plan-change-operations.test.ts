import { describe, expect, it, onTestFinished } from "vitest";
import {
  PlanCreationDraftSchema,
  type PlanCreationAnswerInput,
  type PlanChangeIntent,
} from "@enduragent/coach-contract";
import { canonicalJson } from "@enduragent/kernel/archive";
import { createPlanCreationRepository } from "@enduragent/kernel/planning";
import { dumpStore, runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { createPlanCreationOperations } from "../src/plan-creation-operations.js";
import { createPlanChangeOperations } from "../src/plan-change-operations.js";

async function activatedPlan() {
  const store = openSqliteStorage(":memory:");
  onTestFinished(() => store.close());
  await runMigrations(store, MIGRATIONS);
  let sequence = 100;
  const identity = {
    deviceId: async () => "plan-change-test-device",
    newUlid: () => String(++sequence).padStart(26, "0"),
    hlcStamp: () => ({ physicalMs: 904_694_400_000, counter: sequence }),
  };
  const dependencies = {
    store,
    identity,
    crypto: globalThis.crypto,
    todayDateKey: () => 19980902,
    now: () => 904_694_400_000,
  };
  const creation = createPlanCreationOperations({
    ...dependencies,
    repository: createPlanCreationRepository(store),
    eventCandidates: { read: async () => [] },
    today: () => "1998-09-02",
  });
  const changes = createPlanChangeOperations(dependencies);
  const start = await creation["plan_creation.start"]({ commandId: "start" });
  if (start.status !== "started") throw new Error("Expected creation");
  let card = start.planCreation;
  const answers: PlanCreationAnswerInput[] = [
    { kind: "goal", goal: { kind: "fitness" } },
    { kind: "plan-length", weeks: 4 },
    { kind: "schedule-mode", mode: "fixed" },
    {
      kind: "availability",
      mode: "fixed",
      weeklyHoursLimit: 8,
      longestWorkoutHours: 3,
      usableWeekdays: [6, 2, 4],
    },
    { kind: "start-timing", timing: { kind: "as-soon-as-possible" } },
    { kind: "commitments", commitments: { kind: "none" } },
    { kind: "baseline", baseline: "regular" },
    { kind: "success", success: { kind: "fitness-choice", choice: "climb-stronger" } },
    { kind: "restriction", restriction: { kind: "none" } },
  ];
  for (const answer of answers) {
    const result = await creation["plan_creation.answer"]({
      commandId: `answer-${++sequence}`,
      creationId: card.creationId,
      expectedVersion: card.version,
      answer,
    });
    if (result.status !== "answered") throw new Error("Expected answer");
    card = result.planCreation;
  }
  const draftResult = await creation["plan_creation.preview"]({
    commandId: "draft",
    creationId: card.creationId,
    expectedVersion: card.version,
  });
  if (draftResult.status !== "previewed" || draftResult.planCreation.draft === null)
    throw new Error("Expected Draft");
  const activated = await creation["plan_creation.activate"]({
    commandId: "activate",
    creationId: card.creationId,
    expectedVersion: draftResult.planCreation.version,
  });
  expect(activated.planId).toBeTruthy();
  const listed = await creation["plan.list"]({});
  if (listed.active === null) throw new Error("Expected active Plan summary");
  const planId = listed.active.planId;
  const preview = async (
    intent: PlanChangeIntent = { kind: "longest-workout", minutes: 30 },
    commandId = "change-preview",
  ) => {
    const result = await changes["plan_change.preview"]({
      commandId,
      planId,
      expectedVersion: 1,
      intent,
    });
    if (result.status !== "previewed") throw new Error(`Expected Change preview: ${result.reason}`);
    return result;
  };
  const workouts = () =>
    store.all("SELECT * FROM plan_workout WHERE plan_id = ? ORDER BY id", [planId]);
  return {
    store,
    creation,
    changes,
    planId,
    preview,
    workouts,
    draft: draftResult.planCreation.draft,
  };
}

describe("Plan Change operations", () => {
  it("stores a pending preview in plan.list without changing training and replays its captured result", async () => {
    const test = await activatedPlan();
    const before = await test.workouts();
    const first = await test.preview();
    expect(first.change).toMatchObject({
      status: "pending",
      title: "Limit the longest Workout",
      baseRevisionNumber: 1,
      confidence:
        "Moderate confidence. Based on your confirmed limits and the available training record.",
      premises: [
        {
          id: "confirmed-limits",
          label: "Confirmed Plan limits",
          source: "Your confirmed answers",
          value: { kind: "longest-workout", minutes: 30 },
        },
      ],
    });
    expect(first.change.diff.length).toBeGreaterThan(0);
    expect(first.change.totals.after.plan).toBeLessThan(first.change.totals.before.plan);
    expect(await test.workouts()).toEqual(before);
    expect((await test.creation["plan.list"]({})).changes).toEqual([first.change]);
    expect(await test.preview()).toEqual(first);
    const second = await test.preview({ kind: "weekly-duration", hours: 2 }, "replacement");
    expect((await test.creation["plan.list"]({})).changes).toMatchObject([
      {
        changeId: first.change.changeId,
        status: "superseded",
        supersededBy: second.change.changeId,
      },
      { changeId: second.change.changeId, status: "pending", supersedes: first.change.changeId },
    ]);
    expect(await test.preview()).toEqual(first);
  });

  it("rejects invalid intents and stale versions without writing a Change", async () => {
    const test = await activatedPlan();
    await expect(
      test.changes["plan_change.preview"]({
        commandId: "invalid",
        planId: test.planId,
        expectedVersion: 1,
        intent: { kind: "weekday-duration", day: 8, minutes: 0 },
      }),
    ).resolves.toEqual({ status: "rejected", reason: "invalid-intent" });
    await expect(
      test.changes["plan_change.preview"]({
        commandId: "stale",
        planId: test.planId,
        expectedVersion: 2,
        intent: { kind: "longest-workout", minutes: 30 },
      }),
    ).resolves.toEqual({ status: "rejected", reason: "stale-version" });
    expect((await test.creation["plan.list"]({})).changes).toEqual([]);
    expect(
      await test.store.all(
        "SELECT * FROM planning_command WHERE command_name = 'plan_change.preview'",
      ),
    ).toEqual([]);
  });

  it("applies the captured Draft as revision 2 and preserves retained Workout row ids", async () => {
    const test = await activatedPlan();
    const before = await test.workouts();
    const preview = await test.preview({ kind: "weekday-unavailable", day: 4 });
    const request = {
      commandId: "apply",
      planId: test.planId,
      changeId: preview.change.changeId,
      expectedVersion: 1,
      decision: "apply" as const,
    };
    await expect(
      test.changes["plan_change.apply"]({ ...request, expectedVersion: 2 }),
    ).resolves.toEqual({ status: "rejected", reason: "stale-version" });
    const result = await test.changes["plan_change.apply"](request);
    expect(result).toEqual({
      status: "applied",
      changeId: preview.change.changeId,
      revisionNumber: 2,
      version: 2,
    });
    const after = await test.workouts();
    const removed = new Set(
      preview.change.diff.filter((row) => row.after === null).map((row) => row.workoutId),
    );
    expect(removed.size).toBeGreaterThan(0);
    const retained = before.filter(
      (row) =>
        !removed.has(
          PlanCreationDraftSchema.shape.weeks.element.shape.workouts.element.parse(
            JSON.parse(String(row.structure_json)),
          ).id,
        ),
    );
    expect(after).toEqual(retained);
    expect(after.map((row) => row.structure_json)).toEqual(
      retained.map((row) => row.structure_json),
    );
    const revision = await test.store.get(
      "SELECT * FROM plan_revision WHERE plan_id = ? AND revision_number = 2",
      [test.planId],
    );
    const expected = structuredClone(test.draft);
    for (const week of expected.weeks)
      week.workouts = week.workouts.filter((row) => !removed.has(row.id));
    const captured = PlanCreationDraftSchema.parse(JSON.parse(String(revision?.snapshot_json)));
    expect(captured.weeks).toEqual(expected.weeks);
    expect(revision).toMatchObject({
      source_kind: "plan-change",
      source_id: preview.change.changeId,
      parent_revision_number: 1,
    });
    expect((await test.creation["plan.list"]({})).changes).toMatchObject([
      { status: "applied", resultRevisionNumber: 2 },
    ]);
    expect(await test.changes["plan_change.apply"](request)).toEqual(result);
    expect(await test.workouts()).toEqual(after);
    expect(
      await test.store.all("SELECT * FROM plan_revision WHERE plan_id = ?", [test.planId]),
    ).toHaveLength(2);
  });

  it("preserves provider notes on retained Workouts while applying affected Workouts", async () => {
    const test = await activatedPlan();
    const preview = await test.preview({ kind: "weekday-unavailable", day: 4 });
    const diffIds = new Set(preview.change.diff.map((row) => row.workoutId));
    const retained = test.draft.weeks
      .flatMap((week) => week.workouts)
      .find((workout) => workout.date !== null && !diffIds.has(workout.id));
    if (retained === undefined) throw new Error("Expected a retained Workout");
    await test.store.run(
      "UPDATE plan_workout SET structure_json=? WHERE plan_id=? AND json_extract(structure_json,'$.id')=?",
      [canonicalJson({ ...retained, description: "Provider notes" }), test.planId, retained.id],
    );
    const before = await test.workouts();
    const affected = before.filter((row) =>
      preview.change.diff.some((change) => row.structure_json === canonicalJson(change.before)),
    );
    expect(affected).toHaveLength(diffIds.size);
    expect(affected.length).toBeGreaterThan(0);
    expect(preview.change.diff.every((row) => row.after === null)).toBe(true);
    await expect(
      test.changes["plan_change.apply"]({
        commandId: "apply-provider-notes",
        planId: test.planId,
        changeId: preview.change.changeId,
        expectedVersion: 1,
        decision: "apply",
      }),
    ).resolves.toMatchObject({ status: "applied", revisionNumber: 2, version: 2 });
    const after = await test.workouts();
    expect(JSON.stringify(after)).toBe(
      JSON.stringify(before.filter((row) => !affected.some((changed) => changed.id === row.id))),
    );
  });

  it("materializes changed durations and canonical Draft structures", async () => {
    const test = await activatedPlan();
    const preview = await test.preview();
    const before = await test.workouts();
    await test.changes["plan_change.apply"]({
      commandId: "apply",
      planId: test.planId,
      changeId: preview.change.changeId,
      expectedVersion: 1,
      decision: "apply",
    });
    const after = await test.workouts();
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    for (const row of after) {
      const draft = PlanCreationDraftSchema.shape.weeks.element.shape.workouts.element.parse(
        JSON.parse(String(row.structure_json)),
      );
      expect(row).toMatchObject({
        sport: "Ride",
        origin: "coach",
        duration_s: Math.round(draft.minutes * 60),
        date_key: Number(draft.date?.replaceAll("-", "")),
        structure_json: canonicalJson(draft),
      });
      expect(draft.minutes).toBeLessThanOrEqual(30);
    }
  });

  it("rejects an athlete edit to a changed Workout without writes through plan_change.apply", async () => {
    const test = await activatedPlan();
    const preview = await test.preview();
    const [changed] = preview.change.diff;
    if (changed?.before === null || changed?.before === undefined)
      throw new Error("Expected a changed Workout");
    await test.store.run(
      "UPDATE plan_workout SET structure_json=? WHERE plan_id=? AND json_extract(structure_json,'$.id')=?",
      [
        canonicalJson({ ...changed.before, minutes: changed.before.minutes + 5 }),
        test.planId,
        changed.workoutId,
      ],
    );
    const before = await dumpStore(test.store);
    await expect(
      test.changes["plan_change.apply"]({
        commandId: "apply-drifted",
        planId: test.planId,
        changeId: preview.change.changeId,
        expectedVersion: 1,
        decision: "apply",
      }),
    ).resolves.toEqual({ status: "rejected", reason: "stale-version" });
    expect(await dumpStore(test.store)).toBe(before);
  });

  it("cancels and replays without changing revision or Workouts", async () => {
    const test = await activatedPlan();
    const before = await test.workouts();
    const preview = await test.preview();
    const request = {
      commandId: "cancel",
      planId: test.planId,
      changeId: preview.change.changeId,
      expectedVersion: 1,
      decision: "cancel" as const,
    };
    const result = await test.changes["plan_change.apply"](request);
    expect(result).toEqual({ status: "cancelled", changeId: preview.change.changeId, version: 1 });
    expect(await test.changes["plan_change.apply"](request)).toEqual(result);
    expect(
      await test.changes["plan_change.apply"]({
        ...request,
        commandId: "apply-cancelled",
        decision: "apply",
      }),
    ).toEqual({ status: "rejected", reason: "not-pending" });
    expect(await test.workouts()).toEqual(before);
    expect(
      await test.store.all("SELECT * FROM plan_revision WHERE plan_id = ?", [test.planId]),
    ).toHaveLength(1);
    expect((await test.creation["plan.list"]({})).changes).toMatchObject([
      { status: "cancelled", supersededBy: null },
    ]);
    await test.creation["plan.close"]({
      commandId: "close",
      planId: test.planId,
      expectedVersion: 1,
    });
    expect((await test.creation["plan.list"]({})).changes).toEqual([]);
  });
});
