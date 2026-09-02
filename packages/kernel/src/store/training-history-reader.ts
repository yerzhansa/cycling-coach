import { z } from "zod";
import { parseActivityLandingEnvelope } from "../ingest/source-ledger.js";
import { ActivitySchema } from "../reference/schemas/inputs.js";
import type { Row, SqlReadStore } from "./ports.js";

export type RecordedFactRejectionReason =
  | "invalid-value"
  | "invalid-envelope"
  | "oversized-payload"
  | "ambiguous-source"
  | "payload-budget-exhausted";

export type RecordedFact<T> =
  | { readonly kind: "recorded"; readonly value: T }
  | { readonly kind: "absent" }
  | { readonly kind: "rejected"; readonly reason: RecordedFactRejectionReason };

export interface TrainingHistoryFactRow {
  readonly id: string;
  readonly localDate: string;
  readonly startEpochSeconds: number;
  readonly timezoneOffsetSeconds: number | null;
  readonly subSport: string | null;
  readonly movingSeconds: number | null;
  readonly elapsedSeconds: number | null;
  readonly distanceMeters: number | null;
  readonly title: string | null;
  readonly load: RecordedFact<number>;
  readonly averagePowerWatts: RecordedFact<number>;
  readonly averageHeartRateBpm: RecordedFact<number>;
  readonly perceivedExertion: RecordedFact<number>;
  readonly energyKilojoules: RecordedFact<number>;
}

export type TrainingHistoryRideFact = TrainingHistoryFactRow;

export interface TrainingHistoryWindowFacts {
  readonly rows: readonly TrainingHistoryFactRow[];
  readonly scanTruncated: boolean;
}

export type TrainingHistoryReadErrorCode = "invalid_input" | "invalid_row";

export class TrainingHistoryReadError extends Error {
  readonly code: TrainingHistoryReadErrorCode;

  constructor(code: TrainingHistoryReadErrorCode) {
    super(`training history read rejected: ${code}`);
    this.name = "TrainingHistoryReadError";
    this.code = code;
  }
}

export interface TrainingHistoryReader {
  readWindow(input: {
    readonly start: string;
    readonly end: string;
  }): Promise<TrainingHistoryWindowFacts>;
}

interface CoreFactRow {
  readonly id: string;
  readonly localDate: string;
  readonly startEpochSeconds: number;
  readonly timezoneOffsetSeconds: number | null;
  readonly subSport: string | null;
  readonly movingSeconds: number | null;
  readonly elapsedSeconds: number | null;
  readonly distanceMeters: number | null;
  readonly overlayTitle: string | null;
  readonly workoutTitle: string | null;
}

interface PendingFactRow extends CoreFactRow {
  sourceTitle: string | null;
  load: RecordedFact<number>;
  averagePowerWatts: RecordedFact<number>;
  averageHeartRateBpm: RecordedFact<number>;
  perceivedExertion: RecordedFact<number>;
  energyKilojoules: RecordedFact<number>;
}

interface ParsedPayloadFacts {
  readonly kind: "parsed";
  readonly sourceTitle: string | null;
  readonly load: RecordedFact<number>;
  readonly averagePowerWatts: RecordedFact<number>;
  readonly averageHeartRateBpm: RecordedFact<number>;
  readonly perceivedExertion: RecordedFact<number>;
  readonly energyKilojoules: RecordedFact<number>;
}

interface InvalidPayloadEnvelope {
  readonly kind: "invalid-envelope";
}

interface ParseBudget {
  bytes: number;
  exhausted: boolean;
}

interface SafeParseSchema {
  safeParse(
    value: unknown,
  ): { readonly success: true; readonly data: unknown } | { readonly success: false };
}

const SESSION_ID = /^[0-9a-f]{64}$/;
const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CORE_PAGE_SIZE = 200;
const PAYLOAD_PAGE_SIZE = 100;
const SESSION_LIMIT = 1_000;
const PAYLOAD_ROW_BYTES = 65_536;
const PAYLOAD_PROJECTION_BYTES = 16 * 1_024 * 1_024;

const PICKED_ACTIVITY_SCHEMA = z
  .object({
    name: ActivitySchema.shape.name,
    icu_training_load: ActivitySchema.shape.icu_training_load,
    average_watts: ActivitySchema.shape.average_watts,
    average_heartrate: ActivitySchema.shape.average_heartrate,
    icu_rpe: ActivitySchema.shape.icu_rpe,
    rpe: ActivitySchema.shape.rpe,
    kj: ActivitySchema.shape.kj,
  })
  .strict();

function invalidInput(): never {
  throw new TrainingHistoryReadError("invalid_input");
}

function invalidRow(): never {
  throw new TrainingHistoryReadError("invalid_row");
}

function absentFact(): RecordedFact<number> {
  return Object.freeze({ kind: "absent" });
}

function rejectedFact(reason: RecordedFactRejectionReason): RecordedFact<number> {
  return Object.freeze({ kind: "rejected", reason });
}

function recordedFact(value: number): RecordedFact<number> {
  return Object.freeze({ kind: "recorded", value });
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

function readInteger(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) invalidRow();
  return value;
}

function readNonnegativeInteger(row: Row, key: string): number {
  const value = readInteger(row, key);
  if (value < 0) invalidRow();
  return value;
}

function readNullableNonnegativeInteger(row: Row, key: string): number | null {
  if (row[key] === null) return null;
  return readNonnegativeInteger(row, key);
}

function readNullableDistance(row: Row, key: string): number | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100_000_000) {
    invalidRow();
  }
  return value;
}

function readFlag(row: Row, key: string): boolean {
  const value = readInteger(row, key);
  if (value !== 0 && value !== 1) invalidRow();
  return value === 1;
}

function readSessionId(row: Row): string {
  const value = row.session_key;
  if (typeof value !== "string" || !SESSION_ID.test(value)) invalidRow();
  return value;
}

function readLocalDate(row: Row): string {
  const value = readNonnegativeInteger(row, "local_date_key");
  const compact = String(value).padStart(8, "0");
  if (compact.length !== 8) invalidRow();
  const candidate = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  const epoch = Date.parse(`${candidate}T00:00:00.000Z`);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== candidate) {
    invalidRow();
  }
  return candidate;
}

function readBoundedNullableString(
  row: Row,
  key: string,
  maxBytes: number,
  allowEmpty: boolean,
): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) invalidRow();
  const bytes = strictUtf8Length(value);
  if (bytes === undefined || bytes > maxBytes) invalidRow();
  return value;
}

function overlayTitle(value: string | null): string | null {
  if (value === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== "string") return null;
  const bytes = strictUtf8Length(parsed);
  return bytes !== undefined && bytes <= 512 ? parsed : null;
}

function coreFact(row: Row): CoreFactRow {
  if (!readFlag(row, "sub_sport_valid")) invalidRow();
  const startEpochSeconds = readNonnegativeInteger(row, "start_utc");
  const timezoneOffsetSeconds = row.tz_offset_s === null ? null : readInteger(row, "tz_offset_s");
  if (
    timezoneOffsetSeconds !== null &&
    (timezoneOffsetSeconds < -86_400 || timezoneOffsetSeconds > 86_400)
  ) {
    invalidRow();
  }
  const overlayValue = readBoundedNullableString(row, "overlay_value_json", 4_096, true);
  return {
    id: readSessionId(row),
    localDate: readLocalDate(row),
    startEpochSeconds,
    timezoneOffsetSeconds,
    subSport: readBoundedNullableString(row, "sub_sport", 128, false),
    movingSeconds: readNullableNonnegativeInteger(row, "moving_s"),
    elapsedSeconds: readNullableNonnegativeInteger(row, "elapsed_s"),
    distanceMeters: readNullableDistance(row, "distance_m"),
    overlayTitle: overlayTitle(overlayValue),
    workoutTitle: readBoundedNullableString(row, "workout_name", 512, true),
  };
}

function numericFact(
  value: unknown,
  schema: SafeParseSchema,
  valid: (candidate: number) => boolean,
): RecordedFact<number> {
  if (value === null || value === undefined) return absentFact();
  const parsed = schema.safeParse(value);
  if (
    !parsed.success ||
    typeof parsed.data !== "number" ||
    !Number.isFinite(parsed.data) ||
    !valid(parsed.data)
  ) {
    return rejectedFact("invalid-value");
  }
  return recordedFact(parsed.data);
}

function sourceTitle(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const parsed = ActivitySchema.shape.name.safeParse(value);
  if (!parsed.success || typeof parsed.data !== "string") return null;
  const bytes = strictUtf8Length(parsed.data);
  return bytes !== undefined && bytes <= 512 ? parsed.data : null;
}

function parsePayloadFacts(payloadJson: string): ParsedPayloadFacts | InvalidPayloadEnvelope {
  let activity: Readonly<Record<string, unknown>>;
  try {
    activity = parseActivityLandingEnvelope(payloadJson).activity;
  } catch {
    return { kind: "invalid-envelope" };
  }
  const pickedInput = {
    name: activity.name,
    icu_training_load: activity.icu_training_load,
    average_watts: activity.average_watts,
    average_heartrate: activity.average_heartrate,
    icu_rpe: activity.icu_rpe,
    rpe: activity.rpe,
    kj: activity.kj,
  };
  const picked = PICKED_ACTIVITY_SCHEMA.safeParse(pickedInput);
  const fields = picked.success ? picked.data : pickedInput;
  const preferredRpe =
    fields.icu_rpe === null || fields.icu_rpe === undefined ? fields.rpe : fields.icu_rpe;
  return {
    kind: "parsed",
    sourceTitle: sourceTitle(fields.name),
    load: numericFact(
      fields.icu_training_load,
      ActivitySchema.shape.icu_training_load,
      (value) => value >= 0 && value <= Number.MAX_SAFE_INTEGER,
    ),
    averagePowerWatts: numericFact(
      fields.average_watts,
      ActivitySchema.shape.average_watts,
      (value) => value >= 0 && value <= 20_000,
    ),
    averageHeartRateBpm: numericFact(
      fields.average_heartrate,
      ActivitySchema.shape.average_heartrate,
      (value) => value > 0 && value <= 500,
    ),
    perceivedExertion: numericFact(
      preferredRpe,
      preferredRpe === fields.icu_rpe ? ActivitySchema.shape.icu_rpe : ActivitySchema.shape.rpe,
      (value) => value >= 0 && value <= 10,
    ),
    energyKilojoules: numericFact(
      fields.kj,
      ActivitySchema.shape.kj,
      (value) => value >= 0 && value <= Number.MAX_SAFE_INTEGER,
    ),
  };
}

function pendingFact(core: CoreFactRow): PendingFactRow {
  return {
    ...core,
    sourceTitle: null,
    load: absentFact(),
    averagePowerWatts: absentFact(),
    averageHeartRateBpm: absentFact(),
    perceivedExertion: absentFact(),
    energyKilojoules: absentFact(),
  };
}

function rejectPayloadFacts(row: PendingFactRow, reason: RecordedFactRejectionReason): void {
  row.load = rejectedFact(reason);
  row.averagePowerWatts = rejectedFact(reason);
  row.averageHeartRateBpm = rejectedFact(reason);
  row.perceivedExertion = rejectedFact(reason);
  row.energyKilojoules = rejectedFact(reason);
}

function applyParsedPayload(row: PendingFactRow, parsed: ParsedPayloadFacts): void {
  row.sourceTitle = parsed.sourceTitle;
  row.load = parsed.load;
  row.averagePowerWatts = parsed.averagePowerWatts;
  row.averageHeartRateBpm = parsed.averageHeartRateBpm;
  row.perceivedExertion = parsed.perceivedExertion;
  row.energyKilojoules = parsed.energyKilojoules;
}

function publicFact(row: PendingFactRow): TrainingHistoryFactRow {
  return Object.freeze({
    id: row.id,
    localDate: row.localDate,
    startEpochSeconds: row.startEpochSeconds,
    timezoneOffsetSeconds: row.timezoneOffsetSeconds,
    subSport: row.subSport,
    movingSeconds: row.movingSeconds,
    elapsedSeconds: row.elapsedSeconds,
    distanceMeters: row.distanceMeters,
    title: row.overlayTitle ?? row.workoutTitle ?? row.sourceTitle,
    load: row.load,
    averagePowerWatts: row.averagePowerWatts,
    averageHeartRateBpm: row.averageHeartRateBpm,
    perceivedExertion: row.perceivedExertion,
    energyKilojoules: row.energyKilojoules,
  });
}

async function applyPayloadPage(
  store: Pick<SqlReadStore, "all">,
  rows: readonly PendingFactRow[],
  budget: ParseBudget,
): Promise<void> {
  if (budget.exhausted) {
    for (const row of rows) rejectPayloadFacts(row, "payload-budget-exhausted");
    return;
  }
  const placeholders = rows.map(() => "?").join(", ");
  const selected = await store.all(
    `WITH ranked_source AS (
  SELECT
    s.session_key,
    r.payload_json,
    count(*) OVER (PARTITION BY s.session_key) AS source_count,
    row_number() OVER (
      PARTITION BY s.session_key
      ORDER BY sr.id COLLATE BINARY ASC
    ) AS source_rank
  FROM session AS s
  JOIN source_record AS sr ON sr.session_key = s.session_key
  JOIN source_record_current AS c ON c.source_record_id = sr.id
  JOIN source_record_revision AS r
    ON r.source_record_id = c.source_record_id AND r.revision_id = c.revision_id
  JOIN source_artifact AS a ON a.artifact_key = r.artifact_key
  WHERE s.session_key IN (${placeholders})
    AND sr.source = 'intervals-icu'
    AND a.source = 'intervals-icu'
    AND a.lane = 'activities'
    AND a.external_id = sr.external_id
)
SELECT
  CASE
    WHEN typeof(session_key) = 'text'
      AND length(CAST(session_key AS BLOB)) <= 64 THEN session_key
    ELSE NULL
  END AS session_key,
  source_count,
  CASE WHEN source_count = 1 AND typeof(payload_json) = 'text' THEN 1 ELSE 0 END
    AS payload_text_valid,
  CASE
    WHEN source_count = 1
      AND typeof(payload_json) = 'text'
      AND length(CAST(payload_json AS BLOB)) > 65536 THEN 1
    ELSE 0
  END AS payload_oversized,
  CASE
    WHEN source_count = 1
      AND typeof(payload_json) = 'text'
      AND length(CAST(payload_json AS BLOB)) <= 65536
      THEN length(CAST(payload_json AS BLOB))
    ELSE NULL
  END AS payload_bytes,
  CASE
    WHEN source_count = 1
      AND typeof(payload_json) = 'text'
      AND length(CAST(r.payload_json AS BLOB)) <= 65536 THEN payload_json
    ELSE NULL
  END AS payload_json
FROM ranked_source AS r
WHERE source_rank = 1
ORDER BY session_key ASC
LIMIT 100`,
    rows.map(({ id }) => id),
  );
  if (selected.length > rows.length || selected.length > PAYLOAD_PAGE_SIZE) invalidRow();
  const expected = new Map(rows.map((row) => [row.id, row]));
  const resolved = new Map<string, Row>();
  for (const selectedRow of selected) {
    const id = readSessionId(selectedRow);
    if (!expected.has(id) || resolved.has(id)) invalidRow();
    resolved.set(id, selectedRow);
  }
  for (const row of rows) {
    if (budget.exhausted) {
      rejectPayloadFacts(row, "payload-budget-exhausted");
      continue;
    }
    const payloadRow = resolved.get(row.id);
    if (payloadRow === undefined) continue;
    const sourceCount = readNonnegativeInteger(payloadRow, "source_count");
    if (sourceCount < 1) invalidRow();
    if (sourceCount > 1) {
      rejectPayloadFacts(row, "ambiguous-source");
      continue;
    }
    const textValid = readFlag(payloadRow, "payload_text_valid");
    const oversized = readFlag(payloadRow, "payload_oversized");
    if (!textValid) {
      rejectPayloadFacts(row, "invalid-envelope");
      continue;
    }
    if (oversized) {
      if (payloadRow.payload_bytes !== null || payloadRow.payload_json !== null) invalidRow();
      rejectPayloadFacts(row, "oversized-payload");
      continue;
    }
    const payloadBytes = readNonnegativeInteger(payloadRow, "payload_bytes");
    if (payloadBytes > PAYLOAD_ROW_BYTES || typeof payloadRow.payload_json !== "string")
      invalidRow();
    const measured = strictUtf8Length(payloadRow.payload_json);
    if (measured === undefined || measured !== payloadBytes) invalidRow();
    if (budget.bytes + payloadBytes > PAYLOAD_PROJECTION_BYTES) {
      budget.exhausted = true;
      rejectPayloadFacts(row, "payload-budget-exhausted");
      continue;
    }
    budget.bytes += payloadBytes;
    const parsed = parsePayloadFacts(payloadRow.payload_json);
    if (parsed.kind === "invalid-envelope") {
      rejectPayloadFacts(row, "invalid-envelope");
    } else {
      applyParsedPayload(row, parsed);
    }
  }
}

async function applyPayloads(
  store: Pick<SqlReadStore, "all">,
  rows: readonly PendingFactRow[],
  budget: ParseBudget,
): Promise<void> {
  for (let index = 0; index < rows.length; index += PAYLOAD_PAGE_SIZE) {
    await applyPayloadPage(store, rows.slice(index, index + PAYLOAD_PAGE_SIZE), budget);
  }
}

export function createTrainingHistoryReader(
  store: Pick<SqlReadStore, "all">,
): TrainingHistoryReader {
  return {
    async readWindow(input) {
      if (input === null || typeof input !== "object") invalidInput();
      const startEpoch = civilDateEpoch(input.start);
      const endEpoch = civilDateEpoch(input.end);
      if (startEpoch > endEpoch) invalidInput();
      const startKey = dateKey(input.start);
      const endKey = dateKey(input.end);
      const facts: TrainingHistoryFactRow[] = [];
      const budget: ParseBudget = { bytes: 0, exhausted: false };
      let cursor: { readonly startEpochSeconds: number; readonly id: string } | undefined;
      let scanTruncated = false;
      while (facts.length < SESSION_LIMIT) {
        const cursorSql =
          cursor === undefined
            ? ""
            : "\n  AND (s.start_utc < ? OR (s.start_utc = ? AND s.session_key > ?))";
        const params =
          cursor === undefined
            ? [startKey, endKey, CORE_PAGE_SIZE + 1]
            : [
                startKey,
                endKey,
                cursor.startEpochSeconds,
                cursor.startEpochSeconds,
                cursor.id,
                CORE_PAGE_SIZE + 1,
              ];
        const selected = await store.all(
          `SELECT
  CASE
    WHEN typeof(s.session_key) = 'text'
      AND length(CAST(s.session_key AS BLOB)) <= 64 THEN s.session_key
    ELSE NULL
  END AS session_key,
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
  s.start_utc,
  s.tz_offset_s,
  s.local_date_key,
  s.elapsed_s,
  s.moving_s,
  s.distance_m,
  CASE
    WHEN typeof(w.name) = 'text'
      AND length(CAST(w.name AS BLOB)) <= 512 THEN w.name
    ELSE NULL
  END AS workout_name,
  CASE
    WHEN typeof(o.override_value_json) = 'text'
      AND length(CAST(o.override_value_json AS BLOB)) <= 4096 THEN o.override_value_json
    ELSE NULL
  END AS overlay_value_json
FROM session AS s
JOIN workout AS w ON w.workout_key = s.workout_key
LEFT JOIN field_merge_override_overlay AS o
  ON o.target_table = 'workout'
  AND o.target_key = s.workout_key
  AND o.field_name = 'name'
WHERE s.local_date_key BETWEEN ? AND ?
  AND s.sport = 'cycling'
  AND s.is_transition = 0${cursorSql}
ORDER BY s.start_utc DESC, s.session_key ASC
LIMIT ?`,
          params,
        );
        if (selected.length > CORE_PAGE_SIZE + 1) invalidRow();
        const mapped = selected.map(coreFact);
        let boundary = cursor;
        for (const row of mapped) {
          if (row.localDate < input.start || row.localDate > input.end) invalidRow();
          if (
            boundary !== undefined &&
            !(
              row.startEpochSeconds < boundary.startEpochSeconds ||
              (row.startEpochSeconds === boundary.startEpochSeconds && row.id > boundary.id)
            )
          ) {
            invalidRow();
          }
          boundary = { startEpochSeconds: row.startEpochSeconds, id: row.id };
        }
        const page = mapped.slice(0, CORE_PAGE_SIZE).map(pendingFact);
        await applyPayloads(store, page, budget);
        facts.push(...page.map(publicFact));
        if (facts.length === SESSION_LIMIT && mapped.length > CORE_PAGE_SIZE) {
          scanTruncated = true;
          break;
        }
        if (mapped.length <= CORE_PAGE_SIZE) break;
        const last = page.at(-1);
        if (last === undefined) invalidRow();
        cursor = { startEpochSeconds: last.startEpochSeconds, id: last.id };
      }
      return Object.freeze({ rows: Object.freeze(facts), scanTruncated });
    },
  };
}
