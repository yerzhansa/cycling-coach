import { sortKeys } from "../store/canonical-json.js";
import { canonicalJson } from "../archive/canonical.js";
import type { ArchiveInstant, ArchiveWriteResult } from "../archive/types.js";
import type { SourceRecordRow } from "../store/ports.js";
import type { Candidate, ConcernValue } from "./canonical-pick.js";
import { QUALITY_RANK, assertQualityRank } from "./quality-rank.js";
import type { DedupCandidateSummary } from "./dedup.js";

export interface PlatformDedupInput {
  readonly sport_family: string;
  readonly is_transition: boolean;
  readonly start_utc: number;
  readonly duration_s: number;
  readonly distance_m: number | null;
}

export interface PlatformImportArtifact {
  readonly source: "intervals-icu";
  readonly activity_id: string | number;
  readonly activity: Readonly<Record<string, unknown>>;
  readonly dedup: PlatformDedupInput;
  readonly concerns: Readonly<Record<string, ConcernValue>>;
  readonly raw_snapshot_address: string | null;
  readonly raw_snapshot_rel_path: string | null;
  readonly sourceEvidence?: {
    readonly source: "intervals-icu";
    readonly lane: "activities";
    readonly externalId: string;
    readonly archiveInstant: ArchiveInstant;
    readonly archive: ArchiveWriteResult;
    readonly normalizedActivityJson: string;
  };
}

export interface PlatformPresentation {
  readonly row: SourceRecordRow;
  readonly candidate: Candidate;
  readonly summary: DedupCandidateSummary;
}

export type HashKey = (fields: readonly (string | number)[]) => Promise<string>;

export interface ActivityLandingEnvelope {
  readonly activity: Readonly<Record<string, unknown>>;
  readonly concerns: Readonly<Record<string, unknown>>;
  readonly dedup: Readonly<Record<string, unknown>>;
  readonly schema_version: 1;
}

function plainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseCanonicalProjectionValue(
  payloadJson: string,
  label: "activity" | "streams" | "settings",
): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try { parsed = JSON.parse(payloadJson); } catch { throw new TypeError(`${label} source evidence is invalid`); }
  if (!plainObject(parsed) || canonicalJson(parsed) !== payloadJson) {
    throw new TypeError(`${label} source evidence is invalid`);
  }
  return parsed;
}

export function parseActivityLandingEnvelope(payloadJson: string): ActivityLandingEnvelope {
  const parsed = parseCanonicalProjectionValue(payloadJson, "activity");
  if (Object.keys(parsed).sort().join(",") !== "activity,concerns,dedup,schema_version"
    || parsed.schema_version !== 1 || !plainObject(parsed.activity)
    || !plainObject(parsed.concerns) || !plainObject(parsed.dedup)) {
    throw new TypeError("activity source evidence is invalid");
  }
  return parsed as unknown as ActivityLandingEnvelope;
}

export function assertProjectionEvidenceEqual(
  persisted: unknown,
  decoded: unknown,
  label: "activity" | "streams" | "settings",
): void {
  if (canonicalJson(persisted) !== canonicalJson(decoded)) {
    throw new TypeError(`${label} source evidence mismatch`);
  }
}

function canonical(value: unknown): string { return JSON.stringify(sortKeys(value)); }

function externalId(value: unknown): string {
  if (typeof value === "string") {
    if (value.length === 0) throw new TypeError("platform activity id is empty");
    return value;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value) || Object.is(value, -0)) {
    throw new TypeError("platform activity id is invalid");
  }
  return String(value);
}

function finiteNonnegative(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`platform ${name} is invalid`);
  }
  return value;
}

function validateInput(platform: PlatformImportArtifact): void {
  if (platform.source !== "intervals-icu") throw new TypeError("unsupported platform source");
  externalId(platform.activity_id);
  if (platform.activity === null || typeof platform.activity !== "object" || Array.isArray(platform.activity)) {
    throw new TypeError("platform activity is invalid");
  }
  if (typeof platform.dedup.sport_family !== "string" || platform.dedup.sport_family.length === 0
      || typeof platform.dedup.is_transition !== "boolean") throw new TypeError("platform dedup shape is invalid");
  finiteNonnegative(platform.dedup.start_utc, "start");
  finiteNonnegative(platform.dedup.duration_s, "duration");
  if (platform.dedup.distance_m !== null) finiteNonnegative(platform.dedup.distance_m, "distance");
  if ((platform.raw_snapshot_address === null) !== (platform.raw_snapshot_rel_path === null)) {
    throw new TypeError("platform snapshot identity is incomplete");
  }
  if (platform.raw_snapshot_address !== null && !/^[0-9a-f]{64}$/.test(platform.raw_snapshot_address)) {
    throw new TypeError("platform snapshot address is invalid");
  }
  if (platform.sourceEvidence !== undefined) {
    const evidence = platform.sourceEvidence;
    if (evidence.source !== "intervals-icu" || evidence.lane !== "activities"
      || evidence.externalId !== externalId(platform.activity_id)
      || evidence.archive.address !== platform.raw_snapshot_address
      || evidence.archive.relPath !== platform.raw_snapshot_rel_path
      || typeof evidence.archive.relPath !== "string" || evidence.archive.relPath.length === 0
      || typeof evidence.archiveInstant.epochSeconds !== "number"
      || !Number.isSafeInteger(evidence.archiveInstant.epochSeconds) || evidence.archiveInstant.epochSeconds < 0) {
      throw new TypeError("platform source evidence is invalid");
    }
    assertProjectionEvidenceEqual(
      parseCanonicalProjectionValue(evidence.normalizedActivityJson, "activity"),
      platform.activity, "activity",
    );
  }
  const concerns = platform.concerns;
  if (concerns["session.sport"] !== platform.dedup.sport_family
      || concerns["session.start_utc"] !== platform.dedup.start_utc
      || concerns["session.elapsed_s"] !== platform.dedup.duration_s
      || concerns["session.is_transition"] !== platform.dedup.is_transition) {
    throw new TypeError("platform concerns disagree with dedup input");
  }
  if (!Object.hasOwn(concerns, "session.local_date_key") || !Object.hasOwn(concerns, "stream:time")) {
    throw new TypeError("platform concerns are incomplete");
  }
  if (Object.hasOwn(concerns, "session.distance_m")) {
    if (concerns["session.distance_m"] !== platform.dedup.distance_m) throw new TypeError("platform distance mismatch");
  } else if (platform.dedup.distance_m !== null) throw new TypeError("platform distance concern is missing");
  if (concerns["session.summary_json"] !== canonical(platform.activity)) throw new TypeError("platform summary is not canonical");
}

function payload(platform: PlatformImportArtifact): string {
  const envelope = {
    activity: platform.activity,
    concerns: platform.concerns,
    dedup: {
      distance_m: platform.dedup.distance_m,
      duration_s: platform.dedup.duration_s,
      is_transition: platform.dedup.is_transition,
      sport_family: platform.dedup.sport_family,
      start_utc: platform.dedup.start_utc,
    },
  };
  const payloadJson = platform.sourceEvidence === undefined
    ? canonical(envelope)
    : canonicalJson({ ...envelope, schema_version: 1 });
  if (platform.sourceEvidence !== undefined) parseActivityLandingEnvelope(payloadJson);
  return payloadJson;
}

export async function buildPlatformPresentation(platform: PlatformImportArtifact, hashKey: HashKey): Promise<PlatformPresentation> {
  validateInput(platform);
  const idValue = externalId(platform.activity_id);
  const id = await hashKey(["source_record", "intervals-icu", idValue]);
  if (!/^[0-9a-f]{64}$/.test(id)) throw new TypeError("source record key is invalid");
  const quality = assertQualityRank(QUALITY_RANK.PLATFORM_API);
  const row: SourceRecordRow = {
    id,
    workout_key: null,
    session_key: null,
    source: "intervals-icu",
    external_id: idValue,
    raw_sha256: platform.raw_snapshot_address,
    quality_rank: quality,
    payload_json: payload(platform),
  };
  const { candidate, summary } = candidateAndSummary(platform, row);
  return { row, candidate, summary };
}

function candidateAndSummary(platform: PlatformImportArtifact, row: SourceRecordRow): {
  readonly candidate: Candidate;
  readonly summary: DedupCandidateSummary;
} {
  const candidate: Candidate = {
    id: `platform_api:${row.id}:0:0`,
    origin: { kind: "platform", source: "intervals-icu", sourceRecordId: row.id, persistedQualityRank: row.quality_rank },
    workoutOrdinal: 0,
    sessionOrdinal: 0,
    rank: assertQualityRank(row.quality_rank),
    concerns: platform.concerns,
  };
  if (candidate.origin.kind !== "platform" || candidate.origin.persistedQualityRank !== QUALITY_RANK.PLATFORM_API
      || candidate.rank !== QUALITY_RANK.PLATFORM_API) throw new Error("platform quality invariant mismatch");
  const summary: DedupCandidateSummary = {
    candidate_id: candidate.id,
    member_id: row.id,
    source_kind: "platform_api",
    source_session_seq: 0,
    sport_family: platform.dedup.sport_family,
    is_transition: platform.dedup.is_transition,
    start_utc: platform.dedup.start_utc,
    duration_s: platform.dedup.duration_s,
    distance_m: platform.dedup.distance_m,
    file_id_manufacturer: null,
    file_id_serial: null,
    file_id_time_created_utc: null,
  };
  return { candidate, summary };
}

export function parseEnvelope(value: string): { readonly version: 0 | 1; activity: Readonly<Record<string, unknown>>; concerns: Readonly<Record<string, ConcernValue>>; dedup: PlatformDedupInput } {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("source record payload is invalid"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("source record envelope is invalid");
  const envelope = parsed as Record<string, unknown>;
  const keys = Object.keys(envelope).join(",");
  const version = keys === "activity,concerns,dedup" ? 0
    : keys === "activity,concerns,dedup,schema_version" && envelope.schema_version === 1 ? 1 : null;
  if (version === null) throw new Error("source record envelope is invalid");
  if (envelope.activity === null || typeof envelope.activity !== "object" || Array.isArray(envelope.activity)
      || envelope.concerns === null || typeof envelope.concerns !== "object" || Array.isArray(envelope.concerns)
      || envelope.dedup === null || typeof envelope.dedup !== "object" || Array.isArray(envelope.dedup)) {
    throw new Error("source record envelope is invalid");
  }
  const dedup = envelope.dedup as Record<string, unknown>;
  if (Object.keys(dedup).join(",") !== "distance_m,duration_s,is_transition,sport_family,start_utc") {
    throw new Error("source record dedup envelope is invalid");
  }
  return { version, activity: envelope.activity as Readonly<Record<string, unknown>>,
    concerns: envelope.concerns as Readonly<Record<string, ConcernValue>>, dedup: dedup as unknown as PlatformDedupInput };
}

export interface ReplayPlatformEvidence {
  readonly archiveRelPath: string | null;
  readonly archiveEpochSeconds: number | null;
}

export async function replayPlatformPresentation(
  row: SourceRecordRow,
  hashKey: HashKey,
  evidence: ReplayPlatformEvidence = { archiveRelPath: null, archiveEpochSeconds: null },
): Promise<PlatformPresentation> {
  if (row.source !== "intervals-icu" || row.quality_rank !== QUALITY_RANK.PLATFORM_API) throw new Error("unsupported source record");
  const envelope = parseEnvelope(row.payload_json);
  if ((evidence.archiveRelPath === null) !== (evidence.archiveEpochSeconds === null)
    || (evidence.archiveRelPath !== null && evidence.archiveRelPath.length === 0)
    || (evidence.archiveEpochSeconds !== null && (!Number.isSafeInteger(evidence.archiveEpochSeconds) || evidence.archiveEpochSeconds < 0))) {
    throw new Error("source record archive evidence is invalid");
  }
  const platform: PlatformImportArtifact = {
    source: "intervals-icu",
    activity_id: row.external_id,
    activity: envelope.activity,
    concerns: envelope.concerns,
    dedup: envelope.dedup,
    raw_snapshot_address: null,
    raw_snapshot_rel_path: null,
  };
  validateInput(platform);
  const expectedId = await hashKey(["source_record", "intervals-icu", row.external_id]);
  if (expectedId !== row.id || (envelope.version === 1 && canonicalJson(JSON.parse(row.payload_json)) !== row.payload_json)) {
    throw new Error("source record immutable mismatch");
  }
  const rebuilt = candidateAndSummary(platform, row);
  return { row: { ...row }, candidate: rebuilt.candidate, summary: rebuilt.summary };
}
