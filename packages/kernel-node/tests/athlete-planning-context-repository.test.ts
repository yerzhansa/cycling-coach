import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AthletePlanningContextStoreError,
  createAthletePlanningContextRepository,
  type CreateAthletePreferenceInput,
  type CreateTrainingRestrictionInput,
  type TrainingRestrictionKind,
} from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/index.js";

const id = (suffix: number): string => String(suffix).padStart(26, "0");
const BASE_MS = 903_945_600_000;
const DEVICE_ID = "device-1998";

function preference(
  preferenceId: string,
  overrides: Partial<CreateAthletePreferenceInput> = {},
): CreateAthletePreferenceInput {
  return {
    id: preferenceId,
    preferenceKey: "preferred-training-days",
    valueJson: JSON.stringify(["tue", "thu", "sat"]),
    sourceAnswerId: null,
    createdAtMs: BASE_MS,
    deviceId: DEVICE_ID,
    hlcPhysicalMs: BASE_MS,
    hlcCounter: 0,
    ...overrides,
  };
}

function restriction(
  restrictionId: string,
  overrides: Partial<CreateTrainingRestrictionInput> = {},
): CreateTrainingRestrictionInput {
  return {
    id: restrictionId,
    kind: "no-training",
    startDateKey: 19980824,
    endDateKey: null,
    maximumDurationMinutes: null,
    confirmedAtMs: BASE_MS,
    createdAtMs: BASE_MS,
    deviceId: DEVICE_ID,
    hlcPhysicalMs: BASE_MS,
    hlcCounter: 0,
    ...overrides,
  };
}

describe("Athlete Planning context repository", () => {
  let store: SqlStore & MigratorStore;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
  });

  afterEach(async () => {
    await store.close();
  });

  it("uses Preference CAS and preserves removal history", async () => {
    const repository = createAthletePlanningContextRepository(store);
    const preferenceId = id(1);
    const created = await repository.createPreference(preference(preferenceId));
    expect(created).toMatchObject({ status: "active", version: 1, removedAtMs: null });
    await expect(repository.readActivePreferences()).resolves.toEqual([created]);
    await expect(
      repository.createPreference(
        preference(preferenceId, {
          createdAtMs: BASE_MS + 1,
          hlcPhysicalMs: BASE_MS + 1,
        }),
      ),
    ).rejects.toEqual(new AthletePlanningContextStoreError("preference-conflict"));

    await expect(
      repository.removePreference({
        id: preferenceId,
        expectedVersion: 2,
        removedAtMs: BASE_MS + 10,
        updatedAtMs: BASE_MS + 10,
        deviceId: DEVICE_ID,
        hlcPhysicalMs: BASE_MS + 10,
        hlcCounter: 0,
      }),
    ).rejects.toEqual(new AthletePlanningContextStoreError("stale-preference"));
    await expect(
      repository.removePreference({
        id: preferenceId,
        expectedVersion: 1,
        removedAtMs: BASE_MS + 10,
        updatedAtMs: BASE_MS + 10,
        deviceId: DEVICE_ID,
        hlcPhysicalMs: BASE_MS - 1,
        hlcCounter: 0,
      }),
    ).rejects.toEqual(new AthletePlanningContextStoreError("stale-preference"));

    const removed = await repository.removePreference({
      id: preferenceId,
      expectedVersion: 1,
      removedAtMs: BASE_MS + 10,
      updatedAtMs: BASE_MS + 10,
      deviceId: DEVICE_ID,
      hlcPhysicalMs: BASE_MS + 10,
      hlcCounter: 0,
    });
    expect(removed).toEqual({
      ...created,
      status: "removed",
      version: 2,
      updatedAtMs: BASE_MS + 10,
      removedAtMs: BASE_MS + 10,
      hlcPhysicalMs: BASE_MS + 10,
    });
    await expect(repository.readActivePreferences()).resolves.toEqual([]);
    await expect(repository.readPreference(preferenceId)).resolves.toEqual(removed);
    await expect(
      repository.removePreference({
        id: preferenceId,
        expectedVersion: 2,
        removedAtMs: BASE_MS + 20,
        updatedAtMs: BASE_MS + 20,
        deviceId: DEVICE_ID,
        hlcPhysicalMs: BASE_MS + 20,
        hlcCounter: 0,
      }),
    ).rejects.toEqual(new AthletePlanningContextStoreError("stale-preference"));
    await expect(
      store.run("UPDATE athlete_preference SET value_json='{}' WHERE id=?", [preferenceId]),
    ).rejects.toThrow("removed athlete preference is immutable");
    await expect(
      store.run("DELETE FROM athlete_preference WHERE id=?", [preferenceId]),
    ).rejects.toThrow("athlete preference records are durable");
  });

  it("replaces the active value for one Preference key", async () => {
    const repository = createAthletePlanningContextRepository(store);
    const firstId = id(1);
    const secondId = id(2);
    const first = await repository.createPreference(preference(firstId));
    const second = await repository.createPreference(
      preference(secondId, {
        valueJson: JSON.stringify(["mon", "wed", "fri"]),
        createdAtMs: BASE_MS + 10,
        hlcPhysicalMs: BASE_MS + 10,
      }),
    );

    await expect(repository.readActivePreferences()).resolves.toEqual([second]);
    await expect(repository.readPreference(firstId)).resolves.toEqual({
      ...first,
      status: "removed",
      version: 2,
      updatedAtMs: BASE_MS + 10,
      removedAtMs: BASE_MS + 10,
      hlcPhysicalMs: BASE_MS + 10,
    });
    await expect(
      repository.createPreference(
        preference(id(3), {
          sourceAnswerId: id(99),
          createdAtMs: BASE_MS + 20,
          hlcPhysicalMs: BASE_MS + 20,
        }),
      ),
    ).rejects.toEqual(new AthletePlanningContextStoreError("invalid-preference"));
    await expect(repository.readActivePreferences()).resolves.toEqual([second]);
  });

  it("validates Restriction kind, dates, and maximum duration", async () => {
    const repository = createAthletePlanningContextRepository(store);
    const restrictionId = id(1);
    await expect(
      repository.createRestriction(
        restriction(restrictionId, { kind: "medical" as TrainingRestrictionKind }),
      ),
    ).rejects.toEqual(new AthletePlanningContextStoreError("invalid-restriction"));
    await expect(
      repository.createRestriction(restriction(restrictionId, { startDateKey: 19980230 })),
    ).rejects.toEqual(new AthletePlanningContextStoreError("invalid-restriction"));
    await expect(
      repository.createRestriction(
        restriction(restrictionId, {
          startDateKey: 19980825,
          endDateKey: 19980824,
        }),
      ),
    ).rejects.toEqual(new AthletePlanningContextStoreError("invalid-restriction"));
    await expect(
      repository.createRestriction(
        restriction(restrictionId, {
          kind: "no-hard-training",
          maximumDurationMinutes: 60,
        }),
      ),
    ).rejects.toEqual(new AthletePlanningContextStoreError("invalid-restriction"));
    await expect(
      repository.createRestriction(
        restriction(restrictionId, {
          kind: "maximum-duration",
          maximumDurationMinutes: null,
        }),
      ),
    ).rejects.toEqual(new AthletePlanningContextStoreError("invalid-restriction"));
    await expect(
      repository.createRestriction(
        restriction(restrictionId, {
          kind: "maximum-duration",
          maximumDurationMinutes: 0,
        }),
      ),
    ).rejects.toEqual(new AthletePlanningContextStoreError("invalid-restriction"));

    const noTraining = await repository.createRestriction(
      restriction(id(2), { endDateKey: 19980825 }),
    );
    const noHardTraining = await repository.createRestriction(
      restriction(id(3), {
        kind: "no-hard-training",
        startDateKey: 19980826,
        confirmedAtMs: BASE_MS + 1,
        createdAtMs: BASE_MS + 1,
        hlcPhysicalMs: BASE_MS + 1,
      }),
    );
    const maximumDuration = await repository.createRestriction(
      restriction(id(4), {
        kind: "maximum-duration",
        startDateKey: 19980827,
        endDateKey: 19980830,
        maximumDurationMinutes: 90,
        confirmedAtMs: BASE_MS + 2,
        createdAtMs: BASE_MS + 2,
        hlcPhysicalMs: BASE_MS + 2,
      }),
    );
    expect(noTraining).toMatchObject({ kind: "no-training", maximumDurationMinutes: null });
    expect(noHardTraining).toMatchObject({
      kind: "no-hard-training",
      maximumDurationMinutes: null,
    });
    expect(maximumDuration).toMatchObject({
      kind: "maximum-duration",
      maximumDurationMinutes: 90,
    });
    await expect(repository.readActiveRestrictions()).resolves.toEqual([
      noTraining,
      noHardTraining,
      maximumDuration,
    ]);
  });

  it("uses Restriction CAS and preserves end history", async () => {
    const repository = createAthletePlanningContextRepository(store);
    const restrictionId = id(1);
    const created = await repository.createRestriction(
      restriction(restrictionId, {
        kind: "no-hard-training",
        startDateKey: 19980824,
      }),
    );

    await expect(
      repository.endRestriction({
        id: restrictionId,
        expectedVersion: 2,
        endDateKey: 19980831,
        endedAtMs: BASE_MS + 10,
        updatedAtMs: BASE_MS + 10,
        deviceId: DEVICE_ID,
        hlcPhysicalMs: BASE_MS + 10,
        hlcCounter: 0,
      }),
    ).rejects.toEqual(new AthletePlanningContextStoreError("stale-restriction"));
    await expect(
      repository.endRestriction({
        id: restrictionId,
        expectedVersion: 1,
        endDateKey: 19980831,
        endedAtMs: BASE_MS + 10,
        updatedAtMs: BASE_MS + 10,
        deviceId: DEVICE_ID,
        hlcPhysicalMs: BASE_MS - 1,
        hlcCounter: 0,
      }),
    ).rejects.toEqual(new AthletePlanningContextStoreError("stale-restriction"));
    await expect(
      repository.endRestriction({
        id: restrictionId,
        expectedVersion: 1,
        endDateKey: 19980823,
        endedAtMs: BASE_MS + 10,
        updatedAtMs: BASE_MS + 10,
        deviceId: DEVICE_ID,
        hlcPhysicalMs: BASE_MS + 10,
        hlcCounter: 0,
      }),
    ).rejects.toEqual(new AthletePlanningContextStoreError("stale-restriction"));
    await expect(
      repository.endRestriction({
        id: restrictionId,
        expectedVersion: 1,
        endDateKey: 19980230,
        endedAtMs: BASE_MS + 10,
        updatedAtMs: BASE_MS + 10,
        deviceId: DEVICE_ID,
        hlcPhysicalMs: BASE_MS + 10,
        hlcCounter: 0,
      }),
    ).rejects.toEqual(new AthletePlanningContextStoreError("invalid-restriction"));

    const ended = await repository.endRestriction({
      id: restrictionId,
      expectedVersion: 1,
      endDateKey: 19980831,
      endedAtMs: BASE_MS + 10,
      updatedAtMs: BASE_MS + 10,
      deviceId: DEVICE_ID,
      hlcPhysicalMs: BASE_MS + 10,
      hlcCounter: 0,
    });
    expect(ended).toEqual({
      ...created,
      status: "ended",
      version: 2,
      endDateKey: 19980831,
      updatedAtMs: BASE_MS + 10,
      endedAtMs: BASE_MS + 10,
      hlcPhysicalMs: BASE_MS + 10,
    });
    await expect(repository.readActiveRestrictions()).resolves.toEqual([]);
    await expect(repository.readRestriction(restrictionId)).resolves.toEqual(ended);
    await expect(
      repository.endRestriction({
        id: restrictionId,
        expectedVersion: 2,
        endDateKey: 19980901,
        endedAtMs: BASE_MS + 20,
        updatedAtMs: BASE_MS + 20,
        deviceId: DEVICE_ID,
        hlcPhysicalMs: BASE_MS + 20,
        hlcCounter: 0,
      }),
    ).rejects.toEqual(new AthletePlanningContextStoreError("stale-restriction"));
    await expect(
      store.run("UPDATE training_restriction SET end_date_key=19980901 WHERE id=?", [
        restrictionId,
      ]),
    ).rejects.toThrow("ended training restriction is immutable");
    await expect(
      store.run("DELETE FROM training_restriction WHERE id=?", [restrictionId]),
    ).rejects.toThrow("training restriction records are durable");
  });
});
