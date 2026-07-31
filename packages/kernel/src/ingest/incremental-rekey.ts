import { assertValidAddress } from "../archive/paths.js";
import { sortKeys } from "../store/canonical-json.js";
import { createDedupConfirmationRepository } from "../store/dedup-confirmation-repository.js";
import { createIntervalsSourceRepository, createRawFileRepository, createSourceRecordRepository } from "../store/source-repository.js";
import type { RawFileRow, Row, SqlValue } from "../store/ports.js";
import type { Candidate } from "./canonical-pick.js";
import { planBrickAdjacencyFromTopology, type SportSettingInput } from "./brick-adjacency.js";
import {
  dedupPairStates,
  evaluateIncrementalDedupPairs,
  planDedupFromPairStates,
  type DedupCandidateSummary,
  type DedupPairState,
  type OverlapDiagnostic,
  type PairDiagnostic,
} from "./dedup.js";
import {
  buildIncrementalClusterShapes,
  importArtifactsWithReport,
  incrementalCandidateCacheRow,
  incrementalSessionCacheRows,
  orphanReports,
  planClusters,
  readRepairFixerSettings,
  readSelectedSourceRows,
  readSourceRevisionState,
  sourcePresentationRow,
  type IncrementalCandidateCacheRow,
} from "./dedup-rekey.js";
import { buildPlatformPresentation, replayPlatformPresentation, type PlatformPresentation } from "./source-ledger.js";
import { DEFAULT_TRANSITION_WINDOW_S } from "./brick-adjacency.js";
import { DEFAULT_TIER3_THRESHOLDS } from "./dedup.js";
import { FIT_INGEST_VERSION } from "./types.js";
import { qualityRankForFile, QUALITY_RANK } from "./quality-rank.js";
import type { FileReport, ImportArtifact, ImportBatch, ImportReport, ImportReportDeps, PreparedFile, PreparedRepairEvent } from "./import-report.js";

function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function canonical(value: unknown): string { return JSON.stringify(sortKeys(value)); }
function nonempty(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`invalid ${name}`);
  return value;
}
function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`invalid ${name}`);
  return value;
}

interface PreparedAddress { readonly prepared: PreparedFile; readonly row: RawFileRow; }

function exactPrepared(left: PreparedFile, right: PreparedFile): boolean {
  return canonical({ ...left, archive_instant: left.archive_instant }) === canonical({ ...right, archive_instant: right.archive_instant });
}

function rawRow(row: Row): RawFileRow {
  const sha256 = nonempty(row.sha256, "raw SHA"); assertValidAddress(sha256);
  const ext = row.ext;
  if (ext !== "fit" && ext !== "tcx" && ext !== "gpx") throw new TypeError("invalid raw extension");
  const nullableInteger = (value: unknown): number | null => value === null ? null : integer(value, "raw identity integer");
  const nullableString = (value: unknown): string | null => value === null ? null : nonempty(value, "raw identity string");
  return { sha256, path: nonempty(row.path, "raw path"), ext, bytes: integer(row.bytes, "raw byte count"),
    file_id_serial: nullableInteger(row.file_id_serial), file_id_time_created_utc: nullableInteger(row.file_id_time_created_utc),
    manufacturer: nullableString(row.manufacturer), product: nullableString(row.product) };
}

function summaryFromCache(row: Row): DedupCandidateSummary {
  const json = nonempty(row.candidate_summary_json, "candidate summary");
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw new Error("candidate cache disagreement"); }
  if (canonical(parsed) !== json) throw new Error("candidate cache disagreement");
  const summary = parsed as DedupCandidateSummary;
  const expected = {
    candidate_id: row.candidate_id, member_id: row.member_id, source_kind: row.source_kind,
    source_session_seq: row.source_session_seq, sport_family: row.sport_family,
    is_transition: row.is_transition === 1, start_utc: row.start_utc, duration_s: row.duration_s,
    distance_m: row.distance_m, file_id_manufacturer: row.file_id_manufacturer,
    file_id_serial: row.file_id_serial, file_id_time_created_utc: row.file_id_time_created_utc,
  };
  if (canonical(summary) !== canonical(expected)) throw new Error("candidate cache disagreement");
  return summary;
}

function diagnosticFromCache<T extends PairDiagnostic>(
  value: unknown,
  row: Row,
  name: string,
): T | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("dedup pair cache disagreement");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("dedup pair cache disagreement"); }
  if (canonical(parsed) !== value || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("dedup pair cache disagreement");
  }
  const diagnostic = parsed as PairDiagnostic;
  // The diagnostic payload keeps evaluation orientation (member-id order)
  // while the cache row key is candidate-id ordered; the two orderings can
  // legitimately disagree, so the pair is compared as an unordered set.
  const samePair = (diagnostic.candidate_a === row.candidate_a && diagnostic.candidate_b === row.candidate_b)
    || (diagnostic.candidate_a === row.candidate_b && diagnostic.candidate_b === row.candidate_a);
  if (!samePair || typeof diagnostic.reason !== "string" || diagnostic.reason.length === 0) {
    throw new Error(`dedup pair cache disagreement: ${name}`);
  }
  return diagnostic as T;
}

function pairStateFromCache(row: Row): DedupPairState {
  const candidateA = nonempty(row.candidate_a, "pair candidate A"), candidateB = nonempty(row.candidate_b, "pair candidate B");
  if (candidateA >= candidateB) throw new Error("dedup pair cache disagreement");
  const edge = row.edge_tier;
  if (edge !== null && edge !== "tier2" && edge !== "tier3" && edge !== "confirmation") {
    throw new Error("dedup pair cache disagreement");
  }
  const source = { ...row, candidate_a: candidateA, candidate_b: candidateB };
  const state: DedupPairState = { candidate_a: candidateA, candidate_b: candidateB, edge_tier: edge,
    threshold_near_miss: diagnosticFromCache<PairDiagnostic>(row.threshold_near_miss_json, source, "near miss"),
    overlap_watchlist: diagnosticFromCache<OverlapDiagnostic>(row.overlap_watchlist_json, source, "overlap"),
    confirm_queue: diagnosticFromCache<PairDiagnostic>(row.confirm_queue_json, source, "confirmation") };
  if (state.edge_tier === null && state.threshold_near_miss === null && state.overlap_watchlist === null && state.confirm_queue === null) {
    throw new Error("dedup pair cache disagreement");
  }
  return state;
}

function placeholder(row: Row, summary: DedupCandidateSummary): Candidate {
  const artifactId = nonempty(row.artifact_id, "candidate artifact");
  if (row.artifact_kind === "raw_file") {
    if (summary.source_kind === "platform_api") throw new Error("candidate cache disagreement");
    return { id: summary.candidate_id, origin: { kind: "file", format: summary.source_kind, rawSha256: artifactId },
      workoutOrdinal: 0, sessionOrdinal: summary.source_session_seq, rank: qualityRankForFile(summary.source_kind), concerns: {} };
  }
  if (row.artifact_kind !== "source_record" || summary.source_kind !== "platform_api") throw new Error("candidate cache disagreement");
  return { id: summary.candidate_id, origin: { kind: "platform", source: "intervals-icu", sourceRecordId: artifactId,
    persistedQualityRank: QUALITY_RANK.PLATFORM_API }, workoutOrdinal: 0, sessionOrdinal: summary.source_session_seq,
    rank: QUALITY_RANK.PLATFORM_API, concerns: {} };
}

async function phase<T>(deps: ImportReportDeps, name: "archive-decode" | "topology" | "sqlite", work: () => Promise<T>): Promise<T> {
  return deps.measurePhase === undefined ? work() : deps.measurePhase(name, work);
}

function cacheRowValues(row: IncrementalCandidateCacheRow): readonly SqlValue[] {
  return [row.candidate_id, row.artifact_kind, row.artifact_id, row.member_id, row.source_kind, row.source_session_seq,
    row.sport_family, row.is_transition, row.start_utc, row.duration_s, row.distance_m, row.file_id_manufacturer,
    row.file_id_serial, row.file_id_time_created_utc, row.candidate_summary_json];
}

async function snapshotInputs(deps: ImportReportDeps): Promise<string> {
  const tables = ["ingest_metadata", "ingest_incremental_state", "raw_file", "source_artifact", "source_record",
    "source_record_revision", "source_record_current", "dedup_confirmation", "sport_settings", "repair_fixer_settings",
    "ingest_candidate_index", "ingest_dedup_pair_state", "ingest_dedup_session_state", "ingest_cluster_state"];
  const values: Record<string, readonly Row[]> = {};
  for (const table of tables) values[table] = await deps.store.all(`SELECT * FROM ${table} ORDER BY rowid ASC`);
  return canonical(values);
}

export async function importArtifactsIncrementally(batch: ImportBatch, deps: ImportReportDeps): Promise<ImportReport> {
  if (batch.files.length + batch.platform_records.length === 0) throw new TypeError("import batch is empty");
  if (deps.ingestVersion !== FIT_INGEST_VERSION) throw new Error("ingest dependency version mismatch");
  const metadata = await deps.store.get("SELECT ingest_version FROM ingest_metadata WHERE singleton=1");
  if (metadata === undefined || typeof metadata.ingest_version !== "number") throw new Error("ingest metadata invariant mismatch");
  if (metadata.ingest_version > deps.ingestVersion) throw new Error("store uses newer ingest semantics");
  if (metadata.ingest_version < deps.ingestVersion) return importArtifactsWithReport(batch, deps);
  const state = await deps.store.get("SELECT initialized FROM ingest_incremental_state WHERE singleton=1");
  if (state === undefined || (state.initialized !== 0 && state.initialized !== 1)) throw new Error("incremental state invariant mismatch");
  if (state.initialized === 0) {
    const counts = await Promise.all([deps.store.get("SELECT COUNT(*) AS n FROM raw_file"), deps.store.get("SELECT COUNT(*) AS n FROM source_record")]);
    if (counts.some((row) => row === undefined || typeof row.n !== "number")) throw new Error("input count invariant mismatch");
    if (counts.some((row) => row!.n !== 0)) return importArtifactsWithReport(batch, deps);
  }

  const settings = await readRepairFixerSettings(deps.store);
  const inputPaths = new Set<string>();
  const incomingAddresses = new Map<string, PreparedAddress>();
  const fileReports: { readonly report: FileReport; readonly address: string }[] = [];
  for (const file of [...batch.files].sort((a, b) => compareText(a.input_path, b.input_path))) {
    if (typeof file.input_path !== "string" || file.input_path.length === 0 || inputPaths.has(file.input_path)) throw new TypeError("duplicate or invalid input path");
    inputPaths.add(file.input_path);
    const result = await phase(deps, "archive-decode", () => deps.prepareFile({ ...file, bytes: new Uint8Array(file.bytes) }, settings));
    if (result.outcome === "quarantined") {
      const archived = await phase(deps, "archive-decode", () =>
        deps.archive.quarantine(file.bytes, file.ext, `${canonical(result.quarantine)}\n`));
      fileReports.push({ address: archived.address, report: { input_path: file.input_path, address: archived.address, ext: file.ext,
        archive_deduped: archived.deduped, raw_file_inserted: false, outcome: "quarantined", quarantine: result.quarantine } });
      continue;
    }
    const prepared = result.value;
    const archived = await phase(deps, "archive-decode", () =>
      deps.archive.writeArtifact(file.bytes, file.ext, prepared.archive_instant));
    if (archived.address !== prepared.expected_address) throw new Error("archive address mismatch");
    const row: RawFileRow = { ...prepared.raw_file, path: archived.relPath };
    const prior = incomingAddresses.get(archived.address);
    if (prior !== undefined && (!exactPrepared(prior.prepared, prepared) || canonical(prior.row) !== canonical(row))) {
      throw new Error("same-address preparation conflict");
    }
    incomingAddresses.set(archived.address, prior ?? { prepared, row });
    fileReports.push({ address: archived.address, report: { input_path: file.input_path, address: archived.address, ext: file.ext,
      archive_deduped: archived.deduped, raw_file_inserted: false, outcome: "imported", quarantine: null } });
  }

  const incomingPlatforms = new Map<string, PlatformPresentation>();
  for (const artifact of batch.platform_records) {
    const presentation = await buildPlatformPresentation(artifact, deps.hashKey);
    const prior = incomingPlatforms.get(presentation.row.id);
    if (prior !== undefined && canonical(prior.row) !== canonical(presentation.row)) throw new Error("platform source conflict");
    incomingPlatforms.set(presentation.row.id, presentation);
  }

  const selectedSources = new Map((await readSelectedSourceRows(deps.store)).map((row) => [row.id, row]));
  for (const presentation of incomingPlatforms.values()) {
    const selected = selectedSources.get(presentation.row.id);
    if (selected !== undefined
      && canonical({ ...sourcePresentationRow(selected), workout_key: null, session_key: null }) !== canonical(presentation.row)) {
      return importArtifactsWithReport(batch, deps);
    }
  }

  const cachedRows = await deps.store.all("SELECT * FROM ingest_candidate_index ORDER BY candidate_id COLLATE BINARY ASC");
  const cachedCandidates = new Map<string, { readonly row: Row; readonly summary: DedupCandidateSummary; readonly candidate: Candidate }>();
  for (const row of cachedRows) {
    const summary = summaryFromCache(row), candidate = placeholder(row, summary);
    cachedCandidates.set(summary.candidate_id, { row, summary, candidate });
  }
  const incomingCandidates: Candidate[] = [];
  const incomingSummaries: DedupCandidateSummary[] = [];
  const eventsByCandidate = new Map<string, readonly PreparedRepairEvent[]>();
  for (const [address, entry] of incomingAddresses) {
    for (const candidate of entry.prepared.candidates) {
      incomingCandidates.push(candidate);
      eventsByCandidate.set(candidate.id, entry.prepared.repair_events.filter((event) => event.candidate_id === candidate.id));
    }
    for (const summary of entry.prepared.summaries) incomingSummaries.push(summary);
    const existing = await deps.store.get("SELECT * FROM raw_file WHERE sha256=?", [address]);
    if (existing !== undefined && canonical(rawRow(existing)) !== canonical(entry.row)) throw new Error("incoming raw artifact conflicts with persisted source");
  }
  for (const presentation of incomingPlatforms.values()) {
    incomingCandidates.push(presentation.candidate); incomingSummaries.push(presentation.summary);
  }

  const newIds = new Set<string>();
  for (let index = 0; index < incomingCandidates.length; index += 1) {
    const candidate = incomingCandidates[index]!, summary = incomingSummaries.find((value) => value.candidate_id === candidate.id)!;
    const expected = incrementalCandidateCacheRow(candidate, summary), cached = cachedCandidates.get(candidate.id);
    if (cached === undefined) newIds.add(candidate.id);
    else if (canonical(expected) !== canonical(Object.fromEntries(Object.keys(expected).map((key) => [key, cached.row[key]])))) {
      throw new Error("candidate cache disagreement");
    }
  }
  const allSummaryById = new Map<string, DedupCandidateSummary>([...cachedCandidates.values()].map(({ summary }) => [summary.candidate_id, summary]));
  const allCandidateById = new Map<string, Candidate>([...cachedCandidates.values()].map(({ candidate }) => [candidate.id, candidate]));
  for (const summary of incomingSummaries) allSummaryById.set(summary.candidate_id, summary);
  for (const candidate of incomingCandidates) allCandidateById.set(candidate.id, candidate);
  const confirmations = await createDedupConfirmationRepository(deps.store).readAll();
  const sportSettings = (await deps.store.all("SELECT sport, session_cluster_conventions_json FROM sport_settings ORDER BY sport COLLATE BINARY ASC"))
    .map((row): SportSettingInput => ({ sport: nonempty(row.sport, "setting sport"),
      session_cluster_conventions_json: row.session_cluster_conventions_json === null ? null : nonempty(row.session_cluster_conventions_json, "setting conventions") }));
  const persistedPairStates = (await deps.store.all(
    "SELECT * FROM ingest_dedup_pair_state ORDER BY candidate_a COLLATE BINARY ASC, candidate_b COLLATE BINARY ASC",
  )).map(pairStateFromCache);
  const persistedDedup = planDedupFromPairStates(
    [...cachedCandidates.values()].map(({ candidate }) => candidate),
    [...cachedCandidates.values()].map(({ summary }) => summary),
    confirmations,
    persistedPairStates,
  );
  const storedSessions = await deps.store.all(
    "SELECT * FROM ingest_dedup_session_state ORDER BY session_group_id COLLATE BINARY ASC",
  );
  const expectedSessions = incrementalSessionCacheRows(persistedDedup);
  if (canonical(storedSessions) !== canonical(expectedSessions)) throw new Error("dedup session cache disagreement");
  const persistedBricks = planBrickAdjacencyFromTopology(persistedDedup, sportSettings);
  const persistedShapes = await buildIncrementalClusterShapes(persistedDedup, persistedBricks, deps.hashKey);
  const oldClusters = await deps.store.all("SELECT * FROM ingest_cluster_state ORDER BY cluster_id COLLATE BINARY ASC");
  const expectedOldClusters = new Map(persistedShapes.map((shape) => [shape.cluster_id, shape]));
  if (oldClusters.length !== expectedOldClusters.size || oldClusters.some((row) => {
    const expected = expectedOldClusters.get(String(row.cluster_id));
    if (expected === undefined || row.workout_key !== expected.workout_key
      || row.topology_signature_json !== expected.topology_signature_json) return true;
    const reportJson = row.cluster_report_json;
    if (typeof reportJson !== "string") return true;
    try { return canonical(JSON.parse(reportJson)) !== reportJson; } catch { return true; }
  })) throw new Error("cluster cache disagreement");
  const evaluatedPairs = evaluateIncrementalDedupPairs([...allSummaryById.values()], confirmations, newIds);
  const pairStates = persistedPairStates.filter((state) => {
    const left = allSummaryById.get(state.candidate_a), right = allSummaryById.get(state.candidate_b);
    if (left === undefined || right === undefined) throw new Error("dedup pair cache disagreement");
    return !evaluatedPairs.affected_members.has(left.member_id) && !evaluatedPairs.affected_members.has(right.member_id);
  }).concat(evaluatedPairs.pair_states);
  const topology = await phase(deps, "topology", async () => {
    const dedup = planDedupFromPairStates([...allCandidateById.values()], [...allSummaryById.values()], confirmations, pairStates);
    const bricks = planBrickAdjacencyFromTopology(dedup, sportSettings);
    const shapes = await buildIncrementalClusterShapes(dedup, bricks, deps.hashKey);
    return { dedup, bricks, shapes };
  });
  const oldSignatures = new Set(oldClusters.map((row) => nonempty(row.topology_signature_json, "cluster signature")));
  const newSignatures = new Set(topology.shapes.map((shape) => shape.topology_signature_json));
  const newAffected = new Set(topology.shapes.filter((shape) => !oldSignatures.has(shape.topology_signature_json)).map((shape) => shape.cluster_id));
  const oldAffected = oldClusters.filter((row) => !newSignatures.has(nonempty(row.topology_signature_json, "cluster signature")));
  const hydrateIds = new Set(topology.shapes.filter((shape) => newAffected.has(shape.cluster_id)).flatMap((shape) => shape.candidate_ids));

  const hydrated = new Map<string, Candidate>(incomingCandidates.map((candidate) => [candidate.id, candidate]));
  for (const id of hydrateIds) {
    if (hydrated.has(id)) continue;
    const cache = cachedCandidates.get(id)!;
    if (cache.row.artifact_kind === "raw_file") {
      const raw = await deps.store.get("SELECT * FROM raw_file WHERE sha256=?", [cache.row.artifact_id]);
      if (raw === undefined) throw new Error("cached raw artifact is absent");
      const row = rawRow(raw), bytes = await phase(deps, "archive-decode", () => deps.archive.readArtifact(row.path!));
      const prepared = await phase(deps, "archive-decode", () => deps.prepareFile({ input_path: row.path!, bytes,
        ext: row.ext as "fit" | "tcx" | "gpx" }, settings));
      if (prepared.outcome !== "prepared" || prepared.value.expected_address !== row.sha256) throw new Error("persisted raw artifact invariant mismatch");
      for (const candidate of prepared.value.candidates) hydrated.set(candidate.id, candidate);
      for (const summary of prepared.value.summaries) {
        const cachedSummary = allSummaryById.get(summary.candidate_id);
        if (cachedSummary === undefined || canonical(cachedSummary) !== canonical(summary)) throw new Error("candidate cache disagreement");
      }
      for (const candidate of prepared.value.candidates) eventsByCandidate.set(candidate.id,
        prepared.value.repair_events.filter((event) => event.candidate_id === candidate.id));
    } else {
      const selected = selectedSources.get(nonempty(cache.row.artifact_id, "source candidate artifact"));
      if (selected === undefined) throw new Error("cached source artifact is absent");
      const presentation = await phase(deps, "archive-decode", () =>
        replayPlatformPresentation(sourcePresentationRow(selected), deps.hashKey, {
          archiveRelPath: selected.archive_rel_path, archiveEpochSeconds: selected.archive_epoch_s }));
      if (canonical(presentation.summary) !== canonical(cache.summary)) throw new Error("candidate cache disagreement");
      hydrated.set(presentation.candidate.id, presentation.candidate);
    }
  }
  for (const [id, candidate] of allCandidateById) if (hydrateIds.has(id)) allCandidateById.set(id, hydrated.get(id)!);
  const hydratedDedup = await phase(deps, "topology", async () => planDedupFromPairStates(
    [...allCandidateById.values()], [...allSummaryById.values()], confirmations, dedupPairStates(topology.dedup),
  ));
  const clusterPlan = await phase(deps, "topology", () => planClusters({ candidates: [...allCandidateById.values()],
    summaries: [...allSummaryById.values()], confirmations, settings: sportSettings, eventsByCandidate,
    materializeClusterIds: newAffected, dedup: hydratedDedup }, deps));
  const unchangedReports = oldClusters.filter((row) => !oldAffected.includes(row) && !newAffected.has(String(row.cluster_id)))
    .map((row) => JSON.parse(nonempty(row.cluster_report_json, "cluster report")) as ImportReport["clusters"][number]);
  const allClusterReports = [...unchangedReports, ...clusterPlan.clusterReports].sort((a, b) => compareText(a.cluster_id, b.cluster_id));
  const plannedSnapshot = await snapshotInputs(deps);
  const insertedRaw = new Map<string, boolean>(), insertedSource = new Map<string, boolean>();
  let sourceArtifactInserted = 0, sourceUpdates = 0, relinked = 0;
  let orphans: ImportReport["orphaned_overlays"] = [];
  await phase(deps, "sqlite", () => deps.store.transaction(async () => {
    if (await snapshotInputs(deps) !== plannedSnapshot) throw new Error("ingest inputs changed during planning");
    const intervals = createIntervalsSourceRepository(deps.store, deps.hashKey);
    for (const file of batch.files) if (file.source_evidence !== undefined) {
      const evidence = file.source_evidence;
      const work = fileReports.find((entry) => entry.report.input_path === file.input_path);
      if (work === undefined || evidence.entry.archiveAddress !== work.address) {
        throw new Error("bulk FIT source evidence mismatch");
      }
      for (const draft of evidence.container === null ? [evidence.entry] : [evidence.container, evidence.entry]) {
        if (draft.source !== "intervals-icu" || draft.lane !== "bulk-fit" || draft.artifactKind !== "raw_file") throw new TypeError("invalid bulk FIT source evidence");
        const result = await intervals.recordArtifact(draft); if (result.inserted) sourceArtifactInserted += 1;
      }
    }
    const raws = createRawFileRepository(deps.store);
    for (const [address, entry] of incomingAddresses) insertedRaw.set(address, await raws.upsert(entry.row));
    const sources = createSourceRecordRepository(deps.store);
    for (const presentation of incomingPlatforms.values()) {
      const artifact = batch.platform_records.find((value) => String(value.activity_id) === presentation.row.external_id);
      if (artifact?.sourceEvidence === undefined) insertedSource.set(presentation.row.id, await sources.upsert(presentation.row));
      else {
        const evidence = artifact.sourceEvidence;
        const recorded = await intervals.recordArtifact({ source: "intervals-icu", lane: "activities", externalId: evidence.externalId,
          artifactKind: "snapshot", archiveAddress: evidence.archive.address, archiveRelPath: evidence.archive.relPath,
          archiveEpochSeconds: evidence.archiveInstant.epochSeconds });
        if (recorded.inserted) sourceArtifactInserted += 1;
        const revision = await intervals.applyActivityRevision({ sourceRow: presentation.row, artifactKey: recorded.artifactKey });
        insertedSource.set(presentation.row.id, revision.kind === "inserted-current");
        if (revision.selectorChanged && revision.kind !== "inserted-current") sourceUpdates += 1;
      }
    }
    for (const id of newIds) {
      const candidate = allCandidateById.get(id)!, summary = allSummaryById.get(id)!;
      const row = incrementalCandidateCacheRow(candidate, summary);
      await deps.store.run(`INSERT INTO ingest_candidate_index (
  candidate_id, artifact_kind, artifact_id, member_id, source_kind, source_session_seq, sport_family, is_transition,
  start_utc, duration_s, distance_m, file_id_manufacturer, file_id_serial, file_id_time_created_utc, candidate_summary_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, cacheRowValues(row));
    }
    const currentPairs = new Map<string, Row>((await deps.store.all("SELECT * FROM ingest_dedup_pair_state")).map((row) => [`${row.candidate_a}\u0000${row.candidate_b}`, row]));
    const nextPairs = new Map<string, { candidate_a: string; candidate_b: string; edge_tier: string | null; threshold_near_miss_json: string | null; overlap_watchlist_json: string | null; confirm_queue_json: string | null }>(dedupPairStates(clusterPlan.dedup).map((pair) => {
      const row = { candidate_a: pair.candidate_a, candidate_b: pair.candidate_b, edge_tier: pair.edge_tier,
        threshold_near_miss_json: pair.threshold_near_miss === null ? null : canonical(pair.threshold_near_miss),
        overlap_watchlist_json: pair.overlap_watchlist === null ? null : canonical(pair.overlap_watchlist),
        confirm_queue_json: pair.confirm_queue === null ? null : canonical(pair.confirm_queue) };
      return [`${pair.candidate_a}\u0000${pair.candidate_b}`, row];
    }));
    for (const [key, row] of currentPairs) if (!nextPairs.has(key)) await deps.store.run("DELETE FROM ingest_dedup_pair_state WHERE candidate_a=? AND candidate_b=?", [row.candidate_a, row.candidate_b]);
    for (const [key, row] of nextPairs) if (canonical(currentPairs.get(key)) !== canonical(row)) await deps.store.run(`INSERT INTO ingest_dedup_pair_state (
  candidate_a,candidate_b,edge_tier,threshold_near_miss_json,overlap_watchlist_json,confirm_queue_json
) VALUES (?,?,?,?,?,?) ON CONFLICT(candidate_a,candidate_b) DO UPDATE SET edge_tier=excluded.edge_tier,
threshold_near_miss_json=excluded.threshold_near_miss_json,overlap_watchlist_json=excluded.overlap_watchlist_json,
confirm_queue_json=excluded.confirm_queue_json`, [row.candidate_a, row.candidate_b, row.edge_tier,
      row.threshold_near_miss_json, row.overlap_watchlist_json, row.confirm_queue_json]);
    const currentSessions = new Map((await deps.store.all("SELECT * FROM ingest_dedup_session_state")).map((row) => [String(row.session_group_id), row]));
    const nextSessions = new Map(incrementalSessionCacheRows(clusterPlan.dedup).map((row) => [row.session_group_id, row]));
    for (const [id] of currentSessions) if (!nextSessions.has(id)) await deps.store.run("DELETE FROM ingest_dedup_session_state WHERE session_group_id=?", [id]);
    for (const [id, row] of nextSessions) if (canonical(currentSessions.get(id)) !== canonical(row)) await deps.store.run(`INSERT INTO ingest_dedup_session_state (
  session_group_id,topology_signature_json,candidate_ids_json,summaries_json,members_json,edge_tiers_json
) VALUES (?,?,?,?,?,?) ON CONFLICT(session_group_id) DO UPDATE SET topology_signature_json=excluded.topology_signature_json,
candidate_ids_json=excluded.candidate_ids_json,summaries_json=excluded.summaries_json,members_json=excluded.members_json,
edge_tiers_json=excluded.edge_tiers_json`, [row.session_group_id, row.topology_signature_json,
      row.candidate_ids_json, row.summaries_json, row.members_json, row.edge_tiers_json]);
    for (const row of oldAffected) {
      await deps.store.run("DELETE FROM ingest_cluster_state WHERE cluster_id=?", [row.cluster_id]);
      await deps.store.run("DELETE FROM workout WHERE workout_key=?", [row.workout_key]);
    }
    for (const cluster of clusterPlan.planned) await deps.materializeClusterInTransaction(deps.store, cluster);
    for (const cluster of clusterPlan.incrementalClusters) await deps.store.run(`INSERT INTO ingest_cluster_state (
  cluster_id,workout_key,topology_signature_json,cluster_report_json
) VALUES (?,?,?,?)`, [cluster.cluster_id, cluster.workout_key, cluster.topology_signature_json, cluster.cluster_report_json]);
    for (const presentation of [...selectedSources.values()].map((row) => ({ row, candidateId: `platform_api:${row.id}:0:0` }))) {
      const keys = clusterPlan.finalKeyByCandidate.get(presentation.candidateId);
      if (keys === undefined) continue;
      const changed = await deps.store.get(`UPDATE source_record SET workout_key=?,session_key=? WHERE id=?
AND (workout_key IS NOT ? OR session_key IS NOT ?) RETURNING id`, [keys.workout, keys.session, presentation.row.id, keys.workout, keys.session]);
      if (changed !== undefined) relinked += 1;
    }
    for (const presentation of incomingPlatforms.values()) {
      const keys = clusterPlan.finalKeyByCandidate.get(presentation.candidate.id);
      if (keys === undefined) continue;
      const changed = await deps.store.get(`UPDATE source_record SET workout_key=?,session_key=? WHERE id=?
AND (workout_key IS NOT ? OR session_key IS NOT ?) RETURNING id`, [keys.workout, keys.session, presentation.row.id, keys.workout, keys.session]);
      if (changed !== undefined) relinked += 1;
    }
    await deps.store.run("UPDATE ingest_metadata SET ingest_version=? WHERE singleton=1", [deps.ingestVersion]);
    await deps.store.run("UPDATE ingest_incremental_state SET initialized=1 WHERE singleton=1");
    orphans = await orphanReports(deps.store, new Set([...allSummaryById.values()].map((summary) => summary.member_id)));
    await deps.finalizeBatchInTransaction?.(deps.store, { source_artifact_inserted: sourceArtifactInserted,
      raw_file_inserted: [...insertedRaw.values()].filter(Boolean).length,
      source_record_inserted: [...insertedSource.values()].filter(Boolean).length, source_record_updated: sourceUpdates,
      relinked_source_records: relinked });
  }));
  const owners = new Map<string, string>();
  for (const { address, report } of fileReports.filter(({ report }) => report.outcome === "imported")) {
    const current = owners.get(address); if (current === undefined || report.input_path < current) owners.set(address, report.input_path);
  }
  const reports = fileReports.map(({ address, report }) => ({ ...report, raw_file_inserted: report.outcome === "imported"
    && owners.get(address) === report.input_path && insertedRaw.get(address) === true }))
    .sort((a, b) => compareText(a.address, b.address) || compareText(a.input_path, b.input_path));
  return { schema_version: 1, ingest_version: FIT_INGEST_VERSION,
    effective: { tier3: DEFAULT_TIER3_THRESHOLDS, transition_window_s: DEFAULT_TRANSITION_WINDOW_S }, files: reports,
    inserts: { raw_file: [...insertedRaw.values()].filter(Boolean).length, source_record: [...insertedSource.values()].filter(Boolean).length },
    updates: { source_record: sourceUpdates, relinked_source_records: relinked }, clusters: allClusterReports,
    threshold_near_misses: clusterPlan.dedup.threshold_near_misses, overlap_watchlist: clusterPlan.dedup.overlap_watchlist,
    confirm_queue: clusterPlan.dedup.confirm_queue, applied_confirmations: clusterPlan.dedup.applied_confirmations,
    brick_groups: clusterPlan.bricks.brick_groups, orphaned_overlays: orphans };
}
