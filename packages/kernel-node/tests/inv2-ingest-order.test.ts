import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalPick, createMaterializeClusterInTransaction, importArtifactsWithReport, type ConcernValue,
  type ImportArtifact, type PlatformImportArtifact, type RepairFixerSettings } from "@enduragent/kernel/ingest";
import type { ArchiveManager } from "@enduragent/kernel/archive";
import { dumpStore, runMigrations, sortKeys } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createNodeImportRuntime, importFilesWithReport } from "../src/ingest/import-files.js";
import { openSqliteStorage } from "../src/sqlite/index.js";

const roots = new Set<string>();
afterEach(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); roots.clear(); });
const path = (name: string) => resolve(`packages/kernel-node/tests/fixtures/ingest/${name}`);
async function fresh() {
  const root = mkdtempSync(join(tmpdir(), "dedup-sql-")); roots.add(root);
  const store = openSqliteStorage(join(root, "store.db")); await runMigrations(store, MIGRATIONS);
  return { root, store, archiveDir: join(root, "archive") };
}
function matchingXmlPaths(root: string): readonly [string, string] {
  const original = path("fallback-cycling.tcx");
  const copy = join(root, "matching-cycling.tcx");
  writeFileSync(copy, `${readFileSync(original, "utf8")}\n`);
  return [original, copy];
}
function matchingFitXmlPaths(root: string): readonly [string, string] {
  const fit = path("brick-cycling.fit"), tcx = join(root, "matching-fit-cycling.tcx");
  writeFileSync(tcx, `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities><Activity Sport="Biking"><Id>1998-07-04T20:53:20Z</Id>
    <Lap StartTime="1998-07-04T20:53:20Z"><TotalTimeSeconds>2400</TotalTimeSeconds><DistanceMeters>23990</DistanceMeters>
      <Intensity>Active</Intensity><TriggerMethod>Manual</TriggerMethod><Track>
        <Trackpoint><Time>1998-07-04T20:53:20Z</Time><DistanceMeters>0</DistanceMeters></Trackpoint>
        <Trackpoint><Time>1998-07-04T21:33:20Z</Time><DistanceMeters>23990</DistanceMeters></Trackpoint>
      </Track></Lap></Activity></Activities>
</TrainingCenterDatabase>`);
  return [fit, tcx];
}
const fitCrcTable = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
  0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400] as const;
function fitCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    let next = fitCrcTable[crc & 0xf]!;
    crc = ((crc >> 4) & 0xfff) ^ next ^ fitCrcTable[byte & 0xf]!;
    next = fitCrcTable[crc & 0xf]!;
    crc = ((crc >> 4) & 0xfff) ^ next ^ fitCrcTable[(byte >> 4) & 0xf]!;
  }
  return crc;
}
function differentSerialFitPaths(root: string): readonly [string, string] {
  const original = path("pool-size-correction.fit");
  const bytes = Buffer.from(readFileSync(original));
  let replacements = 0;
  for (let offset = 0; offset + 4 <= bytes.length - 2; offset += 1) {
    if (bytes.readUInt32LE(offset) !== 90_407) continue;
    bytes.writeUInt32LE(90_409, offset); replacements += 1;
  }
  if (replacements !== 2) throw new Error("synthetic FIT serial fixture drifted");
  bytes.writeUInt16LE(fitCrc(bytes.subarray(0, -2)), bytes.length - 2);
  const copy = join(root, "different-serial.fit");
  writeFileSync(copy, bytes);
  return [original, copy];
}
const hashKey = async (fields: readonly (string | number)[]) => createHash("sha256").update(fields.join("\u001f")).digest("hex");

function matchingPlatformArtifact(): PlatformImportArtifact {
  const start = Date.parse("1998-07-04T20:53:20Z") / 1_000;
  const activity = { id: "synthetic-api-presentation", start, duration: 2_400, distance: 23_990 };
  const concerns: Record<string, ConcernValue> = {
    "session.sport": "cycling", "session.start_utc": start, "session.local_date_key": 19980704,
    "session.elapsed_s": 2_400, "session.distance_m": 23_990, "session.is_transition": false,
    "session.summary_json": JSON.stringify(sortKeys(activity)),
    "stream:time": { timestamps: [start, start + 2_400], values: [start, start + 2_400] },
  };
  return { source: "intervals-icu", activity_id: "synthetic-api-presentation", activity,
    dedup: { sport_family: "cycling", is_transition: false, start_utc: start, duration_s: 2_400, distance_m: 23_990 },
    concerns, raw_snapshot_address: null, raw_snapshot_rel_path: null };
}

describe("real SQLite dedup ordering", () => {
  it("[PR05-SQL-001] makes forward and reverse paths converge to identical state", async () => {
    const left = await fresh(), right = await fresh();
    try {
      const files = [path("fallback-cycling.tcx"), path("fallback-cycling.gpx")];
      const a = await importFilesWithReport({ inputPaths: files, archiveDir: left.archiveDir, store: left.store });
      const b = await importFilesWithReport({ inputPaths: [...files].reverse(), archiveDir: right.archiveDir, store: right.store });
      expect(await dumpStore(left.store)).toBe(await dumpStore(right.store));
      expect({ ...a, files: [] }).toEqual({ ...b, files: [] });
    } finally { await left.store.close(); await right.store.close(); }
  });
  it("[PR05-SQL-002] associates FIT/XML presentations and confirms different FIT serials", async () => {
    const fitXml = await fresh(), serials = await fresh();
    try {
      const fitXmlPaths = matchingFitXmlPaths(fitXml.root);
      const pendingFitXml = await importFilesWithReport({ inputPaths: fitXmlPaths, archiveDir: fitXml.archiveDir, store: fitXml.store });
      expect(pendingFitXml.confirm_queue).toEqual([]);
      const fitXmlMembers = (await fitXml.store.all("SELECT sha256 FROM raw_file ORDER BY sha256")).map((row) => row.sha256 as string);
      expect(pendingFitXml.clusters).toHaveLength(1);
      expect(pendingFitXml.clusters[0]).toMatchObject({ members: fitXmlMembers, edge_tiers: ["tier3"] });

      const serialPaths = differentSerialFitPaths(serials.root);
      const pendingSerials = await importFilesWithReport({ inputPaths: serialPaths, archiveDir: serials.archiveDir, store: serials.store });
      expect(pendingSerials.confirm_queue).toHaveLength(1);
      const serialMembers = (await serials.store.all("SELECT sha256 FROM raw_file ORDER BY sha256")).map((row) => row.sha256 as string);
      await serials.store.run("INSERT INTO dedup_confirmation VALUES(?,?,?,?,?,?,?)",
        ["1".repeat(26), serialMembers[0]!, serialMembers[1]!, "merge", "device", 1, 0]);
      await serials.store.run("UPDATE ingest_incremental_state SET initialized=0 WHERE singleton=1");
      const confirmed = await importFilesWithReport({ inputPaths: [serialPaths[0]], archiveDir: serials.archiveDir, store: serials.store });
      expect(confirmed.clusters).toHaveLength(1); expect(confirmed.clusters[0]).toMatchObject({ members: serialMembers, edge_tiers: ["confirmation"] });
    } finally { await fitXml.store.close(); await serials.store.close(); }
  });
  it("SQL API plus FIT with a present serial merges without confirmation", async () => {
    const apiFirst = await fresh(), fitFirst = await fresh();
    try {
      const fitPath = path("brick-cycling.fit"), platform = matchingPlatformArtifact();
      const leftRuntime = createNodeImportRuntime({ archiveDir: apiFirst.archiveDir, store: apiFirst.store });
      await leftRuntime.importBatchWithReport({ files: [], platform_records: [platform] });
      const left = await importFilesWithReport({ inputPaths: [fitPath], archiveDir: apiFirst.archiveDir, store: apiFirst.store });
      await importFilesWithReport({ inputPaths: [fitPath], archiveDir: fitFirst.archiveDir, store: fitFirst.store });
      const rightRuntime = createNodeImportRuntime({ archiveDir: fitFirst.archiveDir, store: fitFirst.store });
      const right = await rightRuntime.importBatchWithReport({ files: [], platform_records: [platform] });
      for (const [value, report] of [[apiFirst, left], [fitFirst, right]] as const) {
        expect(report.confirm_queue).toEqual([]); expect(report.clusters).toHaveLength(1);
        expect(report.clusters[0]).toMatchObject({ edge_tiers: ["tier3"] });
        expect(report.clusters[0]!.members).toHaveLength(2);
        expect(new Set(report.clusters[0]!.canonical_sources.map((source) => source.rank))).toEqual(new Set([400]));
        expect(await value.store.get("SELECT count(*) c FROM source_record")).toEqual({ c: 1 });
        expect(await value.store.get("SELECT count(*) c FROM workout")).toEqual({ c: 1 });
        expect(await value.store.get("SELECT count(*) c FROM session")).toEqual({ c: 1 });
      }
      expect(await dumpStore(apiFirst.store)).toBe(await dumpStore(fitFirst.store));
      const before = await dumpStore(apiFirst.store);
      const replayApi = await leftRuntime.importBatchWithReport({ files: [], platform_records: [platform] });
      const replayFit = await importFilesWithReport({ inputPaths: [fitPath], archiveDir: apiFirst.archiveDir, store: apiFirst.store });
      expect(replayApi.inserts).toEqual({ raw_file: 0, source_record: 0 });
      expect(replayFit.inserts).toEqual({ raw_file: 0, source_record: 0 });
      expect(await dumpStore(apiFirst.store)).toBe(before);
    } finally { await apiFirst.store.close(); await fitFirst.store.close(); }
  });
  it("[PR05-SQL-003] replans the full archive when a matching file arrives later", async () => {
    const value = await fresh();
    try {
      const files = matchingXmlPaths(value.root);
      expect((await importFilesWithReport({ inputPaths: [files[0]], archiveDir: value.archiveDir, store: value.store })).clusters).toHaveLength(1);
      const later = await importFilesWithReport({ inputPaths: [files[1]], archiveDir: value.archiveDir, store: value.store });
      expect(later.clusters).toHaveLength(1); expect((await value.store.get("SELECT count(*) c FROM raw_file"))?.c).toBe(2);
    } finally { await value.store.close(); }
  });
  it("[PR05-SQL-004] applies authored distinct to split an existing merged cluster", async () => {
    const value = await fresh();
    try {
      const files = matchingXmlPaths(value.root);
      expect((await importFilesWithReport({ inputPaths: files, archiveDir: value.archiveDir, store: value.store })).clusters).toHaveLength(1);
      const members = (await value.store.all("SELECT sha256 FROM raw_file ORDER BY sha256")).map((row) => row.sha256 as string);
      await value.store.run("INSERT INTO dedup_confirmation VALUES(?,?,?,?,?,?,?)", ["0".repeat(26), members[0]!, members[1]!, "distinct", "device", 1, 0]);
      await value.store.run("UPDATE ingest_incremental_state SET initialized=0 WHERE singleton=1");
      expect((await importFilesWithReport({ inputPaths: [files[0]!], archiveDir: value.archiveDir, store: value.store })).clusters).toHaveLength(2);
    } finally { await value.store.close(); }
  });
  it("[PR05-SQL-005] produces zero second-run inserts and a byte-identical logical dump", async () => {
    const value = await fresh();
    try {
      const options = { inputPaths: [path("brick-cycling.fit")], archiveDir: value.archiveDir, store: value.store };
      await importFilesWithReport(options); const before = await dumpStore(value.store);
      const second = await importFilesWithReport(options);
      expect(second.inserts).toEqual({ raw_file: 0, source_record: 0 }); expect(await dumpStore(value.store)).toBe(before);
    } finally { await value.store.close(); }
  });
  it("[PR05-SQL-006] preserves platform rank through insert, relink, and immutable replay", async () => {
    const value = await fresh();
    try {
      const activity = { id: "synthetic" }, concerns: Record<string, ConcernValue> = {
        "session.sport": "cycling", "session.start_utc": 1_000, "session.local_date_key": 20000101,
        "session.elapsed_s": 100, "session.is_transition": false, "session.summary_json": JSON.stringify(sortKeys(activity)),
        "stream:time": { timestamps: [1_000, 1_100], values: [1_000, 1_100] },
      };
      const platform: PlatformImportArtifact = { source: "intervals-icu", activity_id: "synthetic", activity,
        dedup: { sport_family: "cycling", is_transition: false, start_utc: 1_000, duration_s: 100, distance_m: null },
        concerns, raw_snapshot_address: null, raw_snapshot_rel_path: null };
      const unusedArchive: ArchiveManager = {
        async writeArtifact() { throw new Error("unused"); }, async quarantine() { throw new Error("unused"); },
        async readArtifact() { throw new Error("unused"); }, async writeSnapshot() { throw new Error("unused"); },
        async readSnapshot() { throw new Error("unused"); }, async has() { return false; },
      };
      const origins: unknown[] = [], sourceInsertAttachments: unknown[] = [];
      const originalGet = value.store.get.bind(value.store);
      value.store.get = async (sql, params = []) => {
        if (sql.startsWith("INSERT INTO source_record")) sourceInsertAttachments.push([params[1], params[2]]);
        return originalGet(sql, params);
      };
      const deps = { store: value.store, archive: unusedArchive, hashKey,
        prepareFile: async (_artifact: ImportArtifact, _repairSettings: RepairFixerSettings) => { throw new Error("unused"); },
        canonicalPick(group: Parameters<typeof canonicalPick>[0]) {
          origins.push(...group.candidates.map((candidate) => candidate.origin)); return canonicalPick(group);
        }, materializeClusterInTransaction: createMaterializeClusterInTransaction(hashKey), ingestVersion: 4 as const };
      const first = await importArtifactsWithReport({ files: [], platform_records: [platform] }, deps);
      expect(first.inserts.source_record).toBe(1); expect(first.updates.relinked_source_records).toBe(1);
      expect(sourceInsertAttachments[0]).toEqual([null, null]);
      expect(await value.store.get("SELECT workout_key,session_key,quality_rank FROM source_record")).toEqual({
        workout_key: expect.any(String), session_key: expect.any(String), quality_rank: 300,
      });
      const second = await importArtifactsWithReport({ files: [], platform_records: [platform] }, deps);
      expect(second.inserts.source_record).toBe(0); expect(second.updates.relinked_source_records).toBe(0);
      expect(origins).toContainEqual(expect.objectContaining({ kind: "platform", persistedQualityRank: 300 }));
    } finally { await value.store.close(); }
  });
  it("[PR05-SQL-007] proves zero through three upgrade, current four, and early refusal of five", async () => {
    const value = await fresh();
    try {
      const options = { inputPaths: [path("brick-cycling.fit")], archiveDir: value.archiveDir, store: value.store };
      for (const version of [0, 1, 2, 3, 4]) {
        await value.store.run("UPDATE ingest_metadata SET ingest_version=?", [version]);
        expect((await importFilesWithReport(options)).ingest_version).toBe(4);
      }
      await value.store.run("UPDATE ingest_metadata SET ingest_version=5");
      const count = (await value.store.get("SELECT count(*) c FROM raw_file"))?.c;
      await expect(importFilesWithReport(options)).rejects.toThrow("newer ingest semantics");
      expect((await value.store.get("SELECT count(*) c FROM raw_file"))?.c).toBe(count);
    } finally { await value.store.close(); }
  });
  it("[PR05-SQL-008] preserves an effective pool correction under the unchanged final key", async () => {
    const value = await fresh();
    try {
      const options = { inputPaths: [path("pool-size-correction.fit")], archiveDir: value.archiveDir, store: value.store };
      await importFilesWithReport(options);
      const key = (await value.store.get("SELECT session_key FROM session"))!.session_key as string;
      await value.store.run("INSERT INTO pool_size_correction_overlay VALUES(?,?,?,?,?,?)", ["o", key, 50, "d", 1, 0]);
      await value.store.run("UPDATE ingest_incremental_state SET initialized=0 WHERE singleton=1");
      await importFilesWithReport(options);
      expect(await value.store.get("SELECT distance_m FROM session WHERE session_key=?", [key])).toEqual({ distance_m: 200 });
      expect((await value.store.all("SELECT distance_m FROM swim_length ORDER BY length_key")).map((row) => row.distance_m)).toEqual([50, 50, 50, 50]);
    } finally { await value.store.close(); }
  });
});
