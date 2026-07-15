import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAnchorRepository,
  createActivityRepository,
  createRawFileRepository,
  createSourceRecordRepository,
  runMigrations,
  type ActivityRows,
  type AnchorHistoryRow,
  type MigratorStore,
  type RawFileRow,
  RawFileInvariantError,
  type SourceRecordRow,
  type SqlStore,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/index.js";

function anchorRow(overrides: Partial<AnchorHistoryRow> = {}): AnchorHistoryRow {
  return {
    id: "anchor-1",
    sport: "cycling",
    anchor_type: "ftp",
    value: 250,
    unit: "W",
    valid_from: 1000,
    source: "manual",
    confidence: "manual",
    note: null,
    provenance: "manual",
    device_id: null,
    hlc_physical_ms: null,
    hlc_counter: null,
    ...overrides,
  };
}

function activityRows(rawSha256: string, localDateKey: number): ActivityRows {
  return {
    workout: {
      workout_key: `workout-${rawSha256}`,
      start_utc: 1000,
      tz_offset_s: null,
      name: null,
      notes: null,
      is_multisport: 0,
      dedup_cluster_id: rawSha256,
    },
    sessions: [{
      session_key: `session-${rawSha256}`,
      workout_key: `workout-${rawSha256}`,
      session_seq: 0,
      sport: "cycling",
      sub_sport: null,
      start_utc: 1000,
      tz_offset_s: null,
      local_date_key: localDateKey,
      elapsed_s: null,
      timer_s: null,
      moving_s: null,
      distance_m: null,
      is_transition: 0,
      summary_json: null,
    }],
    laps: [],
    swimLengths: [],
    streams: [],
    repairLogs: [],
    poolSessions: [],
  };
}

describe("repository ports over real node:sqlite", () => {
  let dir: string;
  let store: SqlStore & MigratorStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kn-"));
    store = openSqliteStorage(join(dir, "store.db"));
    await runMigrations(store, MIGRATIONS);
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("createAnchorRepository", () => {
    it("inserts once and is idempotent on the 3-column key", async () => {
      const repo = createAnchorRepository(store);
      expect(await repo.insertIfAbsent(anchorRow())).toBe(true);
      expect(await repo.insertIfAbsent(anchorRow({ id: "anchor-1-dup", value: 999 }))).toBe(false);
      const count = await store.get("SELECT count(*) AS c FROM anchor_history");
      expect(count?.c).toBe(1);
    });

    it("reads the effective-dated current row", async () => {
      const repo = createAnchorRepository(store);
      await repo.insertIfAbsent(anchorRow({ id: "v1", valid_from: 1000, value: 250 }));
      const asOf1 = await repo.readCurrent("cycling", "ftp", 1500);
      expect(asOf1?.value).toBe(250);
      await repo.insertIfAbsent(anchorRow({ id: "v2", valid_from: 2000, value: 260 }));
      const asOf2 = await repo.readCurrent("cycling", "ftp", 2500);
      expect(asOf2?.value).toBe(260);
    });

    it("applies confidence precedence for same valid_from (manual > platform)", async () => {
      const repo = createAnchorRepository(store);
      await repo.insertIfAbsent(
        anchorRow({ id: "plat", valid_from: 1000, value: 240, confidence: "platform", provenance: "sync", source: "connector" }),
      );
      await store.run(
        "INSERT INTO anchor_history (id, sport, anchor_type, value, unit, valid_from, source, confidence, note, provenance, device_id, hlc_physical_ms, hlc_counter) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ["man", "cycling", "ftp", 250, "W", 1000, "manual", "manual", null, "manual", null, null, null],
      );
      const current = await repo.readCurrent("cycling", "ftp", 1500);
      expect(current?.confidence).toBe("manual");
      expect(current?.value).toBe(250);
    });
  });

  it("inserts raw_file once and rejects same-address metadata drift", async () => {
    const repo = createRawFileRepository(store);
    const row: RawFileRow = {
      sha256: "abc",
      path: "/x.fit",
      ext: "fit",
      bytes: 100,
      file_id_serial: 1,
      file_id_time_created_utc: 1000,
      manufacturer: "garmin",
      product: "edge",
    };
    expect(await repo.upsert(row)).toBe(true);
    expect(await repo.upsert(row)).toBe(false);
    const changes: readonly [keyof RawFileRow, RawFileRow[keyof RawFileRow]][] = [
      ["path", "/y.fit"], ["ext", "bin"], ["bytes", 999], ["file_id_serial", 2],
      ["file_id_time_created_utc", 2000], ["manufacturer", "other"], ["product", "other"],
    ];
    for (const [key,value] of changes) {
      await expect(repo.upsert({...row,[key]:value})).rejects.toBeInstanceOf(RawFileInvariantError);
    }
    const count = await store.get("SELECT count(*) AS c FROM raw_file");
    expect(count?.c).toBe(1);
  });

  it("invalidates incoming activity snapshots on first import", async () => {
    const repo = createActivityRepository(store);
    const rows = activityRows("raw", 19980101);
    for (const [key, kind, id] of [
      ["incoming-session", "session", "session-raw"],
      ["incoming-date", "date", "19980101"],
      ["unrelated-session", "session", "other"],
      ["unrelated-date", "date", "19980102"],
    ] as const) {
      await store.run(
        "INSERT INTO metric_snapshot (snapshot_key,scope_kind,scope_id,metric_key,value_json,kernel_version,basis_version) VALUES (?,?,?,?,?,?,?)",
        [key, kind, id, "m", "{}", "k", "b"],
      );
    }

    await repo.replaceForRawFile("raw", rows, async () => {});

    const remaining = await store.all("SELECT snapshot_key FROM metric_snapshot ORDER BY snapshot_key");
    expect(remaining.map((row) => row.snapshot_key)).toEqual(["unrelated-date", "unrelated-session"]);
  });

  it("invalidates old and incoming date snapshots when an activity date changes", async () => {
    const repo = createActivityRepository(store);
    await repo.replaceForRawFile("raw", activityRows("raw", 19980101), async () => {});
    for (const [key, kind, id] of [
      ["session", "session", "session-raw"],
      ["old-date", "date", "19980101"],
      ["incoming-date", "date", "19980102"],
      ["unrelated-session", "session", "other"],
      ["unrelated-date", "date", "19980103"],
    ] as const) {
      await store.run(
        "INSERT INTO metric_snapshot (snapshot_key,scope_kind,scope_id,metric_key,value_json,kernel_version,basis_version) VALUES (?,?,?,?,?,?,?)",
        [key, kind, id, "m", "{}", "k", "b"],
      );
    }

    await repo.replaceForRawFile("raw", activityRows("raw", 19980102), async () => {});

    const remaining = await store.all("SELECT snapshot_key FROM metric_snapshot ORDER BY snapshot_key");
    expect(remaining.map((row) => row.snapshot_key)).toEqual(["unrelated-date", "unrelated-session"]);
  });

  it("upserts source_record idempotently by (source, external_id)", async () => {
    const repo = createSourceRecordRepository(store);
    const row: SourceRecordRow = {
      id: "sr-1",
      workout_key: null,
      session_key: null,
      source: "intervals",
      external_id: "ext-1",
      raw_sha256: null,
      quality_rank: 1,
      payload_json: "{}",
    };
    await repo.upsert(row);
    await repo.upsert({ ...row, id: "sr-2", quality_rank: 5 });
    const count = await store.get("SELECT count(*) AS c FROM source_record");
    expect(count?.c).toBe(1);
  });
});
