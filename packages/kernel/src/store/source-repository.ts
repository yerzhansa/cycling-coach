import { canonicalJson } from "../archive/canonical.js";
import { QUALITY_RANK } from "../ingest/quality-rank.js";
import { createAnchorRepository } from "./anchor-repository.js";
import { RawFileInvariantError, type ActivityRevisionDraft, type ActivityRevisionResult, type AnchorHistoryRow, type GenericLandingDraft, type IntervalsSourceRepository, type RawFileColumn, type RawFileRepository, type RawFileRow, type Row, type SourceArtifactDraft, type SourceRecordRepository, type SourceRecordRow, type SqlStore, type WellnessLandingRow, type ZoneSetHistoryRow } from "./ports.js";

export function createRawFileRepository(store: SqlStore): RawFileRepository {
  return {
    async upsert(row: RawFileRow): Promise<boolean> {
      const inserted = await store.get(
        "INSERT INTO raw_file (sha256, path, ext, bytes, file_id_serial, file_id_time_created_utc, manufacturer, product) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING sha256",
        [
          row.sha256,
          row.path,
          row.ext,
          row.bytes,
          row.file_id_serial,
          row.file_id_time_created_utc,
          row.manufacturer,
          row.product,
        ],
      );
      const selected = await store.get(
        "SELECT sha256, path, ext, bytes, file_id_serial, file_id_time_created_utc, manufacturer, product FROM raw_file WHERE sha256=?",
        [row.sha256],
      );
      const columns: readonly RawFileColumn[] = [
        "sha256",
        "path",
        "ext",
        "bytes",
        "file_id_serial",
        "file_id_time_created_utc",
        "manufacturer",
        "product",
      ];
      if (selected === undefined) throw new RawFileInvariantError(row.sha256, columns);
      const mismatched = columns.filter((column) => selected[column] !== row[column]);
      if (mismatched.length > 0) throw new RawFileInvariantError(row.sha256, mismatched);
      return inserted !== undefined;
    },
  };
}

export function createSourceRecordRepository(store: SqlStore): SourceRecordRepository {
  return {
    async upsert(row: SourceRecordRow): Promise<boolean> {
      const inserted = await store.get(
        "INSERT INTO source_record (id,workout_key,session_key,source,external_id,raw_sha256,quality_rank,payload_json) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING id",
        [
          row.id,
          row.workout_key,
          row.session_key,
          row.source,
          row.external_id,
          row.raw_sha256,
          row.quality_rank,
          row.payload_json,
        ],
      );
      if (inserted !== undefined) return true;
      const byId = await store.get(
        "SELECT id, source, external_id, raw_sha256, quality_rank, payload_json FROM source_record WHERE id = ?",
        [row.id],
      );
      const bySource = await store.get(
        "SELECT id, source, external_id, raw_sha256, quality_rank, payload_json FROM source_record WHERE source = ? AND external_id = ?",
        [row.source, row.external_id],
      );
      const exact = (selected: typeof byId): boolean => selected !== undefined
        && selected.id === row.id
        && selected.source === row.source
        && selected.external_id === row.external_id
        && selected.raw_sha256 === row.raw_sha256
        && selected.quality_rank === row.quality_rank
        && selected.payload_json === row.payload_json;
      if (!exact(byId) || !exact(bySource) || byId!.id !== bySource!.id) {
        throw new Error("source record invariant mismatch");
      }
      return false;
    },
  };
}

type HashKey = (fields: readonly (string | number)[]) => Promise<string>;
const HEX = /^[0-9a-f]{64}$/;
const SNAPSHOT_PATH = /^[0-9]{4}\/[0-9]{2}\/[0-9a-f]{64}\.json\.gz$/;

function nonempty(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} is invalid`);
}

function address(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !HEX.test(value)) throw new TypeError(`${name} is invalid`);
}

function snapshotPath(value: unknown, expectedAddress: string, name: string): asserts value is string {
  if (typeof value !== "string" || !SNAPSHOT_PATH.test(value)
    || value.split("/").at(-1) !== `${expectedAddress}.json.gz`) throw new TypeError(`${name} is invalid`);
}

function epoch(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} is invalid`);
}

function assertCanonicalJson(value: string, name: string): unknown {
  nonempty(value, name);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new TypeError(`${name} is invalid`); }
  if (canonicalJson(parsed) !== value) throw new TypeError(`${name} is not canonical`);
  return parsed;
}

function exactRow(selected: Row | undefined, expected: Readonly<Record<string, unknown>>, message: string): void {
  if (selected === undefined || Object.entries(expected).some(([key, value]) => selected[key] !== value)) {
    throw new Error(message);
  }
}

function parseActivityEnvelope(value: string): { readonly version: 0 | 1; readonly semantic: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("source record payload is invalid"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("source record envelope is invalid");
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).join(",");
  const version = keys === "activity,concerns,dedup" ? 0
    : keys === "activity,concerns,dedup,schema_version" && record.schema_version === 1 ? 1 : null;
  if (version === null) throw new Error("source record envelope is invalid");
  return { version, semantic: canonicalJson({ activity: record.activity, concerns: record.concerns, dedup: record.dedup }) };
}

function validateSourceRow(row: SourceRecordRow): void {
  address(row.id, "source record id");
  if (row.source !== "intervals-icu") throw new TypeError("source record source is invalid");
  nonempty(row.external_id, "source record external id");
  address(row.raw_sha256, "source record raw address");
  if (row.quality_rank !== QUALITY_RANK.PLATFORM_API) throw new TypeError("source record quality rank is invalid");
  if (row.workout_key !== null || row.session_key !== null) throw new TypeError("incoming source attachments must be null");
  const envelope = parseActivityEnvelope(row.payload_json);
  if (envelope.version !== 1 || canonicalJson(JSON.parse(row.payload_json)) !== row.payload_json) {
    throw new TypeError("activity revision payload must be canonical version 1");
  }
}

async function selectArtifact(store: SqlStore, artifactKey: string): Promise<Row> {
  const selected = await store.get(`SELECT artifact_key, source, lane, external_id, artifact_kind,
       archive_address, archive_rel_path, archive_epoch_s
FROM source_artifact
WHERE artifact_key = ?`, [artifactKey]);
  if (selected === undefined) throw new Error("source artifact is absent");
  return selected;
}

function exactSourcePresentation(selected: Row | undefined, row: SourceRecordRow, artifactKey: string): boolean {
  return selected !== undefined
    && selected.id === row.id
    && selected.source === row.source
    && selected.external_id === row.external_id
    && selected.raw_sha256 === row.raw_sha256
    && selected.quality_rank === row.quality_rank
    && selected.payload_json === row.payload_json
    && selected.artifact_key === artifactKey;
}

export function createIntervalsSourceRepository(store: SqlStore, hashKey: HashKey): IntervalsSourceRepository {
  const anchors = createAnchorRepository(store);

  async function recordArtifact(draft: SourceArtifactDraft): Promise<{ readonly artifactKey: string; readonly inserted: boolean }> {
    if (draft.source !== "intervals-icu") throw new TypeError("source artifact source is invalid");
    if (!["activities", "streams", "wellness", "settings", "bulk-fit"].includes(draft.lane)) throw new TypeError("source artifact lane is invalid");
    if ((draft.lane === "bulk-fit") !== (draft.artifactKind === "raw_file")) throw new TypeError("source artifact kind is invalid");
    nonempty(draft.externalId, "source artifact external id");
    address(draft.archiveAddress, "source artifact address");
    nonempty(draft.archiveRelPath, "source artifact path");
    epoch(draft.archiveEpochSeconds, "source artifact epoch");
    const artifactKey = await hashKey(["source_artifact", draft.source, draft.lane, draft.externalId,
      draft.archiveAddress, draft.archiveRelPath, draft.archiveEpochSeconds]);
    address(artifactKey, "source artifact key");
    const values = [artifactKey, draft.source, draft.lane, draft.externalId, draft.artifactKind,
      draft.archiveAddress, draft.archiveRelPath, draft.archiveEpochSeconds] as const;
    const inserted = await store.get(`INSERT INTO source_artifact (
  artifact_key, source, lane, external_id, artifact_kind,
  archive_address, archive_rel_path, archive_epoch_s
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT DO NOTHING
RETURNING artifact_key`, values);
    const columns = `artifact_key, source, lane, external_id, artifact_kind,
       archive_address, archive_rel_path, archive_epoch_s`;
    const byKey = await store.get(`SELECT ${columns} FROM source_artifact WHERE artifact_key = ?`, [artifactKey]);
    const byTuple = await store.get(`SELECT ${columns} FROM source_artifact
WHERE source = ? AND lane = ? AND external_id = ? AND archive_address = ?
  AND archive_rel_path = ? AND archive_epoch_s = ?`, [draft.source, draft.lane, draft.externalId,
      draft.archiveAddress, draft.archiveRelPath, draft.archiveEpochSeconds]);
    const expected = { artifact_key: artifactKey, source: draft.source, lane: draft.lane, external_id: draft.externalId,
      artifact_kind: draft.artifactKind, archive_address: draft.archiveAddress,
      archive_rel_path: draft.archiveRelPath, archive_epoch_s: draft.archiveEpochSeconds };
    exactRow(byKey, expected, "source artifact invariant mismatch");
    exactRow(byTuple, expected, "source artifact invariant mismatch");
    if (byKey!.artifact_key !== byTuple!.artifact_key) throw new Error("source artifact invariant mismatch");
    return { artifactKey, inserted: inserted !== undefined };
  }

  async function insertEvidenceSource(row: SourceRecordRow, artifactKey: string): Promise<boolean> {
    const inserted = await store.get(`INSERT INTO source_record (
  id, workout_key, session_key, source, external_id,
  raw_sha256, quality_rank, payload_json, artifact_key
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT DO NOTHING
RETURNING id`, [row.id, row.workout_key, row.session_key, row.source, row.external_id,
      row.raw_sha256, row.quality_rank, row.payload_json, artifactKey]);
    const columns = "id, source, external_id, raw_sha256, quality_rank, payload_json, artifact_key";
    const byId = await store.get(`SELECT ${columns} FROM source_record WHERE id = ?`, [row.id]);
    const bySource = await store.get(`SELECT ${columns} FROM source_record WHERE source = ? AND external_id = ?`, [row.source, row.external_id]);
    if (!exactSourcePresentation(byId, row, artifactKey) || !exactSourcePresentation(bySource, row, artifactKey)
      || byId!.id !== bySource!.id) throw new Error("source record invariant mismatch");
    return inserted !== undefined;
  }

  async function recordGenericLanding(draft: GenericLandingDraft): Promise<boolean> {
    nonempty(draft.externalId, "generic landing external id");
    address(draft.artifactKey, "generic landing artifact key");
    address(draft.archiveAddress, "generic landing archive address");
    const landing = assertCanonicalJson(draft.normalizedPayloadJson, "generic normalized payload");
    const expectedPrefix = `${draft.endpoint}:`;
    if (!draft.externalId.startsWith(expectedPrefix)) throw new TypeError("generic landing external id is invalid");
    const artifact = await selectArtifact(store, draft.artifactKey);
    exactRow(artifact, { artifact_key: draft.artifactKey, source: "intervals-icu", lane: draft.endpoint,
      artifact_kind: "snapshot", archive_address: draft.archiveAddress }, "generic landing artifact mismatch");
    const sourceRecordId = await hashKey(["source_record", "intervals-icu", draft.externalId]);
    address(sourceRecordId, "generic source record id");
    const payloadJson = canonicalJson({ endpoint: draft.endpoint, landing, schema_version: 1 });
    const row: SourceRecordRow = { id: sourceRecordId, workout_key: null, session_key: null, source: "intervals-icu",
      external_id: draft.externalId, raw_sha256: draft.archiveAddress, quality_rank: QUALITY_RANK.PLATFORM_API,
      payload_json: payloadJson };
    const existing = await store.get(`SELECT sr.id, sr.artifact_key, a.lane
FROM source_record AS sr
LEFT JOIN source_artifact AS a ON a.artifact_key = sr.artifact_key
WHERE sr.source = ? AND sr.external_id = ?`, ["intervals-icu", draft.externalId]);
    if (existing !== undefined && (existing.artifact_key === null || existing.lane !== draft.endpoint)) {
      throw new Error("generic landing external-id collision");
    }
    const inserted = await insertEvidenceSource(row, draft.artifactKey);
    const revision = await store.get(`SELECT revision_id, source_record_id, artifact_key, raw_sha256, quality_rank, payload_json
FROM source_record_revision WHERE source_record_id = ? AND revision_id = ?`, [sourceRecordId, sourceRecordId]);
    exactRow(revision, { revision_id: sourceRecordId, source_record_id: sourceRecordId, artifact_key: draft.artifactKey,
      raw_sha256: draft.archiveAddress, quality_rank: QUALITY_RANK.PLATFORM_API, payload_json: payloadJson },
    "generic landing revision mismatch");
    exactRow(await store.get("SELECT source_record_id, revision_id FROM source_record_current WHERE source_record_id = ?", [sourceRecordId]),
      { source_record_id: sourceRecordId, revision_id: sourceRecordId }, "generic landing selector mismatch");
    return inserted;
  }

  async function applyActivityRevision(draft: ActivityRevisionDraft): Promise<ActivityRevisionResult> {
    validateSourceRow(draft.sourceRow);
    address(draft.artifactKey, "activity artifact key");
    const row = draft.sourceRow;
    const artifact = await selectArtifact(store, draft.artifactKey);
    exactRow(artifact, { artifact_key: draft.artifactKey, source: "intervals-icu", lane: "activities",
      external_id: row.external_id, artifact_kind: "snapshot", archive_address: row.raw_sha256 },
    "activity source artifact mismatch");
    const existing = await store.get(`SELECT sr.id, sr.artifact_key, a.lane
FROM source_record AS sr
LEFT JOIN source_artifact AS a ON a.artifact_key = sr.artifact_key
WHERE sr.source = ? AND sr.external_id = ?`, ["intervals-icu", row.external_id]);
    if (existing === undefined) {
      if (!await insertEvidenceSource(row, draft.artifactKey)) throw new Error("source record insert race");
      return { kind: "inserted-current", revisionId: row.id, selectorChanged: true };
    }
    if (existing.id !== row.id) throw new Error("source record invariant mismatch");
    if (existing.artifact_key !== null && existing.lane !== "activities") throw new Error("generic landing external-id collision");
    const current = await store.get(`SELECT
  r.revision_id, r.source_record_id, r.artifact_key, r.raw_sha256, r.quality_rank, r.payload_json,
  a.source AS artifact_source, a.lane AS artifact_lane, a.external_id AS artifact_external_id,
  a.archive_address, a.archive_rel_path, a.archive_epoch_s
FROM source_record_current AS c
JOIN source_record_revision AS r
  ON r.source_record_id = c.source_record_id AND r.revision_id = c.revision_id
LEFT JOIN source_artifact AS a ON a.artifact_key = r.artifact_key
WHERE c.source_record_id = ?`, [row.id]);
    if (current === undefined) throw new Error("activity current revision is absent");
    const incomingEnvelope = parseActivityEnvelope(row.payload_json);
    const currentEnvelope = parseActivityEnvelope(String(current.payload_json));
    if (current.raw_sha256 === row.raw_sha256) {
      const exact = current.quality_rank === row.quality_rank && current.payload_json === row.payload_json
        && current.artifact_key === draft.artifactKey && current.artifact_source === "intervals-icu"
        && current.artifact_lane === "activities" && current.artifact_external_id === row.external_id
        && current.archive_address === row.raw_sha256 && typeof current.archive_rel_path === "string"
        && current.archive_rel_path.length > 0 && typeof current.archive_epoch_s === "number";
      if (currentEnvelope.version === 1 && exact) {
        return { kind: "exact-current", revisionId: String(current.revision_id), selectorChanged: false };
      }
      if ((currentEnvelope.version === 0 || current.artifact_key === null)
        && current.quality_rank === row.quality_rank && currentEnvelope.semantic === incomingEnvelope.semantic) {
        const revisionId = await appendRevision(row, draft.artifactKey);
        await selectRevision(row.id, revisionId, String(current.revision_id));
        return { kind: "hydrated-current", revisionId, selectorChanged: true };
      }
      throw new Error("activity landing disagrees with payload hash");
    }
    const known = await store.get(`SELECT revision_id, source_record_id, artifact_key, raw_sha256, quality_rank, payload_json
FROM source_record_revision
WHERE source_record_id = ? AND raw_sha256 = ? AND quality_rank = ? AND payload_json = ?
ORDER BY revision_id COLLATE BINARY ASC
LIMIT 1`, [row.id, row.raw_sha256, row.quality_rank, row.payload_json]);
    if (known !== undefined) {
      if (known.artifact_key !== draft.artifactKey) throw new Error("activity landing disagrees with payload hash");
      const revisionId = String(known.revision_id);
      await selectRevision(row.id, revisionId, String(current.revision_id));
      return { kind: "reselected-current", revisionId, selectorChanged: true };
    }
    const revisionId = await appendRevision(row, draft.artifactKey);
    await selectRevision(row.id, revisionId, String(current.revision_id));
    return { kind: "appended-current", revisionId, selectorChanged: true };
  }

  async function appendRevision(row: SourceRecordRow, artifactKey: string): Promise<string> {
    const revisionId = await hashKey(["source_record_revision", row.id, row.raw_sha256!,
      QUALITY_RANK.PLATFORM_API, row.payload_json]);
    address(revisionId, "source record revision id");
    await store.run(`INSERT INTO source_record_revision (
  revision_id, source_record_id, artifact_key, raw_sha256, quality_rank, payload_json
) VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT DO NOTHING`, [revisionId, row.id, artifactKey, row.raw_sha256, row.quality_rank, row.payload_json]);
    exactRow(await store.get(`SELECT revision_id, source_record_id, artifact_key, raw_sha256, quality_rank, payload_json
FROM source_record_revision WHERE revision_id = ?`, [revisionId]), { revision_id: revisionId,
      source_record_id: row.id, artifact_key: artifactKey, raw_sha256: row.raw_sha256,
      quality_rank: row.quality_rank, payload_json: row.payload_json }, "activity revision invariant mismatch");
    return revisionId;
  }

  async function selectRevision(sourceRecordId: string, revisionId: string, previousRevisionId: string): Promise<void> {
    if (revisionId === previousRevisionId) throw new Error("activity selector transition is unchanged");
    await store.run(`UPDATE source_record_current
SET revision_id = ?
WHERE source_record_id = ? AND revision_id != ?`, [revisionId, sourceRecordId, revisionId]);
    exactRow(await store.get("SELECT source_record_id, revision_id FROM source_record_current WHERE source_record_id = ?", [sourceRecordId]),
      { source_record_id: sourceRecordId, revision_id: revisionId }, "activity selector update failed");
  }

  async function upsertWellness(row: WellnessLandingRow): Promise<"inserted" | "updated" | "unchanged" | "manual-wins"> {
    address(row.id, "wellness id"); epoch(row.date_key, "wellness date key");
    if (row.provenance !== "sync" || row.source !== "intervals-icu" || row.device_id !== null
      || row.hlc_physical_ms !== null || row.hlc_counter !== null) throw new TypeError("wellness provenance is invalid");
    assertCanonicalJson(row.fields_json, "wellness fields");
    const existing = await store.get("SELECT * FROM wellness WHERE date_key = ?", [row.date_key]);
    if (existing === undefined) {
      await store.run(`INSERT INTO wellness (id,date_key,provenance,source,resting_hr,hrv,hrv_sdnn,sleep_s,sleep_score,weight_kg,soreness,fatigue,fields_json,device_id,hlc_physical_ms,hlc_counter)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [row.id, row.date_key, row.provenance, row.source, row.resting_hr, row.hrv,
        row.hrv_sdnn, row.sleep_s, row.sleep_score, row.weight_kg, row.soreness, row.fatigue, row.fields_json,
        row.device_id, row.hlc_physical_ms, row.hlc_counter]);
      return "inserted";
    }
    if (existing.provenance === "manual") return "manual-wins";
    if (existing.provenance !== "sync" || existing.source !== "intervals-icu" || existing.id !== row.id) {
      throw new Error("wellness source collision");
    }
    const expected = row as unknown as Readonly<Record<string, unknown>>;
    if (Object.entries(expected).every(([key, value]) => existing[key] === value)) return "unchanged";
    await store.run(`UPDATE wellness SET resting_hr=?,hrv=?,hrv_sdnn=?,sleep_s=?,sleep_score=?,weight_kg=?,soreness=?,fatigue=?,fields_json=?
WHERE date_key=? AND provenance='sync' AND source='intervals-icu'`, [row.resting_hr, row.hrv, row.hrv_sdnn,
      row.sleep_s, row.sleep_score, row.weight_kg, row.soreness, row.fatigue, row.fields_json, row.date_key]);
    exactRow(await store.get("SELECT * FROM wellness WHERE date_key = ?", [row.date_key]), expected, "wellness update mismatch");
    return "updated";
  }

  async function insertSyncedAnchor(row: AnchorHistoryRow): Promise<boolean> {
    if (row.source !== "intervals-icu" || row.provenance !== "sync" || row.confidence !== "platform"
      || row.note !== null || row.device_id !== null || row.hlc_physical_ms !== null || row.hlc_counter !== null) {
      throw new TypeError("anchor provenance is invalid");
    }
    address(row.id, "anchor id"); nonempty(row.sport, "anchor sport"); epoch(row.valid_from, "anchor valid from");
    const inserted = await anchors.insertIfAbsent(row);
    exactRow(await store.get("SELECT * FROM anchor_history WHERE sport=? AND anchor_type=? AND valid_from=?",
      [row.sport, row.anchor_type, row.valid_from]), row as unknown as Readonly<Record<string, unknown>>, "anchor history mismatch");
    return inserted;
  }

  async function insertSyncedZone(row: ZoneSetHistoryRow): Promise<boolean> {
    if (row.source !== "intervals-icu" || row.provenance !== "sync" || row.device_id !== null
      || row.hlc_physical_ms !== null || row.hlc_counter !== null) throw new TypeError("zone provenance is invalid");
    address(row.id, "zone id"); nonempty(row.sport, "zone sport"); epoch(row.valid_from, "zone valid from");
    assertCanonicalJson(row.boundaries_json, "zone boundaries");
    const inserted = await store.get(`INSERT INTO zone_set_history (id,sport,stream,anchor_ref,boundaries_json,valid_from,source,provenance,device_id,hlc_physical_ms,hlc_counter)
VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING id`, [row.id, row.sport, row.stream, row.anchor_ref,
      row.boundaries_json, row.valid_from, row.source, row.provenance, row.device_id, row.hlc_physical_ms, row.hlc_counter]);
    exactRow(await store.get("SELECT * FROM zone_set_history WHERE id=?", [row.id]),
      row as unknown as Readonly<Record<string, unknown>>, "zone history mismatch");
    return inserted !== undefined;
  }

  async function readCurrentCaptureEvidence(
    lane: "activities" | "settings" | "streams",
    externalId: string,
  ): Promise<{ artifactKey: string; archiveAddress: string; archiveRelPath: string; sourceRecordId: string; revisionId: string }> {
    if (!["activities", "settings", "streams"].includes(lane)) throw new TypeError("capture evidence lane is invalid");
    nonempty(externalId, "capture evidence external id");
    const rows = await store.all(`SELECT
  a.artifact_key, a.archive_address, a.archive_rel_path,
  r.source_record_id, r.revision_id
FROM source_record_current AS c
JOIN source_record_revision AS r
  ON r.source_record_id = c.source_record_id AND r.revision_id = c.revision_id
JOIN source_record AS sr ON sr.id = r.source_record_id
JOIN source_artifact AS a ON a.artifact_key = r.artifact_key
WHERE sr.source = 'intervals-icu' AND sr.external_id = ?
  AND a.source = 'intervals-icu' AND a.lane = ? AND a.external_id = ?`, [externalId, lane, externalId]);
    if (rows.length !== 1) throw new Error("current capture evidence is absent or ambiguous");
    const row = rows[0]!;
    address(row.artifact_key, "capture artifact key");
    address(row.archive_address, "capture archive address");
    snapshotPath(row.archive_rel_path, row.archive_address, "capture archive path");
    address(row.source_record_id, "capture source record id");
    address(row.revision_id, "capture revision id");
    return { artifactKey: row.artifact_key, archiveAddress: row.archive_address,
      archiveRelPath: row.archive_rel_path, sourceRecordId: row.source_record_id, revisionId: row.revision_id };
  }

  async function assertPinnedCaptureEvidence(input: {
    lane: "activities" | "settings" | "streams" | "wellness";
    externalId: string;
    artifactKey: string;
    archiveAddress: string;
    archiveRelPath: string;
    currentRevision: { sourceRecordId: string; revisionId: string } | null;
  }): Promise<void> {
    if (input === null || typeof input !== "object"
      || !["activities", "settings", "streams", "wellness"].includes(input.lane)) {
      throw new TypeError("pinned capture evidence is invalid");
    }
    nonempty(input.externalId, "pinned capture external id");
    address(input.artifactKey, "pinned capture artifact key");
    address(input.archiveAddress, "pinned capture archive address");
    snapshotPath(input.archiveRelPath, input.archiveAddress, "pinned capture archive path");
    const artifact = await store.get(`SELECT artifact_key, source, lane, external_id, artifact_kind,
       archive_address, archive_rel_path
FROM source_artifact WHERE artifact_key = ?`, [input.artifactKey]);
    exactRow(artifact, { artifact_key: input.artifactKey, source: "intervals-icu", lane: input.lane,
      external_id: input.externalId, artifact_kind: "snapshot", archive_address: input.archiveAddress,
      archive_rel_path: input.archiveRelPath }, "pinned capture artifact mismatch");
    if (input.lane === "wellness") {
      if (input.currentRevision !== null) throw new TypeError("wellness capture revision must be null");
      const attached = await store.get("SELECT id FROM source_record WHERE artifact_key = ?", [input.artifactKey]);
      if (attached !== undefined) throw new Error("wellness capture artifact has a source record");
      return;
    }
    if (input.currentRevision === null) throw new TypeError("pinned capture revision is absent");
    address(input.currentRevision.sourceRecordId, "pinned source record id");
    address(input.currentRevision.revisionId, "pinned revision id");
    const revision = await store.get(`SELECT
  r.source_record_id, r.revision_id, r.artifact_key,
  sr.source, sr.external_id,
  a.source AS artifact_source, a.lane, a.external_id AS artifact_external_id,
  a.artifact_kind, a.archive_address, a.archive_rel_path
FROM source_record_revision AS r
JOIN source_record AS sr ON sr.id = r.source_record_id
JOIN source_artifact AS a ON a.artifact_key = r.artifact_key
WHERE r.source_record_id = ? AND r.revision_id = ?`,
    [input.currentRevision.sourceRecordId, input.currentRevision.revisionId]);
    exactRow(revision, { source_record_id: input.currentRevision.sourceRecordId,
      revision_id: input.currentRevision.revisionId, artifact_key: input.artifactKey,
      source: "intervals-icu", external_id: input.externalId, artifact_source: "intervals-icu",
      lane: input.lane, artifact_external_id: input.externalId, artifact_kind: "snapshot",
      archive_address: input.archiveAddress, archive_rel_path: input.archiveRelPath },
    "pinned capture revision mismatch");
  }

  return { recordArtifact, recordGenericLanding, applyActivityRevision, upsertWellness, insertSyncedAnchor,
    insertSyncedZone, readCurrentCaptureEvidence, assertPinnedCaptureEvidence };
}
