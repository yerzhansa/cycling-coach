import type { Row, SqlStore } from "./ports.js";

export const ACTIVITY_ANALYSIS_PROJECTION_CONTRACT_VERSION = 1 as const;
export const ACTIVITY_ANALYSIS_PROJECTION_MAX_BYTES = 256 * 1_024;
export const ACTIVITY_ANALYSIS_PROJECTION_MAX_REVISIONS = 128;
export const ACTIVITY_ANALYSIS_PROJECTION_MAX_TOTAL_BYTES = 64 * 1_024 * 1_024;

export const ACTIVITY_ANALYSIS_PROJECTION_SECTIONS = [
  "aerobic-drift",
  "intervals",
  "best-efforts",
  "power-distribution",
  "heart-rate-distribution",
  "power-heart-rate",
] as const;

export type ActivityAnalysisProjectionSection =
  (typeof ACTIVITY_ANALYSIS_PROJECTION_SECTIONS)[number];
export type ActivityAnalysisProjectionSource = "local-canonical" | "provider";

export interface ActivityAnalysisProjectionKey {
  readonly canonicalActivityId: string;
  readonly sourceRevision: string;
  readonly contractVersion: typeof ACTIVITY_ANALYSIS_PROJECTION_CONTRACT_VERSION;
  readonly section: ActivityAnalysisProjectionSection;
}

export interface ActivityAnalysisProjection extends ActivityAnalysisProjectionKey {
  readonly source: ActivityAnalysisProjectionSource;
  readonly observedAt: string;
  readonly dataJson: string;
}

export interface ActivityAnalysisProjectionRepository {
  read(
    key: ActivityAnalysisProjectionKey,
    accessedEpochSeconds: number,
  ): Promise<ActivityAnalysisProjection | undefined>;
  write(
    value: ActivityAnalysisProjection,
    cachedEpochSeconds: number,
  ): Promise<void>;
}

export class ActivityAnalysisProjectionError extends Error {
  readonly code: "invalid-input" | "invalid-row";

  constructor(code: "invalid-input" | "invalid-row") {
    super(`activity analysis projection rejected: ${code}`);
    this.name = "ActivityAnalysisProjectionError";
    this.code = code;
  }
}

const HASH = /^[0-9a-f]{64}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SECTION_SET = new Set<string>(ACTIVITY_ANALYSIS_PROJECTION_SECTIONS);

function invalidInput(): never {
  throw new ActivityAnalysisProjectionError("invalid-input");
}

function invalidRow(): never {
  throw new ActivityAnalysisProjectionError("invalid-row");
}

function validEpochSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validInstant(value: unknown): value is string {
  if (typeof value !== "string" || !INSTANT.test(value)) return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function validJson(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes < 2 || bytes > ACTIVITY_ANALYSIS_PROJECTION_MAX_BYTES) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function validateKey(value: ActivityAnalysisProjectionKey): void {
  if (
    value === null
    || typeof value !== "object"
    || !HASH.test(value.canonicalActivityId)
    || !HASH.test(value.sourceRevision)
    || value.contractVersion !== ACTIVITY_ANALYSIS_PROJECTION_CONTRACT_VERSION
    || !SECTION_SET.has(value.section)
  ) {
    invalidInput();
  }
}

function projectionFromRow(row: Row, key: ActivityAnalysisProjectionKey): ActivityAnalysisProjection {
  const source = row.source;
  const observedAt = row.observed_at;
  const dataJson = row.data_json;
  if (
    (source !== "local-canonical" && source !== "provider")
    || !validInstant(observedAt)
    || !validJson(dataJson)
  ) {
    invalidRow();
  }
  return Object.freeze({ ...key, source, observedAt, dataJson });
}

interface RevisionUsage {
  readonly canonicalActivityId: string;
  readonly sourceRevision: string;
  readonly bytes: number;
  readonly accessedEpochSeconds: number;
}

function revisionUsage(row: Row): RevisionUsage {
  if (
    typeof row.canonical_activity_id !== "string"
    || !HASH.test(row.canonical_activity_id)
    || typeof row.source_revision !== "string"
    || !HASH.test(row.source_revision)
    || typeof row.bytes !== "number"
    || !Number.isSafeInteger(row.bytes)
    || row.bytes < 0
    || !validEpochSeconds(row.accessed_epoch_s)
  ) {
    invalidRow();
  }
  return {
    canonicalActivityId: row.canonical_activity_id,
    sourceRevision: row.source_revision,
    bytes: row.bytes,
    accessedEpochSeconds: row.accessed_epoch_s,
  };
}

async function prune(store: SqlStore): Promise<void> {
  const revisions = (await store.all(`SELECT
  canonical_activity_id,
  source_revision,
  sum(length(CAST(data_json AS BLOB))) AS bytes,
  max(accessed_epoch_s) AS accessed_epoch_s
FROM activity_analysis_projection
GROUP BY canonical_activity_id, source_revision
ORDER BY accessed_epoch_s DESC, canonical_activity_id DESC, source_revision DESC`)).map(
    revisionUsage,
  );
  let retainedBytes = 0;
  for (let index = 0; index < revisions.length; index += 1) {
    const revision = revisions[index]!;
    retainedBytes += revision.bytes;
    if (
      index < ACTIVITY_ANALYSIS_PROJECTION_MAX_REVISIONS
      && retainedBytes <= ACTIVITY_ANALYSIS_PROJECTION_MAX_TOTAL_BYTES
    ) {
      continue;
    }
    await store.run(
      `DELETE FROM activity_analysis_projection
WHERE canonical_activity_id = ? AND source_revision = ?`,
      [revision.canonicalActivityId, revision.sourceRevision],
    );
  }
}

export function createActivityAnalysisProjectionRepository(
  store: SqlStore,
): ActivityAnalysisProjectionRepository {
  return Object.freeze({
    async read(key: ActivityAnalysisProjectionKey, accessedEpochSeconds: number) {
      validateKey(key);
      if (!validEpochSeconds(accessedEpochSeconds)) invalidInput();
      const row = await store.get(`SELECT source, observed_at, data_json
FROM activity_analysis_projection
WHERE canonical_activity_id = ?
  AND source_revision = ?
  AND contract_version = ?
  AND section = ?`, [
        key.canonicalActivityId,
        key.sourceRevision,
        key.contractVersion,
        key.section,
      ]);
      if (row === undefined) return undefined;
      const projection = projectionFromRow(row, key);
      await store.run(`UPDATE activity_analysis_projection
SET accessed_epoch_s = max(accessed_epoch_s, ?)
WHERE canonical_activity_id = ?
  AND source_revision = ?
  AND contract_version = ?
  AND section = ?`, [
        accessedEpochSeconds,
        key.canonicalActivityId,
        key.sourceRevision,
        key.contractVersion,
        key.section,
      ]);
      return projection;
    },

    async write(value: ActivityAnalysisProjection, cachedEpochSeconds: number) {
      validateKey(value);
      if (
        (value.source !== "local-canonical" && value.source !== "provider")
        || !validInstant(value.observedAt)
        || !validJson(value.dataJson)
        || !validEpochSeconds(cachedEpochSeconds)
      ) {
        invalidInput();
      }
      await store.run(`INSERT INTO activity_analysis_projection (
  canonical_activity_id,
  source_revision,
  contract_version,
  section,
  source,
  observed_at,
  data_json,
  cached_epoch_s,
  accessed_epoch_s
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (canonical_activity_id, source_revision, contract_version, section)
DO UPDATE SET
  source = excluded.source,
  observed_at = excluded.observed_at,
  data_json = excluded.data_json,
  cached_epoch_s = excluded.cached_epoch_s,
  accessed_epoch_s = excluded.accessed_epoch_s`, [
        value.canonicalActivityId,
        value.sourceRevision,
        value.contractVersion,
        value.section,
        value.source,
        value.observedAt,
        value.dataJson,
        cachedEpochSeconds,
        cachedEpochSeconds,
      ]);
      await prune(store);
    },
  });
}
