import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, type ArchiveManager } from "../src/archive/index.js";
import { canonicalPick, createMaterializeClusterInTransaction, importArtifactsIncrementally, importArtifactsWithReport,
  type Candidate, type ConcernValue, type ImportArtifact, type ImportReportDeps, type PlatformImportArtifact,
  type PrepareFileResult } from "../src/ingest/index.js";
import { dumpStore, runMigrations, sortKeys, type MigratorStore, type SqlStore } from "../src/store/index.js";
import { MIGRATIONS } from "../src/store/migrations/index.js";
import { openSqliteStorage } from "../../kernel-node/src/sqlite/index.js";

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const hashKey = async (fields: readonly (string | number)[]): Promise<string> =>
  createHash("sha256").update(fields.join("\u001f")).digest("hex");
const starts: Readonly<Record<number, number>> = Object.freeze({ 1: 1_000, 2: 100_000, 3: 1_050, 4: 200_000 });
const file = (byte: 1 | 2 | 3 | 4): ImportArtifact => ({ input_path: `incoming-${byte}.fit`, bytes: new Uint8Array([byte]), ext: "fit" });
const platform = (name = "Structured ride"): PlatformImportArtifact => {
  const activity = { id: "platform-1", name };
  const compact = JSON.stringify(sortKeys(activity));
  const snapshot = canonicalJson(activity), address = digest(new TextEncoder().encode(snapshot));
  const archive = { address, relPath: `1000/${address}.json.gz`, deduped: false };
  platformSnapshots.set(archive.relPath, structuredClone(activity));
  const concerns: Record<string, ConcernValue> = { "session.sport": "cycling", "session.start_utc": 1_000,
    "session.local_date_key": 20100101, "session.elapsed_s": 100, "session.distance_m": 1_000,
    "session.is_transition": false, "session.summary_json": compact,
    "stream:time": { timestamps: [1_000, 1_100], values: [1_000, 1_100] } };
  return { source: "intervals-icu", activity_id: "platform-1", activity,
    dedup: { sport_family: "cycling", is_transition: false, start_utc: 1_000, duration_s: 100, distance_m: 1_000 },
    concerns, raw_snapshot_address: address, raw_snapshot_rel_path: archive.relPath,
    sourceEvidence: { source: "intervals-icu", lane: "activities", externalId: "platform-1",
      archiveInstant: { epochSeconds: 1_000 }, archive, normalizedActivityJson: snapshot } };
};

const platformSnapshots = new Map<string, unknown>();

function memoryArchive(): ArchiveManager {
  const values = new Map<string, Uint8Array>();
  return {
    async writeArtifact(bytes, ext) { const address = digest(bytes), relPath = `${address}.${ext}`, deduped = values.has(relPath);
      values.set(relPath, new Uint8Array(bytes)); return { address, relPath, deduped }; },
    async readArtifact(path) { const value = values.get(path); if (value === undefined) throw new Error("missing archive"); return new Uint8Array(value); },
    async has(path) { return values.has(path) || platformSnapshots.has(path); },
    async quarantine(bytes, ext) { const address = digest(bytes), relPath = `quarantine/${address}.${ext}`, deduped = values.has(relPath);
      values.set(relPath, new Uint8Array(bytes)); return { address, relPath, deduped }; },
    async writeSnapshot(value, when) {
      const json = canonicalJson(value), address = digest(new TextEncoder().encode(json));
      const relPath = `${when.epochSeconds}/${address}.json.gz`;
      platformSnapshots.set(relPath, structuredClone(value));
      return { address, relPath, deduped: false };
    },
    async readSnapshot(path) {
      const value = platformSnapshots.get(path);
      if (value === undefined) throw new Error("missing snapshot");
      return structuredClone(value);
    },
  };
}

function prepared(artifact: ImportArtifact): PrepareFileResult {
  const byte = artifact.bytes[0] as 1 | 2 | 3 | 4, start = starts[byte];
  if (start === undefined) throw new Error("unknown synthetic artifact");
  const address = digest(artifact.bytes);
  const candidate: Candidate = { id: `fit:${address}:0:0`, origin: { kind: "file", format: "fit", rawSha256: address },
    workoutOrdinal: 0, sessionOrdinal: 0, rank: 400, concerns: { "session.sport": "cycling", "session.start_utc": start,
      "session.local_date_key": 20100101, "session.elapsed_s": 100, "session.distance_m": 1_000,
      "session.is_transition": false, "stream:time": { timestamps: [start, start + 100], values: [start, start + 100] } } };
  return { outcome: "prepared", value: { expected_address: address, archive_instant: { epochSeconds: start },
    raw_file: { sha256: address, ext: "fit", bytes: 1, file_id_serial: null, file_id_time_created_utc: null,
      manufacturer: null, product: null }, candidates: [candidate], summaries: [{ candidate_id: candidate.id, member_id: address,
      source_kind: "fit", source_session_seq: 0, sport_family: "cycling", is_transition: false, start_utc: start,
      duration_s: 100, distance_m: 1_000, file_id_manufacturer: null, file_id_serial: null, file_id_time_created_utc: null }],
    repair_events: [] } };
}

async function harness(
  prepareValue: (artifact: ImportArtifact) => PrepareFileResult = prepared,
  materializeClusterInTransaction = createMaterializeClusterInTransaction(hashKey),
) {
  const store = openSqliteStorage(":memory:"); await runMigrations(store, MIGRATIONS);
  const counts = new Map<string, number>();
  const deps: ImportReportDeps = { store, archive: memoryArchive(), hashKey, canonicalPick, ingestVersion: 4,
    prepareFile: async (artifact) => { const address = digest(artifact.bytes); counts.set(address, (counts.get(address) ?? 0) + 1); return prepareValue(artifact); },
    materializeClusterInTransaction };
  return { store: store as SqlStore & MigratorStore, deps, counts };
}

function numberedFile(value: number): ImportArtifact {
  const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value);
  return { input_path: `numbered-${value}.fit`, bytes, ext: "fit" };
}

function numberedPrepared(artifact: ImportArtifact): PrepareFileResult {
  if (artifact.bytes.byteLength !== 4) throw new Error("invalid numbered artifact");
  const value = new DataView(artifact.bytes.buffer, artifact.bytes.byteOffset, artifact.bytes.byteLength).getUint32(0);
  const address = digest(artifact.bytes), start = value * 10_000;
  const candidate: Candidate = { id: `fit:${address}:0:0`, origin: { kind: "file", format: "fit", rawSha256: address },
    workoutOrdinal: 0, sessionOrdinal: 0, rank: 400, concerns: { "session.sport": "cycling", "session.start_utc": start,
      "session.local_date_key": 20100101, "session.elapsed_s": 100, "session.distance_m": 1_000,
      "session.is_transition": false, "stream:time": { timestamps: [start, start + 100], values: [start, start + 100] } } };
  return { outcome: "prepared", value: { expected_address: address, archive_instant: { epochSeconds: start },
    raw_file: { sha256: address, ext: "fit", bytes: 4, file_id_serial: null, file_id_time_created_utc: null,
      manufacturer: null, product: null }, candidates: [candidate], summaries: [{ candidate_id: candidate.id, member_id: address,
      source_kind: "fit", source_session_seq: 0, sport_family: "cycling", is_transition: false, start_utc: start,
      duration_s: 100, distance_m: 1_000, file_id_manufacturer: null, file_id_serial: null,
      file_id_time_created_utc: null }], repair_events: [] } };
}

interface ScenarioSession {
  readonly start: number;
  readonly sport: string;
  readonly transition?: boolean;
  readonly serial?: number;
}

const scenarioFile = (value: number): ImportArtifact => ({ input_path: `scenario-${value}.fit`, bytes: new Uint8Array([value]), ext: "fit" });

function scenarioPrepared(scenarios: Readonly<Record<number, readonly ScenarioSession[]>>) {
  return (artifact: ImportArtifact): PrepareFileResult => {
    const value = artifact.bytes[0]!, sessions = scenarios[value];
    if (sessions === undefined) throw new Error("unknown scenario artifact");
    const address = digest(artifact.bytes);
    const candidates = sessions.map((session, index): Candidate => ({ id: `fit:${address}:0:${index}`,
      origin: { kind: "file", format: "fit", rawSha256: address }, workoutOrdinal: 0, sessionOrdinal: index, rank: 400,
      concerns: { "session.sport": session.sport, "session.start_utc": session.start,
        "session.local_date_key": 20100101, "session.elapsed_s": 100, "session.distance_m": 1_000,
        "session.is_transition": session.transition ?? false,
        "stream:time": { timestamps: [session.start, session.start + 100], values: [session.start, session.start + 100] } } }));
    return { outcome: "prepared", value: { expected_address: address, archive_instant: { epochSeconds: sessions[0]!.start },
      raw_file: { sha256: address, ext: "fit", bytes: 1, file_id_serial: sessions[0]!.serial ?? null,
        file_id_time_created_utc: null, manufacturer: null, product: null }, candidates,
      summaries: sessions.map((session, index) => ({ candidate_id: candidates[index]!.id, member_id: address,
        source_kind: "fit" as const, source_session_seq: index, sport_family: session.sport,
        is_transition: session.transition ?? false, start_utc: session.start, duration_s: 100, distance_m: 1_000,
        file_id_manufacturer: null, file_id_serial: session.serial ?? null, file_id_time_created_utc: null })),
      repair_events: [] } };
  };
}

async function clusterRows(store: SqlStore): Promise<readonly Record<string, unknown>[]> {
  return store.all("SELECT cluster_id,workout_key,topology_signature_json,cluster_report_json FROM ingest_cluster_state ORDER BY cluster_id");
}

describe("incremental rekey", () => {
  it("commits quarantined source evidence without manufacturing a raw input row", async () => {
    const value = await harness(() => ({ outcome: "quarantined", quarantine: { code: "fit:invalid", message: "invalid FIT" } }));
    try {
      const artifact = file(1), address = digest(artifact.bytes), finalized: unknown[] = [];
      await importArtifactsIncrementally({ files: [{ ...artifact, source_evidence: { container: null, entry: {
        source: "intervals-icu", lane: "bulk-fit", externalId: "synthetic-entry", artifactKind: "raw_file",
        archiveAddress: address, archiveRelPath: `1000/${address}.fit`, archiveEpochSeconds: 1_000,
      } } }], platform_records: [] }, { ...value.deps,
        finalizeBatchInTransaction: async (_store, result) => { finalized.push(result); } });
      expect(await value.store.get("SELECT count(*) AS n FROM source_artifact")).toEqual({ n: 1 });
      expect(await value.store.get("SELECT count(*) AS n FROM raw_file")).toEqual({ n: 0 });
      expect(finalized).toEqual([expect.objectContaining({ source_artifact_inserted: 1, raw_file_inserted: 0 })]);
    } finally { await value.store.close(); }
  });

  it("accepts source evidence placement independent of the import placement", async () => {
    const value = await harness();
    try {
      const artifact = file(1), address = digest(artifact.bytes);
      const entry = { source: "intervals-icu" as const, lane: "bulk-fit" as const, externalId: "synthetic-entry",
        artifactKind: "raw_file" as const, archiveAddress: address,
        archiveRelPath: `2024/11/${address}.fit`, archiveEpochSeconds: 1_730_603_881 };
      await expect(importArtifactsIncrementally({ files: [{ ...artifact, source_evidence: { container: null, entry } }],
        platform_records: [] }, value.deps)).resolves.toBeDefined();
      expect(await value.store.get(`SELECT source,lane,external_id,artifact_kind,archive_address,
archive_rel_path,archive_epoch_s FROM source_artifact`)).toEqual({ source: entry.source, lane: entry.lane,
        external_id: entry.externalId, artifact_kind: entry.artifactKind, archive_address: entry.archiveAddress,
        archive_rel_path: entry.archiveRelPath, archive_epoch_s: entry.archiveEpochSeconds });
      expect(await value.store.get("SELECT path FROM raw_file WHERE sha256=?", [address])).toEqual({ path: `${address}.fit` });
    } finally { await value.store.close(); }
  });

  it("recomputes exactly the affected closure", async () => {
    const value = await harness();
    try {
      await importArtifactsIncrementally({ files: [file(1), file(2)], platform_records: [] }, value.deps);
      const unrelated = await value.store.get("SELECT cluster_id,workout_key,topology_signature_json,cluster_report_json FROM ingest_cluster_state WHERE cluster_report_json LIKE ?", [`%${digest(file(2).bytes)}%`]);
      expect(unrelated).toBeDefined();
      value.counts.clear();
      await importArtifactsIncrementally({ files: [file(3)], platform_records: [] }, value.deps);
      expect(value.counts.get(digest(file(3).bytes))).toBe(1);
      expect(value.counts.get(digest(file(1).bytes))).toBe(1);
      expect(value.counts.get(digest(file(2).bytes)) ?? 0).toBe(0);
      expect(await value.store.get("SELECT cluster_id,workout_key,topology_signature_json,cluster_report_json FROM ingest_cluster_state WHERE cluster_id=?", [unrelated!.cluster_id]))
        .toEqual(unrelated);
    } finally { await value.store.close(); }
  });

  it("recomputes exactly the affected closure for a far singleton", async () => {
    const value = await harness(scenarioPrepared({ 1: [{ start: 1_000, sport: "cycling" }],
      2: [{ start: 10_000, sport: "cycling" }], 3: [{ start: 100_000, sport: "cycling" }] }));
    try {
      await importArtifactsIncrementally({ files: [scenarioFile(1), scenarioFile(2)], platform_records: [] }, value.deps);
      const before = await clusterRows(value.store); value.counts.clear();
      await importArtifactsIncrementally({ files: [scenarioFile(3)], platform_records: [] }, value.deps);
      expect(value.counts.get(digest(scenarioFile(3).bytes))).toBe(1);
      expect(value.counts.get(digest(scenarioFile(1).bytes)) ?? 0).toBe(0);
      expect(value.counts.get(digest(scenarioFile(2).bytes)) ?? 0).toBe(0);
      expect((await clusterRows(value.store)).filter((row) => before.some((prior) => prior.cluster_id === row.cluster_id))).toEqual(before);
    } finally { await value.store.close(); }
  });

  it("recomputes exactly the affected closure when a new candidate joins a shared-member cluster", async () => {
    const value = await harness(scenarioPrepared({
      1: [{ start: 1_000, sport: "cycling" }, { start: 5_000, sport: "running" }],
      2: [{ start: 1_050, sport: "cycling" }], 3: [{ start: 100_000, sport: "cycling" }],
    }));
    try {
      await importArtifactsIncrementally({ files: [scenarioFile(1), scenarioFile(3)], platform_records: [] }, value.deps);
      const unrelated = (await clusterRows(value.store)).find((row) => String(row.cluster_report_json).includes(digest(scenarioFile(3).bytes)));
      value.counts.clear();
      await importArtifactsIncrementally({ files: [scenarioFile(2)], platform_records: [] }, value.deps);
      expect(value.counts.get(digest(scenarioFile(1).bytes))).toBe(1);
      expect(value.counts.get(digest(scenarioFile(2).bytes))).toBe(1);
      expect(value.counts.get(digest(scenarioFile(3).bytes)) ?? 0).toBe(0);
      expect((await clusterRows(value.store)).find((row) => row.cluster_id === unrelated?.cluster_id)).toEqual(unrelated);
    } finally { await value.store.close(); }
  });

  it("recomputes exactly the affected closure for a brick merge", async () => {
    const value = await harness(scenarioPrepared({ 1: [{ start: 0, sport: "running" }],
      2: [{ start: 400, sport: "running" }], 3: [{ start: 200, sport: "cycling" }] }));
    try {
      await importArtifactsIncrementally({ files: [scenarioFile(1), scenarioFile(2)], platform_records: [] }, value.deps);
      expect(await clusterRows(value.store)).toHaveLength(2); value.counts.clear();
      await importArtifactsIncrementally({ files: [scenarioFile(3)], platform_records: [] }, value.deps);
      expect(await clusterRows(value.store)).toHaveLength(1);
      expect(Object.fromEntries([1, 2, 3].map((number) => [number,
        value.counts.get(digest(scenarioFile(number).bytes)) ?? 0]))).toEqual({ 1: 1, 2: 1, 3: 1 });
    } finally { await value.store.close(); }
  });

  it("recomputes exactly the affected closure for an inserted-between brick split", async () => {
    const value = await harness(scenarioPrepared({ 1: [{ start: 0, sport: "running" }],
      2: [{ start: 300, sport: "cycling" }], 3: [{ start: 200, sport: "transition", transition: true }] }));
    try {
      await importArtifactsIncrementally({ files: [scenarioFile(1), scenarioFile(2)], platform_records: [] }, value.deps);
      expect(await clusterRows(value.store)).toHaveLength(1); value.counts.clear();
      await importArtifactsIncrementally({ files: [scenarioFile(3)], platform_records: [] }, value.deps);
      expect(await clusterRows(value.store)).toHaveLength(3);
      expect(Object.fromEntries([1, 2, 3].map((number) => [number,
        value.counts.get(digest(scenarioFile(number).bytes)) ?? 0]))).toEqual({ 1: 1, 2: 1, 3: 1 });
    } finally { await value.store.close(); }
  });

  it("full oracle and incremental dumps are byte-identical", async () => {
    const oracle = await harness(), incremental = await harness();
    try {
      await importArtifactsWithReport({ files: [file(3), file(2), file(1)], platform_records: [platform()] }, oracle.deps);
      await importArtifactsIncrementally({ files: [file(1), file(2)], platform_records: [platform()] }, incremental.deps);
      await importArtifactsIncrementally({ files: [file(3)], platform_records: [] }, incremental.deps);
      expect(await dumpStore(incremental.store)).toBe(await dumpStore(oracle.store));
    } finally { await oracle.store.close(); await incremental.store.close(); }
  });

  it("full oracle and incremental dumps are byte-identical under a permuted order with settings and confirmation", async () => {
    const prepare = scenarioPrepared({ 1: [{ start: 0, sport: "cycling", serial: 1 }],
      2: [{ start: 50, sport: "cycling", serial: 2 }], 3: [{ start: 1_200, sport: "running" }] });
    const oracle = await harness(prepare), incremental = await harness(prepare);
    try {
      const members = [digest(scenarioFile(1).bytes), digest(scenarioFile(2).bytes)].sort();
      for (const value of [oracle, incremental]) {
        await value.store.run(`INSERT INTO sport_settings
(id,sport,session_cluster_conventions_json,preferred_units,activity_type_map_json,device_id,hlc_physical_ms,hlc_counter)
VALUES(?,?,?,?,?,?,?,?)`, ["1".repeat(26), "cycling", '{"transition_window_s":1500}', null, null, "device", 1, 0]);
        await value.store.run(`INSERT INTO dedup_confirmation
(id,member_a,member_b,verdict,device_id,hlc_physical_ms,hlc_counter) VALUES(?,?,?,?,?,?,?)`,
        ["0".repeat(26), members[0], members[1], "merge", "device", 1, 0]);
      }
      await importArtifactsWithReport({ files: [scenarioFile(3), scenarioFile(1), scenarioFile(2)], platform_records: [] }, oracle.deps);
      await importArtifactsIncrementally({ files: [scenarioFile(2)], platform_records: [] }, incremental.deps);
      await importArtifactsIncrementally({ files: [scenarioFile(3), scenarioFile(1)], platform_records: [] }, incremental.deps);
      expect(await dumpStore(incremental.store)).toBe(await dumpStore(oracle.store));
    } finally { await oracle.store.close(); await incremental.store.close(); }
  });

  it("prepares incoming once and only affected persisted artifacts", async () => {
    const value = await harness();
    try {
      await importArtifactsIncrementally({ files: [file(1), file(2)], platform_records: [] }, value.deps);
      value.counts.clear();
      await importArtifactsIncrementally({ files: [file(3)], platform_records: [] }, value.deps);
      expect(Object.fromEntries([1, 2, 3].map((byte) => [byte, value.counts.get(digest(file(byte as 1 | 2 | 3).bytes)) ?? 0])))
        .toEqual({ 1: 1, 2: 0, 3: 1 });
    } finally { await value.store.close(); }
  });

  it("prepares incoming once and only affected persisted artifacts across 4000 nonoverlapping rows", async () => {
    let materialized = 0;
    const baseMaterializer = createMaterializeClusterInTransaction(hashKey);
    const value = await harness(numberedPrepared, async (store, cluster) => {
      materialized += 1;
      await baseMaterializer(store, cluster);
    });
    try {
      for (let offset = 1; offset <= 4_000; offset += 400) {
        await importArtifactsIncrementally({ files: Array.from({ length: 400 }, (_, index) => numberedFile(offset + index)),
          platform_records: [] }, value.deps);
      }
      expect([...value.counts.values()].reduce((sum, count) => sum + count, 0)).toBe(4_000);
      expect([...value.counts.values()].every((count) => count === 1)).toBe(true);
      expect(materialized).toBe(4_000);
    } finally { await value.store.close(); }
  }, 120_000);

  it.each([400, 1_000])("bootstraps legacy cache once with a bounded %i-row batch", async (batchSize) => {
    const value = await harness(numberedPrepared);
    try {
      const persisted = numberedFile(10_000);
      await importArtifactsIncrementally({ files: [persisted], platform_records: [] }, value.deps);
      await value.store.run("UPDATE ingest_incremental_state SET initialized=0");
      value.counts.clear();
      await importArtifactsIncrementally({ files: Array.from({ length: batchSize }, (_, index) => numberedFile(index + 1)),
        platform_records: [] }, value.deps);
      expect(value.counts.get(digest(persisted.bytes))).toBe(1);
      expect([...value.counts.values()].reduce((sum, count) => sum + count, 0)).toBe(batchSize + 1);
      expect(await value.store.get("SELECT initialized FROM ingest_incremental_state")).toEqual({ initialized: 1 });
      value.counts.clear();
      await importArtifactsIncrementally({ files: [numberedFile(20_000 + batchSize)], platform_records: [] }, value.deps);
      expect(value.counts.get(digest(persisted.bytes)) ?? 0).toBe(0);
    } finally { await value.store.close(); }
  }, 120_000);

  it("uses the full oracle when stored ingest semantics are stale", async () => {
    const value = await harness();
    try {
      await importArtifactsIncrementally({ files: [file(1), file(2)], platform_records: [] }, value.deps);
      await value.store.run("UPDATE ingest_metadata SET ingest_version=3");
      value.counts.clear();
      await importArtifactsIncrementally({ files: [file(4)], platform_records: [] }, value.deps);
      expect(value.counts.get(digest(file(1).bytes))).toBe(1);
      expect(value.counts.get(digest(file(2).bytes))).toBe(1);
      expect(value.counts.get(digest(file(4).bytes))).toBe(1);
      expect(await value.store.get("SELECT ingest_version FROM ingest_metadata")).toEqual({ ingest_version: 4 });
    } finally { await value.store.close(); }
  });

  it("uses the full oracle for a mutable platform current-selection refresh", async () => {
    const value = await harness();
    try {
      await importArtifactsIncrementally({ files: [file(1)], platform_records: [platform()] }, value.deps);
      value.counts.clear();
      const report = await importArtifactsIncrementally({ files: [], platform_records: [platform("Revised ride")] }, value.deps);
      expect(value.counts.get(digest(file(1).bytes))).toBe(1);
      expect(report.updates.source_record).toBe(1);
      expect(await value.store.get("SELECT count(*) AS n FROM source_record_revision")).toEqual({ n: 2 });
    } finally { await value.store.close(); }
  });

  it("commits data and progress together", async () => {
    const value = await harness();
    try {
      const before = await dumpStore(value.store);
      await expect(importArtifactsIncrementally({ files: [file(1)], platform_records: [] }, { ...value.deps,
        finalizeBatchInTransaction: async () => { throw new Error("injected checkpoint failure"); } })).rejects.toThrow("injected checkpoint failure");
      expect(await dumpStore(value.store)).toBe(before);
      let finalized = false;
      const run = value.store.run.bind(value.store);
      value.store.run = async (sql, params) => { if (finalized) throw new Error("write after checkpoint"); return run(sql, params); };
      await importArtifactsIncrementally({ files: [file(1)], platform_records: [] }, { ...value.deps,
        finalizeBatchInTransaction: async () => { finalized = true; } });
      expect(finalized).toBe(true);
    } finally { await value.store.close(); }
  });

  it("accepts cached pair diagnostics oriented opposite to the candidate-ordered row key", async () => {
    const longPrepared = (artifact: ImportArtifact): PrepareFileResult => {
      const base = prepared(artifact), start = starts[artifact.bytes[0] as 1 | 2 | 3 | 4]!;
      if (base.outcome !== "prepared") throw new Error("unexpected quarantine");
      if (artifact.bytes[0] !== 1) return base;
      const candidate = base.value.candidates[0]!;
      return { ...base, value: { ...base.value,
        candidates: [{ ...candidate, concerns: { ...candidate.concerns, "session.elapsed_s": 1_000,
          "stream:time": { timestamps: [start, start + 1_000], values: [start, start + 1_000] } } }],
        summaries: [{ ...base.value.summaries[0]!, duration_s: 1_000 }] } };
    };
    const platformVariant = (activityId: string): PlatformImportArtifact => {
      const base = platform();
      const activity = { id: activityId, name: "Structured ride" };
      const compact = JSON.stringify(sortKeys(activity));
      const snapshot = canonicalJson(activity), address = digest(new TextEncoder().encode(snapshot));
      const archive = { address, relPath: `1000/${address}.json.gz`, deduped: false };
      platformSnapshots.set(archive.relPath, structuredClone(activity));
      return { ...base, activity_id: activityId, activity,
        concerns: { ...base.concerns, "session.summary_json": compact },
        raw_snapshot_address: address, raw_snapshot_rel_path: archive.relPath,
        sourceEvidence: { ...base.sourceEvidence!, externalId: activityId, archive, normalizedActivityJson: snapshot } };
    };
    let exercised = false;
    for (const suffix of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      const value = await harness(longPrepared);
      try {
        await importArtifactsIncrementally({ files: [file(1)], platform_records: [] }, value.deps);
        await importArtifactsIncrementally({ files: [], platform_records: [platformVariant(`platform-${suffix}`)] }, value.deps);
        const row = await value.store.get("SELECT * FROM ingest_dedup_pair_state WHERE overlap_watchlist_json IS NOT NULL");
        if (row === undefined) continue;
        const diagnostic = JSON.parse(row.overlap_watchlist_json as string) as { candidate_a: string; candidate_b: string };
        expect([diagnostic.candidate_a, diagnostic.candidate_b].sort()).toEqual([row.candidate_a, row.candidate_b].sort());
        if (diagnostic.candidate_a === row.candidate_a) continue;
        await importArtifactsIncrementally({ files: [file(4)], platform_records: [] }, value.deps);
        expect(await value.store.get("SELECT count(*) AS n FROM raw_file")).toEqual({ n: 2 });
        exercised = true;
        break;
      } finally { await value.store.close(); }
    }
    expect(exercised).toBe(true);
  });

  it("rejects pair-cache disagreement without preferring cached or fresh topology", async () => {
    const value = await harness();
    try {
      await importArtifactsIncrementally({ files: [file(1)], platform_records: [] }, value.deps);
      await importArtifactsIncrementally({ files: [file(3)], platform_records: [] }, value.deps);
      expect(await value.store.get("SELECT count(*) AS n FROM ingest_dedup_pair_state")).toEqual({ n: 1 });
      await value.store.run("UPDATE ingest_dedup_pair_state SET edge_tier='tier2'");
      await expect(importArtifactsIncrementally({ files: [file(4)], platform_records: [] }, value.deps))
        .rejects.toThrow("dedup pair cache disagreement");
      expect(await value.store.get("SELECT count(*) AS n FROM raw_file")).toEqual({ n: 2 });
    } finally { await value.store.close(); }
  });
});
