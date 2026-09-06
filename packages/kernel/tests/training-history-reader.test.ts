import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/archive/canonical.js";
import {
  TrainingHistoryReadError,
  createTrainingHistoryReader,
  type RecordedFact,
  type Row,
  type SqlReadStore,
  type SqlValue,
} from "../src/store/index.js";

const SESSION_A = "a".repeat(64);
const SESSION_B = "b".repeat(64);
const SESSION_C = "c".repeat(64);
const SESSION_D = "d".repeat(64);
const SESSION_E = "e".repeat(64);
const SESSION_F = "f".repeat(64);
const SESSION_G = "1".repeat(64);
const SESSION_H = "2".repeat(64);

interface PayloadRowFixture extends Row {
  readonly session_key: string;
  readonly revision_id: string;
  readonly source_count: number;
  readonly payload_text_valid: number;
  readonly payload_oversized: number;
  readonly payload_bytes: number | null;
  readonly payload_json: string | null;
}

function activityPayload(activity: Readonly<Record<string, unknown>>): string {
  return canonicalJson({ activity, concerns: {}, dedup: {}, schema_version: 1 });
}

function payloadRow(sessionKey: string, payloadJson: string): PayloadRowFixture {
  return {
    session_key: sessionKey,
    revision_id: sessionKey,
    source_count: 1,
    payload_text_valid: 1,
    payload_oversized: 0,
    payload_bytes: new TextEncoder().encode(payloadJson).byteLength,
    payload_json: payloadJson,
  };
}

function coreRow(
  sessionKey: string,
  startUtc: number,
  input: {
    readonly overlay?: string | null;
    readonly workoutName?: string | null;
  } = {},
) {
  return {
    session_key: sessionKey,
    sub_sport: "road",
    sub_sport_valid: 1,
    start_utc: startUtc,
    tz_offset_s: 21_600,
    local_date_key: 19980706,
    elapsed_s: 3_700,
    moving_s: 3_600,
    distance_m: 30_000,
    workout_name: input.workoutName ?? null,
    overlay_value_json: input.overlay ?? null,
  };
}

class WindowStore implements Pick<SqlReadStore, "all"> {
  readonly calls: Array<{ readonly sql: string; readonly params: readonly unknown[] }> = [];
  readonly corePages: Array<readonly ReturnType<typeof coreRow>[]>;
  readonly payloadRows: ReadonlyMap<string, PayloadRowFixture>;
  readonly latestDateKey: number | null;

  constructor(input: {
    readonly corePages: Array<readonly ReturnType<typeof coreRow>[]>;
    readonly payloadRows?: readonly PayloadRowFixture[];
    readonly latestDateKey?: number | null;
  }) {
    this.corePages = [...input.corePages];
    this.payloadRows = new Map(
      (input.payloadRows ?? []).map((row) => [String(row.session_key), row]),
    );
    this.latestDateKey = input.latestDateKey ?? null;
  }

  async all(sql: string, params: readonly SqlValue[] = []): Promise<Row[]> {
    this.calls.push({ sql, params });
    if (sql.includes("max(s.local_date_key)")) {
      return [{ local_date_key: this.latestDateKey }];
    }
    if (sql.includes("FROM session AS s") && !sql.includes("source_record_revision")) {
      return [...(this.corePages.shift() ?? [])];
    }
    if (sql.includes("source_record_revision")) {
      return params.flatMap((value) => {
        const row = this.payloadRows.get(String(value));
        return row === undefined ? [] : [row];
      });
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }
}

function rejected(reason: Extract<RecordedFact<number>, { kind: "rejected" }>["reason"]) {
  return { kind: "rejected", reason };
}

describe("training history reader", () => {
  it("discovers the latest ride date without reading activity payloads", async () => {
    const store = new WindowStore({ corePages: [], latestDateKey: 19980706 });

    await expect(
      createTrainingHistoryReader(store).readLatestRideDate({ through: "1998-07-12" }),
    ).resolves.toBe("1998-07-06");
    expect(store.calls).toEqual([
      {
        sql: expect.stringContaining("max(s.local_date_key)"),
        params: [19980712],
      },
    ]);
  });

  it("returns null when sparse discovery finds no rides", async () => {
    const store = new WindowStore({ corePages: [] });

    await expect(
      createTrainingHistoryReader(store).readLatestRideDate({ through: "1998-07-12" }),
    ).resolves.toBeNull();
  });

  it("reuses parsed payload facts until the source revision changes", async () => {
    let payload = activityPayload({
      id: 12345,
      name: "Cached source title",
      start_date_local: "1998-07-06T08:00:00",
      type: "Ride",
      moving_time: 3_600,
      elapsed_time: 3_700,
      icu_training_load: 75,
    });
    const fixture = payloadRow(SESSION_A, payload);
    let revisionId = SESSION_A;
    let payloadReads = 0;
    Object.defineProperty(fixture, "revision_id", {
      enumerable: true,
      get() {
        return revisionId;
      },
    });
    Object.defineProperty(fixture, "payload_json", {
      enumerable: true,
      get() {
        payloadReads += 1;
        return payload;
      },
    });
    const store = new WindowStore({
      corePages: [
        [coreRow(SESSION_A, 900)],
        [coreRow(SESSION_A, 900)],
        [coreRow(SESSION_A, 900)],
      ],
      payloadRows: [fixture],
    });
    const reader = createTrainingHistoryReader(store);

    await reader.readWindow({ start: "1998-07-06", end: "1998-07-12" });
    const readsAfterFirstProjection = payloadReads;
    await reader.readWindow({ start: "1998-07-06", end: "1998-07-12" });

    expect(readsAfterFirstProjection).toBeGreaterThan(0);
    expect(payloadReads).toBe(readsAfterFirstProjection);

    revisionId = SESSION_B;
    payload = payload.replace("75", "80");
    const revised = await reader.readWindow({ start: "1998-07-06", end: "1998-07-12" });

    expect(payloadReads).toBeGreaterThan(readsAfterFirstProjection);
    expect(revised.rows[0]?.load).toEqual({ kind: "recorded", value: 80 });
  });

  it("resolves title precedence and preserves localized RecordedFact outcomes", async () => {
    const valid = {
      id: 12345,
      name: "Source title",
      start_date_local: "1998-07-06T08:00:00",
      type: "Ride",
      moving_time: 3_600,
      elapsed_time: 3_700,
      icu_training_load: 75,
      average_watts: 205,
      average_heartrate: 142,
      icu_rpe: 7,
      rpe: 6,
      kj: 900,
    };
    const invalidValue = activityPayload({
      ...valid,
      name: null,
      icu_training_load: -1,
      average_heartrate: null,
      icu_rpe: null,
      rpe: null,
      kj: undefined,
    });
    const payloads = [
      payloadRow(SESSION_A, activityPayload(valid)),
      payloadRow(SESSION_B, activityPayload({ ...valid, name: "Ignored source title" })),
      payloadRow(SESSION_C, activityPayload({ ...valid, name: "Typed source title" })),
      {
        session_key: SESSION_D,
        revision_id: SESSION_D,
        source_count: 2,
        payload_text_valid: 0,
        payload_oversized: 0,
        payload_bytes: null,
        payload_json: null,
      },
      {
        session_key: SESSION_E,
        revision_id: SESSION_E,
        source_count: 1,
        payload_text_valid: 1,
        payload_oversized: 1,
        payload_bytes: null,
        payload_json: null,
      },
      payloadRow(SESSION_F, "not-json"),
      payloadRow(SESSION_G, invalidValue),
    ];
    const store = new WindowStore({
      corePages: [
        [
          coreRow(SESSION_A, 900, {
            overlay: canonicalJson("Athlete title"),
            workoutName: "Workout title",
          }),
          coreRow(SESSION_B, 900, { workoutName: "Workout title" }),
          coreRow(SESSION_C, 800),
          coreRow(SESSION_D, 700),
          coreRow(SESSION_E, 600),
          coreRow(SESSION_F, 500),
          coreRow(SESSION_G, 400),
          coreRow(SESSION_H, 300),
        ],
      ],
      payloadRows: payloads,
    });

    const result = await createTrainingHistoryReader(store).readWindow({
      start: "1998-07-06",
      end: "1998-07-12",
    });

    expect(result.rows.map(({ id }) => id)).toEqual([
      SESSION_A,
      SESSION_B,
      SESSION_C,
      SESSION_D,
      SESSION_E,
      SESSION_F,
      SESSION_G,
      SESSION_H,
    ]);
    expect(result.rows.slice(0, 3).map(({ title }) => title)).toEqual([
      "Athlete title",
      "Workout title",
      "Typed source title",
    ]);
    expect(result.rows[0]!.load).toEqual({ kind: "recorded", value: 75 });
    expect(result.rows[0]!.perceivedExertion).toEqual({ kind: "recorded", value: 7 });
    expect(result.rows[1]!.load).toEqual({ kind: "recorded", value: 75 });
    expect(result.rows[3]!.load).toEqual(rejected("ambiguous-source"));
    expect(result.rows[4]!.load).toEqual(rejected("oversized-payload"));
    expect(result.rows[5]!.load).toEqual(rejected("invalid-envelope"));
    expect(result.rows[6]!.load).toEqual(rejected("invalid-value"));
    expect(result.rows[6]!.averagePowerWatts).toEqual({ kind: "recorded", value: 205 });
    expect(result.rows[6]!.averageHeartRateBpm).toEqual({ kind: "absent" });
    expect(result.rows[6]!.perceivedExertion).toEqual({ kind: "absent" });
    expect(result.rows[6]!.energyKilojoules).toEqual({ kind: "absent" });
    expect(result.rows[7]!.load).toEqual({ kind: "absent" });
    expect(result.rows[0]!.subSport).toBe("road");
    expect(result.scanTruncated).toBe(false);
    expect(store.calls[0]!.sql).toContain("ORDER BY s.start_utc DESC, s.session_key ASC");
    expect(store.calls[0]!.params.at(-1)).toBe(201);
    expect(store.calls[1]!.sql).toContain("length(CAST(r.payload_json AS BLOB)) <= 65536");
    expect(store.calls[1]!.params).toHaveLength(8);
    expect(JSON.stringify(result)).not.toContain("payload_json");
    expect(JSON.stringify(result)).not.toContain("providerActivityId");
  });

  it("returns exactly 1000 safely scanned rows and reports a 1001st match", async () => {
    const allRows = Array.from({ length: 1_001 }, (_, index) =>
      coreRow(index.toString(16).padStart(64, "0"), 20_000 - index),
    );
    const store = new WindowStore({
      corePages: [
        allRows.slice(0, 201),
        allRows.slice(200, 401),
        allRows.slice(400, 601),
        allRows.slice(600, 801),
        allRows.slice(800, 1_001),
      ],
    });

    const result = await createTrainingHistoryReader(store).readWindow({
      start: "1998-07-06",
      end: "1998-07-12",
    });

    expect(result.rows).toHaveLength(1_000);
    expect(result.scanTruncated).toBe(true);
    expect(result.rows[0]!.startEpochSeconds).toBe(20_000);
    expect(result.rows.at(-1)!.startEpochSeconds).toBe(19_001);
  });

  it("parses exactly 16 MiB and rejects every later payload fact", async () => {
    const baseActivity = {
      id: 12345,
      name: "Budget title",
      start_date_local: "1998-07-06T08:00:00",
      type: "Ride",
      moving_time: 3_600,
      elapsed_time: 3_700,
      icu_training_load: 75,
      padding: "",
    };
    const emptyPayload = activityPayload(baseActivity);
    const payload = activityPayload({
      ...baseActivity,
      padding: "x".repeat(65_536 - new TextEncoder().encode(emptyPayload).byteLength),
    });
    expect(new TextEncoder().encode(payload).byteLength).toBe(65_536);
    const rows = Array.from({ length: 258 }, (_, index) =>
      coreRow(index.toString(16).padStart(64, "0"), 20_000 - index),
    );
    const store = new WindowStore({
      corePages: [rows.slice(0, 201), rows.slice(200)],
      payloadRows: rows.map((row) => payloadRow(String(row.session_key), payload)),
    });

    const result = await createTrainingHistoryReader(store).readWindow({
      start: "1998-07-06",
      end: "1998-07-12",
    });

    expect(result.rows[255]!.load).toEqual({ kind: "recorded", value: 75 });
    expect(result.rows[256]!.load).toEqual(rejected("payload-budget-exhausted"));
    expect(result.rows[257]!.load).toEqual(rejected("payload-budget-exhausted"));
    const payloadCalls = store.calls.filter(({ sql }) => sql.includes("source_record_revision"));
    expect(payloadCalls).toHaveLength(3);
    expect(payloadCalls.every(({ params }) => params.length <= 100)).toBe(true);
  });

  it("rejects invalid windows with a typed closed-code error", async () => {
    const store = new WindowStore({ corePages: [] });
    await expect(
      createTrainingHistoryReader(store).readWindow({
        start: "1998-07-12",
        end: "1998-07-06",
      }),
    ).rejects.toEqual(new TrainingHistoryReadError("invalid_input"));
    expect(store.calls).toEqual([]);
  });
});
