import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, type ArchiveManager } from "@enduragent/kernel/archive";
import { canonicalPick, createMaterializeClusterInTransaction, importArtifactsWithReport,
  type ConcernValue, type ImportReportDeps, type PlatformImportArtifact } from "@enduragent/kernel/ingest";
import { dumpStore, runMigrations, sortKeys, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/index.js";

const hashKey = async (fields: readonly (string | number)[]) => createHash("sha256").update(fields.join("\u001f")).digest("hex");

function memoryArchive(): ArchiveManager & { readonly snapshots: Map<string, unknown> } {
  const snapshots = new Map<string, unknown>();
  return {
    snapshots,
    async writeSnapshot(value, when) {
      const address = createHash("sha256").update(canonicalJson(value)).digest("hex");
      const relPath = `${when.epochSeconds}/${address}.json.gz`;
      const deduped = snapshots.has(relPath); snapshots.set(relPath, structuredClone(value));
      return { address, relPath, deduped };
    },
    async readSnapshot(path) { const value = snapshots.get(path); if (value === undefined) throw new Error("missing snapshot"); return structuredClone(value); },
    async has(path) { return snapshots.has(path); },
    async writeArtifact() { throw new Error("unused"); }, async readArtifact() { throw new Error("unused"); },
    async quarantine() { throw new Error("unused"); },
  };
}

async function platform(archive: ReturnType<typeof memoryArchive>, name: string, evidence = true): Promise<PlatformImportArtifact> {
  const activity = { id: "synthetic-a", name };
  const instant = { epochSeconds: 884_000_000 };
  const stored = await archive.writeSnapshot(activity, instant);
  const concerns: Record<string, ConcernValue> = {
    "session.sport": "cycling", "session.start_utc": instant.epochSeconds,
    "session.local_date_key": 19980105, "session.elapsed_s": 100, "session.moving_s": 90,
    "session.is_transition": false, "session.summary_json": JSON.stringify(sortKeys(activity)),
    "stream:time": { timestamps: [instant.epochSeconds, instant.epochSeconds + 100], values: [instant.epochSeconds, instant.epochSeconds + 100] },
  };
  return { source: "intervals-icu", activity_id: activity.id, activity, concerns,
    dedup: { sport_family: "cycling", is_transition: false, start_utc: instant.epochSeconds, duration_s: 100, distance_m: null },
    raw_snapshot_address: stored.address, raw_snapshot_rel_path: stored.relPath,
    sourceEvidence: evidence ? { source: "intervals-icu", lane: "activities", externalId: activity.id,
      archiveInstant: instant, archive: stored, normalizedActivityJson: canonicalJson(activity) } : undefined };
}

describe("activity source revision refresh", () => {
  let root: string;
  let store: SqlStore & MigratorStore;
  let archive: ReturnType<typeof memoryArchive>;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "source-revision-"));
    store = openSqliteStorage(join(root, "store.db"));
    await runMigrations(store, MIGRATIONS);
    archive = memoryArchive();
  });
  afterEach(async () => { await store.close(); rmSync(root, { recursive: true, force: true }); });

  function deps(materialize = createMaterializeClusterInTransaction(hashKey)): ImportReportDeps {
    return { store, archive, hashKey, canonicalPick, materializeClusterInTransaction: materialize,
      prepareFile: async () => { throw new Error("unused"); }, ingestVersion: 4 };
  }

  it("uses payload hash only, persists archive address path and instant, and reports one update", async () => {
    const firstArtifact = await platform(archive, "first");
    const first = await importArtifactsWithReport({ files: [], platform_records: [firstArtifact] }, deps());
    expect(first.inserts.source_record).toBe(1); expect(first.updates.source_record).toBe(0);
    const persisted = await store.get(`SELECT a.archive_address,a.archive_rel_path,a.archive_epoch_s
FROM source_record_current c JOIN source_record_revision r ON r.source_record_id=c.source_record_id AND r.revision_id=c.revision_id
JOIN source_artifact a ON a.artifact_key=r.artifact_key`);
    expect(persisted).toEqual({ archive_address: firstArtifact.sourceEvidence!.archive.address,
      archive_rel_path: firstArtifact.sourceEvidence!.archive.relPath, archive_epoch_s: 884_000_000 });
    expect(await archive.readSnapshot(String(persisted!.archive_rel_path))).toEqual(firstArtifact.activity);
    const exactDump = await dumpStore(store);
    const exact = await importArtifactsWithReport({ files: [], platform_records: [firstArtifact] }, deps());
    expect(exact.updates.source_record).toBe(0); expect(await dumpStore(store)).toBe(exactDump);

    const sessionKey = String((await store.get("SELECT session_key FROM session"))!.session_key);
    const changed = await platform(archive, "changed");
    const revision = await importArtifactsWithReport({ files: [], platform_records: [changed] }, deps());
    expect(revision.updates.source_record).toBe(1);
    expect((await store.get("SELECT session_key FROM session"))!.session_key).toBe(sessionKey);
    expect((await store.get("SELECT count(*) AS c FROM source_record_revision"))!.c).toBe(2);
  });

  it("hydrates path for a legacy equal presentation and reports one update", async () => {
    const legacy = await platform(archive, "legacy", false);
    await importArtifactsWithReport({ files: [], platform_records: [legacy] }, deps());
    expect(await store.get("SELECT artifact_key FROM source_record_revision")).toEqual({ artifact_key: null });
    const hydrated = { ...legacy, sourceEvidence: { source: "intervals-icu" as const, lane: "activities" as const,
      externalId: String(legacy.activity_id), archiveInstant: { epochSeconds: 884_000_000 },
      archive: { address: legacy.raw_snapshot_address!, relPath: legacy.raw_snapshot_rel_path!, deduped: true },
      normalizedActivityJson: canonicalJson(legacy.activity) } };
    const report = await importArtifactsWithReport({ files: [], platform_records: [hydrated] }, deps());
    expect(report.updates.source_record).toBe(1);
    expect((await store.get(`SELECT a.archive_rel_path FROM source_record_current c
JOIN source_record_revision r ON r.source_record_id=c.source_record_id AND r.revision_id=c.revision_id
JOIN source_artifact a ON a.artifact_key=r.artifact_key`))!.archive_rel_path).toBe(legacy.raw_snapshot_rel_path);
  });

  it("reselects known revision, relinks, and reports one update", async () => {
    const first = await platform(archive, "first"), second = await platform(archive, "second");
    await importArtifactsWithReport({ files: [], platform_records: [first] }, deps());
    await importArtifactsWithReport({ files: [], platform_records: [second] }, deps());
    const result = await importArtifactsWithReport({ files: [], platform_records: [first] }, deps());
    expect(result.updates.source_record).toBe(1);
    expect((await store.get(`SELECT r.raw_sha256 FROM source_record_current c
JOIN source_record_revision r ON r.source_record_id=c.source_record_id AND r.revision_id=c.revision_id`))!.raw_sha256)
      .toBe(first.raw_snapshot_address);
    expect((await store.get("SELECT workout_key,session_key FROM source_record"))!.session_key).toBe(
      (await store.get("SELECT session_key FROM session"))!.session_key,
    );
  });

  it("rolls back revision selection and recompute together", async () => {
    await importArtifactsWithReport({ files: [], platform_records: [await platform(archive, "first")] }, deps());
    const before = await dumpStore(store);
    const changed = await platform(archive, "changed");
    await expect(importArtifactsWithReport({ files: [], platform_records: [changed] }, deps(async () => {
      throw new Error("injected materialization failure");
    }))).rejects.toThrow("injected materialization failure");
    expect(await dumpStore(store)).toBe(before);
  });
});
