import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildPlatformPresentation, parseEnvelope, replayPlatformPresentation, type ConcernValue, type PlatformImportArtifact } from "../src/ingest/index.js";
import { canonicalJson } from "../src/archive/index.js";
import { createSourceRecordRepository, sortKeys, type Row, type SourceRecordRow, type SqlStore } from "../src/store/index.js";

const hashKey = async (fields: readonly (string | number)[]) => createHash("sha256").update(fields.join("\u001f")).digest("hex");
function platform(id: string | number = "123"): PlatformImportArtifact {
  const activity = { id, name: "synthetic" };
  const concerns: Record<string, ConcernValue> = {
    "session.sport": "cycling", "session.start_utc": 1_000, "session.local_date_key": 20000101,
    "session.elapsed_s": 100, "session.distance_m": 1_000, "session.is_transition": false,
    "session.summary_json": JSON.stringify(sortKeys(activity)),
    "stream:time": { timestamps: [1_000, 1_100], values: [1_000, 1_100] },
  };
  return { source: "intervals-icu", activity_id: id, activity, dedup: { sport_family: "cycling", is_transition: false,
    start_utc: 1_000, duration_s: 100, distance_m: 1_000 }, concerns, raw_snapshot_address: null, raw_snapshot_rel_path: null };
}

class SourceStore implements SqlStore {
  readonly rows = new Map<string, SourceRecordRow>();
  async exec(): Promise<void> {}
  async run(): Promise<void> {}
  async get(sql: string, params: readonly unknown[] = []): Promise<Row | undefined> {
    if (sql.startsWith("INSERT")) {
      const row: SourceRecordRow = { id: params[0] as string, workout_key: params[1] as string | null,
        session_key: params[2] as string | null, source: params[3] as string, external_id: params[4] as string,
        raw_sha256: params[5] as string | null, quality_rank: params[6] as number, payload_json: params[7] as string };
      const collision = this.rows.has(row.id) || [...this.rows.values()].some((entry) => entry.source === row.source && entry.external_id === row.external_id);
      if (collision) return undefined;
      this.rows.set(row.id, row); return { id: row.id };
    }
    if (sql.includes("WHERE id = ?")) return this.rows.get(params[0] as string) as unknown as Row | undefined;
    if (sql.includes("WHERE source = ?")) return [...this.rows.values()].find((row) => row.source === params[0] && row.external_id === params[1]) as unknown as Row | undefined;
    return undefined;
  }
  async all(): Promise<Row[]> { return []; }
  async close(): Promise<void> {}
}

describe("platform source ledger", () => {
  it("[PR05-SOURCE-001] normalizes string and numeric activity IDs into the same key", async () => {
    const string = await buildPlatformPresentation(platform("123"), hashKey);
    const numeric = await buildPlatformPresentation(platform(123), hashKey);
    expect(string.row.external_id).toBe("123"); expect(numeric.row.id).toBe(string.row.id);
  });
  it("[PR05-SOURCE-002] keeps payload external identity as evidence only", async () => {
    const base = platform("activity-id"), activity = { ...base.activity, external_id: "evidence-only" };
    const value = { ...base, activity, concerns: { ...base.concerns, "session.summary_json": JSON.stringify(sortKeys(activity)) } };
    const built = await buildPlatformPresentation(value, hashKey);
    expect(built.row.external_id).toBe("activity-id"); expect(built.row.payload_json).toContain("evidence-only");
  });
  it("[PR05-SOURCE-003] validates IDs, rank, and the exact four-key platform origin", async () => {
    const built = await buildPlatformPresentation(platform(), hashKey);
    expect(built.row.quality_rank).toBe(300); expect(built.candidate.rank).toBe(300);
    expect(built.candidate.origin).toEqual({ kind: "platform", source: "intervals-icu", sourceRecordId: built.row.id, persistedQualityRank: 300 });
    for (const id of ["", Number.NaN, Number.POSITIVE_INFINITY, 1.5, -0, null, undefined]) {
      await expect(buildPlatformPresentation({ ...platform(), activity_id: id as never }, hashKey)).rejects.toThrow();
    }
    await expect(replayPlatformPresentation({ ...built.row, quality_rank: 200 }, hashKey)).rejects.toThrow();
  });
  it("[PR05-SOURCE-004] replays the exact envelope and copied persisted rank", async () => {
    const built = await buildPlatformPresentation(platform(), hashKey);
    const replayed = await replayPlatformPresentation({ ...built.row, workout_key: "w", session_key: "s" }, hashKey);
    expect(replayed.row.payload_json).toBe(built.row.payload_json);
    expect(replayed.candidate.origin).toMatchObject({ persistedQualityRank: built.row.quality_rank });
    expect(replayed.candidate.rank).toBe(built.row.quality_rank);
  });
  it("[PR05-SOURCE-005] treats exact immutable re-presentation after relink as not inserted", async () => {
    const built = await buildPlatformPresentation(platform(), hashKey), store = new SourceStore(), repo = createSourceRecordRepository(store);
    expect(await repo.upsert(built.row)).toBe(true);
    store.rows.set(built.row.id, { ...built.row, workout_key: "w", session_key: "s" });
    expect(await repo.upsert(built.row)).toBe(false);
  });
  it("[PR05-SOURCE-006] rejects payload, primary-key, unique-key, and rank conflicts", async () => {
    const built = await buildPlatformPresentation(platform(), hashKey), store = new SourceStore(), repo = createSourceRecordRepository(store);
    await repo.upsert(built.row);
    await expect(repo.upsert({ ...built.row, payload_json: "{}" })).rejects.toThrow();
    await expect(repo.upsert({ ...built.row, quality_rank: 200 })).rejects.toThrow();
    await expect(repo.upsert({ ...built.row, id: "f".repeat(64) })).rejects.toThrow();
    const other = await buildPlatformPresentation(platform("other"), hashKey);
    store.rows.set(other.row.id, { ...other.row, external_id: built.row.external_id });
    await expect(repo.upsert({ ...built.row, id: other.row.id })).rejects.toThrow();
  });
  it("builds version-one evidence envelopes and validates archive identity", async () => {
    const base = platform("evidence"), address = "a".repeat(64), relPath = `1998/01/${address}.json.gz`;
    const value: PlatformImportArtifact = { ...base,
      raw_snapshot_address: address, raw_snapshot_rel_path: relPath,
      sourceEvidence: { source: "intervals-icu", lane: "activities", externalId: "evidence",
        archiveInstant: { epochSeconds: 1_000 }, archive: { address, relPath, deduped: false },
        normalizedActivityJson: canonicalJson(base.activity) } };
    const built = await buildPlatformPresentation(value, hashKey);
    expect(parseEnvelope(built.row.payload_json).version).toBe(1);
    expect(built.row.payload_json).toBe(canonicalJson({ activity: value.activity, concerns: value.concerns,
      dedup: { distance_m: 1_000, duration_s: 100, is_transition: false, sport_family: "cycling", start_utc: 1_000 },
      schema_version: 1 }));
    await expect(buildPlatformPresentation({ ...value, raw_snapshot_rel_path: "wrong" }, hashKey)).rejects.toThrow("source evidence");
    expect(() => parseEnvelope('{"activity":{},"concerns":{},"dedup":{},"schema_version":2}')).toThrow("envelope");
  });
});
