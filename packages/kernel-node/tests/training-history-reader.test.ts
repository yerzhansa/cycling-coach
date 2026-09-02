import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson } from "@enduragent/kernel/archive";
import {
  createTrainingHistoryReader,
  runMigrations,
  type MigratorStore,
  type SqlStore,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/index.js";

const SESSION = "a".repeat(64);
const WORKOUT = "b".repeat(64);
const ARTIFACT = "c".repeat(64);
const ARCHIVE = "d".repeat(64);
const SOURCE_RECORD = "e".repeat(64);

describe("training history reader with real SQLite", () => {
  let store: SqlStore & MigratorStore;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    await store.run(
      "INSERT INTO workout(workout_key,start_utc,tz_offset_s,name,notes,is_multisport,dedup_cluster_id) VALUES(?,?,?,?,?,?,?)",
      [WORKOUT, 899_712_000, 21_600, "Workout title", null, 0, "cluster-12345"],
    );
    await store.run(
      "INSERT INTO session(session_key,workout_key,session_seq,sport,sub_sport,start_utc,tz_offset_s,local_date_key,elapsed_s,timer_s,moving_s,distance_m,is_transition,summary_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        SESSION,
        WORKOUT,
        0,
        "cycling",
        "road",
        899_712_000,
        21_600,
        19980706,
        3_700,
        3_650,
        3_600,
        30_000,
        0,
        null,
      ],
    );
    await store.run(
      "INSERT INTO source_artifact(artifact_key,source,lane,external_id,artifact_kind,archive_address,archive_rel_path,archive_epoch_s) VALUES(?,?,?,?,?,?,?,?)",
      [
        ARTIFACT,
        "intervals-icu",
        "activities",
        "12345",
        "snapshot",
        ARCHIVE,
        `1998/07/${ARCHIVE}.json.gz`,
        899_712_000,
      ],
    );
    await store.run(
      "INSERT INTO source_record(id,workout_key,session_key,source,external_id,raw_sha256,quality_rank,payload_json,artifact_key) VALUES(?,?,?,?,?,?,?,?,?)",
      [
        SOURCE_RECORD,
        WORKOUT,
        SESSION,
        "intervals-icu",
        "12345",
        ARCHIVE,
        300,
        canonicalJson({
          activity: {
            average_heartrate: 142,
            average_watts: 205,
            elapsed_time: 3_700,
            icu_rpe: 7,
            icu_training_load: 75,
            id: 12345,
            kj: 900,
            moving_time: 3_600,
            name: "Typed source title",
            rpe: 6,
            start_date_local: "1998-07-06T08:00:00",
            type: "Ride",
          },
          concerns: {},
          dedup: {},
          schema_version: 1,
        }),
        ARTIFACT,
      ],
    );
    await store.run(
      "INSERT INTO field_merge_override_overlay(id,target_table,target_key,field_name,override_value_json,device_id,hlc_physical_ms,hlc_counter) VALUES(?,?,?,?,?,?,?,?)",
      [
        "overlay-12345",
        "workout",
        WORKOUT,
        "name",
        canonicalJson("Athlete title"),
        "device-12345",
        899_712_000_000,
        0,
      ],
    );
  });

  afterEach(async () => {
    await store.close();
  });

  it("discovers the latest ride date through a bounded SQLite query", async () => {
    const reader = createTrainingHistoryReader(store);

    await expect(reader.readLatestRideDate({ through: "1998-07-05" })).resolves.toBeNull();
    await expect(reader.readLatestRideDate({ through: "1998-07-06" })).resolves.toBe(
      "1998-07-06",
    );
  });

  it("reads canonical, authored, and trusted payload facts through one call", async () => {
    const result = await createTrainingHistoryReader(store).readWindow({
      start: "1998-07-06",
      end: "1998-07-06",
    });

    expect(result).toEqual({
      rows: [
        {
          id: SESSION,
          localDate: "1998-07-06",
          startEpochSeconds: 899_712_000,
          timezoneOffsetSeconds: 21_600,
          subSport: "road",
          movingSeconds: 3_600,
          elapsedSeconds: 3_700,
          distanceMeters: 30_000,
          title: "Athlete title",
          load: { kind: "recorded", value: 75 },
          averagePowerWatts: { kind: "recorded", value: 205 },
          averageHeartRateBpm: { kind: "recorded", value: 142 },
          perceivedExertion: { kind: "recorded", value: 7 },
          energyKilojoules: { kind: "recorded", value: 900 },
        },
      ],
      scanTruncated: false,
    });
    expect(Object.keys(result.rows[0]!)).not.toContain("payloadJson");
    expect(Object.keys(result.rows[0]!)).not.toContain("providerActivityId");
  });

  it("excludes non-cycling, transition, and out-of-window sessions and caps oversized titles", async () => {
    const runWorkout = "1".repeat(64);
    const transitionWorkout = "2".repeat(64);
    const lateWorkout = "3".repeat(64);
    const longTitleWorkout = "4".repeat(64);
    const runSession = "5".repeat(64);
    const transitionSession = "6".repeat(64);
    const lateSession = "7".repeat(64);
    const longTitleSession = "8".repeat(64);
    const insertWorkout = async (key: string, name: string): Promise<void> => {
      await store.run(
        "INSERT INTO workout(workout_key,start_utc,tz_offset_s,name,notes,is_multisport,dedup_cluster_id) VALUES(?,?,?,?,?,?,?)",
        [key, 899_712_000, 21_600, name, null, 0, `cluster-${key.slice(0, 8)}`],
      );
    };
    const insertSession = async (input: {
      readonly session: string;
      readonly workout: string;
      readonly sport: string;
      readonly localDateKey: number;
      readonly isTransition: number;
      readonly startUtc: number;
    }): Promise<void> => {
      await store.run(
        "INSERT INTO session(session_key,workout_key,session_seq,sport,sub_sport,start_utc,tz_offset_s,local_date_key,elapsed_s,timer_s,moving_s,distance_m,is_transition,summary_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          input.session,
          input.workout,
          0,
          input.sport,
          null,
          input.startUtc,
          21_600,
          input.localDateKey,
          1_800,
          1_800,
          1_800,
          10_000,
          input.isTransition,
          null,
        ],
      );
    };
    await insertWorkout(runWorkout, "Morning run");
    await insertSession({
      session: runSession,
      workout: runWorkout,
      sport: "running",
      localDateKey: 19980706,
      isTransition: 0,
      startUtc: 899_713_000,
    });
    await insertWorkout(transitionWorkout, "T1");
    await insertSession({
      session: transitionSession,
      workout: transitionWorkout,
      sport: "cycling",
      localDateKey: 19980706,
      isTransition: 1,
      startUtc: 899_714_000,
    });
    await insertWorkout(lateWorkout, "Next week ride");
    await insertSession({
      session: lateSession,
      workout: lateWorkout,
      sport: "cycling",
      localDateKey: 19980713,
      isTransition: 0,
      startUtc: 900_316_800,
    });
    await insertWorkout(longTitleWorkout, "x".repeat(513));
    await insertSession({
      session: longTitleSession,
      workout: longTitleWorkout,
      sport: "cycling",
      localDateKey: 19980707,
      isTransition: 0,
      startUtc: 899_798_400,
    });

    const result = await createTrainingHistoryReader(store).readWindow({
      start: "1998-07-06",
      end: "1998-07-12",
    });

    expect(result.rows.map(({ id }) => id)).toEqual([longTitleSession, SESSION]);
    expect(result.rows[0]!.title).toBeNull();
    expect(result.scanTruncated).toBe(false);
  });
});
