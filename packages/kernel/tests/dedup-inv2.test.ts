import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalPick, createMaterializeClusterInTransaction, decodeStream, importArtifactsWithReport, type Candidate,
  type ConcernValue, type ImportArtifact, type PlatformImportArtifact, type PrepareFileResult } from "../src/ingest/index.js";
import type { ArchiveManager } from "../src/archive/index.js";
import { DERIVED_TABLES, sortKeys, type DedupConfirmationRow, type Row, type SourceRecordRow, type SqlStore, type SqlValue } from "../src/store/index.js";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const hashKey = async (fields: readonly (string | number)[]) => createHash("sha256").update(fields.join("\u001f")).digest("hex");

class MemoryStore implements SqlStore {
  metadata = 2;
  raw = new Map<string, Row>();
  source = new Map<string, SourceRecordRow>();
  confirmations: DedupConfirmationRow[] = [];
  strokeOverlays: Row[] = [];
  poolOverlays: Row[] = [];
  fieldOverlays: Row[] = [];
  events: string[] = [];
  streamWrites: { readonly channel: string; readonly encoding: string; readonly n: number; readonly data: Uint8Array }[] = [];
  transactionCount = 0;
  failOrphans = false;
  async exec(sql: string) { this.events.push(`delete:${sql.slice(12)}`); }
  async run(sql: string, params: readonly SqlValue[] = []) {
    if (sql.startsWith("UPDATE ingest_metadata")) this.metadata = params[0] as number;
    else if (sql.startsWith("UPDATE source_record")) {
      const row = this.source.get(params[2] as string); if (row) this.source.set(row.id, { ...row, workout_key: params[0] as string, session_key: params[1] as string });
    } else if (sql.startsWith("INSERT INTO stream")) {
      const data = params[6];
      if (!(data instanceof Uint8Array)) throw new TypeError("stream data must be bytes");
      this.events.push("insert:stream");
      this.streamWrites.push({ channel: params[2] as string, encoding: params[3] as string, n: params[5] as number, data: new Uint8Array(data) });
    } else if (sql.startsWith("INSERT INTO workout")) this.events.push("insert:workout");
    else if (sql.startsWith("INSERT INTO session")) this.events.push("insert:session");
    else if (sql.startsWith("INSERT INTO lap")) this.events.push("insert:lap");
    else if (sql.startsWith("INSERT INTO swim_length")) this.events.push("insert:swim_length");
    else if (sql.startsWith("INSERT INTO repair_log")) this.events.push("insert:repair_log");
  }
  async get(sql: string, params: readonly SqlValue[] = []): Promise<Row | undefined> {
    if (sql.startsWith("INSERT INTO raw_file")) {
      this.events.push("insert:raw");
      const sha = params[0] as string;
      if (this.raw.has(sha)) return undefined;
      this.raw.set(sha, { sha256: sha, path: params[1]!, ext: params[2]!, bytes: params[3]!, file_id_serial: params[4]!,
        file_id_time_created_utc: params[5]!, manufacturer: params[6]!, product: params[7]! }); return { sha256: sha };
    }
    if (sql.includes("FROM raw_file WHERE sha256=?")) return this.raw.get(params[0] as string);
    if (sql.startsWith("INSERT INTO source_record")) {
      this.events.push("insert:source");
      const row: SourceRecordRow = { id: params[0] as string, workout_key: params[1] as string | null, session_key: params[2] as string | null,
        source: params[3] as string, external_id: params[4] as string, raw_sha256: params[5] as string | null,
        quality_rank: params[6] as number, payload_json: params[7] as string };
      if (this.source.has(row.id)) return undefined; this.source.set(row.id, row); return { id: row.id };
    }
    if (sql.includes("FROM source_record WHERE id = ?")) return this.source.get(params[0] as string) as unknown as Row | undefined;
    if (sql.includes("FROM source_record WHERE source = ?")) return [...this.source.values()].find((row) => row.source === params[0] && row.external_id === params[1]) as unknown as Row | undefined;
    if (sql.startsWith("SELECT corrected_pool_length_m")) return undefined;
    if (sql.startsWith("SELECT repair_key")) return undefined;
    return undefined;
  }
  async all(sql: string): Promise<Row[]> {
    if (sql.startsWith("SELECT ingest_version")) return [{ ingest_version: this.metadata }];
    if (sql.startsWith("SELECT singleton")) return [{ singleton: 1, ingest_version: this.metadata }];
    if (sql.includes("FROM raw_file") && sql.includes("ORDER BY sha256")) return [...this.raw.values()].sort((a, b) => String(a.sha256).localeCompare(String(b.sha256)));
    if (sql.includes("FROM source_record") && sql.includes("ORDER BY id")) return [...this.source.values()] as unknown as Row[];
    if (sql.includes("FROM dedup_confirmation")) return this.confirmations as unknown as Row[];
    if (sql.includes("FROM sport_settings")) return [];
    if (sql.includes("FROM workout")) return [];
    if (sql.includes("FROM stroke_correction_overlay")) {
      if (this.failOrphans) throw new Error("orphan enumeration failed");
      return this.strokeOverlays;
    }
    if (sql.includes("FROM pool_size_correction_overlay")) return this.poolOverlays;
    if (sql.includes("FROM field_merge_override_overlay")) return this.fieldOverlays;
    return [];
  }
  async close() {}
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.transactionCount += 1; this.events.push("transaction:start");
    const raw = new Map(this.raw), source = new Map(this.source), metadata = this.metadata;
    try { const value = await fn(); this.events.push("transaction:commit"); return value; }
    catch (error) { this.raw = raw; this.source = source; this.metadata = metadata; this.events.push("transaction:rollback"); throw error; }
  }
}

function archive(): ArchiveManager & { readonly files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    async writeArtifact(bytes, ext) { const address = digest(bytes), relPath = `${address}.${ext}`, deduped = files.has(relPath); files.set(relPath, new Uint8Array(bytes)); return { address, relPath, deduped }; },
    async quarantine(bytes, ext) { const address = digest(bytes), relPath = `q/${address}.${ext}`; files.set(relPath, new Uint8Array(bytes)); return { address, relPath, deduped: false }; },
    async readArtifact(path) { const value = files.get(path); if (!value) throw new Error("missing archive"); return new Uint8Array(value); },
    async writeSnapshot() { throw new Error("unused"); }, async readSnapshot() { throw new Error("unused"); }, async has(path) { return files.has(path); },
  };
}

function prepared(artifact: ImportArtifact): PrepareFileResult {
  const address = digest(artifact.bytes), start = 1_000;
  const candidate: Candidate = { id: `fit:${address}:0:0`, origin: { kind: "file", format: "fit", rawSha256: address }, workoutOrdinal: 0,
    sessionOrdinal: 0, rank: 400, concerns: { "session.sport": "cycling", "session.start_utc": start,
      "session.local_date_key": 20000101, "session.elapsed_s": 100, "session.is_transition": false,
      "stream:time": { timestamps: [start, start + 100], values: [start, start + 100] },
      "stream:power": { timestamps: [start, start + 100], values: [100, 110] } } };
  return { outcome: "prepared", value: { expected_address: address, archive_instant: { epochSeconds: start },
    raw_file: { sha256: address, ext: artifact.ext, bytes: artifact.bytes.byteLength, file_id_serial: 7,
      file_id_time_created_utc: null, manufacturer: null, product: null }, candidates: [candidate],
    summaries: [{ candidate_id: candidate.id, member_id: address, source_kind: "fit", source_session_seq: 0,
      sport_family: "cycling", is_transition: false, start_utc: start, duration_s: 100, distance_m: null,
      file_id_manufacturer: null, file_id_serial: 7, file_id_time_created_utc: null }], repair_events: [] } };
}

function platform(): PlatformImportArtifact {
  const activity = { id: "p" };
  const concerns: Record<string, ConcernValue> = { "session.sport": "cycling", "session.start_utc": 1_000,
    "session.local_date_key": 20000101, "session.elapsed_s": 100, "session.is_transition": false,
    "session.summary_json": JSON.stringify(sortKeys(activity)), "stream:time": { timestamps: [1_000, 1_100], values: [1_000, 1_100] } };
  return { source: "intervals-icu", activity_id: "p", activity, dedup: { sport_family: "cycling", is_transition: false,
    start_utc: 1_000, duration_s: 100, distance_m: null }, concerns, raw_snapshot_address: null, raw_snapshot_rel_path: null };
}

function deps(store: MemoryStore, rawArchive: ReturnType<typeof archive>, materialize: () => Promise<void> = async () => {}) {
  const groups: Candidate[][] = [];
  return { groups, value: { archive: rawArchive, store, hashKey, prepareFile: async (artifact: ImportArtifact) => prepared(artifact),
    canonicalPick(group: Parameters<typeof canonicalPick>[0]) { groups.push([...group.candidates]); return canonicalPick(group); },
    materializeClusterInTransaction: async () => { store.events.push("materialize"); await materialize(); }, ingestVersion: 2 as const } };
}

describe("global replan invariant", () => {
  it("[PR05-INV2-001] completes preparation and planning before writes", async () => {
    const store = new MemoryStore(), a = archive(), d = deps(store, a);
    await importArtifactsWithReport({ files: [{ input_path: "a.fit", bytes: new Uint8Array([1]), ext: "fit" }], platform_records: [] }, d.value);
    expect(store.events.indexOf("transaction:start")).toBeLessThan(store.events.indexOf("insert:raw"));
    expect(d.groups).toHaveLength(1);
  });
  it("[PR05-INV2-002] inserts sources before one global delete and materialization transaction", async () => {
    const store = new MemoryStore(), a = archive(), d = deps(store, a);
    await importArtifactsWithReport({ files: [{ input_path: "a.fit", bytes: new Uint8Array([1]), ext: "fit" }], platform_records: [platform()] }, d.value);
    expect(store.events.indexOf("insert:raw")).toBeLessThan(store.events.findIndex((event) => event.startsWith("delete:")));
    expect(store.events.indexOf("insert:source")).toBeLessThan(store.events.indexOf("materialize")); expect(store.transactionCount).toBe(1);
  });
  it("[PR05-INV2-003] rolls back SQL while retaining archive bytes on later failure", async () => {
    const store = new MemoryStore(), a = archive(), d = deps(store, a, async () => { throw new Error("materialize failed"); });
    await expect(importArtifactsWithReport({ files: [{ input_path: "a.fit", bytes: new Uint8Array([1]), ext: "fit" }], platform_records: [] }, d.value)).rejects.toThrow("materialize failed");
    expect(store.raw.size).toBe(0); expect(a.files.size).toBe(1); expect(store.events).toContain("transaction:rollback");
  });
  it("[PR05-INV2-004] rereads persisted raw bytes and replays the exact platform origin rank", async () => {
    const store = new MemoryStore(), a = archive(), first = deps(store, a);
    await importArtifactsWithReport({ files: [{ input_path: "a.fit", bytes: new Uint8Array([1]), ext: "fit" }], platform_records: [platform()] }, first.value);
    const second = deps(store, a);
    await importArtifactsWithReport({ files: [{ input_path: "b.fit", bytes: new Uint8Array([2]), ext: "fit" }], platform_records: [] }, second.value);
    const origin = second.groups.flat().find((candidate) => candidate.origin.kind === "platform")?.origin;
    expect(origin).toEqual({ kind: "platform", source: "intervals-icu", sourceRecordId: [...store.source.keys()][0], persistedQualityRank: 300 });
  });
  it("[PR05-INV2-005] recomputes later merges and authored distinct splits", async () => {
    const store = new MemoryStore(), a = archive(), first = deps(store, a);
    const files = [{ input_path: "a.fit", bytes: new Uint8Array([1]), ext: "fit" as const }, { input_path: "b.fit", bytes: new Uint8Array([2]), ext: "fit" as const }];
    expect((await importArtifactsWithReport({ files, platform_records: [] }, first.value)).clusters).toHaveLength(1);
    const ids = [...store.raw.keys()].sort(); store.confirmations = [{ id: "0".repeat(26), member_a: ids[0]!, member_b: ids[1]!, verdict: "distinct", device_id: "d", hlc_physical_ms: 1, hlc_counter: 0 }];
    const second = deps(store, a);
    expect((await importArtifactsWithReport({ files: [{ input_path: "retry.fit", bytes: new Uint8Array([1]), ext: "fit" }], platform_records: [] }, second.value)).clusters).toHaveLength(2);
  });
  it("[PR05-INV2-006] retains authored sources and overlays with exact orphan mappings", async () => {
    const store = new MemoryStore(), a = archive(), missing = "f".repeat(64);
    store.confirmations = [{ id: "0".repeat(26), member_a: "e".repeat(64), member_b: missing, verdict: "merge", device_id: "d", hlc_physical_ms: 1, hlc_counter: 0 }];
    store.strokeOverlays = [{ id: "stroke", target_length_key: "missing-length" }];
    store.poolOverlays = [{ id: "pool", target_session_key: "missing-session" }];
    store.fieldOverlays = [{ id: "field-session", target_table: "session", target_key: "missing-field-session" },
      { id: "field-unsupported", target_table: "athlete", target_key: "missing-athlete" }];
    const retained = { confirmations: structuredClone(store.confirmations), stroke: structuredClone(store.strokeOverlays),
      pool: structuredClone(store.poolOverlays), field: structuredClone(store.fieldOverlays) };
    const d = deps(store, a), value = await importArtifactsWithReport({ files: [{ input_path: "a.fit", bytes: new Uint8Array([1]), ext: "fit" }], platform_records: [platform()] }, d.value);
    expect(store.source.size).toBe(1);
    expect({ confirmations: store.confirmations, stroke: store.strokeOverlays, pool: store.poolOverlays, field: store.fieldOverlays }).toEqual(retained);
    expect(store.events.filter((event) => event.startsWith("delete:"))).toEqual(DERIVED_TABLES.map((table) => `delete:${table}`));
    expect(value.applied_confirmations).toEqual([expect.objectContaining({ id: "0".repeat(26), result: "orphaned", reason: "confirmation_member_missing" })]);
    expect(value.orphaned_overlays).toEqual([
      { id: "0".repeat(26), target_kind: "dedup_confirmation:member", target_key: "e".repeat(64), reason: "confirmation_member_missing" },
      { id: "0".repeat(26), target_kind: "dedup_confirmation:member", target_key: missing, reason: "confirmation_member_missing" },
      { id: "field-unsupported", target_kind: "field_merge_override_overlay:athlete", target_key: "missing-athlete", reason: "unsupported_target_kind" },
      { id: "field-session", target_kind: "field_merge_override_overlay:session", target_key: "missing-field-session", reason: "target_missing_after_rekey" },
      { id: "pool", target_kind: "pool_size_correction_overlay:session", target_key: "missing-session", reason: "target_missing_after_rekey" },
      { id: "stroke", target_kind: "stroke_correction_overlay:swim_length", target_key: "missing-length", reason: "target_missing_after_rekey" },
    ]);
  });
  it("[PR05-INV2-007] owns one outer transaction and passes atomic concerns to materialization", async () => {
    const store = new MemoryStore(), a = archive(), d = deps(store, a);
    const materialize = createMaterializeClusterInTransaction(hashKey);
    const selectedTime = { timestamps: [1_000, 1_050, 1_100], values: [1_000, 1_050, 1_100] };
    const selectedPower = { timestamps: [1_000, 1_050, 1_100], values: [101, 202, 303] };
    const lowerTime = { timestamps: [1_001, 1_051, 1_101], values: [1_001, 1_051, 1_101] };
    const lowerPower = { timestamps: [1_001, 1_051, 1_101], values: [901, 902, 903] };
    const competingPrepared = (artifact: ImportArtifact): PrepareFileResult => {
      const result = prepared(artifact);
      if (result.outcome !== "prepared") throw new Error("fixture preparation failed");
      const baseCandidate = result.value.candidates[0]!;
      const baseSummary = result.value.summaries[0]!;
      const selected = artifact.ext === "fit";
      const candidate: Candidate = {
        ...baseCandidate,
        id: `${artifact.ext}:${result.value.expected_address}:0:0`,
        origin: { kind: "file", format: artifact.ext, rawSha256: result.value.expected_address },
        rank: selected ? 400 : 100,
        concerns: { ...baseCandidate.concerns, "stream:time": selected ? selectedTime : lowerTime,
          "stream:power": selected ? selectedPower : lowerPower },
      };
      return { outcome: "prepared", value: { ...result.value, candidates: [candidate], summaries: [{ ...baseSummary,
        candidate_id: candidate.id, source_kind: artifact.ext }] } };
    };
    await importArtifactsWithReport({ files: [
      { input_path: "selected.fit", bytes: new Uint8Array([1]), ext: "fit" },
      { input_path: "lower.gpx", bytes: new Uint8Array([2]), ext: "gpx" },
    ], platform_records: [] }, {
      ...d.value,
      prepareFile: async (artifact) => competingPrepared(artifact),
      materializeClusterInTransaction: async (target, cluster) => { store.events.push("materialize"); await materialize(target, cluster); },
    });
    expect(store.transactionCount).toBe(1);
    expect(store.events.filter((event) => event === "materialize")).toHaveLength(1);
    expect(d.groups).toHaveLength(1);
    expect(d.groups[0]?.map((candidate) => ({ format: candidate.origin.kind === "file" ? candidate.origin.format : "platform", rank: candidate.rank })))
      .toEqual([{ format: "fit", rank: 400 }, { format: "gpx", rank: 100 }]);
    expect(store.streamWrites.map(({ channel, n }) => ({ channel, n }))).toEqual([
      { channel: "time", n: 3 }, { channel: "power", n: 3 },
    ]);
    const persisted = (channel: "time" | "power") => {
      const row = store.streamWrites.find((entry) => entry.channel === channel);
      if (!row) throw new Error(`missing persisted ${channel} stream`);
      return decodeStream({ encoding: row.encoding, n: row.n, kind: channel === "time" ? "time" : "value", data: row.data });
    };
    expect(persisted("time")).toEqual(selectedTime.values);
    expect(persisted("power")).toEqual(selectedPower.values);
    expect(lowerTime.values.every((value, index) => value !== selectedTime.values[index])).toBe(true);
    expect(lowerPower.values.every((value, index) => value !== selectedPower.values[index])).toBe(true);
    expect(store.events.indexOf("transaction:start")).toBeLessThan(store.events.indexOf("insert:stream"));
    expect(store.events.indexOf("insert:stream")).toBeLessThan(store.events.indexOf("transaction:commit"));
    const candidate = (id: string, powerTimestamps: readonly number[]): Candidate => ({
      id, origin: { kind: "file", format: "fit", rawSha256: id.slice(4, 68) }, workoutOrdinal: 0, sessionOrdinal: 0, rank: 400,
      concerns: { "session.sport": "cycling", "session.start_utc": 1_000, "session.local_date_key": 20000101,
        "session.is_transition": false, "stream:time": { timestamps: [1_000, 1_100], values: [1_000, 1_100] },
        "stream:power": { timestamps: powerTimestamps, values: [100, 110] } },
    });
    const high = candidate(`fit:${"a".repeat(64)}:0:0`, [1_000, 1_100]);
    const mismatch = candidate(`fit:${"b".repeat(64)}:0:0`, [1_000, 1_101]);
    const selected = (candidates: readonly Candidate[], forceMismatchedWinner = false) => {
      const fitSerialByCandidateId = Object.fromEntries(candidates.map((entry) => [entry.id, 1]));
      const group = { id: candidates[0]!.id, candidates, fitSerialByCandidateId };
      const base = canonicalPick(group);
      const pick = forceMismatchedWinner ? { ...base, winners: [...base.winners, { concern: "stream:power",
        candidateId: candidates[0]!.id, rank: 400 as const, value: candidates[0]!.concerns["stream:power"]! }] } : base;
      return { cluster_id: "a".repeat(64), workout_key: "b".repeat(64), sessions: [{
        session_seq: 0, group, pick, repair_events: [],
      }] };
    };
    await expect(materialize(new MemoryStore(), selected([mismatch], true))).rejects.toThrow("winning stream timeline mismatch: power");
    await expect(materialize(new MemoryStore(), selected([high, mismatch]))).resolves.toBeUndefined();
  });
  it("[PR05-INV2-008] upgrades old metadata and reports the current code version", async () => {
    const store = new MemoryStore(); store.metadata = 0; const a = archive(), d = deps(store, a);
    const value = await importArtifactsWithReport({ files: [{ input_path: "a.fit", bytes: new Uint8Array([1]), ext: "fit" }], platform_records: [] }, d.value);
    expect(value.ingest_version).toBe(2); expect(store.metadata).toBe(2);
  });
});
