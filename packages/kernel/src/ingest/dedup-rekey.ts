import { assertValidAddress } from "../archive/paths.js";
import { sortKeys } from "../store/canonical-json.js";
import { createDedupConfirmationRepository } from "../store/dedup-confirmation-repository.js";
import { deleteAllDerivedRowsInTransaction } from "./rebuild.js";
import { createRawFileRepository, createSourceRecordRepository } from "../store/source-repository.js";
import type { RawFileRow, Row, SourceRecordRow, SqlStore } from "../store/ports.js";
import type { Candidate, ConcernValue, LapConcern, SwimLengthConcern } from "./canonical-pick.js";
import { DEFAULT_TRANSITION_WINDOW_S, planBrickAdjacency, type SportSettingInput } from "./brick-adjacency.js";
import { DEFAULT_TIER3_THRESHOLDS, planDedup, type DedupCandidateSummary } from "./dedup.js";
import { encodeStream } from "./stream-codec.js";
import { rescalePoolDistances } from "./pool-size-rescale.js";
import { buildPlatformPresentation, replayPlatformPresentation, type PlatformPresentation } from "./source-ledger.js";
import { FIT_INGEST_VERSION } from "./types.js";
import {
  DEFAULT_REPAIR_FIXER_SETTINGS,
  REPAIR_FIXERS,
  normalizeRepairFixerSettings,
  type RepairFixer,
  type RepairFixerSettings,
} from "./repair/types.js";
import type {
  ClusterReport,
  FileReport,
  ImportBatch,
  ImportReport,
  ImportReportDeps,
  OrphanReport,
  PlannedCluster,
  PlannedLogicalSession,
  PreparedFile,
  PreparedRepairEvent,
} from "./import-report.js";

function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function canonical(value: unknown): string { return JSON.stringify(sortKeys(value)); }

function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`invalid ${name}`);
  return value;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`invalid ${name}`);
  return value;
}

function rawRow(row: Row): RawFileRow {
  const sha256 = string(row.sha256, "raw SHA"); assertValidAddress(sha256);
  const path = string(row.path, "raw path");
  const ext = row.ext;
  if (ext !== "fit" && ext !== "tcx" && ext !== "gpx") throw new TypeError("invalid raw extension");
  const bytes = integer(row.bytes, "raw byte count");
  const nullableInteger = (value: unknown): number | null => value === null ? null : integer(value, "raw identity integer");
  const nullableString = (value: unknown): string | null => value === null ? null : string(value, "raw identity string");
  return { sha256, path, ext, bytes, file_id_serial: nullableInteger(row.file_id_serial),
    file_id_time_created_utc: nullableInteger(row.file_id_time_created_utc), manufacturer: nullableString(row.manufacturer),
    product: nullableString(row.product) };
}

function sourceRow(row: Row): SourceRecordRow {
  return {
    id: string(row.id, "source id"),
    workout_key: row.workout_key === null ? null : string(row.workout_key, "source workout key"),
    session_key: row.session_key === null ? null : string(row.session_key, "source session key"),
    source: string(row.source, "source"),
    external_id: string(row.external_id, "source external id"),
    raw_sha256: row.raw_sha256 === null ? null : string(row.raw_sha256, "source raw SHA"),
    quality_rank: integer(row.quality_rank, "source quality rank"),
    payload_json: string(row.payload_json, "source payload"),
  };
}

interface RepairFixerSettingsRow {
  readonly fixer: RepairFixer;
  readonly enabled: 1;
}

interface RepairFixerSettingsSnapshot {
  readonly rows: readonly RepairFixerSettingsRow[];
  readonly settings: RepairFixerSettings;
  readonly canonicalRows: string;
}

async function readRepairFixerSettingsSnapshot(
  store: SqlStore,
): Promise<RepairFixerSettingsSnapshot> {
  const selected = await store.all(`SELECT fixer, enabled
FROM repair_fixer_settings
ORDER BY fixer COLLATE BINARY ASC`);
  if (selected.length > REPAIR_FIXERS.length) {
    throw new TypeError("invalid repair fixer settings row");
  }
  const mutableSettings: Record<RepairFixer, boolean> = {
    ...DEFAULT_REPAIR_FIXER_SETTINGS,
  };
  const seen = new Set<RepairFixer>();
  const rows: RepairFixerSettingsRow[] = [];
  for (const row of selected) {
    const fixer = row.fixer;
    if (typeof fixer !== "string" || !REPAIR_FIXERS.includes(fixer as RepairFixer)
      || row.enabled !== 1 || seen.has(fixer as RepairFixer)) {
      throw new TypeError("invalid repair fixer settings row");
    }
    const validFixer = fixer as RepairFixer;
    seen.add(validFixer);
    mutableSettings[validFixer] = true;
    rows.push(Object.freeze({ fixer: validFixer, enabled: 1 }));
  }
  const frozenRows = Object.freeze(rows);
  const settings = normalizeRepairFixerSettings(mutableSettings);
  return Object.freeze({ rows: frozenRows, settings, canonicalRows: canonical(frozenRows) });
}

export async function readRepairFixerSettings(
  store: SqlStore,
): Promise<RepairFixerSettings> {
  return (await readRepairFixerSettingsSnapshot(store)).settings;
}

export interface RepairFixerSettingChange {
  readonly fixer: RepairFixer;
  readonly enabled: boolean;
}

export interface RepairFixerSettingChangeResult {
  readonly changed: boolean;
  readonly rebuilt: boolean;
  readonly from: boolean;
  readonly to: boolean;
  readonly ingest_version: typeof FIT_INGEST_VERSION;
}

type GlobalReplanRequest =
  | { readonly kind: "import"; readonly batch: ImportBatch }
  | { readonly kind: "repair-fixer-setting"; readonly change: RepairFixerSettingChange };

type GlobalReplanResult =
  | { readonly kind: "import"; readonly report: ImportReport }
  | { readonly kind: "repair-fixer-setting"; readonly result: RepairFixerSettingChangeResult };

function exactPrepared(left: PreparedFile, right: PreparedFile): boolean {
  return canonical({ ...left, archive_instant: left.archive_instant }) === canonical({ ...right, archive_instant: right.archive_instant });
}

interface PreparedAddress {
  readonly prepared: PreparedFile;
  readonly row: RawFileRow;
}

interface FileWork {
  readonly report: FileReport;
  readonly address: string;
}

function candidateStart(session: { readonly summaries: readonly DedupCandidateSummary[] }): readonly [number, string] {
  const first = [...session.summaries].sort((a, b) => a.start_utc - b.start_utc || compareText(a.candidate_id, b.candidate_id))[0]!;
  return [first.start_utc, first.candidate_id];
}

function repairEventsForSession(
  pick: ReturnType<ImportReportDeps["canonicalPick"]>,
  eventsByCandidate: ReadonlyMap<string, readonly PreparedRepairEvent[]>,
): PreparedRepairEvent[] {
  const result: PreparedRepairEvent[] = [];
  for (const winner of pick.winners) {
    if (!winner.concern.startsWith("stream:")) continue;
    const channel = winner.concern.slice(7);
    for (const event of eventsByCandidate.get(winner.candidateId) ?? []) if (event.channel === channel) result.push(event);
  }
  return result.sort((a, b) => compareText(a.channel, b.channel) || compareText(a.fixer, b.fixer));
}

async function orphanReports(store: SqlStore, members: ReadonlySet<string>): Promise<OrphanReport[]> {
  const result: OrphanReport[] = [];
  const current = new Map<string, Set<string>>();
  const inventories = [
    ["workout", "workout_key", "SELECT workout_key FROM workout ORDER BY workout_key COLLATE BINARY ASC"],
    ["session", "session_key", "SELECT session_key FROM session ORDER BY session_key COLLATE BINARY ASC"],
    ["lap", "lap_key", "SELECT lap_key FROM lap ORDER BY lap_key COLLATE BINARY ASC"],
    ["swim_length", "length_key", "SELECT length_key FROM swim_length ORDER BY length_key COLLATE BINARY ASC"],
    ["stream", "stream_key", "SELECT stream_key FROM stream ORDER BY stream_key COLLATE BINARY ASC"],
    ["metric_snapshot", "snapshot_key", "SELECT snapshot_key FROM metric_snapshot ORDER BY snapshot_key COLLATE BINARY ASC"],
    ["mean_max_cache", "mmax_key", "SELECT mmax_key FROM mean_max_cache ORDER BY mmax_key COLLATE BINARY ASC"],
    ["repair_log", "repair_key", "SELECT repair_key FROM repair_log ORDER BY repair_key COLLATE BINARY ASC"],
  ] as const;
  for (const [table, column, sql] of inventories) current.set(table, new Set((await store.all(sql)).map((row) => String(row[column]))));
  for (const row of await store.all("SELECT id, target_length_key FROM stroke_correction_overlay ORDER BY id COLLATE BINARY ASC")) {
    const key = String(row.target_length_key);
    if (!current.get("swim_length")!.has(key)) result.push({ id: String(row.id), target_kind: "stroke_correction_overlay:swim_length", target_key: key, reason: "target_missing_after_rekey" });
  }
  for (const row of await store.all("SELECT id, target_session_key FROM pool_size_correction_overlay ORDER BY id COLLATE BINARY ASC")) {
    const key = String(row.target_session_key);
    if (!current.get("session")!.has(key)) result.push({ id: String(row.id), target_kind: "pool_size_correction_overlay:session", target_key: key, reason: "target_missing_after_rekey" });
  }
  for (const row of await store.all("SELECT id, target_table, target_key FROM field_merge_override_overlay ORDER BY id COLLATE BINARY ASC")) {
    const table = String(row.target_table), key = String(row.target_key), inventory = current.get(table);
    if (inventory === undefined) result.push({ id: String(row.id), target_kind: `field_merge_override_overlay:${table}`, target_key: key, reason: "unsupported_target_kind" });
    else if (!inventory.has(key)) result.push({ id: String(row.id), target_kind: `field_merge_override_overlay:${table}`, target_key: key, reason: "target_missing_after_rekey" });
  }
  for (const row of await createDedupConfirmationRepository(store).readAll()) {
    for (const member of [row.member_a, row.member_b]) if (!members.has(member)) {
      result.push({ id: row.id, target_kind: "dedup_confirmation:member", target_key: member, reason: "confirmation_member_missing" });
    }
  }
  const unique = new Map(result.map((row) => [`${row.id}\u0000${row.target_kind}\u0000${row.target_key}\u0000${row.reason}`, row]));
  return [...unique.values()].sort((a, b) => compareText(a.target_kind, b.target_kind)
    || compareText(a.target_key, b.target_key) || compareText(a.id, b.id));
}

async function runGlobalReplan(
  request: GlobalReplanRequest,
  deps: ImportReportDeps,
): Promise<GlobalReplanResult> {
  if (deps.ingestVersion !== FIT_INGEST_VERSION) throw new Error("ingest dependency version mismatch");
  const metadata = await deps.store.all("SELECT ingest_version FROM ingest_metadata WHERE singleton=1");
  if (metadata.length !== 1) throw new Error("ingest metadata invariant mismatch");
  const storedVersion = integer(metadata[0]!.ingest_version, "ingest version");
  if (storedVersion > deps.ingestVersion) throw new Error("store uses newer ingest semantics");
  const repairSnapshot = await readRepairFixerSettingsSnapshot(deps.store);
  let targetSettings = repairSnapshot.settings;
  let settingFrom: boolean | undefined;
  let settingChanged = false;
  if (request.kind === "repair-fixer-setting") {
    if (!REPAIR_FIXERS.includes(request.change.fixer)) throw new TypeError("invalid repair fixer");
    if (typeof request.change.enabled !== "boolean") {
      throw new TypeError("repair fixer enabled must be boolean");
    }
    settingFrom = repairSnapshot.settings[request.change.fixer];
    settingChanged = settingFrom !== request.change.enabled;
    targetSettings = normalizeRepairFixerSettings({
      ...repairSnapshot.settings,
      [request.change.fixer]: request.change.enabled,
    });
    if (!settingChanged && storedVersion === FIT_INGEST_VERSION) {
      return {
        kind: "repair-fixer-setting",
        result: {
          changed: false,
          rebuilt: false,
          from: settingFrom,
          to: settingFrom,
          ingest_version: FIT_INGEST_VERSION,
        },
      };
    }
  }
  const batch: ImportBatch = request.kind === "import"
    ? request.batch
    : { files: [], platform_records: [] };
  const inputPaths = new Set<string>();
  for (const file of batch.files) {
    if (typeof file.input_path !== "string" || file.input_path.length === 0 || inputPaths.has(file.input_path)) throw new TypeError("duplicate or invalid input path");
    inputPaths.add(file.input_path);
    if (file.ext !== "fit" && file.ext !== "tcx" && file.ext !== "gpx") throw new TypeError("unsupported input extension");
  }

  const incomingPlatforms = new Map<string, PlatformPresentation>();
  for (const platform of batch.platform_records) {
    const presentation = await buildPlatformPresentation(platform, deps.hashKey);
    if (platform.raw_snapshot_address !== null) {
      assertValidAddress(platform.raw_snapshot_address);
      if (!await deps.archive.has(platform.raw_snapshot_rel_path!)) throw new Error("platform snapshot is absent");
    }
    const prior = incomingPlatforms.get(presentation.row.id);
    if (prior && canonical(prior.row) !== canonical(presentation.row)) throw new Error("platform source conflict");
    incomingPlatforms.set(presentation.row.id, presentation);
  }

  const files = [...batch.files].map((file) => ({ ...file, bytes: new Uint8Array(file.bytes) }))
    .sort((a, b) => compareText(a.input_path, b.input_path));
  const fileWork: FileWork[] = [];
  const incomingAddresses = new Map<string, PreparedAddress>();
  for (const file of files) {
    const result = await deps.prepareFile(file, targetSettings);
    if (result.outcome === "quarantined") {
      const archived = await deps.archive.quarantine(file.bytes, file.ext, `${canonical(result.quarantine)}\n`);
      assertValidAddress(archived.address);
      fileWork.push({ address: archived.address, report: { input_path: file.input_path, address: archived.address, ext: file.ext,
        archive_deduped: archived.deduped, raw_file_inserted: false, outcome: "quarantined", quarantine: result.quarantine } });
      continue;
    }
    const prepared = result.value;
    assertValidAddress(prepared.expected_address);
    const archived = await deps.archive.writeArtifact(file.bytes, file.ext, prepared.archive_instant);
    if (archived.address !== prepared.expected_address) throw new Error("archive address mismatch");
    assertValidAddress(archived.address);
    const row: RawFileRow = { ...prepared.raw_file, path: archived.relPath };
    const prior = incomingAddresses.get(archived.address);
    if (prior && (!exactPrepared(prior.prepared, prepared) || canonical(prior.row) !== canonical(row))) throw new Error("same-address preparation conflict");
    incomingAddresses.set(archived.address, prior ?? { prepared, row });
    fileWork.push({ address: archived.address, report: { input_path: file.input_path, address: archived.address, ext: file.ext,
      archive_deduped: archived.deduped, raw_file_inserted: false, outcome: "imported", quarantine: null } });
  }

  const persistedRawRows = (await deps.store.all(`SELECT sha256, path, ext, bytes, file_id_serial,
       file_id_time_created_utc, manufacturer, product
FROM raw_file
ORDER BY sha256 COLLATE BINARY ASC`)).map(rawRow);
  const allAddresses = new Map<string, PreparedAddress>();
  for (const row of persistedRawRows) {
    const bytes = await deps.archive.readArtifact(row.path!);
    if (bytes.byteLength !== row.bytes) throw new Error("persisted raw byte count mismatch");
    const result = await deps.prepareFile(
      { input_path: row.path!, bytes, ext: row.ext as "fit" | "tcx" | "gpx" },
      targetSettings,
    );
    if (result.outcome !== "prepared") throw new Error("persisted raw artifact is quarantined");
    if (result.value.expected_address !== row.sha256 || canonical({ ...result.value.raw_file, path: row.path }) !== canonical(row)) {
      throw new Error("persisted raw artifact invariant mismatch");
    }
    allAddresses.set(row.sha256, { prepared: result.value, row });
  }
  for (const [address, incoming] of incomingAddresses) {
    const prior = allAddresses.get(address);
    if (prior && (!exactPrepared(prior.prepared, incoming.prepared) || canonical(prior.row) !== canonical(incoming.row))) {
      throw new Error("incoming raw artifact conflicts with persisted source");
    }
    allAddresses.set(address, incoming);
  }

  const persistedSourceRows = (await deps.store.all(`SELECT id, workout_key, session_key, source, external_id,
       raw_sha256, quality_rank, payload_json
FROM source_record
ORDER BY id COLLATE BINARY ASC`)).map(sourceRow);
  const allPlatforms = new Map<string, PlatformPresentation>();
  for (const row of persistedSourceRows) allPlatforms.set(row.id, await replayPlatformPresentation(row, deps.hashKey));
  for (const [id, incoming] of incomingPlatforms) {
    const prior = allPlatforms.get(id);
    if (prior && canonical({ ...prior.row, workout_key: null, session_key: null }) !== canonical(incoming.row)) {
      throw new Error("incoming platform source conflicts with persisted source");
    }
    allPlatforms.set(id, prior ?? incoming);
  }

  const candidates: Candidate[] = [];
  const summaries: DedupCandidateSummary[] = [];
  const eventsByCandidate = new Map<string, readonly PreparedRepairEvent[]>();
  for (const { prepared } of [...allAddresses.values()].sort((a, b) => compareText(a.row.sha256, b.row.sha256))) {
    candidates.push(...prepared.candidates); summaries.push(...prepared.summaries);
    for (const candidate of prepared.candidates) eventsByCandidate.set(candidate.id,
      prepared.repair_events.filter((event) => event.candidate_id === candidate.id));
  }
  for (const presentation of [...allPlatforms.values()].sort((a, b) => compareText(a.row.id, b.row.id))) {
    candidates.push(presentation.candidate); summaries.push(presentation.summary);
  }
  const confirmations = await createDedupConfirmationRepository(deps.store).readAll();
  const settingRows = (await deps.store.all("SELECT sport, session_cluster_conventions_json FROM sport_settings ORDER BY sport COLLATE BINARY ASC"))
    .map((row): SportSettingInput => ({ sport: string(row.sport, "setting sport"),
      session_cluster_conventions_json: row.session_cluster_conventions_json === null ? null : string(row.session_cluster_conventions_json, "setting conventions") }));
  const plannedRawState = canonical(persistedRawRows);
  const plannedSourceState = canonical(persistedSourceRows);
  const plannedConfirmationState = canonical(confirmations);
  const plannedSettingState = canonical(settingRows);
  const plannedRepairSettingState = repairSnapshot.canonicalRows;
  const dedup = planDedup(candidates, summaries, confirmations);
  const bricks = planBrickAdjacency(dedup, settingRows);
  const sessionById = new Map(dedup.sessions.map((session) => [session.group.id, session]));
  const planned: PlannedCluster[] = [];
  const clusterReports: ClusterReport[] = [];
  const finalKeyByCandidate = new Map<string, { workout: string; session: string }>();
  for (const workout of bricks.workouts) {
    const sessions = workout.session_group_ids.map((id) => sessionById.get(id)!).sort((left, right) => {
      const [aStart, aId] = candidateStart(left), [bStart, bId] = candidateStart(right);
      return aStart - bStart || compareText(aId, bId);
    });
    const clusterId = workout.members[0]!;
    const workoutKey = await deps.hashKey(["workout", clusterId]);
    const plannedSessions: PlannedLogicalSession[] = [];
    const canonicalSources: ClusterReport["canonical_sources"][number][] = [];
    for (let index = 0; index < sessions.length; index += 1) {
      const session = sessions[index]!, pick = deps.canonicalPick(session.group);
      if (pick.materialization.status !== "ready") throw new Error("logical session is not materializable");
      const sessionKey = await deps.hashKey(["session", workoutKey, index]);
      for (const candidate of session.group.candidates) finalKeyByCandidate.set(candidate.id, { workout: workoutKey, session: sessionKey });
      for (const winner of pick.winners) canonicalSources.push({ concern: `${index}:${winner.concern}`, candidate_id: winner.candidateId, rank: winner.rank });
      plannedSessions.push({ session_seq: index, group: session.group, pick,
        repair_events: repairEventsForSession(pick, eventsByCandidate) });
    }
    planned.push({ cluster_id: clusterId, workout_key: workoutKey, sessions: plannedSessions });
    clusterReports.push({ cluster_id: clusterId, workout_key: workoutKey, members: workout.members,
      edge_tiers: workout.edge_tiers, canonical_sources: canonicalSources.sort((a, b) => compareText(a.concern, b.concern)
        || compareText(a.candidate_id, b.candidate_id)) });
  }
  planned.sort((a, b) => compareText(a.cluster_id, b.cluster_id));
  clusterReports.sort((a, b) => compareText(a.cluster_id, b.cluster_id));
  const members = new Set(summaries.map((summary) => summary.member_id));
  const incomingRows = [...incomingAddresses.values()].sort((a, b) => compareText(a.row.sha256, b.row.sha256));
  const incomingSourceRows = [...incomingPlatforms.values()].sort((a, b) => compareText(a.row.id, b.row.id));
  const insertedRaw = new Map<string, boolean>(), insertedSource = new Map<string, boolean>();
  let relinked = 0;
  let orphans: OrphanReport[] = [];
  await deps.store.transaction(async () => {
    const current = await deps.store.all("SELECT ingest_version FROM ingest_metadata WHERE singleton=1");
    const currentRawRows = (await deps.store.all(`SELECT sha256, path, ext, bytes, file_id_serial,
       file_id_time_created_utc, manufacturer, product
FROM raw_file
ORDER BY sha256 COLLATE BINARY ASC`)).map(rawRow);
    const currentSourceRows = (await deps.store.all(`SELECT id, workout_key, session_key, source, external_id,
       raw_sha256, quality_rank, payload_json
FROM source_record
ORDER BY id COLLATE BINARY ASC`)).map(sourceRow);
    const currentConfirmations = await createDedupConfirmationRepository(deps.store).readAll();
    const currentSettings = (await deps.store.all("SELECT sport, session_cluster_conventions_json FROM sport_settings ORDER BY sport COLLATE BINARY ASC"))
      .map((row): SportSettingInput => ({ sport: string(row.sport, "setting sport"),
        session_cluster_conventions_json: row.session_cluster_conventions_json === null ? null : string(row.session_cluster_conventions_json, "setting conventions") }));
    const currentRepairSettings = await readRepairFixerSettingsSnapshot(deps.store);
    if (current.length !== 1 || current[0]!.ingest_version !== storedVersion
      || canonical(currentRawRows) !== plannedRawState || canonical(currentSourceRows) !== plannedSourceState
      || canonical(currentConfirmations) !== plannedConfirmationState || canonical(currentSettings) !== plannedSettingState
      || currentRepairSettings.canonicalRows !== plannedRepairSettingState) {
      throw new Error("ingest inputs changed during planning");
    }
    if (request.kind === "repair-fixer-setting" && settingChanged) {
      if (request.change.enabled) {
        await deps.store.run(
          "INSERT INTO repair_fixer_settings (fixer, enabled) VALUES (?, 1) ON CONFLICT(fixer) DO NOTHING",
          [request.change.fixer],
        );
      } else {
        await deps.store.run("DELETE FROM repair_fixer_settings WHERE fixer = ?", [request.change.fixer]);
      }
      const updatedRepairSettings = await readRepairFixerSettingsSnapshot(deps.store);
      if (canonical(updatedRepairSettings.settings) !== canonical(targetSettings)) {
        throw new Error("repair fixer settings update mismatch");
      }
    }
    const rawRepository = createRawFileRepository(deps.store), sourceRepository = createSourceRecordRepository(deps.store);
    for (const entry of incomingRows) insertedRaw.set(entry.row.sha256, await rawRepository.upsert(entry.row));
    for (const entry of incomingSourceRows) insertedSource.set(entry.row.id, await sourceRepository.upsert(entry.row));
    await deleteAllDerivedRowsInTransaction(deps.store);
    for (const cluster of planned) await deps.materializeClusterInTransaction(deps.store, cluster);
    for (const presentation of [...allPlatforms.values()].sort((a, b) => compareText(a.row.id, b.row.id))) {
      const keys = finalKeyByCandidate.get(presentation.candidate.id);
      if (!keys) throw new Error("source candidate attachment is missing");
      const before = persistedSourceRows.find((row) => row.id === presentation.row.id);
      await deps.store.run("UPDATE source_record SET workout_key=?, session_key=? WHERE id=? AND (workout_key IS NOT ? OR session_key IS NOT ?)",
        [keys.workout, keys.session, presentation.row.id, keys.workout, keys.session]);
      if (!before || before.workout_key !== keys.workout || before.session_key !== keys.session) relinked += 1;
    }
    await deps.store.run("UPDATE ingest_metadata SET ingest_version=? WHERE singleton=1", [deps.ingestVersion]);
    const final = await deps.store.all("SELECT singleton, ingest_version FROM ingest_metadata WHERE singleton=1");
    if (final.length !== 1 || final[0]!.singleton !== 1 || final[0]!.ingest_version !== deps.ingestVersion) throw new Error("ingest metadata update failed");
    orphans = await orphanReports(deps.store, members);
  });

  if (request.kind === "repair-fixer-setting") {
    return {
      kind: "repair-fixer-setting",
      result: {
        changed: settingChanged,
        rebuilt: true,
        from: settingFrom!,
        to: request.change.enabled,
        ingest_version: FIT_INGEST_VERSION,
      },
    };
  }

  const ownerByAddress = new Map<string, string>();
  for (const work of fileWork.filter((entry) => entry.report.outcome === "imported")) {
    const owner = ownerByAddress.get(work.address);
    if (owner === undefined || work.report.input_path < owner) ownerByAddress.set(work.address, work.report.input_path);
  }
  const reports = fileWork.map(({ report, address }) => ({ ...report,
    raw_file_inserted: report.outcome === "imported" && ownerByAddress.get(address) === report.input_path
      && insertedRaw.get(address) === true })).sort((a, b) => compareText(a.address, b.address) || compareText(a.input_path, b.input_path));
  return {
    kind: "import",
    report: {
      schema_version: 1,
      ingest_version: deps.ingestVersion,
      effective: { tier3: DEFAULT_TIER3_THRESHOLDS, transition_window_s: DEFAULT_TRANSITION_WINDOW_S },
      files: reports,
      inserts: { raw_file: [...insertedRaw.values()].filter(Boolean).length, source_record: [...insertedSource.values()].filter(Boolean).length },
      updates: { source_record: 0, relinked_source_records: relinked },
      clusters: clusterReports,
      threshold_near_misses: dedup.threshold_near_misses,
      overlap_watchlist: dedup.overlap_watchlist,
      confirm_queue: dedup.confirm_queue,
      applied_confirmations: dedup.applied_confirmations,
      brick_groups: bricks.brick_groups,
      orphaned_overlays: orphans,
    },
  };
}

export async function importArtifactsWithReport(
  batch: ImportBatch,
  deps: ImportReportDeps,
): Promise<ImportReport> {
  if (batch.files.length + batch.platform_records.length === 0) throw new TypeError("import batch is empty");
  const result = await runGlobalReplan({ kind: "import", batch }, deps);
  if (result.kind !== "import") throw new Error("global replan result invariant mismatch");
  return result.report;
}

export async function applyRepairFixerSettingWithRebuild(
  change: RepairFixerSettingChange,
  deps: ImportReportDeps,
): Promise<RepairFixerSettingChangeResult> {
  const result = await runGlobalReplan({ kind: "repair-fixer-setting", change }, deps);
  if (result.kind !== "repair-fixer-setting") throw new Error("global replan result invariant mismatch");
  return result.result;
}

function winnerMap(session: PlannedLogicalSession): Map<string, ConcernValue> {
  return new Map(session.pick.winners.map((winner) => [winner.concern, winner.value]));
}

function optionalNumber(winners: ReadonlyMap<string, ConcernValue>, key: string): number | null {
  const value = winners.get(key); return value === undefined ? null : value as number;
}

interface SelectedStream {
  readonly timestamps: readonly number[];
  readonly values: readonly (number | null)[];
}

function validateSelectedStream(value: ConcernValue, channel: string): SelectedStream {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid winning stream: ${channel}`);
  const stream = value as SelectedStream;
  if (!Array.isArray(stream.timestamps) || !Array.isArray(stream.values)
    || stream.timestamps.length === 0 || stream.timestamps.length !== stream.values.length) {
    throw new Error(`invalid winning stream: ${channel}`);
  }
  for (let index = 0; index < stream.timestamps.length; index += 1) {
    const timestamp = stream.timestamps[index]!, sample = stream.values[index] as number | null;
    if (!Number.isFinite(timestamp) || (index > 0 && timestamp <= stream.timestamps[index - 1]!)) {
      throw new Error(`invalid winning stream timeline: ${channel}`);
    }
    if (sample !== null && !Number.isFinite(sample)) throw new Error(`invalid winning stream sample: ${channel}`);
  }
  if (channel === "time") {
    if (stream.values.some((sample, index) => sample !== stream.timestamps[index])) throw new Error("winning time stream is not canonical");
  } else if (stream.values.every((sample) => sample === null)) throw new Error(`winning stream is empty: ${channel}`);
  return stream;
}

export function createMaterializeClusterInTransaction(hashKey: ImportReportDeps["hashKey"]): ImportReportDeps["materializeClusterInTransaction"] {
  return async (store, cluster) => {
    const ordered = [...cluster.sessions].sort((a, b) => a.session_seq - b.session_seq);
    if (ordered.length === 0 || ordered.some((session, index) => session.session_seq !== index)) throw new Error("planned session sequence is invalid");
    const sessionData = await Promise.all(ordered.map(async (session) => ({ session, winners: winnerMap(session),
      sessionKey: await hashKey(["session", cluster.workout_key, session.session_seq]) })));
    const start = Math.min(...sessionData.map(({ winners }) => winners.get("session.start_utc") as number));
    const firstOffset = optionalNumber(sessionData[0]!.winners, "session.tz_offset_s");
    await store.run("INSERT INTO workout (workout_key,start_utc,tz_offset_s,name,notes,is_multisport,dedup_cluster_id) VALUES (?,?,?,?,?,?,?)",
      [cluster.workout_key, start, firstOffset, null, null, ordered.length > 1 ? 1 : 0, cluster.cluster_id]);
    for (const { session, winners, sessionKey } of [...sessionData].sort((a, b) => compareText(a.sessionKey, b.sessionKey))) {
      const winningStreams = session.pick.winners.filter((entry) => entry.concern.startsWith("stream:"))
        .map((winner) => ({ channel: winner.concern.slice(7), value: validateSelectedStream(winner.value, winner.concern.slice(7)) }));
      const timeStream = winningStreams.find((stream) => stream.channel === "time");
      if (!timeStream) throw new Error("winning time stream is absent");
      for (const stream of winningStreams) {
        if (stream.value.timestamps.length !== timeStream.value.timestamps.length
          || stream.value.timestamps.some((timestamp, index) => timestamp !== timeStream.value.timestamps[index])) {
          throw new Error(`winning stream timeline mismatch: ${stream.channel}`);
        }
      }
      const laps = (winners.get("lap[]") as readonly LapConcern[] | undefined) ?? [];
      const lengths = (winners.get("swim_length[]") as readonly SwimLengthConcern[] | undefined) ?? [];
      const lapKeys = new Map<number, string>();
      for (const lap of laps) lapKeys.set(lap.lap_seq, await hashKey(["lap", sessionKey, lap.lap_seq]));
      let sessionDistance = optionalNumber(winners, "session.distance_m");
      const lengthRows = await Promise.all(lengths.map(async (length) => {
        const lapKey = lapKeys.get(length.lap_seq); if (!lapKey) throw new Error("swim length lap is absent");
        return { value: length, key: await hashKey(["swim_length", lapKey, length.length_seq]), lapKey };
      }));
      const sport = winners.get("session.sport") as string;
      const subSport = (winners.get("session.sub_sport") as string | undefined) ?? null;
      const overlay = await store.get(`SELECT corrected_pool_length_m FROM pool_size_correction_overlay WHERE target_session_key = ? ORDER BY hlc_physical_ms DESC, hlc_counter DESC, device_id DESC, id DESC LIMIT 1`, [sessionKey]);
      if (overlay !== undefined) {
        const correction = overlay.corrected_pool_length_m;
        if (typeof correction !== "number") throw new TypeError("invalid pool correction");
        if (sport !== "swimming" || subSport !== "lap_swimming" || lengthRows.length === 0) {
          throw new Error("pool correction targets a non-pool session");
        }
        const scaled = rescalePoolDistances({ sourceSessionDistanceM: sessionDistance,
          lengths: lengthRows.map((row) => {
            if (row.value.length_type !== "active" && row.value.length_type !== "idle") throw new TypeError("invalid pool length type");
            return { lengthKey: row.key, lengthType: row.value.length_type };
          }), correctedPoolLengthM: correction });
        sessionDistance = scaled.sessionDistanceM;
        const byKey = new Map(scaled.lengths.map((length) => [length.lengthKey, length.distanceM]));
        for (const row of lengthRows) row.value = { ...row.value, distance_m: byKey.get(row.key) ?? null };
      }
      await store.run("INSERT INTO session (session_key,workout_key,session_seq,sport,sub_sport,start_utc,tz_offset_s,local_date_key,elapsed_s,timer_s,moving_s,distance_m,is_transition,summary_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [
        sessionKey, cluster.workout_key, session.session_seq, sport, subSport, winners.get("session.start_utc") as number,
        optionalNumber(winners, "session.tz_offset_s"), winners.get("session.local_date_key") as number,
        optionalNumber(winners, "session.elapsed_s"), optionalNumber(winners, "session.timer_s"), optionalNumber(winners, "session.moving_s"),
        sessionDistance, winners.get("session.is_transition") === true ? 1 : 0,
        (winners.get("session.summary_json") as string | undefined) ?? null,
      ]);
      for (const lap of laps) await store.run("INSERT INTO lap (lap_key,session_key,lap_seq,start_utc,elapsed_s,timer_s,distance_m,summary_json) VALUES (?,?,?,?,?,?,?,?)",
        [lapKeys.get(lap.lap_seq)!, sessionKey, lap.lap_seq, lap.start_utc, lap.elapsed_s, lap.timer_s, lap.distance_m, lap.summary_json]);
      for (const row of lengthRows) await store.run("INSERT INTO swim_length (length_key,lap_key,length_seq,start_utc,elapsed_s,timer_s,strokes,stroke_type,length_type,distance_m) VALUES (?,?,?,?,?,?,?,?,?,?)",
        [row.key, row.lapKey, row.value.length_seq, row.value.start_utc, row.value.elapsed_s, row.value.timer_s, row.value.strokes,
          row.value.stroke_type, row.value.length_type, row.value.distance_m]);
      for (const { channel, value } of winningStreams) {
        const encoded = encodeStream(channel === "time" ? "time" : "value", value.values);
        const streamKey = await hashKey(["stream", sessionKey, channel]);
        await store.run("INSERT INTO stream (stream_key,session_key,channel,encoding,sample_rate,n,data) VALUES (?,?,?,?,?,?,?)",
          [streamKey, sessionKey, channel, encoded.encoding, null, encoded.n, encoded.data]);
      }
      for (const event of session.repair_events) {
        const candidate = session.group.candidates.find((entry) => entry.id === event.candidate_id);
        if (!candidate || candidate.origin.kind !== "file") throw new Error("repair event source is invalid");
        const changed = JSON.parse(event.changed_indices_json) as unknown;
        const params = JSON.parse(event.params_json) as unknown;
        if (!Array.isArray(changed) || changed.length !== event.changed_count || params === null || typeof params !== "object" || Array.isArray(params)) {
          throw new Error("repair event payload is invalid");
        }
        const repairKey = await hashKey(["repair_log", candidate.origin.rawSha256, sessionKey, event.channel, event.fixer]);
        await store.run("INSERT INTO repair_log (repair_key,raw_sha256,session_key,channel,fixer,changed_count,changed_indices_json,params_json) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
          [repairKey, candidate.origin.rawSha256, sessionKey, event.channel, event.fixer, event.changed_count, event.changed_indices_json, event.params_json]);
        const selected = await store.get("SELECT repair_key,raw_sha256,session_key,channel,fixer,changed_count,changed_indices_json,params_json FROM repair_log WHERE repair_key=?", [repairKey]);
        if (!selected || canonical(selected) !== canonical({ repair_key: repairKey, raw_sha256: candidate.origin.rawSha256, session_key: sessionKey,
          channel: event.channel, fixer: event.fixer, changed_count: event.changed_count,
          changed_indices_json: event.changed_indices_json, params_json: event.params_json })) throw new Error("repair log invariant mismatch");
      }
    }
  };
}
