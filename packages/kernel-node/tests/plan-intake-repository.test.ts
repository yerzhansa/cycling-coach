import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PlanIntakeValidationError,
  createPlanConversationRepository,
  createPlanIntakeRepository,
  type PlanConversationRecord,
  type PlanConversationTurnRecord,
  type PlanIntakeRecord,
} from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/index.js";

const CONVERSATION_ID = `${"0".repeat(25)}1`;

function conversation(): PlanConversationRecord {
  return {
    id: CONVERSATION_ID,
    planId: null,
    replacesPlanId: null,
    courseChoiceStatus: "undecided",
    raceCourseJson: null,
    status: "open",
    endedAtMs: null,
    createdAtMs: 10,
    updatedAtMs: 10,
    deviceId: "device-1",
    hlcPhysicalMs: 10,
    hlcCounter: 0,
  };
}

function intake(overrides: Partial<PlanIntakeRecord> = {}): PlanIntakeRecord {
  return {
    conversationId: CONVERSATION_ID,
    eventName: "Gran Fondo Almaty",
    eventPriority: "A",
    eventDateKey: 19981004,
    athleteGoal: "Finish in the front half",
    availabilitySessionsPerWeek: 4,
    availabilityWeekdays: ["tue", "thu", "sat", "sun"],
    experience: "intermediate",
    currentTrainingSummary: "Three recent rides per week with a two-hour weekend ride.",
    sourceTurnSequence: 0,
    createdAtMs: 20,
    updatedAtMs: 20,
    deviceId: "device-1",
    hlcPhysicalMs: 20,
    hlcCounter: 0,
    ...overrides,
  };
}

function turn(overrides: Partial<PlanConversationTurnRecord> = {}): PlanConversationTurnRecord {
  return {
    id: `${"0".repeat(25)}2`,
    conversationId: CONVERSATION_ID,
    sequence: 1,
    athleteText: "Gran Fondo Almaty is on 4 October.",
    coachText: "What result are you targeting?",
    lineageJson: JSON.stringify({
      engineTurnId: "turn-1",
      planIntakePatch: { eventName: "Gran Fondo Almaty", targetDate: "1998-10-04" },
    }),
    completedAtMs: 21,
    deviceId: "device-1",
    hlcPhysicalMs: 21,
    hlcCounter: 0,
    ...overrides,
  };
}

describe("Plan intake repository", () => {
  let store: SqlStore & MigratorStore;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    await createPlanConversationRepository(store).saveConversation(conversation());
  });

  afterEach(async () => {
    await store.close();
  });

  it("persists structured intake and restores canonical weekday order", async () => {
    const repository = createPlanIntakeRepository(store);
    await expect(repository.save(intake(), null)).resolves.toEqual(intake());
    await expect(createPlanIntakeRepository(store).read(CONVERSATION_ID)).resolves.toEqual(
      intake(),
    );
  });

  it("persists a partial intake without duplicating FTP or Course", async () => {
    const partial = intake({
      eventName: null,
      eventPriority: null,
      eventDateKey: null,
      athleteGoal: "Improve general fitness",
      availabilitySessionsPerWeek: null,
      availabilityWeekdays: [],
      experience: null,
      currentTrainingSummary: null,
    });
    await createPlanIntakeRepository(store).save(partial, null);

    const row = await store.get("SELECT * FROM plan_intake WHERE conversation_id=?", [
      CONVERSATION_ID,
    ]);
    expect(row).toEqual(
      expect.not.objectContaining({
        ftp_watts: expect.anything(),
        race_course_json: expect.anything(),
      }),
    );
    await expect(createPlanIntakeRepository(store).read(CONVERSATION_ID)).resolves.toEqual(partial);
  });

  it("updates from the exact authored version and rejects a stale retry", async () => {
    const repository = createPlanIntakeRepository(store);
    const original = await repository.save(intake(), null);
    const expectedVersion = {
      updatedAtMs: original.updatedAtMs,
      deviceId: original.deviceId,
      hlcPhysicalMs: original.hlcPhysicalMs,
      hlcCounter: original.hlcCounter,
    };
    const updated = intake({
      athleteGoal: "Finish in the first third",
      sourceTurnSequence: 1,
      updatedAtMs: 21,
      hlcPhysicalMs: 21,
    });
    await expect(repository.save(updated, expectedVersion)).resolves.toEqual(updated);

    await expect(
      repository.save(
        intake({
          athleteGoal: "Win",
          updatedAtMs: 22,
          hlcPhysicalMs: 22,
        }),
        expectedVersion,
      ),
    ).rejects.toEqual(new PlanIntakeValidationError("stale-intake"));
    await expect(repository.read(CONVERSATION_ID)).resolves.toEqual(updated);

    await expect(
      repository.save(
        intake({
          athleteGoal: "Regressed projection",
          sourceTurnSequence: 0,
          updatedAtMs: 22,
          hlcPhysicalMs: 22,
        }),
        {
          updatedAtMs: updated.updatedAtMs,
          deviceId: updated.deviceId,
          hlcPhysicalMs: updated.hlcPhysicalMs,
          hlcCounter: updated.hlcCounter,
        },
      ),
    ).rejects.toEqual(new PlanIntakeValidationError("invalid-intake"));
  });

  it("commits a conversation turn and its structured intake projection together", async () => {
    const repository = createPlanIntakeRepository(store);
    const original = await repository.save(intake(), null);
    const projected = intake({
      athleteGoal: "Finish in the first third",
      sourceTurnSequence: 1,
      updatedAtMs: 21,
      hlcPhysicalMs: 21,
    });
    await expect(
      repository.appendTurnWithIntake?.(turn(), projected, {
        updatedAtMs: original.updatedAtMs,
        deviceId: original.deviceId,
        hlcPhysicalMs: original.hlcPhysicalMs,
        hlcCounter: original.hlcCounter,
      }),
    ).resolves.toEqual({ turn: turn(), intake: projected });
    await expect(
      store.get("SELECT * FROM plan_conversation_turn WHERE id=?", [turn().id]),
    ).resolves.toEqual(expect.objectContaining({ sequence: 1, athlete_text: turn().athleteText }));
    await expect(repository.read(CONVERSATION_ID)).resolves.toEqual(projected);
  });

  it("rolls back the turn when the intake write fails", async () => {
    const base = createPlanIntakeRepository(store);
    const original = await base.save(intake(), null);
    const failingStore: SqlStore & Pick<MigratorStore, "transaction"> = {
      exec: store.exec.bind(store),
      run: async (sql, params) => {
        if (sql.startsWith("UPDATE plan_intake")) throw new Error("forced intake write failure");
        await store.run(sql, params);
      },
      get: store.get.bind(store),
      all: store.all.bind(store),
      close: store.close.bind(store),
      transaction: store.transaction.bind(store),
    };
    const repository = createPlanIntakeRepository(failingStore);
    await expect(
      repository.appendTurnWithIntake?.(
        turn(),
        intake({ sourceTurnSequence: 1, updatedAtMs: 21, hlcPhysicalMs: 21 }),
        {
          updatedAtMs: original.updatedAtMs,
          deviceId: original.deviceId,
          hlcPhysicalMs: original.hlcPhysicalMs,
          hlcCounter: original.hlcCounter,
        },
      ),
    ).rejects.toThrow("forced intake write failure");
    await expect(
      store.get("SELECT id FROM plan_conversation_turn WHERE id=?", [turn().id]),
    ).resolves.toBeUndefined();
    await expect(base.read(CONVERSATION_ID)).resolves.toEqual(original);
  });

  it("rejects invalid structured values and a missing parent conversation", async () => {
    const repository = createPlanIntakeRepository(store);
    await expect(
      repository.save(intake({ availabilityWeekdays: ["sun", "mon"] }), null),
    ).rejects.toEqual(new PlanIntakeValidationError("invalid-intake"));
    await expect(repository.save(intake({ eventDateKey: 19980231 }), null)).rejects.toEqual(
      new PlanIntakeValidationError("invalid-intake"),
    );
    await expect(
      repository.save(intake({ conversationId: `${"0".repeat(25)}2` }), null),
    ).rejects.toEqual(new PlanIntakeValidationError("missing-conversation"));
  });

  it("deletes the intake with its Plan conversation", async () => {
    await createPlanIntakeRepository(store).save(intake(), null);
    await store.run("DELETE FROM plan_conversation WHERE id=?", [CONVERSATION_ID]);
    await expect(createPlanIntakeRepository(store).read(CONVERSATION_ID)).resolves.toBeUndefined();
  });
});
