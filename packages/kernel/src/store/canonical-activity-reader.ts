import type { Row, SqlReadStore } from "./ports.js";
import { decodeStream, STREAM_ENCODING } from "../ingest/stream-codec.js";

export type CanonicalSessionId = string;

export interface CanonicalActivityCursor {
  readonly startEpochSeconds: number;
  readonly id: CanonicalSessionId;
}

export interface CanonicalActivitySummary {
  readonly id: CanonicalSessionId;
  readonly workoutId: string;
  readonly sessionSequence: number;
  readonly isMultisport: boolean;
  readonly sport: string;
  readonly subSport: string | null;
  readonly isTransition: boolean;
  readonly startEpochSeconds: number;
  readonly timezoneOffsetSeconds: number | null;
  readonly localDate: string;
  readonly elapsedSeconds: number | null;
  readonly timerSeconds: number | null;
  readonly movingSeconds: number | null;
  readonly distanceMeters: number | null;
}

export interface CanonicalActivityLap {
  readonly lapSequence: number;
  readonly startEpochSeconds: number | null;
  readonly elapsedSeconds: number | null;
  readonly timerSeconds: number | null;
  readonly distanceMeters: number | null;
}

export interface CanonicalActivityDetail extends CanonicalActivitySummary {
  readonly laps: readonly CanonicalActivityLap[];
}

export interface CanonicalActivityPage {
  readonly activities: readonly CanonicalActivitySummary[];
  readonly nextCursor: CanonicalActivityCursor | null;
}

export interface CanonicalActivityStreams {
  readonly activityId: CanonicalSessionId;
  readonly channels: Readonly<Record<string, readonly (number | null)[]>>;
}

export type CanonicalActivityReadErrorCode =
  | "invalid_input"
  | "invalid_row"
  | "stream_limit_exceeded"
  | "stream_decode_failed";

export class CanonicalActivityReadError extends Error {
  readonly code: CanonicalActivityReadErrorCode;

  constructor(code: CanonicalActivityReadErrorCode) {
    super(`canonical activity read rejected: ${code}`);
    this.name = "CanonicalActivityReadError";
    this.code = code;
  }
}

export interface CanonicalActivityReader {
  listActivities(input: {
    readonly start: string;
    readonly end: string;
    readonly limit?: number;
    readonly cursor?: CanonicalActivityCursor;
  }): Promise<CanonicalActivityPage>;
  getActivity(input: { readonly id: string }): Promise<CanonicalActivityDetail | undefined>;
  getStreams(input: {
    readonly id: string;
    readonly channels: readonly string[];
  }): Promise<CanonicalActivityStreams | undefined>;
}

const SESSION_ID = /^[0-9a-f]{64}$/;
const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const MAX_CHANNELS = 16;
const MAX_LAPS = 10_000;
const MAX_STREAM_SAMPLES = 1_000_000;
const MAX_TOTAL_STREAM_SAMPLES = 4_000_000;
const MAX_STREAM_BLOB_BYTES = 16 * 1_024 * 1_024;
const MAX_TOTAL_STREAM_BLOB_BYTES = 64 * 1_024 * 1_024;
const PUBLIC_STREAM_CHANNELS = new Set([
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
]);

function invalidInput(): never {
  throw new CanonicalActivityReadError("invalid_input");
}

function invalidRow(): never {
  throw new CanonicalActivityReadError("invalid_row");
}

function isSessionId(value: unknown): value is CanonicalSessionId {
  return typeof value === "string" && SESSION_ID.test(value);
}

function strictUtf8Length(value: string): number | undefined {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return undefined;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return undefined;
      bytes += 4;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return undefined;
    } else if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function isPublicStreamChannel(value: unknown): value is string {
  return typeof value === "string" && PUBLIC_STREAM_CHANNELS.has(value);
}

function civilDateEpoch(value: unknown): number {
  if (typeof value !== "string" || !CIVIL_DATE.test(value)) invalidInput();
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== value) {
    invalidInput();
  }
  return epoch;
}

function dateKey(value: string): number {
  return Number(value.replaceAll("-", ""));
}

function readString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") invalidRow();
  return value;
}

function readNonemptyString(row: Row, key: string): string {
  const value = readString(row, key);
  if (value.length === 0) invalidRow();
  return value;
}

function readBoundedNonemptyString(row: Row, key: string, maxBytes: number): string {
  const value = readNonemptyString(row, key);
  const bytes = strictUtf8Length(value);
  if (bytes === undefined || bytes > maxBytes) invalidRow();
  return value;
}

function readBoundedNullableString(
  row: Row,
  key: string,
  validKey: string,
  maxBytes: number,
): string | null {
  if (!readFlag(row, validKey)) invalidRow();
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0) invalidRow();
  const bytes = strictUtf8Length(value);
  if (bytes === undefined || bytes > maxBytes) invalidRow();
  return value;
}

function readNumber(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) invalidRow();
  return value;
}

function readInteger(row: Row, key: string): number {
  const value = readNumber(row, key);
  if (!Number.isSafeInteger(value)) invalidRow();
  return value;
}

function readNonnegativeInteger(row: Row, key: string): number {
  const value = readInteger(row, key);
  if (value < 0) invalidRow();
  return value;
}

function readNullableInteger(row: Row, key: string): number | null {
  if (row[key] === null) return null;
  return readInteger(row, key);
}

function readNullableNonnegativeInteger(row: Row, key: string): number | null {
  const value = readNullableInteger(row, key);
  if (value !== null && value < 0) invalidRow();
  return value;
}

function readNullableNonnegativeNumber(row: Row, key: string): number | null {
  if (row[key] === null) return null;
  const value = readNumber(row, key);
  if (value < 0) invalidRow();
  return value;
}

function readFlag(row: Row, key: string): boolean {
  const value = readInteger(row, key);
  if (value !== 0 && value !== 1) invalidRow();
  return value === 1;
}

function readSessionId(row: Row, key: string): CanonicalSessionId {
  const value = row[key];
  if (!isSessionId(value)) invalidRow();
  return value;
}

function localDate(row: Row): string {
  const value = readNonnegativeInteger(row, "local_date_key");
  const compact = String(value).padStart(8, "0");
  if (compact.length !== 8) invalidRow();
  const formatted = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  const epoch = Date.parse(`${formatted}T00:00:00.000Z`);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== formatted) {
    invalidRow();
  }
  return formatted;
}

function activitySummary(row: Row): CanonicalActivitySummary {
  const id = readSessionId(row, "session_key");
  const workoutId = readSessionId(row, "workout_key");
  return {
    id,
    workoutId,
    sessionSequence: readNonnegativeInteger(row, "session_seq"),
    isMultisport: readFlag(row, "is_multisport"),
    sport: readBoundedNonemptyString(row, "sport", 64),
    subSport: readBoundedNullableString(row, "sub_sport", "sub_sport_valid", 128),
    isTransition: readFlag(row, "is_transition"),
    startEpochSeconds: readInteger(row, "start_utc"),
    timezoneOffsetSeconds: readNullableInteger(row, "tz_offset_s"),
    localDate: localDate(row),
    elapsedSeconds: readNullableNonnegativeInteger(row, "elapsed_s"),
    timerSeconds: readNullableNonnegativeInteger(row, "timer_s"),
    movingSeconds: readNullableNonnegativeInteger(row, "moving_s"),
    distanceMeters: readNullableNonnegativeNumber(row, "distance_m"),
  };
}

function activityLap(row: Row): CanonicalActivityLap | null {
  const lapKey = row.joined_lap_key;
  if (lapKey === null) {
    if (
      row.lap_seq !== null ||
      row.lap_start_utc !== null ||
      row.lap_elapsed_s !== null ||
      row.lap_timer_s !== null ||
      row.lap_distance_m !== null
    ) {
      invalidRow();
    }
    return null;
  }
  if (!isSessionId(lapKey)) invalidRow();
  return {
    lapSequence: readNonnegativeInteger(row, "lap_seq"),
    startEpochSeconds: readNullableInteger(row, "lap_start_utc"),
    elapsedSeconds: readNullableNonnegativeInteger(row, "lap_elapsed_s"),
    timerSeconds: readNullableNonnegativeInteger(row, "lap_timer_s"),
    distanceMeters: readNullableNonnegativeNumber(row, "lap_distance_m"),
  };
}

function sameSummary(left: CanonicalActivitySummary, right: CanonicalActivitySummary): boolean {
  return (
    left.id === right.id &&
    left.workoutId === right.workoutId &&
    left.sessionSequence === right.sessionSequence &&
    left.isMultisport === right.isMultisport &&
    left.sport === right.sport &&
    left.subSport === right.subSport &&
    left.isTransition === right.isTransition &&
    left.startEpochSeconds === right.startEpochSeconds &&
    left.timezoneOffsetSeconds === right.timezoneOffsetSeconds &&
    left.localDate === right.localDate &&
    left.elapsedSeconds === right.elapsedSeconds &&
    left.timerSeconds === right.timerSeconds &&
    left.movingSeconds === right.movingSeconds &&
    left.distanceMeters === right.distanceMeters
  );
}

function validateListInput(input: {
  readonly start: string;
  readonly end: string;
  readonly limit?: number;
  readonly cursor?: CanonicalActivityCursor;
}): {
  readonly start: string;
  readonly end: string;
  readonly startKey: number;
  readonly endKey: number;
  readonly limit: number;
  readonly cursor?: CanonicalActivityCursor;
} {
  if (input === null || typeof input !== "object") invalidInput();
  const startEpoch = civilDateEpoch(input.start);
  const endEpoch = civilDateEpoch(input.end);
  if (startEpoch > endEpoch || (endEpoch - startEpoch) / DAY_MS + 1 > 366) invalidInput();
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) invalidInput();
  const cursor = input.cursor;
  if (cursor !== undefined) {
    if (
      cursor === null ||
      typeof cursor !== "object" ||
      !Number.isSafeInteger(cursor.startEpochSeconds) ||
      !isSessionId(cursor.id)
    ) {
      invalidInput();
    }
  }
  return {
    start: input.start,
    end: input.end,
    startKey: dateKey(input.start),
    endKey: dateKey(input.end),
    limit,
    ...(cursor === undefined ? {} : { cursor }),
  };
}

function validateStreamsInput(input: {
  readonly id: string;
  readonly channels: readonly string[];
}): { readonly id: CanonicalSessionId; readonly channels: readonly string[] } {
  if (
    input === null ||
    typeof input !== "object" ||
    !isSessionId(input.id) ||
    !Array.isArray(input.channels) ||
    input.channels.length < 1 ||
    input.channels.length > MAX_CHANNELS
  ) {
    invalidInput();
  }
  const seen = new Set<string>();
  for (const channel of input.channels) {
    if (!isPublicStreamChannel(channel) || seen.has(channel)) invalidInput();
    seen.add(channel);
  }
  return { id: input.id, channels: input.channels };
}

interface PendingStream {
  readonly channel: string;
  readonly n: number;
  readonly data: Uint8Array;
}

const SUMMARY_COLUMNS = `CASE
    WHEN typeof(s.session_key) = 'text'
      AND length(CAST(s.session_key AS BLOB)) <= 64 THEN s.session_key
    ELSE NULL
  END AS session_key,
  CASE
    WHEN typeof(s.workout_key) = 'text'
      AND length(CAST(s.workout_key AS BLOB)) <= 64 THEN s.workout_key
    ELSE NULL
  END AS workout_key,
  s.session_seq, w.is_multisport,
  CASE
    WHEN typeof(s.sport) = 'text'
      AND length(CAST(s.sport AS BLOB)) <= 64 THEN s.sport
    ELSE NULL
  END AS sport,
  CASE
    WHEN typeof(s.sub_sport) = 'text'
      AND length(CAST(s.sub_sport AS BLOB)) <= 128 THEN s.sub_sport
    ELSE NULL
  END AS sub_sport,
  CASE
    WHEN s.sub_sport IS NULL
      OR (
        typeof(s.sub_sport) = 'text'
        AND length(CAST(s.sub_sport AS BLOB)) <= 128
      ) THEN 1
    ELSE 0
  END AS sub_sport_valid,
  s.is_transition, s.start_utc, s.tz_offset_s,
  s.local_date_key, s.elapsed_s, s.timer_s, s.moving_s, s.distance_m`;

function streamPayloadBytes(n: number): number {
  return 16 + Math.ceil(n / 8) + n * 8;
}

export function createCanonicalActivityReader(
  store: Pick<SqlReadStore, "all">,
): CanonicalActivityReader {
  return {
    async listActivities(input) {
      const validated = validateListInput(input);
      const cursorSql =
        validated.cursor === undefined
          ? ""
          : "\n  AND (s.start_utc < ? OR (s.start_utc = ? AND s.session_key < ?))";
      const params =
        validated.cursor === undefined
          ? [validated.startKey, validated.endKey, validated.limit + 1]
          : [
              validated.startKey,
              validated.endKey,
              validated.cursor.startEpochSeconds,
              validated.cursor.startEpochSeconds,
              validated.cursor.id,
              validated.limit + 1,
            ];
      const rows = await store.all(
        `SELECT ${SUMMARY_COLUMNS}
FROM session AS s
JOIN workout AS w ON w.workout_key = s.workout_key
WHERE s.local_date_key BETWEEN ? AND ?${cursorSql}
ORDER BY s.start_utc DESC, s.session_key DESC
LIMIT ?`,
        params,
      );
      if (rows.length > validated.limit + 1) invalidRow();
      const mapped = rows.map(activitySummary);
      let boundary = validated.cursor;
      for (const activity of mapped) {
        if (activity.localDate < validated.start || activity.localDate > validated.end)
          invalidRow();
        if (
          boundary !== undefined &&
          !(
            activity.startEpochSeconds < boundary.startEpochSeconds ||
            (activity.startEpochSeconds === boundary.startEpochSeconds && activity.id < boundary.id)
          )
        ) {
          invalidRow();
        }
        boundary = { startEpochSeconds: activity.startEpochSeconds, id: activity.id };
      }
      const activities = mapped.slice(0, validated.limit);
      const last = activities.at(-1);
      return {
        activities,
        nextCursor:
          mapped.length > validated.limit && last !== undefined
            ? { startEpochSeconds: last.startEpochSeconds, id: last.id }
            : null,
      };
    },
    async getActivity(input) {
      if (input === null || typeof input !== "object" || !isSessionId(input.id)) invalidInput();
      const rows = await store.all(
        `SELECT ${SUMMARY_COLUMNS},
  CASE
    WHEN typeof(l.lap_key) = 'text'
      AND length(CAST(l.lap_key AS BLOB)) <= 64 THEN l.lap_key
    ELSE NULL
  END AS joined_lap_key,
  l.lap_seq,
  l.start_utc AS lap_start_utc, l.elapsed_s AS lap_elapsed_s,
  l.timer_s AS lap_timer_s, l.distance_m AS lap_distance_m
FROM session AS s
JOIN workout AS w ON w.workout_key = s.workout_key
LEFT JOIN lap AS l ON l.session_key = s.session_key
WHERE s.session_key = ?
ORDER BY l.lap_seq ASC, l.lap_key ASC
LIMIT 10001`,
        [input.id],
      );
      if (rows.length === 0) return undefined;
      if (rows.length > MAX_LAPS) invalidRow();
      const summary = activitySummary(rows[0]!);
      if (summary.id !== input.id) invalidRow();
      const laps: CanonicalActivityLap[] = [];
      const lapKeys = new Set<string>();
      let previousLapSequence = -1;
      for (const row of rows) {
        const currentSummary = activitySummary(row);
        if (!sameSummary(summary, currentSummary)) invalidRow();
        const lap = activityLap(row);
        if (lap === null) {
          if (rows.length !== 1) invalidRow();
          continue;
        }
        const lapKey = row.joined_lap_key as string;
        if (lapKeys.has(lapKey)) invalidRow();
        lapKeys.add(lapKey);
        if (lap.lapSequence <= previousLapSequence) invalidRow();
        previousLapSequence = lap.lapSequence;
        laps.push(lap);
      }
      return { ...summary, laps };
    },
    async getStreams(input) {
      const validated = validateStreamsInput(input);
      const placeholders = validated.channels.map(() => "?").join(", ");
      const rows = await store.all(
        `WITH selected AS (
  SELECT
    CASE
      WHEN typeof(s.session_key) = 'text'
        AND length(CAST(s.session_key AS BLOB)) <= 64 THEN s.session_key
      ELSE NULL
    END AS session_key,
    st.channel,
    CASE
      WHEN typeof(st.n) = 'integer'
        AND st.n BETWEEN 1 AND 9007199254740991 THEN st.n
      ELSE NULL
    END AS n,
    CASE
      WHEN st.channel IS NULL
        OR (
          typeof(st.n) = 'integer'
          AND st.n BETWEEN 1 AND 9007199254740991
        ) THEN 1
      ELSE 0
    END AS n_valid,
    CASE
      WHEN st.channel IS NULL
        OR (typeof(st.n) = 'integer' AND st.n BETWEEN 1 AND 1000000) THEN 1
      ELSE 0
    END AS n_within_limit,
    CASE
      WHEN st.channel IS NULL OR typeof(st.data) = 'blob' THEN 1
      ELSE 0
    END AS blob_valid,
    CASE
      WHEN st.channel IS NULL
        OR (typeof(st.data) = 'blob' AND length(st.data) <= 16777216) THEN 1
      ELSE 0
    END AS blob_within_limit,
    CASE
      WHEN st.channel IS NULL OR typeof(st.encoding) = 'text' THEN 1
      ELSE 0
    END AS encoding_valid,
    CASE
      WHEN st.channel IS NULL
        OR (typeof(st.encoding) = 'text' AND st.encoding = ?) THEN 1
      ELSE 0
    END AS encoding_ok,
    CASE
      WHEN typeof(st.data) = 'blob' AND length(st.data) <= 16777216
        THEN length(st.data)
      ELSE NULL
    END AS data_bytes,
    CASE
      WHEN typeof(st.data) = 'blob' AND length(st.data) <= 16777216
        THEN st.data
      ELSE NULL
    END AS bounded_data
  FROM session AS s
  LEFT JOIN stream AS st
    ON st.session_key = s.session_key
    AND st.channel IN (${placeholders})
  WHERE s.session_key = ?
  ORDER BY st.channel ASC
  LIMIT 17
),
bounded AS (
  SELECT
    *,
    count(channel) OVER () AS channel_count,
    sum(
      CASE
        WHEN channel IS NULL THEN 0
        WHEN n_within_limit = 1 THEN n
        ELSE 4000001
      END
    ) OVER () AS total_n,
    sum(
      CASE
        WHEN channel IS NULL THEN 0
        WHEN blob_within_limit = 1 THEN data_bytes
        ELSE 67108865
      END
    ) OVER () AS total_data_bytes
  FROM selected
)
SELECT
  session_key, channel, n, n_valid, n_within_limit,
  blob_valid, blob_within_limit, encoding_valid, encoding_ok,
  data_bytes, channel_count, total_n, total_data_bytes,
  CASE
    WHEN n_within_limit = 1
      AND blob_within_limit = 1
      AND encoding_ok = 1
      AND channel_count <= 16
      AND total_n <= 4000000
      AND total_data_bytes <= 67108864 THEN bounded_data
    ELSE NULL
  END AS data
FROM bounded
ORDER BY channel ASC
LIMIT 17`,
        [STREAM_ENCODING, ...validated.channels, validated.id],
      );
      if (rows.length === 0) return undefined;
      if (rows.length > MAX_CHANNELS) invalidRow();
      const requested = new Set(validated.channels);
      const seen = new Set<string>();
      const pending: PendingStream[] = [];
      let emptyJoin = false;
      const channelCount = readNonnegativeInteger(rows[0]!, "channel_count");
      const totalSamples = readNonnegativeInteger(rows[0]!, "total_n");
      const totalDataBytes = readNonnegativeInteger(rows[0]!, "total_data_bytes");
      if (channelCount > MAX_CHANNELS) invalidRow();
      const aggregateLimitExceeded =
        totalSamples > MAX_TOTAL_STREAM_SAMPLES || totalDataBytes > MAX_TOTAL_STREAM_BLOB_BYTES;
      let rowLimitExceeded = false;
      let unsupportedEncoding = false;
      for (const row of rows) {
        if (readSessionId(row, "session_key") !== validated.id) invalidRow();
        if (
          readNonnegativeInteger(row, "channel_count") !== channelCount ||
          readNonnegativeInteger(row, "total_n") !== totalSamples ||
          readNonnegativeInteger(row, "total_data_bytes") !== totalDataBytes
        ) {
          invalidRow();
        }
        if (row.channel === null) {
          if (
            rows.length !== 1 ||
            channelCount !== 0 ||
            row.n !== null ||
            row.data !== null ||
            row.data_bytes !== null ||
            !readFlag(row, "n_valid") ||
            !readFlag(row, "n_within_limit") ||
            !readFlag(row, "blob_valid") ||
            !readFlag(row, "blob_within_limit") ||
            !readFlag(row, "encoding_valid") ||
            !readFlag(row, "encoding_ok")
          ) {
            invalidRow();
          }
          emptyJoin = true;
          continue;
        }
        const channel = row.channel;
        if (!isPublicStreamChannel(channel) || !requested.has(channel) || seen.has(channel)) {
          invalidRow();
        }
        seen.add(channel);
        if (!readFlag(row, "n_valid")) invalidRow();
        if (!readFlag(row, "blob_valid")) invalidRow();
        if (!readFlag(row, "encoding_valid")) invalidRow();
        const nWithinLimit = readFlag(row, "n_within_limit");
        const blobWithinLimit = readFlag(row, "blob_within_limit");
        const encodingOk = readFlag(row, "encoding_ok");
        const n = readNonnegativeInteger(row, "n");
        if (n < 1) invalidRow();
        if (nWithinLimit !== n <= MAX_STREAM_SAMPLES) invalidRow();
        if (!nWithinLimit || !blobWithinLimit) rowLimitExceeded = true;
        let dataBytes: number | null = null;
        if (blobWithinLimit) {
          dataBytes = readNonnegativeInteger(row, "data_bytes");
          if (dataBytes > MAX_STREAM_BLOB_BYTES) invalidRow();
        } else if (row.data_bytes !== null) {
          invalidRow();
        }
        if (!encodingOk) unsupportedEncoding = true;
        if (!aggregateLimitExceeded && !rowLimitExceeded && encodingOk) {
          if (
            !(row.data instanceof Uint8Array) ||
            dataBytes === null ||
            dataBytes !== row.data.byteLength
          ) {
            invalidRow();
          }
          pending.push({ channel, n, data: row.data });
        } else if (row.data !== null) {
          invalidRow();
        }
      }
      if (channelCount !== seen.size) invalidRow();
      if (emptyJoin) return { activityId: validated.id, channels: {} };
      if (aggregateLimitExceeded || rowLimitExceeded) {
        throw new CanonicalActivityReadError("stream_limit_exceeded");
      }
      if (unsupportedEncoding) {
        throw new CanonicalActivityReadError("stream_decode_failed");
      }
      const decoded: [string, readonly (number | null)[]][] = [];
      for (const stream of pending) {
        try {
          decoded.push([
            stream.channel,
            decodeStream({
              encoding: STREAM_ENCODING,
              n: stream.n,
              kind: stream.channel === "time" ? "time" : "value",
              data: stream.data,
              maxInflatedBytes: streamPayloadBytes(stream.n),
            }),
          ]);
        } catch {
          throw new CanonicalActivityReadError("stream_decode_failed");
        }
      }
      return {
        activityId: validated.id,
        channels: Object.fromEntries(decoded),
      };
    },
  };
}
