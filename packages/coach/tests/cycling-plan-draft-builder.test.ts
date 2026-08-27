import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  previewPlanStartDate,
  type PlanFtpAdapter,
  type PlanFtpSnapshot,
} from "@enduragent/engine";
import {
  createPlanRepository,
  createPlanConversationRepository,
  createPlanDraftBuildRepository,
  createRaceCourseSnapshot,
  planWeekIndex,
  weekdayForDateKey,
  type PlanConversationRecord,
  type PlanDraftRevisionRecord,
  type PlanIntakeRecord,
  type PlanIntakeRepository,
  type PlanWorkoutRecord,
} from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import type { AuthoredIdentity } from "@enduragent/kernel-node/home";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { intervalsWorkoutInputSchema, serializeIntervalsWorkout } from "@enduragent/sport-cycling";
import { createCyclingPlanDraftBuilder } from "../src/cycling-plan-draft-builder.js";

const CONVERSATION_ID = "00000000000000000000000001";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodedSequence(value: number): string {
  let remaining = value;
  let result = "";
  while (remaining > 0) {
    result = CROCKFORD[remaining % 32] + result;
    remaining = Math.floor(remaining / 32);
  }
  return result.padStart(26, "0");
}

function identity(sequenceStart = 1, clockStart = 1_000): AuthoredIdentity {
  let sequence = sequenceStart;
  let clock = clockStart;
  return {
    deviceId: async () => "device-1",
    newUlid() {
      sequence += 1;
      return encodedSequence(sequence);
    },
    hlcStamp() {
      clock += 1;
      return { physicalMs: clock, counter: 0 };
    },
  };
}

const INTAKE: PlanIntakeRecord = Object.freeze({
  conversationId: CONVERSATION_ID,
  eventName: "Gran Fondo Almaty",
  eventPriority: "A",
  eventDateKey: 20261004,
  athleteGoal: "Finish in the front half",
  availabilitySessionsPerWeek: 3,
  availabilityWeekdays: Object.freeze(["tue", "thu", "sat", "sun"] as const),
  experience: "intermediate",
  currentTrainingSummary: "Riding three times each week",
  sourceTurnSequence: 1,
  createdAtMs: 100,
  updatedAtMs: 100,
  deviceId: "device-1",
  hlcPhysicalMs: 100,
  hlcCounter: 0,
});

const FTP: PlanFtpSnapshot = Object.freeze({
  manual: null,
  intervalsFtp: { watts: 282, refreshedAtMs: 90 },
  intervalsEftp: null,
  usedSource: "intervals-ftp",
  usedWatts: 282,
  conflict: false,
});

function intakes(value: PlanIntakeRecord | undefined = INTAKE): PlanIntakeRepository {
  return {
    read: async () => value,
    save: async (record) => record,
  };
}

function ftp(value: PlanFtpSnapshot = FTP): PlanFtpAdapter {
  return {
    read: async () => value,
    saveManual: async () => value,
    refreshIntervals: async () => value,
  };
}

function conversation(): PlanConversationRecord {
  return {
    id: CONVERSATION_ID,
    planId: null,
    replacesPlanId: null,
    courseChoiceStatus: "omitted",
    raceCourseJson: null,
    status: "open",
    endedAtMs: null,
    createdAtMs: 100,
    updatedAtMs: 100,
    deviceId: "device-1",
    hlcPhysicalMs: 100,
    hlcCounter: 0,
  };
}

function revision(
  planId: string,
  snapshot: unknown,
  raceCourseJson: string | null = null,
): PlanDraftRevisionRecord {
  return {
    id: encodedSequence(300),
    conversationId: CONVERSATION_ID,
    planId,
    revision: 1,
    parentRevisionId: null,
    status: "ready",
    snapshotJson: JSON.stringify(snapshot),
    raceCourseJson,
    createdAtMs: 500,
    updatedAtMs: 500,
    deviceId: "device-1",
    hlcPhysicalMs: 500,
    hlcCounter: 0,
  };
}

function workoutStructure(workout: PlanWorkoutRecord): Record<string, unknown> {
  return JSON.parse(workout.structureJson) as Record<string, unknown>;
}

function weekWorkouts(
  plan: Parameters<typeof planWeekIndex>[0],
  workouts: readonly PlanWorkoutRecord[],
  weekIndex: number,
): readonly PlanWorkoutRecord[] {
  return workouts.filter((workout) => {
    const location = planWeekIndex(plan, workout.dateKey);
    return location.kind === "inside" && location.weekIndex === weekIndex;
  });
}

describe("cycling Plan Draft builder", () => {
  let store: SqlStore & MigratorStore;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
  });

  afterEach(async () => {
    await store.close();
  });

  it("forms and persists a canonical week-by-week Draft through the Goal Event", async () => {
    const builder = createCyclingPlanDraftBuilder({
      intakes: intakes(),
      ftp: ftp(),
      identity: identity(),
      todayDateKey: () => 20260713,
    });
    const build = await builder.form({ conversation: conversation(), turns: [], course: null });

    expect(build.plan).toMatchObject({
      name: "Gran Fondo Almaty Plan",
      primaryGoal: "Finish in the front half",
      startDateKey: 20260713,
      targetDateKey: 20261004,
      kind: "full_plan",
      totalWeeks: 12,
      weekStartDay: 1,
      status: "draft",
    });
    expect(build.workouts).toHaveLength(36);
    for (let weekIndex = 1; weekIndex <= 12; weekIndex += 1) {
      expect(
        build.workouts.filter(
          (workout) =>
            planWeekIndex(build.plan, workout.dateKey).kind === "inside" &&
            (planWeekIndex(build.plan, workout.dateKey) as { weekIndex?: number }).weekIndex ===
              weekIndex,
        ),
      ).toHaveLength(3);
    }
    expect(build.workouts.at(-1)).toMatchObject({
      dateKey: 20261004,
      name: "Gran Fondo Almaty",
      durationS: 18_000,
    });
    expect(
      build.workouts.every((workout) => {
        const structure = workoutStructure(workout);
        const workoutDoc = intervalsWorkoutInputSchema.safeParse(structure.workoutDoc);
        return (
          typeof structure.slot === "string" &&
          typeof structure.description === "string" &&
          workoutDoc.success &&
          serializeIntervalsWorkout(workoutDoc.data).movingTime === workout.durationS &&
          workoutDoc.data.steps[0]?.type === "warmup" &&
          workoutDoc.data.steps.at(-1)?.type === "cooldown" &&
          (workout.dateKey === 20261004 || structure.ftpWatts === 282)
        );
      }),
    ).toBe(true);
    const sweetSpot = build.workouts.find(
      (workout) => workoutStructure(workout).workoutType === "sweet_spot",
    );
    expect(sweetSpot).toBeDefined();
    expect(workoutStructure(sweetSpot!).powerWatts).toEqual({ low: 248, high: 265 });
    const recovery = build.workouts.find(
      (workout) => workoutStructure(workout).workoutType === "recovery",
    );
    if (recovery !== undefined) {
      expect(workoutStructure(recovery).powerWatts).toEqual({ low: 127, high: 152 });
    }
    const structure = JSON.parse(build.plan.structureJson) as {
      foundation: { cycleLength: number; totalWeeks: number; zoneTables: unknown[] };
      seasonWeeks: unknown[];
      phases: Array<{ durationWeeks: number }>;
    };
    expect(structure.foundation).toMatchObject({ cycleLength: 7, totalWeeks: 12 });
    expect(structure.foundation.zoneTables).toHaveLength(1);
    expect(structure.seasonWeeks).toHaveLength(12);
    expect(structure.phases.reduce((sum, phase) => sum + phase.durationWeeks, 0)).toBe(12);
    expect(build.snapshot).toMatchObject({
      schemaVersion: 1,
      builder: "cycling-plan-draft",
      ftp: { source: "intervals-ftp", watts: 282 },
      evidence: { completeWeeks: 12, workoutCount: 36, revisions: [] },
    });

    const plans = createPlanRepository(store);
    await expect(plans.replaceNew(build.plan, build.workouts, 20260713)).resolves.toBeUndefined();
    await expect(plans.read(build.plan.id)).resolves.toEqual(build.plan);
    await expect(plans.readWorkouts(build.plan.id)).resolves.toHaveLength(36);
  });

  it("resumes from the last durable week after generation is interrupted", async () => {
    await createPlanConversationRepository(store).saveConversation(conversation());
    const durable = createPlanDraftBuildRepository(store);
    let interrupt = true;
    const interrupted = {
      read: durable.read,
      commitReady: durable.commitReady,
      async save(record: Parameters<typeof durable.save>[0]) {
        const saved = await durable.save(record);
        if (interrupt && record.completedWeeks === 5) {
          interrupt = false;
          throw new Error("interrupted after checkpoint");
        }
        return saved;
      },
    };
    const first = createCyclingPlanDraftBuilder({
      intakes: intakes(),
      ftp: ftp(),
      identity: identity(),
      todayDateKey: () => 20260713,
      checkpoints: interrupted,
    });

    await expect(
      first.form({ conversation: conversation(), turns: [], course: null }),
    ).rejects.toThrow("interrupted after checkpoint");
    const checkpoint = await durable.read(CONVERSATION_ID);
    expect(checkpoint).toMatchObject({ completedWeeks: 5 });
    if (checkpoint === undefined) throw new TypeError("Draft checkpoint was not persisted.");
    const payload = JSON.parse(checkpoint.payloadJson) as {
      schemaVersion: 1;
      planId: string;
      workouts: PlanWorkoutRecord[];
    };
    const unchangedWeek = payload.workouts.filter(
      (workout) => workoutStructure(workout).weekIndex === 2,
    );
    const duplicate = payload.workouts.at(-1);
    if (duplicate === undefined) throw new TypeError("Checkpoint has no workouts.");
    const corrupted = payload.workouts.map((workout, index) => {
      const structure = workoutStructure(workout);
      if (index === 0) {
        return { ...workout, dateKey: workout.dateKey + 1, durationS: 99_999 };
      }
      if (structure.weekIndex === 4) {
        return {
          ...workout,
          durationS: 99_999,
          structureJson: JSON.stringify({
            ...structure,
            workoutType: "threshold",
            powerWatts: { low: 282, high: 400 },
          }),
        };
      }
      return workout;
    });
    await store.run(
      "UPDATE plan_draft_build_checkpoint SET payload_json=? WHERE conversation_id=?",
      [
        JSON.stringify({
          ...payload,
          workouts: [...corrupted, { ...duplicate, id: `${"0".repeat(25)}Z` }],
        }),
        CONVERSATION_ID,
      ],
    );

    const progress: number[] = [];
    const resumed = await createCyclingPlanDraftBuilder({
      intakes: intakes({
        ...INTAKE,
        sourceTurnSequence: 99,
        updatedAtMs: 999,
        hlcPhysicalMs: 999,
      }),
      ftp: ftp({
        ...FTP,
        intervalsFtp: { watts: 282, refreshedAtMs: 999 },
      }),
      identity: identity(1_000, 10_000),
      todayDateKey: () => 20260714,
      checkpoints: durable,
    }).form({
      conversation: conversation(),
      turns: [],
      course: null,
      onProgress: ({ completedWeeks }) => progress.push(completedWeeks),
    });

    expect(progress.at(0)).toBe(5);
    expect(progress.at(-1)).toBe(12);
    expect(resumed.plan.startDateKey).toBe(20260713);
    expect(resumed.workouts).toHaveLength(36);
    expect(
      resumed.workouts.filter((workout) => unchangedWeek.some((item) => item.id === workout.id)),
    ).toEqual(unchangedWeek);
    expect(new Set(resumed.workouts.map((workout) => workout.id)).size).toBe(
      resumed.workouts.length,
    );
    expect(resumed.workouts.some((workout) => workout.id === `${"0".repeat(25)}Z`)).toBe(false);
    expect(
      resumed.workouts
        .filter((workout) => workoutStructure(workout).slot !== "race")
        .every((workout) => [2, 4, 6].includes(weekdayForDateKey(workout.dateKey))),
    ).toBe(true);
    const recovery = resumed.workouts.filter(
      (workout) => workoutStructure(workout).phase === "Recovery",
    );
    expect(recovery.length).toBeGreaterThan(0);
    expect(
      recovery.every((workout) => {
        const structure = workoutStructure(workout);
        const power = structure.powerWatts as { high?: number };
        return (
          (structure.workoutType === "recovery" || structure.workoutType === "endurance") &&
          workout.durationS !== null &&
          workout.durationS <= 7_200 &&
          typeof power.high === "number" &&
          power.high <= Math.round(282 * 0.75)
        );
      }),
    ).toBe(true);
    await expect(durable.read(CONVERSATION_ID)).resolves.toMatchObject({
      completedWeeks: 12,
      id: resumed.checkpointId,
      draftRevisionId: resumed.draftRevisionId,
    });
  });

  it("applies a supported recurring weekday move and rejects unsupported Draft prose", async () => {
    const builder = createCyclingPlanDraftBuilder({
      intakes: intakes(),
      ftp: ftp(),
      identity: identity(),
      todayDateKey: () => 20260713,
    });
    const formed = await builder.form({ conversation: conversation(), turns: [], course: null });
    const previous = revision(formed.plan.id, formed.snapshot);
    const revised = await builder.revise({
      conversation: conversation(),
      turns: [],
      previous,
      instruction: "Move Long Ride to Sunday.",
      course: null,
    });

    const moved = revised.workouts.filter((workout) => workout.name === "Long Ride");
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.every((workout) => weekdayForDateKey(workout.dateKey) === 0)).toBe(true);
    expect(revised.workouts).toHaveLength(formed.workouts.length);
    expect(revised.plan.id).toBe(formed.plan.id);
    expect(revised.snapshot).toMatchObject({
      evidence: {
        completeWeeks: 12,
        revisions: [
          {
            kind: "weekday-move",
            instruction: "Move Long Ride to Sunday.",
            targetWeekday: "sun",
          },
        ],
      },
    });

    await expect(
      builder.revise({
        conversation: conversation(),
        turns: [],
        previous,
        instruction: "Make the whole Plan easier.",
        course: null,
      }),
    ).rejects.toMatchObject({ code: "unsupported-revision" });
    await expect(
      builder.revise({
        conversation: conversation(),
        turns: [],
        previous,
        instruction: "Move Long Ride to Friday.",
        course: null,
      }),
    ).rejects.toMatchObject({ code: "revision-conflict" });
  });

  it("applies the prototype Tuesday cap and recurring long-ride move atomically", async () => {
    const builder = createCyclingPlanDraftBuilder({
      intakes: intakes(),
      ftp: ftp(),
      identity: identity(),
      todayDateKey: () => 20260713,
    });
    const formed = await builder.form({ conversation: conversation(), turns: [], course: null });
    const previous = revision(formed.plan.id, formed.snapshot);
    const revised = await builder.revise({
      conversation: conversation(),
      turns: [],
      previous,
      instruction: "Keep Tuesday under 60 minutes and move the long ride to Sunday.",
      course: null,
    });

    expect(revised.plan.id).toBe(formed.plan.id);
    expect(revised.workouts.map((workout) => workout.id)).toEqual(
      formed.workouts.map((workout) => workout.id),
    );
    const longRides = revised.workouts.filter((workout) => workout.name === "Long Ride");
    expect(longRides.length).toBeGreaterThan(0);
    expect(longRides.every((workout) => weekdayForDateKey(workout.dateKey) === 0)).toBe(true);
    const tuesdays = revised.workouts.filter((workout) => weekdayForDateKey(workout.dateKey) === 2);
    expect(tuesdays.length).toBeGreaterThan(0);
    expect(
      tuesdays.every((workout) => workout.durationS !== null && workout.durationS <= 3_300),
    ).toBe(true);
    expect(
      tuesdays.every((workout) => {
        const workoutDoc = intervalsWorkoutInputSchema.safeParse(
          workoutStructure(workout).workoutDoc,
        );
        return (
          workoutDoc.success &&
          serializeIntervalsWorkout(workoutDoc.data).movingTime === workout.durationS
        );
      }),
    ).toBe(true);
    const changedIds = new Set([...longRides, ...tuesdays].map((workout) => workout.id));
    for (const original of formed.workouts) {
      if (changedIds.has(original.id)) continue;
      expect(revised.workouts.find((workout) => workout.id === original.id)).toEqual(original);
    }
    expect(revised.snapshot).toMatchObject({
      evidence: {
        completeWeeks: 12,
        revisions: [
          {
            kind: "weekday-move-and-duration-cap",
            instruction: "Keep Tuesday under 60 minutes and move the long ride to Sunday.",
            targetWeekday: "sun",
            durationWeekday: "tue",
            maximumDurationS: 3_300,
          },
        ],
      },
    });

    const shorter = await builder.revise({
      conversation: conversation(),
      turns: [],
      previous,
      instruction: "Keep Tuesday shorter and move the long ride to Sunday.",
      course: null,
    });
    const originalTuesday = new Map(
      formed.workouts
        .filter((workout) => weekdayForDateKey(workout.dateKey) === 2)
        .map((workout) => [workout.id, workout.durationS]),
    );
    expect(
      shorter.workouts
        .filter((workout) => originalTuesday.has(workout.id))
        .every(
          (workout) =>
            workout.durationS !== null &&
            workout.durationS < (originalTuesday.get(workout.id) ?? Number.POSITIVE_INFINITY),
        ),
    ).toBe(true);
  });

  it("preserves Draft identity while recomputing a Course or start date", async () => {
    const builder = createCyclingPlanDraftBuilder({
      intakes: intakes(),
      ftp: ftp(),
      identity: identity(),
      todayDateKey: () => 20260713,
    });
    const formed = await builder.form({ conversation: conversation(), turns: [], course: null });
    const previous = revision(formed.plan.id, formed.snapshot);
    const course = createRaceCourseSnapshot({
      fileName: "gran-fondo.gpx",
      route: {
        format: "gpx",
        segments: [
          {
            points: [
              { latitude: 43.2, longitude: 76.8, elevationM: 800 },
              { latitude: 43.4, longitude: 77, elevationM: 1_200 },
            ],
          },
        ],
      },
      preview: {
        pointCount: 2,
        distanceM: 120_000,
        elevationGainM: 1_500,
        elevationStatus: "available",
      },
    });
    const withCourse = await builder.recalculateCourse({
      conversation: conversation(),
      turns: [],
      previous,
      course,
    });
    expect(withCourse.plan.id).toBe(formed.plan.id);
    expect(withCourse.workouts.at(-1)).toMatchObject({
      id: formed.workouts.at(-1)?.id,
      dateKey: 20261004,
      durationS: 18_383,
    });
    expect(withCourse.snapshot).toMatchObject({
      course: { fileName: "gran-fondo.gpx", distanceM: 120_000, elevationGainM: 1_500 },
    });
    const originalBuildLong = formed.workouts.find(
      (workout) =>
        workoutStructure(workout).phase === "Build" &&
        workoutStructure(workout).workoutType === "long",
    );
    const courseBuildLong = withCourse.workouts.find(
      (workout) => workout.id === originalBuildLong?.id,
    );
    expect(courseBuildLong?.name).toBe("Climbing long ride");
    expect(courseBuildLong?.durationS).toBeGreaterThan(originalBuildLong?.durationS ?? Infinity);
    const originalTaper = weekWorkouts(formed.plan, formed.workouts, 11).find(
      (workout) => workoutStructure(workout).slot !== "race",
    );
    const courseTaper = withCourse.workouts.find((workout) => workout.id === originalTaper?.id);
    expect(courseTaper?.durationS).toBeLessThan(originalTaper?.durationS ?? 0);

    const preview = previewPlanStartDate({
      planStatus: "draft",
      startDate: "2026-07-20",
      today: "2026-07-13",
      targetDate: "2026-10-04",
    });
    const shifted = await builder.recalculateStartDate?.({
      conversation: conversation(),
      turns: [],
      previous,
      preview,
      course: null,
    });
    expect(shifted?.plan).toMatchObject({
      id: formed.plan.id,
      startDateKey: 20260720,
      targetDateKey: 20261004,
      totalWeeks: 11,
      kind: "short_race_preparation",
      weekStartDay: 1,
    });
    expect(shifted?.workouts.at(-1)).toMatchObject({
      id: formed.workouts.at(-1)?.id,
      dateKey: 20261004,
      name: "Gran Fondo Almaty",
    });
    expect(
      shifted?.workouts.every(
        (workout) => workout.dateKey >= 20260720 && workout.dateKey <= 20261004,
      ),
    ).toBe(true);
  });

  it("preserves the long ride and quality priority with one or two weekly sessions", async () => {
    const oneSession = await createCyclingPlanDraftBuilder({
      intakes: intakes({
        ...INTAKE,
        availabilitySessionsPerWeek: 1,
        availabilityWeekdays: ["sat"],
        currentTrainingSummary: "Riding one time each week",
      }),
      ftp: ftp(),
      identity: identity(),
      todayDateKey: () => 20260713,
    }).form({ conversation: conversation(), turns: [], course: null });
    expect(weekWorkouts(oneSession.plan, oneSession.workouts, 1)).toHaveLength(1);
    expect(
      workoutStructure(weekWorkouts(oneSession.plan, oneSession.workouts, 1)[0]!),
    ).toMatchObject({ workoutType: "long" });

    const twoSessions = await createCyclingPlanDraftBuilder({
      intakes: intakes({
        ...INTAKE,
        availabilitySessionsPerWeek: 2,
        availabilityWeekdays: ["tue", "sat"],
        currentTrainingSummary: "Riding two times each week",
      }),
      ftp: ftp(),
      identity: identity(100),
      todayDateKey: () => 20260713,
    }).form({ conversation: conversation(), turns: [], course: null });
    expect(
      weekWorkouts(twoSessions.plan, twoSessions.workouts, 1).map(
        (workout) => workoutStructure(workout).workoutType,
      ),
    ).toEqual(expect.arrayContaining(["long", "sweet_spot"]));
  });

  it("uses experience and current frequency for conservative progression and recovery cadence", async () => {
    const form = async (input: {
      readonly experience: NonNullable<PlanIntakeRecord["experience"]>;
      readonly sessions: number;
      readonly summary: string;
    }) =>
      createCyclingPlanDraftBuilder({
        intakes: intakes({
          ...INTAKE,
          experience: input.experience,
          availabilitySessionsPerWeek: input.sessions,
          availabilityWeekdays: ["tue", "thu", "sat", "sun"],
          currentTrainingSummary: input.summary,
        }),
        ftp: ftp(),
        identity: identity(input.experience === "beginner" ? 200 : 300),
        todayDateKey: () => 20260713,
      }).form({ conversation: conversation(), turns: [], course: null });

    const beginner = await form({
      experience: "beginner",
      sessions: 3,
      summary: "Riding three times each week",
    });
    const elite = await form({
      experience: "elite",
      sessions: 3,
      summary: "Riding three times each week",
    });
    const seasonWeekIndexes = (build: typeof beginner) =>
      (
        build.snapshot as {
          evidence: { seasonWeeks: Array<{ weekIndex: number; phase: string }> };
        }
      ).evidence.seasonWeeks
        .filter((week) => week.phase === "Recovery")
        .map((week) => week.weekIndex);
    expect(seasonWeekIndexes(beginner)).toEqual([3, 6, 9]);
    expect(seasonWeekIndexes(elite)).toEqual([5, 10]);
    const beginnerLong = weekWorkouts(beginner.plan, beginner.workouts, 1).find(
      (workout) => workoutStructure(workout).workoutType === "long",
    );
    const eliteLong = weekWorkouts(elite.plan, elite.workouts, 1).find(
      (workout) => workoutStructure(workout).workoutType === "long",
    );
    expect(beginnerLong?.durationS).toBeLessThan(eliteLong?.durationS ?? 0);

    const currentlyTwo = await form({
      experience: "intermediate",
      sessions: 4,
      summary: "Riding two times each week",
    });
    const currentlyFour = await form({
      experience: "intermediate",
      sessions: 4,
      summary: "Riding four times each week",
    });
    const firstWeekSeconds = (build: typeof currentlyTwo) =>
      weekWorkouts(build.plan, build.workouts, 1).reduce(
        (sum, workout) => sum + (workout.durationS ?? 0),
        0,
      );
    expect(firstWeekSeconds(currentlyTwo)).toBeLessThan(firstWeekSeconds(currentlyFour));
    const activeRecovery = currentlyFour.workouts.find(
      (workout) => workoutStructure(workout).workoutType === "recovery",
    );
    expect(workoutStructure(activeRecovery!).powerWatts).toEqual({ low: 127, high: 152 });
    const recoveryDoc = intervalsWorkoutInputSchema.parse(
      workoutStructure(activeRecovery!).workoutDoc,
    );
    expect(
      recoveryDoc.steps.every((step) => {
        if (step.type === "set") return false;
        return (step.power?.high ?? step.power?.value ?? 0) <= 54;
      }),
    ).toBe(true);
  });

  it("builds race week from days to a midweek event without a hard day-before session", async () => {
    const build = await createCyclingPlanDraftBuilder({
      intakes: intakes({
        ...INTAKE,
        eventDateKey: 20261001,
        availabilityWeekdays: ["tue", "wed", "sat"],
      }),
      ftp: ftp(),
      identity: identity(400),
      todayDateKey: () => 20260713,
    }).form({ conversation: conversation(), turns: [], course: null });
    const raceWeek = weekWorkouts(build.plan, build.workouts, build.plan.totalWeeks);
    expect(raceWeek).toHaveLength(3);
    expect(raceWeek.find((workout) => workout.dateKey === 20261001)?.name).toBe(
      "Gran Fondo Almaty",
    );
    const opener = raceWeek.find((workout) => workoutStructure(workout).workoutType === "opener");
    expect(opener).toMatchObject({ dateKey: 20260929, durationS: 2_400, name: "Race opener" });
    const dayBefore = raceWeek.find((workout) => workout.dateKey === 20260930);
    expect(dayBefore).toMatchObject({ durationS: 1_800, name: "Pre-race spin" });
    expect(workoutStructure(dayBefore!).workoutType).toBe("recovery");
  });

  it("rejects missing readiness inputs instead of fabricating a Draft", async () => {
    const builder = createCyclingPlanDraftBuilder({
      intakes: intakes({ ...INTAKE, athleteGoal: null }),
      ftp: ftp(),
      identity: identity(),
      todayDateKey: () => 20260713,
    });
    await expect(
      builder.form({ conversation: conversation(), turns: [], course: null }),
    ).rejects.toMatchObject({ code: "incomplete-intake" });
  });
});
