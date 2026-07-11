import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAnchorRepository,
  createRawFileRepository,
  createSourceRecordRepository,
  runMigrations,
  type AnchorHistoryRow,
  type MigratorStore,
  type RawFileRow,
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

  it("upserts raw_file idempotently by sha256", async () => {
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
    await repo.upsert(row);
    await repo.upsert({ ...row, bytes: 999 });
    const count = await store.get("SELECT count(*) AS c FROM raw_file");
    expect(count?.c).toBe(1);
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
