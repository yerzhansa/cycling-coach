import { describe, expect, it } from "vitest";
import {
  CanonicalActivityReadError,
  createCanonicalActivityReader,
  type SqlReadStore,
} from "../src/store/index.js";
import { encodeStream, STREAM_ENCODING } from "../src/ingest/stream-codec.js";
import { zlibSync } from "fflate";

const SESSION_A = "a".repeat(64);
const SESSION_B = "b".repeat(64);
const SESSION_C = "c".repeat(64);
const WORKOUT = "d".repeat(64);
const LAP_A = "e".repeat(64);
const LAP_B = "f".repeat(64);
const PUBLIC_CHANNELS = [
  "time",
  "lat",
  "lng",
  "distance",
  "altitude",
  "speed",
  "heart_rate",
  "cadence",
  "fractional_cadence",
  "power",
  "temperature",
  "stance_time",
  "stance_time_balance",
  "vertical_oscillation",
  "vertical_ratio",
  "step_length",
  "left_right_balance",
  "respiration_rate",
] as const;

function summaryRow(sessionKey: string, startUtc: number, sessionSequence: number) {
  return {
    session_key: sessionKey,
    workout_key: WORKOUT,
    session_seq: sessionSequence,
    is_multisport: 1,
    sport: "cycling",
    sub_sport: null,
    sub_sport_valid: 1,
    is_transition: 0,
    start_utc: startUtc,
    tz_offset_s: 21_600,
    local_date_key: 19980704,
    elapsed_s: 3_600,
    timer_s: 3_500,
    moving_s: 3_400,
    distance_m: 40_000.5,
  };
}

function streamRow(
  channel: string,
  n: number,
  data: Uint8Array | null,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  const dataBytes = data?.byteLength ?? null;
  return {
    session_key: SESSION_A,
    channel,
    n,
    n_valid: 1,
    n_within_limit: 1,
    blob_valid: 1,
    blob_within_limit: 1,
    encoding_valid: 1,
    encoding_ok: 1,
    data_bytes: dataBytes,
    channel_count: 1,
    total_n: n,
    total_data_bytes: dataBytes ?? 0,
    data,
    ...overrides,
  };
}

describe("canonical activity reader", () => {
  it("pages the exact descending start/key order without skipping tied starts", async () => {
    const calls: { readonly sql: string; readonly params: readonly unknown[] }[] = [];
    const store: Pick<SqlReadStore, "all"> = {
      async all(sql, params = []) {
        calls.push({ sql, params });
        return calls.length === 1
          ? [
              summaryRow(SESSION_C, 900, 2),
              summaryRow(SESSION_B, 900, 1),
              summaryRow(SESSION_A, 800, 0),
            ]
          : [summaryRow(SESSION_A, 800, 0)];
      },
    };

    const reader = createCanonicalActivityReader(store);
    const page = await reader.listActivities({
      start: "1998-07-01",
      end: "1998-07-31",
      limit: 2,
    });
    const next = await reader.listActivities({
      start: "1998-07-01",
      end: "1998-07-31",
      limit: 2,
      cursor: page.nextCursor!,
    });

    expect(page.activities.map(({ id }) => id)).toEqual([SESSION_C, SESSION_B]);
    expect(Object.keys(page.activities[0]!)).toEqual([
      "id",
      "workoutId",
      "sessionSequence",
      "isMultisport",
      "sport",
      "subSport",
      "isTransition",
      "startEpochSeconds",
      "timezoneOffsetSeconds",
      "localDate",
      "elapsedSeconds",
      "timerSeconds",
      "movingSeconds",
      "distanceMeters",
    ]);
    expect(page.nextCursor).toEqual({ startEpochSeconds: 900, id: SESSION_B });
    expect(next.activities.map(({ id }) => id)).toEqual([SESSION_A]);
    expect(next.nextCursor).toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.sql).toContain("ORDER BY s.start_utc DESC, s.session_key DESC");
    expect(calls[0]!.sql).toContain("length(CAST(s.sport AS BLOB)) <= 64");
    expect(calls[0]!.sql).toContain("length(CAST(s.sub_sport AS BLOB)) <= 128");
    expect(calls[0]!.params).toEqual([19980701, 19980731, 3]);
    expect(calls[1]!.params).toEqual([19980701, 19980731, 900, 900, SESSION_B, 3]);
  });

  it("returns transition details and whitelisted lap fields from one read", async () => {
    let calls = 0;
    const privateColumns = {
      name: "private workout name",
      notes: "private workout notes",
      summary_json: '{"private":true}',
      source: "private source",
      path: "/private/path",
    };
    const store: Pick<SqlReadStore, "all"> = {
      async all() {
        calls += 1;
        const base = {
          ...summaryRow(SESSION_A, 900, 0),
          is_transition: 1,
          ...privateColumns,
        };
        return [
          {
            ...base,
            joined_lap_key: LAP_A,
            lap_seq: 0,
            lap_start_utc: 900,
            lap_elapsed_s: 100,
            lap_timer_s: 90,
            lap_distance_m: 1_000,
          },
          {
            ...base,
            joined_lap_key: LAP_B,
            lap_seq: 1,
            lap_start_utc: null,
            lap_elapsed_s: null,
            lap_timer_s: null,
            lap_distance_m: null,
          },
        ];
      },
    };

    const detail = await createCanonicalActivityReader(store).getActivity({ id: SESSION_A });

    expect(calls).toBe(1);
    expect(detail).toEqual({
      id: SESSION_A,
      workoutId: WORKOUT,
      sessionSequence: 0,
      isMultisport: true,
      sport: "cycling",
      subSport: null,
      isTransition: true,
      startEpochSeconds: 900,
      timezoneOffsetSeconds: 21_600,
      localDate: "1998-07-04",
      elapsedSeconds: 3_600,
      timerSeconds: 3_500,
      movingSeconds: 3_400,
      distanceMeters: 40_000.5,
      laps: [
        {
          lapSequence: 0,
          startEpochSeconds: 900,
          elapsedSeconds: 100,
          timerSeconds: 90,
          distanceMeters: 1_000,
        },
        {
          lapSequence: 1,
          startEpochSeconds: null,
          elapsedSeconds: null,
          timerSeconds: null,
          distanceMeters: null,
        },
      ],
    });
    expect(Object.keys(detail!)).toEqual([
      "id",
      "workoutId",
      "sessionSequence",
      "isMultisport",
      "sport",
      "subSport",
      "isTransition",
      "startEpochSeconds",
      "timezoneOffsetSeconds",
      "localDate",
      "elapsedSeconds",
      "timerSeconds",
      "movingSeconds",
      "distanceMeters",
      "laps",
    ]);
    expect(Object.keys(detail!.laps[0]!)).toEqual([
      "lapSequence",
      "startEpochSeconds",
      "elapsedSeconds",
      "timerSeconds",
      "distanceMeters",
    ]);
    expect(JSON.stringify(detail)).not.toContain("private");
  });

  it("rejects the lap sentinel row and non-strict lap sequences", async () => {
    const base = summaryRow(SESSION_A, 900, 0);
    const lapRow = (lapKey: string, lapSequence: number) => ({
      ...base,
      joined_lap_key: lapKey,
      lap_seq: lapSequence,
      lap_start_utc: null,
      lap_elapsed_s: null,
      lap_timer_s: null,
      lap_distance_m: null,
    });
    const oversizedStore: Pick<SqlReadStore, "all"> = {
      async all(sql) {
        expect(sql).toContain("LIMIT 10001");
        return Array.from({ length: 10_001 }, (_, index) =>
          lapRow(index.toString(16).padStart(64, "0"), index),
        );
      },
    };
    const repeatedSequenceStore: Pick<SqlReadStore, "all"> = {
      async all() {
        return [lapRow(LAP_A, 1), lapRow(LAP_B, 1)];
      },
    };

    await expect(
      createCanonicalActivityReader(oversizedStore).getActivity({ id: SESSION_A }),
    ).rejects.toEqual(expect.objectContaining({ code: "invalid_row" }));
    await expect(
      createCanonicalActivityReader(repeatedSequenceStore).getActivity({ id: SESSION_A }),
    ).rejects.toEqual(expect.objectContaining({ code: "invalid_row" }));
  });

  it("returns only requested stored channels while preserving names and nulls", async () => {
    const power = encodeStream("value", [200, null, 240]);
    const time = encodeStream("time", [0, 1, 2]);
    const calls: { readonly sql: string; readonly params: readonly unknown[] }[] = [];
    const store: Pick<SqlReadStore, "all"> = {
      async all(sql, params = []) {
        calls.push({ sql, params });
        const totalN = power.n + time.n;
        const totalDataBytes = power.data.byteLength + time.data.byteLength;
        return [
          streamRow("power", power.n, power.data, {
            channel_count: 2,
            total_n: totalN,
            total_data_bytes: totalDataBytes,
          }),
          streamRow("time", time.n, time.data, {
            channel_count: 2,
            total_n: totalN,
            total_data_bytes: totalDataBytes,
          }),
        ];
      },
    };

    const streams = await createCanonicalActivityReader(store).getStreams({
      id: SESSION_A,
      channels: ["time", "power", "speed"],
    });

    expect(streams).toEqual({
      activityId: SESSION_A,
      channels: {
        power: [200, null, 240],
        time: [0, 1, 2],
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("LEFT JOIN stream");
    expect(calls[0]!.sql).toContain("total_data_bytes <= 67108864");
    expect(calls[0]!.sql).toContain("LIMIT 17");
    expect(calls[0]!.sql).not.toContain("st.encoding,");
    expect(calls[0]!.params).toEqual([STREAM_ENCODING, "time", "power", "speed", SESSION_A]);
  });

  it("rejects every invalid input before issuing SQL", async () => {
    let calls = 0;
    const store: Pick<SqlReadStore, "all"> = {
      async all() {
        calls += 1;
        return [];
      },
    };
    const reader = createCanonicalActivityReader(store);
    const invalidCalls = [
      () => reader.listActivities({ start: "1998-02-30", end: "1998-03-01" }),
      () => reader.listActivities({ start: "1998-07-02", end: "1998-07-01" }),
      () => reader.listActivities({ start: "1997-01-01", end: "1998-01-02" }),
      () => reader.listActivities({ start: "1998-01-01", end: "1998-01-01", limit: 0 }),
      () => reader.listActivities({ start: "1998-01-01", end: "1998-01-01", limit: 201 }),
      () =>
        reader.listActivities({
          start: "1998-01-01",
          end: "1998-01-01",
          cursor: { startEpochSeconds: 1, id: SESSION_A.toUpperCase() },
        }),
      () => reader.getActivity({ id: `session:${SESSION_A}` }),
      () => reader.getStreams({ id: SESSION_A, channels: [] }),
      () => reader.getStreams({ id: SESSION_A, channels: ["power", "power"] }),
      () => reader.getStreams({ id: SESSION_A, channels: ["unknown"] }),
      () => reader.getStreams({ id: SESSION_A, channels: ["dev:power"] }),
      () => reader.getStreams({ id: SESSION_A, channels: ["\ud800"] }),
      () =>
        reader.getStreams({
          id: SESSION_A,
          channels: [
            "time",
            "lat",
            "lng",
            "distance",
            "altitude",
            "speed",
            "heart_rate",
            "cadence",
            "fractional_cadence",
            "power",
            "temperature",
            "stance_time",
            "stance_time_balance",
            "vertical_oscillation",
            "vertical_ratio",
            "step_length",
            "left_right_balance",
          ],
        }),
    ];

    for (const call of invalidCalls) {
      await expect(call()).rejects.toEqual(
        expect.objectContaining({
          name: "CanonicalActivityReadError",
          code: "invalid_input",
        }),
      );
    }
    expect(calls).toBe(0);
  });

  it("accepts every fixed public stream channel and no arbitrary extension channel", async () => {
    const calls: readonly unknown[][] = [];
    const mutableCalls = calls as unknown[][];
    const store: Pick<SqlReadStore, "all"> = {
      async all(_sql, params = []) {
        mutableCalls.push([...params]);
        return [];
      },
    };
    const reader = createCanonicalActivityReader(store);

    await expect(
      reader.getStreams({ id: SESSION_A, channels: PUBLIC_CHANNELS.slice(0, 16) }),
    ).resolves.toBeUndefined();
    await expect(
      reader.getStreams({ id: SESSION_A, channels: PUBLIC_CHANNELS.slice(16) }),
    ).resolves.toBeUndefined();

    expect(calls).toHaveLength(2);
  });

  it("returns undefined for a stale but valid activity ID", async () => {
    let calls = 0;
    const store: Pick<SqlReadStore, "all"> = {
      async all() {
        calls += 1;
        return [];
      },
    };
    const reader = createCanonicalActivityReader(store);

    await expect(reader.getActivity({ id: SESSION_A })).resolves.toBeUndefined();
    await expect(reader.getStreams({ id: SESSION_A, channels: ["time"] })).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it("distinguishes an existing activity with none of the requested streams", async () => {
    const store: Pick<SqlReadStore, "all"> = {
      async all() {
        return [
          {
            session_key: SESSION_A,
            channel: null,
            n: null,
            data: null,
            data_bytes: null,
            n_valid: 1,
            n_within_limit: 1,
            blob_valid: 1,
            blob_within_limit: 1,
            encoding_valid: 1,
            encoding_ok: 1,
            channel_count: 0,
            total_n: 0,
            total_data_bytes: 0,
          },
        ];
      },
    };

    await expect(
      createCanonicalActivityReader(store).getStreams({
        id: SESSION_A,
        channels: ["speed"],
      }),
    ).resolves.toEqual({ activityId: SESSION_A, channels: {} });
  });

  it("preflights every stream limit before attempting any inflate", async () => {
    const store: Pick<SqlReadStore, "all"> = {
      async all() {
        return [
          streamRow("power", 1, null, {
            channel_count: 2,
            total_n: 4_000_001,
            total_data_bytes: 2,
            data_bytes: 1,
          }),
          streamRow("cadence", 1_000_001, null, {
            n_within_limit: 0,
            channel_count: 2,
            total_n: 4_000_001,
            total_data_bytes: 2,
            data_bytes: 1,
          }),
        ];
      },
    };

    await expect(
      createCanonicalActivityReader(store).getStreams({
        id: SESSION_A,
        channels: ["power", "cadence"],
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "CanonicalActivityReadError",
        code: "stream_limit_exceeded",
      }),
    );
  });

  it("rejects an oversized stream BLOB before requiring its bytes in JavaScript", async () => {
    const store: Pick<SqlReadStore, "all"> = {
      async all() {
        return [
          streamRow("power", 1, null, {
            blob_within_limit: 0,
            data_bytes: null,
            total_data_bytes: 64 * 1_024 * 1_024 + 1,
          }),
        ];
      },
    };

    await expect(
      createCanonicalActivityReader(store).getStreams({
        id: SESSION_A,
        channels: ["power"],
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "CanonicalActivityReadError",
        code: "stream_limit_exceeded",
      }),
    );
  });

  it.each([
    ["sample", { total_n: 4_000_001, total_data_bytes: 1 }],
    ["compressed-byte", { total_n: 1, total_data_bytes: 64 * 1_024 * 1_024 + 1 }],
  ])("rejects an aggregate %s cap before requiring BLOB bytes", async (_label, totals) => {
    const store: Pick<SqlReadStore, "all"> = {
      async all() {
        return [streamRow("power", 1, null, { ...totals, data_bytes: 1 })];
      },
    };

    await expect(
      createCanonicalActivityReader(store).getStreams({
        id: SESSION_A,
        channels: ["power"],
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "stream_limit_exceeded" }));
  });

  it("rejects a compressed expansion beyond the exact declared stream payload", async () => {
    const compressedBomb = zlibSync(new Uint8Array(4_000_000));
    const store: Pick<SqlReadStore, "all"> = {
      async all() {
        return [streamRow("power", 1, compressedBomb)];
      },
    };

    await expect(
      createCanonicalActivityReader(store).getStreams({
        id: SESSION_A,
        channels: ["power"],
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "stream_decode_failed" }));
  });

  it("rejects the seventeenth returned stream row", async () => {
    const store: Pick<SqlReadStore, "all"> = {
      async all(sql) {
        expect(sql).toContain("LIMIT 17");
        return Array.from({ length: 17 }, (_, index) =>
          streamRow("power", 1, new Uint8Array([1]), {
            channel_count: 17,
            total_n: 17,
            total_data_bytes: 17,
            session_key: index === 0 ? SESSION_A : SESSION_B,
          }),
        );
      },
    };

    await expect(
      createCanonicalActivityReader(store).getStreams({
        id: SESSION_A,
        channels: ["power"],
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "invalid_row" }));
  });

  it.each([
    ["unsupported codec", streamRow("power", 1, null, { encoding_ok: 0, data_bytes: 1 })],
    ["corrupt payload", streamRow("power", 1, new Uint8Array([1]))],
  ])("reports %s as a typed decode failure", async (_label, row) => {
    const store: Pick<SqlReadStore, "all"> = {
      async all() {
        return [row];
      },
    };
    await expect(
      createCanonicalActivityReader(store).getStreams({
        id: SESSION_A,
        channels: ["power"],
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "CanonicalActivityReadError",
        code: "stream_decode_failed",
      }),
    );
  });

  it("does not wrap SQL availability failures", async () => {
    const unavailable = new Error("database is unavailable");
    const store: Pick<SqlReadStore, "all"> = {
      async all() {
        throw unavailable;
      },
    };

    await expect(
      createCanonicalActivityReader(store).getActivity({
        id: SESSION_A,
      }),
    ).rejects.toBe(unavailable);
  });

  it.each([
    [
      "uppercase session key",
      [{ ...summaryRow(SESSION_A, 900, 0), session_key: SESSION_A.toUpperCase() }],
    ],
    [
      "invalid workout key",
      [{ ...summaryRow(SESSION_A, 900, 0), workout_key: `workout:${WORKOUT}` }],
    ],
    ["invalid flag", [{ ...summaryRow(SESSION_A, 900, 0), is_multisport: 2 }]],
    ["invalid civil date", [{ ...summaryRow(SESSION_A, 900, 0), local_date_key: 19980230 }]],
    [
      "unsafe integer",
      [{ ...summaryRow(SESSION_A, 900, 0), start_utc: Number.MAX_SAFE_INTEGER + 1 }],
    ],
    [
      "nonfinite real",
      [{ ...summaryRow(SESSION_A, 900, 0), distance_m: Number.POSITIVE_INFINITY }],
    ],
    ["fractional sequence", [{ ...summaryRow(SESSION_A, 900, 0), session_seq: 0.5 }]],
    ["empty sport", [{ ...summaryRow(SESSION_A, 900, 0), sport: "" }]],
    ["oversized projected sport", [{ ...summaryRow(SESSION_A, 900, 0), sport: null }]],
    [
      "oversized projected sub-sport",
      [{ ...summaryRow(SESSION_A, 900, 0), sub_sport: null, sub_sport_valid: 0 }],
    ],
    ["out-of-order rows", [summaryRow(SESSION_A, 800, 0), summaryRow(SESSION_B, 900, 1)]],
    ["duplicate session rows", [summaryRow(SESSION_A, 900, 0), summaryRow(SESSION_A, 900, 0)]],
  ])("fails closed on malformed list rows: %s", async (_label, rows) => {
    const store: Pick<SqlReadStore, "all"> = {
      async all() {
        return rows;
      },
    };
    await expect(
      createCanonicalActivityReader(store).listActivities({
        start: "1998-01-01",
        end: "1998-12-31",
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "CanonicalActivityReadError",
        code: "invalid_row",
      }),
    );
  });

  it.each([
    [
      "non-string encoding",
      [
        streamRow("power", 1, null, {
          encoding_valid: 0,
          encoding_ok: 0,
          data_bytes: 1,
        }),
      ],
    ],
    [
      "zero samples",
      [
        streamRow("power", 0, null, {
          n: null,
          n_valid: 0,
          n_within_limit: 0,
          data_bytes: 1,
          total_n: 4_000_001,
        }),
      ],
    ],
    [
      "non-BLOB data",
      [
        streamRow("power", 1, null, {
          blob_valid: 0,
          blob_within_limit: 0,
          total_data_bytes: 64 * 1_024 * 1_024 + 1,
        }),
      ],
    ],
    [
      "incorrect BLOB length",
      [
        streamRow("power", 1, new Uint8Array([1]), {
          data_bytes: 2,
          total_data_bytes: 2,
        }),
      ],
    ],
    [
      "duplicate channels",
      [
        streamRow("power", 1, new Uint8Array([1]), {
          channel_count: 2,
          total_n: 2,
          total_data_bytes: 2,
        }),
        streamRow("power", 1, new Uint8Array([1]), {
          channel_count: 2,
          total_n: 2,
          total_data_bytes: 2,
        }),
      ],
    ],
  ])("fails closed on malformed stream rows: %s", async (_label, rows) => {
    const store: Pick<SqlReadStore, "all"> = {
      async all() {
        return rows;
      },
    };
    await expect(
      createCanonicalActivityReader(store).getStreams({
        id: SESSION_A,
        channels: ["power"],
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "CanonicalActivityReadError",
        code: "invalid_row",
      }),
    );
  });

  it("exposes a fixed typed error-code vocabulary", () => {
    expect(new CanonicalActivityReadError("invalid_row")).toEqual(
      expect.objectContaining({
        name: "CanonicalActivityReadError",
        code: "invalid_row",
      }),
    );
  });
});
