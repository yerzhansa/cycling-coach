import { QUALITY_RANK, assertQualityRank, type QualityRank } from "./quality-rank.js";
import type { XmlChannel } from "./xml-types.js";

export type FileFormat = "fit" | "tcx" | "gpx";

export interface FileOrigin {
  readonly kind: "file";
  readonly format: FileFormat;
  readonly rawSha256: string;
}

export interface PlatformOrigin {
  readonly kind: "platform";
  readonly source: "intervals-icu";
  readonly sourceRecordId: string;
  readonly persistedQualityRank: number;
}

export type CandidateOrigin = FileOrigin | PlatformOrigin;
export type ScalarConcern = string | number | boolean;

export interface LapConcern {
  readonly lap_seq: number;
  readonly start_utc: number | null;
  readonly elapsed_s: number | null;
  readonly timer_s: number | null;
  readonly distance_m: number | null;
  readonly summary_json: string | null;
}

export interface SwimLengthConcern {
  readonly lap_seq: number;
  readonly length_seq: number;
  readonly start_utc: number | null;
  readonly elapsed_s: number | null;
  readonly timer_s: number | null;
  readonly distance_m: number | null;
  readonly strokes: number | null;
  readonly stroke_type: string | null;
  readonly length_type: string | null;
}

export type ConcernValue = ScalarConcern | readonly LapConcern[] | readonly SwimLengthConcern[] | XmlChannel;

export interface Candidate {
  readonly id: string;
  readonly origin: CandidateOrigin;
  readonly workoutOrdinal: number;
  readonly sessionOrdinal: number;
  readonly rank: QualityRank;
  readonly concerns: Readonly<Record<string, ConcernValue>>;
}

export interface LogicalSessionGroup {
  readonly id: string;
  readonly candidates: readonly Candidate[];
  readonly fitSerialByCandidateId: Readonly<Record<string, number | null>>;
}

export type CanonicalPickErrorCode =
  | "canonical.group_invalid"
  | "canonical.candidate_invalid"
  | "canonical.id_invalid"
  | "canonical.origin_invalid"
  | "canonical.rank_invalid"
  | "canonical.concern_invalid"
  | "canonical.fit_metadata_invalid"
  | "canonical.same_id_conflict";

export const CANONICAL_PICK_ERROR_MESSAGE = {
  "canonical.group_invalid": "Logical session group is invalid.",
  "canonical.candidate_invalid": "Candidate structure is invalid.",
  "canonical.id_invalid": "Candidate identity is invalid.",
  "canonical.origin_invalid": "Candidate origin is invalid.",
  "canonical.rank_invalid": "Candidate quality rank is invalid.",
  "canonical.concern_invalid": "Candidate concern structure is invalid.",
  "canonical.fit_metadata_invalid": "FIT tie metadata is invalid.",
  "canonical.same_id_conflict": "Repeated candidate identity has conflicting content.",
} as const;

export class CanonicalPickError extends Error {
  readonly code: CanonicalPickErrorCode;
  readonly candidateId: string | null;
  readonly concern: string | null;

  constructor(code: CanonicalPickErrorCode, candidateId: string | null = null, concern: string | null = null) {
    super(CANONICAL_PICK_ERROR_MESSAGE[code]);
    this.name = "CanonicalPickError";
    this.code = code;
    this.candidateId = candidateId;
    this.concern = concern;
  }
}

export interface ArbitrationDiagnostic {
  readonly code: "arbitration.timeline_mismatch";
  readonly candidateId: string;
  readonly concern: string;
}

export interface ConcernWinner {
  readonly concern: string;
  readonly candidateId: string;
  readonly rank: QualityRank;
  readonly value: ConcernValue;
}

export interface CanonicalPickResult {
  readonly groupId: string;
  readonly winners: readonly ConcernWinner[];
  readonly diagnostics: readonly ArbitrationDiagnostic[];
  readonly materialization:
    | { readonly status: "ready" }
    | {
        readonly status: "not_materializable";
        readonly reasons: readonly (
          | "missing_session_sport"
          | "missing_session_start_utc"
          | "missing_session_local_date_key"
          | "missing_session_is_transition"
          | "missing_stream_time"
        )[];
      };
}

const CANDIDATE_KEYS = ["id", "origin", "workoutOrdinal", "sessionOrdinal", "rank", "concerns"] as const;
const GROUP_KEYS = ["id", "candidates", "fitSerialByCandidateId"] as const;
const FILE_ORIGIN_KEYS = ["kind", "format", "rawSha256"] as const;
const PLATFORM_ORIGIN_KEYS = ["kind", "source", "sourceRecordId", "persistedQualityRank"] as const;
const LAP_KEYS = ["lap_seq", "start_utc", "elapsed_s", "timer_s", "distance_m", "summary_json"] as const;
const LENGTH_KEYS = [
  "lap_seq", "length_seq", "start_utc", "elapsed_s", "timer_s", "distance_m", "strokes", "stroke_type", "length_type",
] as const;
const FIXED_CHANNELS = new Set([
  "time", "lat", "lng", "distance", "altitude", "speed", "heart_rate", "cadence", "fractional_cadence", "power",
  "temperature", "stance_time", "stance_time_balance", "vertical_oscillation", "vertical_ratio", "step_length",
  "left_right_balance", "respiration_rate",
]);
const SCALAR_KEYS = new Set([
  "session.sport", "session.sub_sport", "session.start_utc", "session.tz_offset_s", "session.local_date_key",
  "session.elapsed_s", "session.timer_s", "session.moving_s", "session.distance_m", "session.is_transition",
  "session.summary_json",
]);
const DEV_CHANNEL = /^dev:([0-9a-f]{32}|idx-(0|[1-9][0-9]*)):(0|[1-9][0-9]*):(0|[1-9][0-9]*):(?:[a-z0-9._-]|%[0-9a-f]{2})+$/;
const LOWER_HEX_64 = /^[0-9a-f]{64}$/;
const CANDIDATE_ID = /^(?:(?:fit|tcx|gpx):[0-9a-f]{64}:(?:0|[1-9][0-9]*):(?:0|[1-9][0-9]*)|platform_api:[0-9a-f]{64}:0:0)$/;

type DataRecord = Record<string, unknown>;

function fail(code: CanonicalPickErrorCode, candidateId: string | null = null, concern: string | null = null): never {
  throw new CanonicalPickError(code, candidateId, concern);
}

function record(value: unknown, exactKeys: readonly string[] | null, code: CanonicalPickErrorCode, candidateId: string | null): DataRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code, candidateId);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code, candidateId);
  if (Object.getOwnPropertySymbols(value).length > 0) fail(code, candidateId);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  for (const key of keys) {
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || !descriptor.enumerable) fail(code, candidateId);
  }
  if (exactKeys && (keys.length !== exactKeys.length || exactKeys.some((key) => !Object.hasOwn(descriptors, key)))) {
    fail(code, candidateId);
  }
  const result = Object.create(null) as DataRecord;
  for (const key of keys) result[key] = (descriptors[key] as PropertyDescriptor & { value: unknown }).value;
  return result;
}

function denseArray(value: unknown, code: CanonicalPickErrorCode, candidateId: string | null): readonly unknown[] {
  if (!Array.isArray(value) || !Number.isSafeInteger(value.length)) fail(code, candidateId);
  if (Object.getOwnPropertySymbols(value).length > 0) fail(code, candidateId);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set(["length"]);
  for (let index = 0; index < value.length; index += 1) allowed.add(String(index));
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(key) || (!("value" in descriptor)) || (key !== "length" && !descriptor.enumerable)) fail(code, candidateId);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) fail(code, candidateId);
  }
  return value;
}

function validNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0);
}

function validNonnegative(value: unknown): value is number {
  return validNumber(value) && value >= 0;
}

function validSafeInteger(value: unknown): value is number {
  return validNumber(value) && Number.isSafeInteger(value);
}

function validDateKey(value: unknown): boolean {
  if (!validSafeInteger(value) || value < 10101 || value > 99991231) return false;
  const year = Math.floor(value / 10000);
  const month = Math.floor((value % 10000) / 100);
  const day = value % 100;
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const max = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return day <= max;
}

function compareCodePoints(a: string, b: string): -1 | 0 | 1 {
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  while (true) {
    const l = left.next();
    const r = right.next();
    if (l.done || r.done) return l.done === r.done ? 0 : l.done ? -1 : 1;
    const lc = l.value.codePointAt(0)!;
    const rc = r.value.codePointAt(0)!;
    if (lc !== rc) return lc < rc ? -1 : 1;
  }
}

function sortedJsonValue(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (validNumber(value)) return value;
  if (Array.isArray(value)) {
    denseArray(value, "canonical.concern_invalid", null);
    if (seen.has(value)) fail("canonical.concern_invalid");
    seen.add(value);
    const result = value.map((entry) => sortedJsonValue(entry, seen));
    seen.delete(value);
    return result;
  }
  const source = record(value, null, "canonical.concern_invalid", null);
  if (seen.has(value as object)) fail("canonical.concern_invalid");
  seen.add(value as object);
  const result = Object.create(null) as DataRecord;
  for (const key of Object.keys(source).sort(compareCodePoints)) result[key] = sortedJsonValue(source[key], seen);
  seen.delete(value as object);
  return result;
}

function validSummary(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    return JSON.stringify(sortedJsonValue(parsed, new Set())) === value;
  } catch {
    return false;
  }
}

function validateLapArray(value: unknown, candidateId: string): readonly LapConcern[] {
  const values = denseArray(value, "canonical.concern_invalid", candidateId);
  let previous = -1;
  for (const entry of values) {
    const lap = record(entry, LAP_KEYS, "canonical.concern_invalid", candidateId);
    if (!validSafeInteger(lap.lap_seq) || (lap.lap_seq as number) < 0 || (lap.lap_seq as number) <= previous) fail("canonical.concern_invalid", candidateId, "lap[]");
    previous = lap.lap_seq as number;
    if (lap.start_utc !== null && !validNumber(lap.start_utc)) fail("canonical.concern_invalid", candidateId, "lap[]");
    for (const key of ["elapsed_s", "timer_s", "distance_m"] as const) {
      if (lap[key] !== null && !validNonnegative(lap[key])) fail("canonical.concern_invalid", candidateId, "lap[]");
    }
    if (lap.summary_json !== null && !validSummary(lap.summary_json)) fail("canonical.concern_invalid", candidateId, "lap[]");
  }
  return value as readonly LapConcern[];
}

function validateLengthArray(value: unknown, candidateId: string, lapSeqs: Set<number>): readonly SwimLengthConcern[] {
  const values = denseArray(value, "canonical.concern_invalid", candidateId);
  let previous: readonly [number, number] | null = null;
  for (const entry of values) {
    const length = record(entry, LENGTH_KEYS, "canonical.concern_invalid", candidateId);
    if (!validSafeInteger(length.lap_seq) || (length.lap_seq as number) < 0 || !lapSeqs.has(length.lap_seq as number) ||
        !validSafeInteger(length.length_seq) || (length.length_seq as number) < 0) fail("canonical.concern_invalid", candidateId, "swim_length[]");
    const pair = [length.lap_seq as number, length.length_seq as number] as const;
    if (previous && (pair[0] < previous[0] || (pair[0] === previous[0] && pair[1] <= previous[1]))) fail("canonical.concern_invalid", candidateId, "swim_length[]");
    previous = pair;
    if (length.start_utc !== null && !validNumber(length.start_utc)) fail("canonical.concern_invalid", candidateId, "swim_length[]");
    for (const key of ["elapsed_s", "timer_s", "distance_m"] as const) if (length[key] !== null && !validNonnegative(length[key])) fail("canonical.concern_invalid", candidateId, "swim_length[]");
    if (length.strokes !== null && (!validSafeInteger(length.strokes) || (length.strokes as number) < 0)) fail("canonical.concern_invalid", candidateId, "swim_length[]");
    for (const key of ["stroke_type", "length_type"] as const) if (length[key] !== null && (typeof length[key] !== "string" || length[key] === "")) fail("canonical.concern_invalid", candidateId, "swim_length[]");
  }
  return value as readonly SwimLengthConcern[];
}

function validChannelName(name: string): boolean {
  if (FIXED_CHANNELS.has(name)) return true;
  const match = DEV_CHANNEL.exec(name);
  if (!match) return false;
  const app = match[1]!;
  const embedded = match[2];
  const developerIndex = Number(match[3]);
  const field = Number(match[4]);
  if (!Number.isSafeInteger(developerIndex) || !Number.isSafeInteger(field)) return false;
  return embedded === undefined || (Number.isSafeInteger(Number(embedded)) && Number(embedded) === developerIndex && app === `idx-${embedded}`);
}

function validateChannel(value: unknown, name: string, candidateId: string, allowInterpolatedSamples: boolean): XmlChannel {
  const channel = record(value, ["timestamps", "values"], "canonical.concern_invalid", candidateId);
  const timestamps = denseArray(channel.timestamps, "canonical.concern_invalid", candidateId);
  const values = denseArray(channel.values, "canonical.concern_invalid", candidateId);
  if (timestamps.length === 0 || timestamps.length !== values.length) fail("canonical.concern_invalid", candidateId, `stream:${name}`);
  let hasValue = false;
  for (let index = 0; index < timestamps.length; index += 1) {
    const timestamp = timestamps[index];
    const entry = values[index];
    if (!validNumber(timestamp) || (index > 0 && (timestamp as number) <= (timestamps[index - 1] as number))) fail("canonical.concern_invalid", candidateId, `stream:${name}`);
    if (entry !== null && !validNumber(entry)) fail("canonical.concern_invalid", candidateId, `stream:${name}`);
    if (entry !== null) hasValue = true;
    if (name === "time" && entry !== timestamp) fail("canonical.concern_invalid", candidateId, "stream:time");
    if (name === "lat" && entry !== null && ((entry as number) < -90 || (entry as number) > 90)) fail("canonical.concern_invalid", candidateId, `stream:${name}`);
    if (name === "lng" && entry !== null && ((entry as number) < -180 || (entry as number) > 180)) fail("canonical.concern_invalid", candidateId, `stream:${name}`);
    if (["distance", "speed", "power"].includes(name) && entry !== null && (entry as number) < 0) fail("canonical.concern_invalid", candidateId, `stream:${name}`);
    if (name === "heart_rate" && entry !== null && ((!allowInterpolatedSamples && !Number.isInteger(entry)) || (entry as number) < 1 || (entry as number) > 255)) fail("canonical.concern_invalid", candidateId, `stream:${name}`);
    if (name === "cadence" && entry !== null && ((!allowInterpolatedSamples && !Number.isInteger(entry)) || (entry as number) < 0 || (entry as number) > 255)) fail("canonical.concern_invalid", candidateId, `stream:${name}`);
  }
  if (!hasValue) fail("canonical.concern_invalid", candidateId, `stream:${name}`);
  return value as XmlChannel;
}

function validateConcerns(value: unknown, candidateId: string, allowInterpolatedSamples: boolean): Readonly<Record<string, ConcernValue>> {
  const concerns = record(value, null, "canonical.concern_invalid", candidateId);
  let lapSeqs = new Set<number>();
  if (Object.hasOwn(concerns, "lap[]")) {
    const laps = validateLapArray(concerns["lap[]"], candidateId);
    lapSeqs = new Set(laps.map((lap) => lap.lap_seq));
  }
  for (const [key, entry] of Object.entries(concerns)) {
    if (key === "lap[]") continue;
    if (key === "swim_length[]") {
      validateLengthArray(entry, candidateId, lapSeqs);
      continue;
    }
    if (key.startsWith("stream:")) {
      const name = key.slice(7);
      if (!validChannelName(name)) fail("canonical.concern_invalid", candidateId, key);
      validateChannel(entry, name, candidateId, allowInterpolatedSamples);
      continue;
    }
    if (!SCALAR_KEYS.has(key)) fail("canonical.concern_invalid", candidateId, key);
    if (key === "session.sport" || key === "session.sub_sport") {
      if (typeof entry !== "string" || entry.length === 0) fail("canonical.concern_invalid", candidateId, key);
    } else if (key === "session.is_transition") {
      if (typeof entry !== "boolean") fail("canonical.concern_invalid", candidateId, key);
    } else if (key === "session.summary_json") {
      if (!validSummary(entry)) fail("canonical.concern_invalid", candidateId, key);
    } else if (key === "session.tz_offset_s") {
      if (!validSafeInteger(entry)) fail("canonical.concern_invalid", candidateId, key);
    } else if (key === "session.local_date_key") {
      if (!validDateKey(entry)) fail("canonical.concern_invalid", candidateId, key);
    } else if (key === "session.start_utc") {
      if (!validNumber(entry)) fail("canonical.concern_invalid", candidateId, key);
    } else if (!validNonnegative(entry)) fail("canonical.concern_invalid", candidateId, key);
  }
  return value as Readonly<Record<string, ConcernValue>>;
}

function validateCandidate(value: unknown): Candidate {
  const candidate = record(value, CANDIDATE_KEYS, "canonical.candidate_invalid", null);
  const id = typeof candidate.id === "string" ? candidate.id : null;
  if (!id || !CANDIDATE_ID.test(id)) fail("canonical.id_invalid");
  if (!validSafeInteger(candidate.workoutOrdinal) || (candidate.workoutOrdinal as number) < 0 || !validSafeInteger(candidate.sessionOrdinal) || (candidate.sessionOrdinal as number) < 0) fail("canonical.candidate_invalid", id);
  const origin = record(candidate.origin, null, "canonical.origin_invalid", id);
  let expectedRank: QualityRank;
  if (origin.kind === "file") {
    record(candidate.origin, FILE_ORIGIN_KEYS, "canonical.origin_invalid", id);
    if ((origin.format !== "fit" && origin.format !== "tcx" && origin.format !== "gpx") || typeof origin.rawSha256 !== "string" || !LOWER_HEX_64.test(origin.rawSha256)) fail("canonical.origin_invalid", id);
    const expectedId = `${origin.format}:${origin.rawSha256}:${candidate.workoutOrdinal}:${candidate.sessionOrdinal}`;
    if (id !== expectedId) fail("canonical.id_invalid", id);
    expectedRank = origin.format === "fit" ? QUALITY_RANK.FIT : origin.format === "tcx" ? QUALITY_RANK.TCX : QUALITY_RANK.GPX;
  } else if (origin.kind === "platform") {
    record(candidate.origin, PLATFORM_ORIGIN_KEYS, "canonical.origin_invalid", id);
    if (origin.source !== "intervals-icu" || typeof origin.sourceRecordId !== "string" || !LOWER_HEX_64.test(origin.sourceRecordId) ||
        !validNumber(origin.persistedQualityRank)) fail("canonical.origin_invalid", id);
    try { assertQualityRank(origin.persistedQualityRank as number); } catch { fail("canonical.origin_invalid", id); }
    if (origin.persistedQualityRank !== QUALITY_RANK.PLATFORM_API || candidate.workoutOrdinal !== 0 || candidate.sessionOrdinal !== 0) fail("canonical.origin_invalid", id);
    if (id !== `platform_api:${origin.sourceRecordId}:0:0`) fail("canonical.id_invalid", id);
    expectedRank = QUALITY_RANK.PLATFORM_API;
  } else fail("canonical.origin_invalid", id);
  let rank: QualityRank;
  try { rank = assertQualityRank(candidate.rank as number); } catch { fail("canonical.rank_invalid", id); }
  if (rank! !== expectedRank) fail("canonical.rank_invalid", id);
  validateConcerns(candidate.concerns, id, origin.kind === "file" && origin.format === "fit");
  return value as Candidate;
}

function canonicalEquality(candidate: Candidate, fitSerial: number | null | undefined): string {
  const value = { origin: candidate.origin, workoutOrdinal: candidate.workoutOrdinal, sessionOrdinal: candidate.sessionOrdinal, rank: candidate.rank, concerns: candidate.concerns, fitSerial: fitSerial ?? null };
  return JSON.stringify(sortedJsonValue(value, new Set()));
}

function canonicalConcern(value: ConcernValue): ConcernValue {
  return sortedJsonValue(value, new Set()) as ConcernValue;
}

function candidateOrder(fitSerials: Readonly<Record<string, number | null>>) {
  return (left: Candidate, right: Candidate): number => {
    if (left.rank !== right.rank) return right.rank - left.rank;
    if (left.rank === QUALITY_RANK.FIT && right.rank === QUALITY_RANK.FIT) {
      const leftCount = Object.keys(left.concerns).filter((key) => key.startsWith("stream:")).length;
      const rightCount = Object.keys(right.concerns).filter((key) => key.startsWith("stream:")).length;
      if (leftCount !== rightCount) return rightCount - leftCount;
      const leftSerial = fitSerials[left.id]!;
      const rightSerial = fitSerials[right.id]!;
      if ((leftSerial === null) !== (rightSerial === null)) return leftSerial === null ? 1 : -1;
      if (leftSerial !== null && rightSerial !== null && leftSerial !== rightSerial) return leftSerial - rightSerial;
    }
    return compareCodePoints(left.id, right.id);
  };
}

export function canonicalPick(groupValue: LogicalSessionGroup): CanonicalPickResult {
  const group = record(groupValue, GROUP_KEYS, "canonical.group_invalid", null);
  if (typeof group.id !== "string" || group.id.length === 0) fail("canonical.group_invalid");
  const presentations = denseArray(group.candidates, "canonical.group_invalid", null);
  if (presentations.length === 0) fail("canonical.group_invalid");
  const validated = presentations.map(validateCandidate);
  const metadata = record(group.fitSerialByCandidateId, null, "canonical.fit_metadata_invalid", null);
  const uniqueById = new Map<string, Candidate>();
  for (const candidate of validated) if (!uniqueById.has(candidate.id)) uniqueById.set(candidate.id, candidate);
  const fitIds = [...uniqueById.values()].filter((candidate) => candidate.origin.kind === "file" && candidate.origin.format === "fit").map((candidate) => candidate.id).sort(compareCodePoints);
  const metadataKeys = Object.keys(metadata).sort(compareCodePoints);
  if (fitIds.length !== metadataKeys.length || fitIds.some((id, index) => id !== metadataKeys[index])) fail("canonical.fit_metadata_invalid");
  for (const id of metadataKeys) {
    const serial = metadata[id];
    if (serial !== null && (!validSafeInteger(serial) || (serial as number) < 0)) fail("canonical.fit_metadata_invalid", id);
  }
  const equalityById = new Map<string, string>();
  for (const candidate of validated) {
    const equality = canonicalEquality(candidate, metadata[candidate.id] as number | null | undefined);
    const prior = equalityById.get(candidate.id);
    if (prior !== undefined && prior !== equality) fail("canonical.same_id_conflict", candidate.id);
    equalityById.set(candidate.id, equality);
  }
  const candidates = [...uniqueById.values()].sort(candidateOrder(metadata as Readonly<Record<string, number | null>>));
  const concerns = [...new Set(candidates.flatMap((candidate) => Object.keys(candidate.concerns)))];
  const remaining = concerns.filter((key) => key !== "stream:time").sort(compareCodePoints);
  const ordered = concerns.includes("stream:time") ? ["stream:time", ...remaining] : remaining;
  const winners: ConcernWinner[] = [];
  const diagnostics: ArbitrationDiagnostic[] = [];
  const timeCandidate = candidates.find((candidate) => Object.hasOwn(candidate.concerns, "stream:time"));
  const selectedTime = timeCandidate?.concerns["stream:time"] as XmlChannel | undefined;
  if (timeCandidate && selectedTime) {
    winners.push({
      concern: "stream:time",
      candidateId: timeCandidate.id,
      rank: timeCandidate.rank,
      value: canonicalConcern(selectedTime),
    });
  }
  for (const concern of ordered) {
    if (concern === "stream:time") continue;
    if (!concern.startsWith("stream:")) {
      const candidate = candidates.find((entry) => Object.hasOwn(entry.concerns, concern));
      if (candidate) {
        winners.push({
          concern,
          candidateId: candidate.id,
          rank: candidate.rank,
          value: canonicalConcern(candidate.concerns[concern]!),
        });
      }
      continue;
    }
    let winner: Candidate | null = null;
    for (const candidate of candidates) {
      if (!Object.hasOwn(candidate.concerns, concern)) continue;
      const channel = candidate.concerns[concern] as XmlChannel;
      const eligible = selectedTime !== undefined && channel.timestamps.length === selectedTime.values.length &&
        channel.timestamps.every((timestamp, index) => timestamp === selectedTime.values[index]);
      if (!eligible) diagnostics.push({ code: "arbitration.timeline_mismatch", candidateId: candidate.id, concern });
      else if (!winner) winner = candidate;
    }
    if (winner) {
      winners.push({
        concern,
        candidateId: winner.id,
        rank: winner.rank,
        value: canonicalConcern(winner.concerns[concern]!),
      });
    }
  }
  const winnerKeys = new Set(winners.map((winner) => winner.concern));
  const reasons: (
    "missing_session_sport" | "missing_session_start_utc" | "missing_session_local_date_key" | "missing_session_is_transition" | "missing_stream_time"
  )[] = [];
  if (!winnerKeys.has("session.sport")) reasons.push("missing_session_sport");
  if (!winnerKeys.has("session.start_utc")) reasons.push("missing_session_start_utc");
  if (!winnerKeys.has("session.local_date_key")) reasons.push("missing_session_local_date_key");
  if (!winnerKeys.has("session.is_transition")) reasons.push("missing_session_is_transition");
  if (!winnerKeys.has("stream:time")) reasons.push("missing_stream_time");
  return {
    groupId: group.id as string,
    winners,
    diagnostics,
    materialization: reasons.length === 0 ? { status: "ready" } : { status: "not_materializable", reasons },
  };
}
