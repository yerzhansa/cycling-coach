import { canonicalJson } from "../archive/canonical.js";
import { strictUtf8Length } from "../strict-utf8.js";
import { z } from "zod";

export const REFERENCE_CAPTURE_SCHEMA_VERSION = 1 as const;
export const REFERENCE_CAPTURE_WINDOW_DAYS = 84 as const;
export const REFERENCE_CAPTURE_STREAM_WINDOW_DAYS = 21 as const;
export const REFERENCE_CAPTURE_STREAM_LIMIT = 12 as const;
export const REFERENCE_CAPTURE_STREAM_TYPES = Object.freeze([
  "time", "watts", "heartrate", "dfa_a1", "artifacts",
] as const);
export const REFERENCE_CAPTURE_STREAM_SPORT_TYPES = Object.freeze([
  "Ride", "VirtualRide",
] as const);

const DAY_MS = 24 * 60 * 60 * 1_000;
const HEX = /^[0-9a-f]{64}$/;
const SNAPSHOT_PATH = /^[0-9]{4}\/[0-9]{2}\/[0-9a-f]{64}\.json\.gz$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const LOCAL_DATE_TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$/;

function realDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day;
}

function realLocalDateTime(value: string): boolean {
  if (!LOCAL_DATE_TIME.test(value) || !realDate(value.slice(0, 10))) return false;
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59;
}

const safeInteger = z.number().refine(Number.isSafeInteger, "must be a safe integer");
const nonnegativeInteger = safeInteger.refine((value) => value >= 0, "must be nonnegative");
const nonemptyString = z.string().min(1);
const civilDate = z.string().refine(realDate, "must be a real civil date");
const localDateTime = z.string().refine(realLocalDateTime, "must be a real local date-time");

const calendarTimeZone = z.string().min(1).refine((value) => {
  const bytes = strictUtf8Length(value);
  return bytes !== undefined && bytes <= 255;
}, "must be at most 255 UTF-8 bytes");

const CapturePlanSchema = z.object({
  capture_epoch_ms: safeInteger,
  frozenNow: localDateTime,
  calendar_timezone: calendarTimeZone.optional(),
  window: z.object({ oldest: civilDate, newest: civilDate }).strict(),
  stream_cutoff_epoch_ms: safeInteger,
}).strict().superRefine((value, context) => {
  if (value.window.oldest > value.window.newest) {
    context.addIssue({ code: "custom", message: "capture window is reversed", path: ["window"] });
  }
  if (value.stream_cutoff_epoch_ms !== value.capture_epoch_ms - REFERENCE_CAPTURE_STREAM_WINDOW_DAYS * DAY_MS) {
    context.addIssue({ code: "custom", message: "stream cutoff does not match capture epoch", path: ["stream_cutoff_epoch_ms"] });
  }
});

const SnapshotRefSchema = z.object({
  address: z.string().regex(HEX),
  rel_path: z.string().regex(SNAPSHOT_PATH),
}).strict().superRefine((value, context) => {
  if (value.rel_path.split("/").at(-1) !== `${value.address}.json.gz`) {
    context.addIssue({ code: "custom", message: "snapshot basename does not match address", path: ["rel_path"] });
  }
});

const CurrentRevisionRefSchema = z.object({
  source_record_id: z.string().regex(HEX),
  revision_id: z.string().regex(HEX),
}).strict();

const RecordRefSchema = z.object({
  ordinal: nonnegativeInteger,
  endpoint_ordinal: nonnegativeInteger,
  payload_index: nonnegativeInteger.nullable(),
  external_id: nonemptyString,
  snapshot: SnapshotRefSchema,
  store_evidence: z.object({
    artifact_key: z.string().regex(HEX),
    current_revision: CurrentRevisionRefSchema.nullable(),
  }).strict(),
}).strict();

const EndpointRefSchema = z.object({
  ordinal: nonnegativeInteger,
  lane: z.enum(["settings", "activities", "wellness", "streams"]),
  endpoint: z.enum(["athlete-profile", "activities", "wellness", "activity-streams"]),
  request: z.object({
    oldest: civilDate.nullable(),
    newest: civilDate.nullable(),
    activity_id: nonemptyString.nullable(),
    stream_types: z.array(z.string()),
    include_defaults: z.literal(false).nullable(),
  }).strict(),
  snapshot: SnapshotRefSchema,
}).strict();

const ManifestSchema = z.object({
  schema_version: z.literal(REFERENCE_CAPTURE_SCHEMA_VERSION),
  capture_id: z.string().regex(UUID),
  source: z.literal("external-oracle"),
  plan: CapturePlanSchema,
  operation_ledger: z.object({
    link_kind: z.literal("capture-id"),
    capture_id: z.string().regex(UUID),
  }).strict(),
  endpoints: z.array(EndpointRefSchema),
  records: z.object({
    settings: z.array(RecordRefSchema),
    activities: z.array(RecordRefSchema),
    wellness: z.array(RecordRefSchema),
    streams: z.array(RecordRefSchema),
  }).strict(),
  selected_stream_ids: z.array(nonemptyString),
  captured_stream_ids: z.array(nonemptyString),
  deterministic_order: z.object({
    endpoint_ordinals: z.array(nonnegativeInteger),
    settings: z.array(nonemptyString),
    activities: z.array(nonemptyString),
    wellness: z.array(nonemptyString),
    streams: z.array(nonemptyString),
  }).strict(),
}).strict().superRefine((value, context) => {
  const issue = (message: string, path: PropertyKey[] = []): void => {
    context.addIssue({ code: "custom", message, path: path as (string | number)[] });
  };
  if (value.operation_ledger.capture_id !== value.capture_id) issue("capture IDs disagree", ["operation_ledger", "capture_id"]);

  const expectedRequired = [
    { lane: "settings", endpoint: "athlete-profile" },
    { lane: "activities", endpoint: "activities" },
    { lane: "wellness", endpoint: "wellness" },
  ] as const;
  if (value.endpoints.length < expectedRequired.length) issue("required endpoints are absent", ["endpoints"]);
  for (let index = 0; index < value.endpoints.length; index += 1) {
    const endpoint = value.endpoints[index]!;
    if (endpoint.ordinal !== index) issue("endpoint ordinal is not dense", ["endpoints", index, "ordinal"]);
    if (index < 3) {
      const expected = expectedRequired[index]!;
      if (endpoint.lane !== expected.lane || endpoint.endpoint !== expected.endpoint) {
        issue("required endpoint is invalid", ["endpoints", index]);
      }
      const range = index === 0 ? [null, null] : [value.plan.window.oldest, value.plan.window.newest];
      if (endpoint.request.oldest !== range[0] || endpoint.request.newest !== range[1]
        || endpoint.request.activity_id !== null || endpoint.request.stream_types.length !== 0
        || endpoint.request.include_defaults !== null) issue("required endpoint request is invalid", ["endpoints", index, "request"]);
    } else if (endpoint.lane !== "streams" || endpoint.endpoint !== "activity-streams"
      || endpoint.request.oldest !== null || endpoint.request.newest !== null
      || endpoint.request.activity_id === null
      || canonicalJson(endpoint.request.stream_types) !== canonicalJson(REFERENCE_CAPTURE_STREAM_TYPES)
      || endpoint.request.include_defaults !== false) {
      issue("stream endpoint request is invalid", ["endpoints", index]);
    }
  }

  const unique = (items: readonly string[], path: string): void => {
    if (new Set(items).size !== items.length) issue(`${path} contains duplicates`, [path]);
  };
  unique(value.selected_stream_ids, "selected_stream_ids");
  unique(value.captured_stream_ids, "captured_stream_ids");
  const endpointStreamIds = value.endpoints.slice(3).map((endpoint) => endpoint.request.activity_id!);
  if (canonicalJson(endpointStreamIds) !== canonicalJson(value.captured_stream_ids)) {
    issue("stream endpoints disagree with captured IDs", ["captured_stream_ids"]);
  }
  let selectedOffset = 0;
  for (const id of value.captured_stream_ids) {
    const selectedIndex = value.selected_stream_ids.indexOf(id, selectedOffset);
    if (selectedIndex < 0) { issue("captured IDs are not a selector subsequence", ["captured_stream_ids"]); break; }
    selectedOffset = selectedIndex + 1;
  }

  for (const lane of ["settings", "activities", "wellness", "streams"] as const) {
    const records = value.records[lane];
    unique(records.map((record) => record.external_id), `records.${lane}`);
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      if (record.ordinal !== index) issue("record ordinal is not dense", ["records", lane, index, "ordinal"]);
      if (lane === "streams") {
        if (record.payload_index !== null || record.endpoint_ordinal !== 3 + index
          || record.external_id !== `streams:${value.captured_stream_ids[index]}`
          || canonicalJson(record.snapshot) !== canonicalJson(value.endpoints[3 + index]?.snapshot)) {
          issue("stream record attribution is invalid", ["records", lane, index]);
        }
      } else {
        const expectedEndpoint = lane === "settings" ? 0 : lane === "activities" ? 1 : 2;
        if (record.endpoint_ordinal !== expectedEndpoint || record.payload_index === null) {
          issue("record endpoint attribution is invalid", ["records", lane, index]);
        }
      }
      if ((lane === "wellness") !== (record.store_evidence.current_revision === null)) {
        issue("record revision evidence is invalid", ["records", lane, index, "store_evidence", "current_revision"]);
      }
    }
    if (lane !== "streams") {
      const indexes = records.map((record) => record.payload_index!);
      if (new Set(indexes).size !== indexes.length) issue("payload indexes contain duplicates", ["records", lane]);
    }
  }

  const ordinals = value.endpoints.map((endpoint) => endpoint.ordinal);
  if (canonicalJson(value.deterministic_order.endpoint_ordinals) !== canonicalJson(ordinals)) {
    issue("endpoint deterministic order is invalid", ["deterministic_order", "endpoint_ordinals"]);
  }
  for (const lane of ["settings", "activities", "wellness"] as const) {
    if (canonicalJson(value.deterministic_order[lane]) !== canonicalJson(value.records[lane].map((record) => record.external_id))) {
      issue("record deterministic order is invalid", ["deterministic_order", lane]);
    }
  }
  if (canonicalJson(value.deterministic_order.streams) !== canonicalJson(value.captured_stream_ids)) {
    issue("stream deterministic order is invalid", ["deterministic_order", "streams"]);
  }
});

export type ReferenceCapturePlan = z.infer<typeof CapturePlanSchema>;
export type SnapshotRef = z.infer<typeof SnapshotRefSchema>;
export type CurrentRevisionRef = z.infer<typeof CurrentRevisionRefSchema>;
export type RecordRef = z.infer<typeof RecordRefSchema>;
export type EndpointRef = z.infer<typeof EndpointRefSchema>;
export type ReferenceCaptureManifest = z.infer<typeof ManifestSchema>;

export interface DerivedCaptureMember {
  readonly endpoint_ordinal: number;
  readonly payload_index: number | null;
  readonly external_id: string;
  readonly payload: unknown;
}

export interface DerivedCaptureMembers {
  readonly settings: readonly DerivedCaptureMember[];
  readonly activities: readonly DerivedCaptureMember[];
  readonly wellness: readonly DerivedCaptureMember[];
  readonly streams: readonly DerivedCaptureMember[];
  readonly selected_stream_ids: readonly string[];
}

export interface ReferenceCaptureEndpointPayload {
  readonly ordinal: number;
  readonly lane: EndpointRef["lane"];
  readonly endpoint: EndpointRef["endpoint"];
  readonly request: EndpointRef["request"];
  readonly payload: unknown;
}

function calendarDateTime(now: Date, timeZone: string): {
  readonly date: string;
  readonly dateTime: string;
} {
  const timeZoneBytes =
    typeof timeZone === "string" ? strictUtf8Length(timeZone) : undefined;
  if (timeZoneBytes === undefined || timeZoneBytes > 255 || timeZone.length === 0) {
    throw new TypeError("capture calendar timezone is invalid");
  }
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
  } catch {
    throw new TypeError("capture calendar timezone is invalid");
  }
  let year: string | undefined;
  let month: string | undefined;
  let day: string | undefined;
  let hour: string | undefined;
  let minute: string | undefined;
  let second: string | undefined;
  for (const part of parts) {
    if (part.type === "year") year = part.value;
    else if (part.type === "month") month = part.value;
    else if (part.type === "day") day = part.value;
    else if (part.type === "hour") hour = part.value;
    else if (part.type === "minute") minute = part.value;
    else if (part.type === "second") second = part.value;
  }
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    throw new TypeError("capture calendar timezone is invalid");
  }
  const date = `${year}-${month}-${day}`;
  return { date, dateTime: `${date}T${hour}:${minute}:${second}` };
}

function addCivilDays(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new TypeError("capture calendar date is invalid");
  }
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

export function createReferenceCapturePlan(input: {
  readonly now: Date;
  readonly calendarTimeZone: string;
}): ReferenceCapturePlan {
  if (input === null || typeof input !== "object" || !(input.now instanceof Date)) {
    throw new TypeError("capture clock is invalid");
  }
  const captureEpochMs = input.now.getTime();
  if (!Number.isSafeInteger(captureEpochMs)) throw new TypeError("capture clock is invalid");
  const calendar = calendarDateTime(input.now, input.calendarTimeZone);
  return validateReferenceCapturePlan({
    capture_epoch_ms: captureEpochMs,
    frozenNow: calendar.dateTime,
    calendar_timezone: input.calendarTimeZone,
    window: {
      newest: calendar.date,
      oldest: addCivilDays(calendar.date, -REFERENCE_CAPTURE_WINDOW_DAYS),
    },
    stream_cutoff_epoch_ms: captureEpochMs - REFERENCE_CAPTURE_STREAM_WINDOW_DAYS * DAY_MS,
  });
}

export function planCalendarTimeZone(plan: ReferenceCapturePlan): string {
  return plan.calendar_timezone ?? "UTC";
}

export interface ReferenceCaptureClock {
  readonly captureEpochMs: number;
  readonly civilDateTime: string;
  readonly calendarTimeZone: string;
}

export function referenceCaptureClock(plan: ReferenceCapturePlan): ReferenceCaptureClock {
  return Object.freeze({
    captureEpochMs: plan.capture_epoch_ms,
    civilDateTime: plan.frozenNow,
    calendarTimeZone: planCalendarTimeZone(plan),
  });
}

export function validateReferenceCapturePlan(value: unknown): ReferenceCapturePlan {
  return CapturePlanSchema.parse(value);
}

function exactParse<T>(bytes: string | Uint8Array, validate: (value: unknown) => T, serialize: (value: T) => string): T {
  let text: string;
  try { text = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new TypeError("capture sidecar encoding is invalid"); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new TypeError("capture sidecar JSON is invalid"); }
  const value = validate(parsed);
  if (serialize(value) !== text) throw new TypeError("capture sidecar bytes are not canonical");
  return value;
}

export function serializeReferenceCapturePlan(value: unknown): string {
  return `${canonicalJson(validateReferenceCapturePlan(value))}\n`;
}

export function parseReferenceCapturePlan(bytes: string | Uint8Array): ReferenceCapturePlan {
  return exactParse(bytes, validateReferenceCapturePlan, serializeReferenceCapturePlan);
}

export function selectReferenceCaptureStreamIds(activities: readonly unknown[], plan: ReferenceCapturePlan): string[] {
  const validPlan = validateReferenceCapturePlan(plan);
  if (!Array.isArray(activities)) throw new TypeError("capture activities are invalid");
  const candidates: { readonly id: string; readonly time: number; readonly index: number }[] = [];
  for (let index = 0; index < activities.length; index += 1) {
    const value = activities[index];
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (!(REFERENCE_CAPTURE_STREAM_SPORT_TYPES as readonly unknown[]).includes(row.type)) continue;
    if (typeof row.start_date_local !== "string") continue;
    const time = Date.parse(row.start_date_local);
    if (!Number.isFinite(time) || time < validPlan.stream_cutoff_epoch_ms) continue;
    const id = String(row.id);
    if (id.length === 0) throw new TypeError("capture stream activity ID is empty");
    candidates.push({ id, time, index });
  }
  candidates.sort((left, right) => right.time - left.time || left.index - right.index);
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    selected.push(candidate.id);
    if (selected.length === REFERENCE_CAPTURE_STREAM_LIMIT) break;
  }
  return selected;
}

export function validateReferenceCaptureManifest(value: unknown): ReferenceCaptureManifest {
  return ManifestSchema.parse(value);
}

export function serializeReferenceCaptureManifest(value: unknown): string {
  return `${canonicalJson(validateReferenceCaptureManifest(value))}\n`;
}

export function parseReferenceCaptureManifest(bytes: string | Uint8Array): ReferenceCaptureManifest {
  return exactParse(bytes, validateReferenceCaptureManifest, serializeReferenceCaptureManifest);
}

export interface ReferenceCaptureReplayDependencies {
  readonly readVerifiedSnapshot: (reference: SnapshotRef) => Promise<unknown>;
  readonly derivePayloadMembers: (
    plan: ReferenceCapturePlan,
    endpointPayloads: readonly ReferenceCaptureEndpointPayload[],
  ) => DerivedCaptureMembers | Promise<DerivedCaptureMembers>;
  readonly assertStoreEvidence: (
    record: RecordRef,
    lane: "settings" | "activities" | "wellness" | "streams",
  ) => Promise<void>;
}

function assertDerivedMembers(value: unknown): asserts value is DerivedCaptureMembers {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("derived capture members are invalid");
  const derived = value as Record<string, unknown>;
  if (Object.keys(derived).sort().join(",") !== "activities,selected_stream_ids,settings,streams,wellness") {
    throw new TypeError("derived capture members are invalid");
  }
  for (const lane of ["settings", "activities", "wellness", "streams"] as const) {
    if (!Array.isArray(derived[lane])) throw new TypeError("derived capture members are invalid");
    const ids = new Set<string>();
    for (const member of derived[lane]) {
      if (member === null || typeof member !== "object" || Array.isArray(member)) throw new TypeError("derived capture member is invalid");
      const item = member as Record<string, unknown>;
      if (Object.keys(item).sort().join(",") !== "endpoint_ordinal,external_id,payload,payload_index"
        || !Number.isSafeInteger(item.endpoint_ordinal) || (item.endpoint_ordinal as number) < 0
        || (item.payload_index !== null && (!Number.isSafeInteger(item.payload_index) || (item.payload_index as number) < 0))
        || typeof item.external_id !== "string" || item.external_id.length === 0 || ids.has(item.external_id)) {
        throw new TypeError("derived capture member is invalid");
      }
      ids.add(item.external_id);
    }
  }
  if (!Array.isArray(derived.selected_stream_ids) || derived.selected_stream_ids.some((id) => typeof id !== "string" || id.length === 0)
    || new Set(derived.selected_stream_ids as string[]).size !== derived.selected_stream_ids.length) {
    throw new TypeError("derived stream selection is invalid");
  }
}

export async function assertReferenceCaptureReplayable(
  input: unknown,
  dependencies: ReferenceCaptureReplayDependencies,
): Promise<void> {
  const manifest = validateReferenceCaptureManifest(input);
  const endpointPayloads: ReferenceCaptureEndpointPayload[] = [];
  for (const endpoint of manifest.endpoints) endpointPayloads.push({
    ordinal: endpoint.ordinal,
    lane: endpoint.lane,
    endpoint: endpoint.endpoint,
    request: endpoint.request,
    payload: await dependencies.readVerifiedSnapshot(endpoint.snapshot),
  });
  const recordPayloads = { settings: [] as unknown[], activities: [] as unknown[], wellness: [] as unknown[], streams: [] as unknown[] };
  for (const lane of ["settings", "activities", "wellness", "streams"] as const) {
    for (const record of manifest.records[lane]) recordPayloads[lane].push(await dependencies.readVerifiedSnapshot(record.snapshot));
  }

  const derived = await dependencies.derivePayloadMembers(manifest.plan, endpointPayloads);
  assertDerivedMembers(derived);
  for (const lane of ["settings", "activities", "wellness", "streams"] as const) {
    const expected = manifest.records[lane];
    const actual = derived[lane];
    if (actual.length !== expected.length) throw new Error("capture membership count differs");
    for (let index = 0; index < expected.length; index += 1) {
      const record = expected[index]!, member = actual[index]!;
      if (member.endpoint_ordinal !== record.endpoint_ordinal || member.payload_index !== record.payload_index
        || member.external_id !== record.external_id
        || canonicalJson(recordPayloads[lane][index]) !== canonicalJson(member.payload)) {
        throw new Error("capture membership differs");
      }
    }
  }
  if (canonicalJson(derived.selected_stream_ids) !== canonicalJson(manifest.selected_stream_ids)) {
    throw new Error("capture stream selection differs");
  }
  const derivedCapturedIds = derived.streams.map((member) => member.external_id.slice("streams:".length));
  if (canonicalJson(derivedCapturedIds) !== canonicalJson(manifest.captured_stream_ids)) {
    throw new Error("captured stream membership differs");
  }

  const derivedOrder = {
    endpoint_ordinals: endpointPayloads.map((_, index) => index),
    settings: derived.settings.map((member) => member.external_id),
    activities: derived.activities.map((member) => member.external_id),
    wellness: derived.wellness.map((member) => member.external_id),
    streams: derivedCapturedIds,
  };
  if (canonicalJson(derivedOrder) !== canonicalJson(manifest.deterministic_order)) {
    throw new Error("capture deterministic order differs");
  }
  for (const lane of ["settings", "activities", "wellness", "streams"] as const) {
    for (const record of manifest.records[lane]) await dependencies.assertStoreEvidence(record, lane);
  }
}
