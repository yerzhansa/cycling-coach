import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalPick, DEFAULT_TIER3_THRESHOLDS, DEFAULT_TRANSITION_WINDOW_S, importArtifactsWithReport,
  serializeImportReport, type Candidate, type ImportArtifact, type PrepareFileResult, type RepairFixerSettings } from "../src/ingest/index.js";
import type { ArchiveManager } from "../src/archive/index.js";
import type { DedupConfirmationRow, Row, SqlStore, SqlValue } from "../src/store/index.js";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const hashKey = async (fields: readonly (string | number)[]) => createHash("sha256").update(fields.join("\u001f")).digest("hex");

class ReportStore implements SqlStore {
  readonly raw = new Map<string, Row>();
  confirmations: DedupConfirmationRow[] = [];
  strokeOverlays: Row[] = [];
  poolOverlays: Row[] = [];
  fieldOverlays: Row[] = [];
  metadata = 2;
  async exec() {}
  async run(sql: string, params: readonly SqlValue[] = []) {
    if (sql.startsWith("UPDATE ingest_metadata")) this.metadata = params[0] as number;
  }
  async get(sql: string, params: readonly SqlValue[] = []): Promise<Row | undefined> {
    if (sql.startsWith("INSERT INTO raw_file")) {
      const sha256 = params[0] as string;
      if (this.raw.has(sha256)) return undefined;
      this.raw.set(sha256, { sha256, path: params[1]!, ext: params[2]!, bytes: params[3]!, file_id_serial: params[4]!,
        file_id_time_created_utc: params[5]!, manufacturer: params[6]!, product: params[7]! });
      return { sha256 };
    }
    if (sql.includes("FROM raw_file WHERE sha256=?")) return this.raw.get(params[0] as string);
    return undefined;
  }
  async all(sql: string): Promise<Row[]> {
    if (sql.startsWith("SELECT ingest_version")) return [{ ingest_version: this.metadata }];
    if (sql.startsWith("SELECT singleton")) return [{ singleton: 1, ingest_version: this.metadata }];
    if (sql.includes("FROM raw_file") && sql.includes("ORDER BY sha256")) return [...this.raw.values()].sort((a, b) => String(a.sha256).localeCompare(String(b.sha256)));
    if (sql.includes("FROM dedup_confirmation")) return this.confirmations as unknown as Row[];
    if (sql.includes("FROM repair_fixer_settings")) return [];
    if (sql.includes("FROM stroke_correction_overlay")) return this.strokeOverlays;
    if (sql.includes("FROM pool_size_correction_overlay")) return this.poolOverlays;
    if (sql.includes("FROM field_merge_override_overlay")) return this.fieldOverlays;
    return [];
  }
  async close() {}
  async transaction<T>(fn: () => Promise<T>): Promise<T> { return fn(); }
}

function archive(): ArchiveManager & { readonly files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    async writeArtifact(bytes, ext) {
      const address = digest(bytes), relPath = `${address}.${ext}`, deduped = files.has(relPath);
      files.set(relPath, new Uint8Array(bytes)); return { address, relPath, deduped };
    },
    async quarantine(bytes, ext) {
      const address = digest(bytes), relPath = `q/${address}.${ext}`, deduped = files.has(relPath);
      files.set(relPath, new Uint8Array(bytes)); return { address, relPath, deduped };
    },
    async readArtifact(path) { const value = files.get(path); if (!value) throw new Error("missing archive"); return new Uint8Array(value); },
    async writeSnapshot() { throw new Error("unused"); }, async readSnapshot() { throw new Error("unused"); },
    async has(path) { return files.has(path); },
  };
}

function prepare(artifact: ImportArtifact): PrepareFileResult {
  const address = digest(artifact.bytes);
  if (artifact.bytes[0] === 0) return { outcome: "quarantined", quarantine: { code: "fit:decode_failed", message: "rejected" } };
  const serial = artifact.bytes[0] ?? 1, multi = serial === 9 || serial === 10;
  const offset = serial === 10 ? 180 : 0, duration = serial === 10 ? 115 : 100;
  const baseStart = serial === 11 ? 10_000 : serial === 13 ? 1_200 : 1_000;
  const starts = multi ? [1_000 + offset, 3_000 + offset] : [baseStart];
  const sport = serial === 13 ? "running" : "cycling";
  const candidates: Candidate[] = starts.map((start, sessionOrdinal) => ({ id: `fit:${address}:0:${sessionOrdinal}`,
    origin: { kind: "file", format: "fit", rawSha256: address }, workoutOrdinal: 0, sessionOrdinal, rank: 400,
    concerns: { "session.sport": sport, "session.start_utc": start, "session.local_date_key": 20000101,
      "session.elapsed_s": duration, "session.is_transition": false,
      "stream:time": { timestamps: [start, start + duration], values: [start, start + duration] } } }));
  return { outcome: "prepared", value: { expected_address: address, archive_instant: { epochSeconds: starts[0]! },
    raw_file: { sha256: address, ext: artifact.ext, bytes: artifact.bytes.byteLength, file_id_serial: serial,
      file_id_time_created_utc: null, manufacturer: null, product: null }, candidates,
    summaries: candidates.map((candidate, source_session_seq) => ({ candidate_id: candidate.id, member_id: address,
      source_kind: "fit" as const, source_session_seq, sport_family: sport, is_transition: false,
      start_utc: starts[source_session_seq]!, duration_s: duration, distance_m: null,
      file_id_manufacturer: null, file_id_serial: serial, file_id_time_created_utc: null })), repair_events: [] } };
}

function harness(store = new ReportStore(), rawArchive = archive()) {
  return { store, rawArchive, deps: { store, archive: rawArchive, hashKey,
    prepareFile: async (artifact: ImportArtifact, _repairSettings: RepairFixerSettings) => prepare(artifact),
    canonicalPick, materializeClusterInTransaction: async () => {}, ingestVersion: 4 as const } };
}

const file = (input_path: string, byte: number): ImportArtifact => ({ input_path, bytes: new Uint8Array([byte]), ext: "fit" });
const run = async (files: readonly ImportArtifact[], value = harness()) => ({ value,
  report: await importArtifactsWithReport({ files, platform_records: [] }, value.deps) });
function confirmation(id: string, leftByte: number, rightByte: number, verdict: "merge" | "distinct", physical = 1): DedupConfirmationRow {
  const [member_a, member_b] = [digest(new Uint8Array([leftByte])), digest(new Uint8Array([rightByte]))].sort();
  return { id: id.repeat(26), member_a: member_a!, member_b: member_b!, verdict, device_id: "device",
    hlc_physical_ms: physical, hlc_counter: 0 };
}

describe("stable import report", () => {
  it("[PR05-REPORT-001] exposes every declared key and stable reason vocabulary", async () => {
    const { report } = await run([file("a.fit", 1), file("b.fit", 2)]);
    const near = (await run([file("near-a.fit", 9), file("near-b.fit", 10)])).report;
    const quarantined = (await run([file("bad.fit", 0)])).report;
    const brick = (await run([file("bike.fit", 12), file("run.fit", 13)])).report;
    const mergeStore = new ReportStore(); mergeStore.confirmations = [confirmation("0", 1, 2, "merge")];
    const merged = (await run([file("merge-a.fit", 1), file("merge-b.fit", 2)], harness(mergeStore))).report;
    const historyStore = new ReportStore(); historyStore.confirmations = [
      confirmation("1", 1, 2, "distinct", 2), confirmation("0", 1, 2, "merge", 1),
    ];
    const history = (await run([file("history-a.fit", 1), file("history-b.fit", 2)], harness(historyStore))).report;
    const staleStore = new ReportStore(); staleStore.confirmations = [confirmation("0", 1, 11, "merge")];
    const stale = (await run([file("stale-a.fit", 1), file("stale-b.fit", 11)], harness(staleStore))).report;
    const orphanStore = new ReportStore();
    orphanStore.confirmations = [{ id: "0".repeat(26), member_a: "e".repeat(64), member_b: "f".repeat(64),
      verdict: "merge", device_id: "device", hlc_physical_ms: 1, hlc_counter: 0 }];
    orphanStore.strokeOverlays = [{ id: "stroke", target_length_key: "missing-length" }];
    orphanStore.poolOverlays = [{ id: "pool", target_session_key: "missing-session" }];
    orphanStore.fieldOverlays = [{ id: "field", target_table: "session", target_key: "missing-field-session" },
      { id: "unsupported", target_table: "athlete", target_key: "missing-athlete" }];
    const orphaned = (await run([file("orphan.fit", 1)], harness(orphanStore))).report;
    expect(Object.keys(report)).toEqual(["schema_version", "ingest_version", "effective", "files", "inserts", "updates", "clusters",
      "threshold_near_misses", "overlap_watchlist", "confirm_queue", "applied_confirmations", "brick_groups", "orphaned_overlays"]);
    expect(Object.keys(report.effective)).toEqual(["tier3", "transition_window_s"]);
    expect(Object.keys(report.effective.tier3)).toEqual(["startSeconds", "durationPercent", "distancePercent", "containmentSlackSeconds", "nearMissMultiplier"]);
    expect(Object.keys(report.files[0]!)).toEqual(["input_path", "address", "ext", "archive_deduped", "raw_file_inserted", "outcome", "quarantine"]);
    expect(Object.keys(report.inserts)).toEqual(["raw_file", "source_record"]);
    expect(Object.keys(report.updates)).toEqual(["source_record", "relinked_source_records"]);
    expect(Object.keys(report.clusters[0]!)).toEqual(["cluster_id", "workout_key", "members", "edge_tiers", "canonical_sources"]);
    expect(Object.keys(report.clusters[0]!.canonical_sources[0]!)).toEqual(["concern", "candidate_id", "rank"]);
    expect(Object.keys(report.confirm_queue[0]!)).toEqual(["member_a", "member_b", "candidate_a", "candidate_b", "serial_a", "serial_b",
      "start_delta_s", "duration_ratio", "duration_ratio_failed", "distance_ratio", "distance_ratio_state", "containment", "distance_untested", "reason"]);
    expect(Object.keys(near.overlap_watchlist[0]!)).toEqual(["member_a", "member_b", "candidate_a", "candidate_b", "serial_a", "serial_b",
      "start_delta_s", "duration_ratio", "duration_ratio_failed", "distance_ratio", "distance_ratio_state", "containment", "distance_untested", "reason",
      "expanded_a", "expanded_b"]);
    expect(Object.keys(near.overlap_watchlist[0]!.expanded_a)).toEqual(["start_utc", "end_utc"]);
    expect(Object.keys(near.overlap_watchlist[0]!.expanded_b)).toEqual(["start_utc", "end_utc"]);
    expect(Object.keys(merged.applied_confirmations[0]!)).toEqual(["id", "member_a", "member_b", "verdict", "hlc_physical_ms",
      "hlc_counter", "device_id", "result", "reason"]);
    expect(Object.keys(brick.brick_groups[0]!)).toEqual(["members", "families", "gap_s", "effective_transition_window_s"]);
    expect(Object.keys(orphaned.orphaned_overlays[0]!)).toEqual(["id", "target_kind", "target_key", "reason"]);
    expect(Object.keys(quarantined.files[0]!.quarantine!)).toEqual(["code", "message"]);
    const actualReasons = [report.confirm_queue[0]!.reason, near.threshold_near_misses[0]!.reason,
      near.overlap_watchlist[0]!.reason, merged.applied_confirmations[0]!.reason,
      history.applied_confirmations.find((row) => row.result === "cannot_link_applied")!.reason,
      stale.applied_confirmations[0]!.reason,
      history.applied_confirmations.find((row) => row.result === "superseded")!.reason,
      orphaned.applied_confirmations[0]!.reason,
      orphaned.orphaned_overlays.find((row) => row.reason === "unsupported_target_kind")!.reason,
      orphaned.orphaned_overlays.find((row) => row.reason === "target_missing_after_rekey")!.reason];
    expect(actualReasons).toEqual(["tier3_serial_confirmation_required", "tier3_threshold_near_miss", "expanded_overlap_unmerged",
      "effective_merge_confirmation", "effective_distinct_confirmation", "effective_merge_no_matching_candidate_edge",
      "superseded_confirmation", "confirmation_member_missing", "unsupported_target_kind", "target_missing_after_rekey"]);
  });
  it("[PR05-REPORT-002] preserves the specified array cardinality and sorting contracts", async () => {
    const { report } = await run([file("z.fit", 9), file("a.fit", 10)]);
    expect(report.files).toHaveLength(2);
    expect(report.files).toEqual([...report.files].sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1
      : a.input_path < b.input_path ? -1 : a.input_path > b.input_path ? 1 : 0));
    expect(report.clusters).toHaveLength(2);
    expect(report.threshold_near_misses).toHaveLength(2);
    expect(new Set(report.threshold_near_misses.map((entry) => `${entry.member_a}:${entry.member_b}`)).size).toBe(1);
    expect(report.threshold_near_misses).toEqual([...report.threshold_near_misses].sort((a, b) => a.candidate_a < b.candidate_a ? -1
      : a.candidate_a > b.candidate_a ? 1 : a.candidate_b < b.candidate_b ? -1 : a.candidate_b > b.candidate_b ? 1 : 0));
  });
  it("[PR05-REPORT-003] emits one exact indented golden wire string with a terminal LF", async () => {
    const { report } = await run([file("bad.fit", 0)]);
    const expected = `{
  "schema_version": 1,
  "ingest_version": 4,
  "effective": {
    "tier3": {
      "startSeconds": 120,
      "durationPercent": 10,
      "distancePercent": 10,
      "containmentSlackSeconds": 120,
      "nearMissMultiplier": 2
    },
    "transition_window_s": 900
  },
  "files": [
    {
      "input_path": "bad.fit",
      "address": "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
      "ext": "fit",
      "archive_deduped": false,
      "raw_file_inserted": false,
      "outcome": "quarantined",
      "quarantine": {
        "code": "fit:decode_failed",
        "message": "rejected"
      }
    }
  ],
  "inserts": {
    "raw_file": 0,
    "source_record": 0
  },
  "updates": {
    "source_record": 0,
    "relinked_source_records": 0
  },
  "clusters": [],
  "threshold_near_misses": [],
  "overlap_watchlist": [],
  "confirm_queue": [],
  "applied_confirmations": [],
  "brick_groups": [],
  "orphaned_overlays": []
}
`;
    expect(serializeImportReport(report)).toBe(expected);
  });
  it("[PR05-REPORT-004] keeps deterministic sections equal across caller permutations", async () => {
    const files = [file("b.fit", 1), file("a.fit", 2)];
    const left = await run(files), right = await run([...files].reverse());
    expect(serializeImportReport(left.report)).toBe(serializeImportReport(right.report));
  });
  it("[PR05-REPORT-005] assigns same-byte path booleans to the canonical path", async () => {
    const { report } = await run([file("z.fit", 7), file("a.fit", 7)]);
    expect(report.files.map((entry) => [entry.input_path, entry.archive_deduped, entry.raw_file_inserted])).toEqual([
      ["a.fit", false, true], ["z.fit", true, false],
    ]);
  });
  it("[PR05-REPORT-006] represents an archive-only retry with one later canonical raw insert", async () => {
    const value = harness();
    await value.rawArchive.writeArtifact(new Uint8Array([8]), "fit", { epochSeconds: 1_000 });
    const { report } = await run([file("z.fit", 8), file("a.fit", 8)], value);
    expect(report.files.map((entry) => [entry.input_path, entry.archive_deduped, entry.raw_file_inserted])).toEqual([
      ["a.fit", true, true], ["z.fit", true, false],
    ]);
    expect(report.inserts.raw_file).toBe(1);
  });
  it("[PR05-REPORT-007] carries quarantine, defaults, and ingest version four", async () => {
    const { report } = await run([file("bad.fit", 0)]);
    expect(report).toMatchObject({ ingest_version: 4, effective: { tier3: DEFAULT_TIER3_THRESHOLDS,
      transition_window_s: DEFAULT_TRANSITION_WINDOW_S } });
    expect(report.files[0]).toMatchObject({ outcome: "quarantined", raw_file_inserted: false,
      quarantine: { code: "fit:decode_failed", message: "rejected" } });
  });
});
