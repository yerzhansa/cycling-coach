import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/store/migrations/index.js";
import { DERIVED_TABLES, DUMP_TABLES } from "../src/store/dump.js";
import { MIXED_AUTHORED_TABLES, PURE_AUTHORED_TABLES } from "../src/store/export/ports.js";

const EXPECTED_TABLES = [
  "athlete",
  "sport_settings",
  "anchor_history",
  "zone_set_history",
  "workout",
  "session",
  "lap",
  "swim_length",
  "stream",
  "source_record",
  "raw_file",
  "wellness",
  "planned_workout",
  "race_goal",
  "intake_flags",
  "metric_snapshot",
  "mean_max_cache",
  "stroke_correction_overlay",
  "field_merge_override_overlay",
  "pool_size_correction_overlay",
];
const EXPECTED_FULL_TABLES = [
  ...EXPECTED_TABLES,
  "plan",
  "plan_conversation",
  "plan_conversation_turn",
  "plan_draft_revision",
  "plan_proposal",
  "plan_proposal_premise",
  "plan_reconciliation_item",
  "plan_reconciliation_job",
  "plan_source_request",
  "plan_workout",
  "plan_workout_drift",
  "plan_workout_match",
  "ingest_metadata",
  "repair_log",
  "dedup_confirmation",
  "repair_fixer_settings",
  "source_artifact",
  "source_record_revision",
  "source_record_current",
  "source_watermark",
  "sync_operation",
  "ingest_incremental_state",
  "ingest_candidate_index",
  "ingest_dedup_pair_state",
  "ingest_dedup_session_state",
  "ingest_cluster_state",
  "sync_failure",
  "store_owner",
  "analytics_curve_generation",
  "analytics_curve_evidence",
  "analytics_curve_generation_promotion",
  "analytics_curve_current",
  "analytics_curve_refresh_failure",
  "activity_analysis_projection",
];
const MIGRATION_002 = `ALTER TABLE swim_length ADD COLUMN distance_m REAL;

CREATE TABLE ingest_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  ingest_version INTEGER NOT NULL CHECK (ingest_version >= 0)
) STRICT;

INSERT INTO ingest_metadata (singleton, ingest_version) VALUES (1, 0);

CREATE TABLE repair_log (
  repair_key TEXT PRIMARY KEY,
  raw_sha256 TEXT NOT NULL REFERENCES raw_file(sha256) ON DELETE RESTRICT,
  session_key TEXT NOT NULL REFERENCES session(session_key) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  fixer TEXT NOT NULL,
  changed_count INTEGER NOT NULL CHECK (changed_count >= 0),
  changed_indices_json TEXT NOT NULL,
  params_json TEXT NOT NULL,
  UNIQUE (raw_sha256, session_key, channel, fixer)
) STRICT;
`;
const MIGRATION_003 = `CREATE TABLE dedup_confirmation (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 26
      AND id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    ),
  member_a TEXT NOT NULL
    CHECK (length(member_a) = 64 AND member_a NOT GLOB '*[^0-9a-f]*'),
  member_b TEXT NOT NULL
    CHECK (length(member_b) = 64 AND member_b NOT GLOB '*[^0-9a-f]*'),
  verdict TEXT NOT NULL CHECK (verdict IN ('merge','distinct')),
  device_id TEXT NOT NULL
    CHECK (
      length(device_id) BETWEEN 1 AND 128
      AND substr(device_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND device_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  hlc_physical_ms INTEGER NOT NULL,
  hlc_counter INTEGER NOT NULL,
  CHECK (member_a < member_b)
) STRICT;

CREATE INDEX idx_dedup_confirmation_effective
  ON dedup_confirmation (
    member_a,
    member_b,
    hlc_physical_ms DESC,
    hlc_counter DESC,
    device_id DESC,
    id DESC
  );
`;
const MIGRATION_004 = `CREATE TABLE repair_fixer_settings (
  fixer TEXT PRIMARY KEY
    CHECK (fixer IN ('chronoBridge','summitGuard','pulseWeave')),
  enabled INTEGER NOT NULL CHECK (enabled = 1)
) STRICT;
`;

const EXPECTED_INDEXES = [
  "idx_anchor_history_current",
  "idx_zone_set_history_current",
  "idx_session_workout",
  "idx_session_adherence",
  "idx_lap_session",
  "idx_swim_length_lap",
  "idx_stream_session",
  "idx_planned_workout_adherence",
  "idx_metric_snapshot_scope",
  "idx_metric_snapshot_metric",
  "idx_stroke_correction_target",
  "idx_pool_size_target",
];

const RESERVED_DOMAIN_I_TABLES = [
  "messages",
  "events",
  "daily_notes",
  "memory_journal",
  "plan",
  "usage",
  "claims",
];

let db: DatabaseSync | undefined;

function openMigrated(): DatabaseSync {
  const next = new DatabaseSync(":memory:");
  next.exec("PRAGMA foreign_keys = ON;");
  next.exec(MIGRATIONS[0].sql);
  return next;
}

function openFull(): DatabaseSync {
  const next = openMigrated();
  for (const migration of MIGRATIONS.slice(1)) next.exec(migration.sql);
  return next;
}

afterEach(() => {
  db?.close();
  db = undefined;
});

describe("001_init migration", () => {
  it("wires the ordered migration list with real inlined SQL", () => {
    expect(MIGRATIONS.map(({ version, name }) => ({ version, name }))).toEqual([
      { version: 1, name: "001_init" },
      { version: 2, name: "002_repair_log" },
      { version: 3, name: "003_dedup_confirmation" },
      { version: 4, name: "004_repair_fixer_settings" },
      { version: 5, name: "005_sync_state" },
      { version: 6, name: "006_incremental_ingest" },
      { version: 7, name: "007_sync_failure" },
      { version: 8, name: "008_store_owner" },
      { version: 9, name: "009_activity_source_resolver" },
      { version: 10, name: "010_analytics_curves" },
      { version: 11, name: "011_activity_analysis_projection" },
      { version: 12, name: "012_planning" },
      { version: 13, name: "013_plan_conversations" },
      { version: 14, name: "014_plan_reconciliation" },
      { version: 15, name: "015_plan_race_course" },
      { version: 16, name: "016_plan_workout_match" },
      { version: 17, name: "017_plan_workout_drift" },
      { version: 18, name: "018_plan_proposals" },
    ]);
    expect(typeof MIGRATIONS[0].sql).toBe("string");
    expect(MIGRATIONS[0].sql).toContain("CREATE TABLE athlete");
  });

  it("executes clean under foreign-key enforcement", () => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    expect(() => db!.exec(MIGRATIONS[0].sql)).not.toThrow();
    const violations = db.prepare("PRAGMA foreign_key_check;").all();
    expect(violations).toEqual([]);
  });

  it("creates exactly the 20 Domains A-H tables", () => {
    db = openMigrated();
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual([...EXPECTED_TABLES].sort());
  });

  it("creates exactly the 12 named indexes", () => {
    db = openMigrated();
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual([...EXPECTED_INDEXES].sort());
  });

  it("does NOT build any Domain I table (reservation check)", () => {
    db = openMigrated();
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
      name: string;
    }>;
    const names = new Set(rows.map((r) => r.name));
    for (const reserved of RESERVED_DOMAIN_I_TABLES) {
      expect(names.has(reserved)).toBe(false);
    }
    for (const name of names) {
      expect(name.startsWith("agent_")).toBe(false);
    }
  });

  it("carries no wall-clock column on any derived table (INV-2)", () => {
    db = openMigrated();
    expect(DERIVED_TABLES.join(",")).toBe(
      "metric_snapshot,mean_max_cache,ingest_cluster_state,ingest_dedup_session_state,ingest_dedup_pair_state,ingest_candidate_index,repair_log,stream,swim_length,lap,session,workout",
    );
    for (const table of DERIVED_TABLES.filter((name) => EXPECTED_TABLES.includes(name))) {
      const cols = db.prepare(`PRAGMA table_info(${table});`).all() as Array<{ name: string }>;
      const colNames = cols.map((c) => c.name);
      expect(colNames).not.toContain("computed_at");
      expect(colNames).not.toContain("fetched_at");
    }
  });

  it("enforces a CHECK constraint (metric_snapshot.scope_kind)", () => {
    db = openMigrated();
    const insert = (scopeKind: string) =>
      db!
        .prepare(
          "INSERT INTO metric_snapshot (snapshot_key, scope_kind, scope_id, metric_key, value_json, kernel_version, basis_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(`snap-${scopeKind}`, scopeKind, "scope", "metric", "{}", "k", "b");
    expect(() => insert("bogus")).toThrow();
    expect(() => insert("session")).not.toThrow();
  });

  it("cascades a derived child on parent delete (session <- workout)", () => {
    db = openMigrated();
    db.prepare(
      "INSERT INTO workout (workout_key, start_utc, is_multisport, dedup_cluster_id) VALUES (?, ?, ?, ?)",
    ).run("wk-1", 1000, 0, "cluster-1");
    db.prepare(
      "INSERT INTO session (session_key, workout_key, session_seq, sport, start_utc, local_date_key, is_transition) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("se-1", "wk-1", 0, "cycling", 1000, 19980101, 0);
    expect((db.prepare("SELECT count(*) c FROM session").get() as { c: number }).c).toBe(1);
    db.prepare("DELETE FROM workout").run();
    expect((db.prepare("SELECT count(*) c FROM session").get() as { c: number }).c).toBe(0);
  });

  it("preserves the exact migration 002 SQL string", () => {
    expect(MIGRATIONS[1]!.sql).toBe(MIGRATION_002);
  });

  it("preserves the exact migration 003 SQL string", () => {
    expect(MIGRATIONS[2]!.sql).toBe(MIGRATION_003);
  });

  it("applies all migrations with exactly fifty-two tables and no foreign-key violations", () => {
    db = openFull();
    const names = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
    )
      .map((row) => row.name)
      .sort();
    expect(names).toEqual([...EXPECTED_FULL_TABLES].sort());
    expect(names).toHaveLength(54);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("preserves migration 004 and creates strict sparse fixer settings with exact constraints", () => {
    expect(MIGRATIONS[3]!.sql).toBe(MIGRATION_004);
    db = openFull();
    expect(
      db.prepare("SELECT fixer,enabled FROM repair_fixer_settings ORDER BY fixer").all(),
    ).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_list(repair_fixer_settings)").all()).toEqual([]);
    const tables = db.prepare("PRAGMA table_list").all() as Array<{ name: string; strict: number }>;
    expect(tables.find((row) => row.name === "repair_fixer_settings")?.strict).toBe(1);
    for (const fixer of ["chronoBridge", "summitGuard", "pulseWeave"]) {
      expect(() =>
        db!.prepare("INSERT INTO repair_fixer_settings(fixer,enabled) VALUES(?,1)").run(fixer),
      ).not.toThrow();
    }
    expect(() =>
      db!.prepare("INSERT INTO repair_fixer_settings(fixer,enabled) VALUES('unknown',1)").run(),
    ).toThrow();
    expect(() =>
      db!.prepare("UPDATE repair_fixer_settings SET enabled=0 WHERE fixer='chronoBridge'").run(),
    ).toThrow();
  });

  it("creates strict append-only confirmation history with canonical ASCII pairs and descending effective index", () => {
    db = openFull();
    const tables = db.prepare("PRAGMA table_list").all() as Array<{ name: string; strict: number }>;
    expect(tables.find((row) => row.name === "dedup_confirmation")?.strict).toBe(1);
    expect(db.prepare("PRAGMA foreign_key_list(dedup_confirmation)").all()).toEqual([]);
    const a = "a".repeat(64),
      b = "b".repeat(64),
      id = "0".repeat(26);
    db.prepare("INSERT INTO dedup_confirmation VALUES(?,?,?,?,?,?,?)").run(
      id,
      a,
      b,
      "merge",
      "device-1",
      1,
      0,
    );
    expect(() =>
      db!
        .prepare("INSERT INTO dedup_confirmation VALUES(?,?,?,?,?,?,?)")
        .run("1".repeat(26), b, a, "merge", "device-1", 1, 0),
    ).toThrow();
    expect(() =>
      db!
        .prepare("INSERT INTO dedup_confirmation VALUES(?,?,?,?,?,?,?)")
        .run("2".repeat(26), a, b, "unknown", "device-1", 1, 0),
    ).toThrow();
    for (const [index, character] of [String.fromCodePoint(0x10000), "\ue000"].entries()) {
      expect(() =>
        db!
          .prepare("INSERT INTO dedup_confirmation VALUES(?,?,?,?,?,?,?)")
          .run(`${character}${String(index).repeat(25)}`, a, b, "merge", "device", 1, 0),
      ).toThrow();
      expect(() =>
        db!
          .prepare("INSERT INTO dedup_confirmation VALUES(?,?,?,?,?,?,?)")
          .run(String(index + 3).repeat(26), a, b, "merge", `device-${character}`, 1, 0),
      ).toThrow();
    }
    const sql = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_dedup_confirmation_effective'",
        )
        .get() as { sql: string }
    ).sql;
    expect(sql).toContain("hlc_physical_ms DESC");
    expect(sql).toContain("hlc_counter DESC");
    expect(sql).toContain("device_id DESC");
    expect(sql).toContain("id DESC");
  });

  it("adds nullable REAL distance_m to swim_length", () => {
    db = openFull();
    const column = (
      db.prepare("PRAGMA table_info(swim_length)").all() as Array<{
        name: string;
        type: string;
        notnull: number;
      }>
    ).find((entry) => entry.name === "distance_m");
    expect(column).toMatchObject({ name: "distance_m", type: "REAL", notnull: 0 });
  });

  it("creates both STRICT tables with exact foreign keys and unique repair tuple", () => {
    db = openFull();
    const strict = db.prepare("PRAGMA table_list").all() as Array<{ name: string; strict: number }>;
    expect(strict.find((row) => row.name === "ingest_metadata")?.strict).toBe(1);
    expect(strict.find((row) => row.name === "repair_log")?.strict).toBe(1);
    expect(db.prepare("PRAGMA foreign_key_list(repair_log)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "raw_sha256",
          table: "raw_file",
          to: "sha256",
          on_delete: "RESTRICT",
        }),
        expect.objectContaining({
          from: "session_key",
          table: "session",
          to: "session_key",
          on_delete: "CASCADE",
        }),
      ]),
    );
    const indexes = db.prepare("PRAGMA index_list(repair_log)").all() as Array<{
      name: string;
      unique: number;
    }>;
    expect(indexes.some((index) => index.unique === 1)).toBe(true);
  });

  it("seeds and enforces singleton, version, and changed-count constraints", () => {
    db = openFull();
    expect(db.prepare("SELECT singleton,ingest_version FROM ingest_metadata").all()).toEqual([
      { singleton: 1, ingest_version: 0 },
    ]);
    expect(() =>
      db!.prepare("INSERT INTO ingest_metadata(singleton,ingest_version) VALUES(2,0)").run(),
    ).toThrow();
    expect(() => db!.prepare("UPDATE ingest_metadata SET ingest_version=-1").run()).toThrow();
    db.prepare("INSERT INTO raw_file(sha256,path,ext,bytes) VALUES(?,?,?,?)").run(
      "01".repeat(32),
      "x.fit",
      "fit",
      1,
    );
    db.prepare(
      "INSERT INTO workout(workout_key,start_utc,is_multisport,dedup_cluster_id) VALUES('w',0,0,'d')",
    ).run();
    db.prepare(
      "INSERT INTO session(session_key,workout_key,session_seq,sport,start_utc,local_date_key,is_transition) VALUES('s','w',0,'cycling',0,19700101,0)",
    ).run();
    expect(() =>
      db!
        .prepare("INSERT INTO repair_log VALUES(?,?,?,?,?,?,?,?)")
        .run("k", "01".repeat(32), "s", "power", "summitGuard", -1, "[]", "{}"),
    ).toThrow();
  });

  it("registers migration 005 with its exact digest and schema shapes", () => {
    expect(createHash("sha256").update(MIGRATIONS[4]!.sql).digest("hex")).toBe(
      "dd7b012efe7253849973fbb5d74022aa86494d1230da1ab16a46835505cc0a7f",
    );
    db = openFull();
    const tables = db.prepare("PRAGMA table_list").all() as Array<{
      name: string;
      strict: number;
      wr: number;
    }>;
    for (const name of [
      "source_artifact",
      "source_record_revision",
      "source_record_current",
      "source_watermark",
      "sync_operation",
    ]) {
      expect(tables.find((row) => row.name === name)?.strict).toBe(1);
    }
    expect(tables.find((row) => row.name === "source_watermark")?.wr).toBe(1);

    const indexes = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{
          name: string;
        }>
      ).map(({ name }) => name),
    );
    expect(indexes.has("idx_source_artifact_address")).toBe(true);
    expect(indexes.has("idx_source_record_revision_record")).toBe(true);
    expect(indexes.has("idx_sync_operation_source_lane")).toBe(true);

    const revisionForeignKeys = db.prepare("PRAGMA foreign_key_list(source_record_revision)").all();
    expect(revisionForeignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "source_record_id",
          table: "source_record",
          to: "id",
          on_delete: "RESTRICT",
        }),
        expect.objectContaining({
          from: "artifact_key",
          table: "source_artifact",
          to: "artifact_key",
          on_delete: "RESTRICT",
        }),
      ]),
    );
    const currentForeignKeys = db.prepare("PRAGMA foreign_key_list(source_record_current)").all();
    expect(currentForeignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "source_record_id",
          table: "source_record_revision",
          to: "source_record_id",
          on_delete: "RESTRICT",
        }),
        expect.objectContaining({
          from: "revision_id",
          table: "source_record_revision",
          to: "revision_id",
          on_delete: "RESTRICT",
        }),
      ]),
    );

    const triggers = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as Array<{
          name: string;
        }>
      ).map(({ name }) => name),
    );
    expect(triggers).toEqual(
      new Set([
        "source_record_seed_revision",
        "source_record_immutable_presentation",
        "source_artifact_no_update",
        "source_artifact_no_delete",
        "source_record_revision_no_update",
        "source_record_revision_no_delete",
        "source_record_current_no_delete",
        "sync_operation_no_update",
        "sync_operation_no_delete",
        "store_owner_no_update",
        "store_owner_no_delete",
        "analytics_curve_generation_promotion_requires_complete_evidence",
        "analytics_curve_evidence_uses_generation_instant",
        "analytics_curve_generation_promotion_uses_later_instant",
        "analytics_curve_refresh_failure_insert_uses_later_instant",
        "analytics_curve_refresh_failure_update_uses_later_instant",
        "analytics_curve_generation_no_update",
        "analytics_curve_generation_no_delete",
        "analytics_curve_evidence_no_update",
        "analytics_curve_evidence_no_delete",
        "analytics_curve_generation_promotion_no_update",
        "analytics_curve_generation_promotion_no_delete",
        "analytics_curve_current_no_delete",
        "analytics_curve_current_insert_clears_failure",
        "analytics_curve_current_update_clears_failure",
      ]),
    );

    const forbiddenColumns = new Set([
      "started_at",
      "completed_at",
      "updated_at",
      "duration",
      "error",
      "failure",
      "retry",
      "hlc",
      "device_id",
    ]);
    for (const table of [
      "source_artifact",
      "source_record_revision",
      "source_record_current",
      "source_watermark",
      "sync_operation",
    ]) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      for (const { name } of columns) expect(forbiddenColumns.has(name)).toBe(false);
    }
  });

  it("backfills immutable base revisions and enforces DDL selection constraints", () => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const migration of MIGRATIONS.slice(0, 4)) db.exec(migration.sql);
    db.prepare(
      "INSERT INTO source_record(id,workout_key,session_key,source,external_id,raw_sha256,quality_rank,payload_json) VALUES(?,?,?,?,?,?,?,?)",
    ).run("legacy-record", null, null, "intervals-icu", "42", null, 300, '{"v":1}');
    db.exec(MIGRATIONS[4]!.sql);

    expect(db.prepare("SELECT * FROM source_record_revision").all()).toEqual([
      {
        revision_id: "legacy-record",
        source_record_id: "legacy-record",
        artifact_key: null,
        raw_sha256: null,
        quality_rank: 300,
        payload_json: '{"v":1}',
      },
    ]);
    expect(db.prepare("SELECT * FROM source_record_current").all()).toEqual([
      {
        source_record_id: "legacy-record",
        revision_id: "legacy-record",
      },
    ]);

    db.prepare(
      "INSERT INTO source_record(id,workout_key,session_key,source,external_id,raw_sha256,quality_rank,payload_json) VALUES(?,?,?,?,?,?,?,?)",
    ).run("new-record", null, null, "intervals-icu", "43", null, 300, '{"v":1}');
    expect(
      db
        .prepare(
          "SELECT revision_id FROM source_record_revision WHERE source_record_id='new-record'",
        )
        .all(),
    ).toEqual([{ revision_id: "new-record" }]);
    expect(
      db
        .prepare(
          "SELECT revision_id FROM source_record_current WHERE source_record_id='new-record'",
        )
        .get(),
    ).toEqual({
      revision_id: "new-record",
    });
    expect(() =>
      db!.prepare("UPDATE source_record SET payload_json='{}' WHERE id='new-record'").run(),
    ).toThrow(/presentation is immutable/);

    db.prepare("INSERT INTO source_artifact VALUES(?,?,?,?,?,?,?,?)").run(
      "artifact-revision",
      "intervals-icu",
      "activities",
      "43",
      "snapshot",
      "a".repeat(64),
      "1998/01/a.json.gz",
      883_612_800,
    );
    db.prepare("INSERT INTO source_record_revision VALUES(?,?,?,?,?,?)").run(
      "changed-revision",
      "new-record",
      "artifact-revision",
      null,
      300,
      '{"v":2}',
    );
    db.prepare("UPDATE source_record_current SET revision_id=? WHERE source_record_id=?").run(
      "changed-revision",
      "new-record",
    );
    expect(
      db
        .prepare(
          "SELECT revision_id FROM source_record_current WHERE source_record_id='new-record'",
        )
        .get(),
    ).toEqual({
      revision_id: "changed-revision",
    });
    db.prepare(
      "UPDATE source_record_current SET revision_id='new-record' WHERE source_record_id='new-record'",
    ).run();
    expect(() =>
      db!
        .prepare("INSERT INTO source_record_revision VALUES(?,?,?,?,?,?)")
        .run("changed-revision", "new-record", "artifact-revision", null, 300, '{"v":2}'),
    ).toThrow();
    expect(() =>
      db!
        .prepare("INSERT INTO source_record_revision VALUES(?,?,?,?,?,?)")
        .run("missing-artifact-revision", "new-record", null, null, 300, "{}"),
    ).toThrow();
    expect(() =>
      db!
        .prepare(
          "UPDATE source_record_current SET revision_id='legacy-record' WHERE source_record_id='new-record'",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db!
        .prepare(
          "UPDATE source_record_revision SET quality_rank=200 WHERE revision_id='changed-revision'",
        )
        .run(),
    ).toThrow(/append-only/);
    expect(() =>
      db!.prepare("DELETE FROM source_record_revision WHERE revision_id='changed-revision'").run(),
    ).toThrow(/append-only/);
    expect(() =>
      db!.prepare("DELETE FROM source_record_current WHERE source_record_id='new-record'").run(),
    ).toThrow(/cannot be deleted/);
    expect(() => db!.prepare("UPDATE source_artifact SET archive_epoch_s=1").run()).toThrow(
      /append-only/,
    );
    expect(() => db!.prepare("DELETE FROM source_artifact").run()).toThrow(/append-only/);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("enforces source, lane, artifact, watermark, and completion checks", () => {
    db = openFull();
    const artifact = (values: readonly (string | number | null)[]) =>
      db!.prepare("INSERT INTO source_artifact VALUES(?,?,?,?,?,?,?,?)").run(...values);
    const validAddress = "b".repeat(64);
    expect(() =>
      artifact([
        "a1",
        "intervals-icu",
        "activities",
        "1",
        "snapshot",
        validAddress,
        "1998/01/a",
        1,
      ]),
    ).not.toThrow();
    for (const values of [
      ["a2", "unknown", "activities", "1", "snapshot", validAddress, "p", 1],
      ["a3", "intervals-icu", "file-discovery", null, "raw_file", validAddress, "p", 1],
      ["a4", "file-import", "activities", "1", "snapshot", validAddress, "p", 1],
      ["a5", "file-import", "file-discovery", "1", "raw_file", validAddress, "p", 1],
      ["a6", "file-import", "file-discovery", null, "snapshot", validAddress, "p", 1],
      ["a7", "intervals-icu", "bulk-fit", "1", "raw_file", "B".repeat(64), "p", 1],
      ["a8", "intervals-icu", "bulk-fit", "1", "raw_file", validAddress, "", 1],
      ["a9", "intervals-icu", "bulk-fit", "1", "raw_file", validAddress, "p", -1],
    ]) {
      expect(() => artifact(values)).toThrow();
    }

    expect(() =>
      db!.prepare("INSERT INTO source_watermark VALUES('intervals-icu','activities','next')").run(),
    ).not.toThrow();
    expect(() =>
      db!
        .prepare("INSERT INTO source_watermark VALUES('intervals-icu','file-discovery','x')")
        .run(),
    ).toThrow();
    expect(() =>
      db!.prepare("INSERT INTO source_watermark VALUES('file-import','file-discovery','')").run(),
    ).toThrow();

    expect(() =>
      db!
        .prepare(
          "INSERT INTO sync_operation(source,lane,watermark_before,watermark_after,artifacts_seen,source_changes,completion_kind) VALUES(?,?,?,?,?,?,?)",
        )
        .run("intervals-icu", "activities", "next", "next", 0, 0, "no-op"),
    ).not.toThrow();
    expect(() =>
      db!
        .prepare(
          "INSERT INTO sync_operation(source,lane,watermark_before,watermark_after,artifacts_seen,source_changes,completion_kind) VALUES(?,?,?,?,?,?,?)",
        )
        .run("intervals-icu", "activities", "next", "changed", 0, 0, "no-op"),
    ).toThrow();
    expect(() =>
      db!
        .prepare(
          "INSERT INTO sync_operation(source,lane,watermark_before,watermark_after,artifacts_seen,source_changes,completion_kind) VALUES(?,?,?,?,?,?,?)",
        )
        .run("intervals-icu", "activities", "next", "next", 0, 0, "applied"),
    ).toThrow();
    expect(() => db!.prepare("UPDATE sync_operation SET artifacts_seen=1").run()).toThrow(
      /append-only/,
    );
    expect(() => db!.prepare("DELETE FROM sync_operation").run()).toThrow(/append-only/);
  });

  it("enumerates sync state ownership", () => {
    expect(DUMP_TABLES).toEqual([
      {
        table: "activity_analysis_projection",
        orderBy: "canonical_activity_id, source_revision, contract_version, section",
      },
      { table: "analytics_curve_current", orderBy: "singleton" },
      { table: "analytics_curve_evidence", orderBy: "evidence_id" },
      { table: "analytics_curve_generation", orderBy: "generation_id" },
      { table: "analytics_curve_generation_promotion", orderBy: "generation_id" },
      { table: "anchor_history", orderBy: "id" },
      { table: "athlete", orderBy: "id" },
      { table: "dedup_confirmation", orderBy: "id" },
      { table: "field_merge_override_overlay", orderBy: "id" },
      { table: "ingest_candidate_index", orderBy: "candidate_id" },
      { table: "ingest_cluster_state", orderBy: "cluster_id" },
      { table: "ingest_dedup_pair_state", orderBy: "candidate_a, candidate_b" },
      { table: "ingest_dedup_session_state", orderBy: "session_group_id" },
      { table: "ingest_incremental_state", orderBy: "singleton" },
      { table: "ingest_metadata", orderBy: "singleton" },
      { table: "intake_flags", orderBy: "id" },
      { table: "lap", orderBy: "lap_key" },
      { table: "mean_max_cache", orderBy: "mmax_key" },
      { table: "metric_snapshot", orderBy: "snapshot_key" },
      { table: "plan", orderBy: "id" },
      { table: "plan_conversation", orderBy: "id" },
      { table: "plan_conversation_turn", orderBy: "conversation_id, sequence, id" },
      { table: "plan_draft_revision", orderBy: "conversation_id, revision, id" },
      { table: "plan_proposal", orderBy: "plan_id, created_at_ms, id" },
      { table: "plan_proposal_premise", orderBy: "proposal_id, source_type, source_id, id" },
      { table: "plan_reconciliation_item", orderBy: "job_id, date_key, id" },
      { table: "plan_reconciliation_job", orderBy: "plan_id, kind, window_start_date_key, id" },
      { table: "plan_source_request", orderBy: "conversation_id, created_at_ms, id" },
      { table: "plan_workout", orderBy: "plan_id, date_key, id" },
      { table: "plan_workout_drift", orderBy: "plan_id, detected_at_ms, id" },
      { table: "plan_workout_match", orderBy: "plan_id, activity_date_key, id" },
      { table: "planned_workout", orderBy: "id" },
      { table: "pool_size_correction_overlay", orderBy: "id" },
      { table: "race_goal", orderBy: "id" },
      { table: "raw_file", orderBy: "sha256" },
      { table: "repair_fixer_settings", orderBy: "fixer" },
      { table: "repair_log", orderBy: "repair_key" },
      { table: "session", orderBy: "session_key" },
      { table: "source_artifact", orderBy: "artifact_key" },
      { table: "source_record", orderBy: "id" },
      { table: "source_record_current", orderBy: "source_record_id" },
      { table: "source_record_revision", orderBy: "revision_id" },
      { table: "sport_settings", orderBy: "id" },
      { table: "stream", orderBy: "stream_key" },
      { table: "stroke_correction_overlay", orderBy: "id" },
      { table: "swim_length", orderBy: "length_key" },
      { table: "wellness", orderBy: "id" },
      { table: "workout", orderBy: "workout_key" },
      { table: "zone_set_history", orderBy: "id" },
    ]);
    expect(DUMP_TABLES).toHaveLength(49);
    expect(DUMP_TABLES.map(({ table }) => String(table))).not.toContain("source_watermark");
    expect(DUMP_TABLES.map(({ table }) => String(table))).not.toContain("sync_operation");
    expect(DUMP_TABLES.map(({ table }) => String(table))).not.toContain("sync_failure");
    expect(DUMP_TABLES.map(({ table }) => String(table))).not.toContain("store_owner");
    expect(DUMP_TABLES.map(({ table }) => String(table))).not.toContain(
      "analytics_curve_refresh_failure",
    );
    for (const table of [
      "analytics_curve_current",
      "analytics_curve_evidence",
      "analytics_curve_generation",
      "analytics_curve_generation_promotion",
      "analytics_curve_refresh_failure",
      "source_artifact",
      "source_record_revision",
      "source_record_current",
      "source_watermark",
      "sync_operation",
      "sync_failure",
      "store_owner",
    ]) {
      expect(DERIVED_TABLES).not.toContain(table);
    }
  });

  it("creates the exact strict incremental cache schema", () => {
    db = openFull();
    expect(createHash("sha256").update(MIGRATIONS[5]!.sql).digest("hex")).toBe(
      "85cd423bdb7a12facbc061865035801f22c177388fe111a4e5979face9368574",
    );
    expect(db.prepare("SELECT singleton,initialized FROM ingest_incremental_state").get()).toEqual({
      singleton: 1,
      initialized: 0,
    });
    expect(() => db!.prepare("UPDATE ingest_incremental_state SET initialized=2").run()).toThrow();
    expect(() =>
      db!
        .prepare(`INSERT INTO ingest_candidate_index (
candidate_id,artifact_kind,artifact_id,member_id,source_kind,source_session_seq,sport_family,is_transition,start_utc,duration_s,candidate_summary_json
) VALUES ('c','raw_file','a','not-a-hash','fit',0,'cycling',0,0,0,'{}')`)
        .run(),
    ).toThrow();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("creates the exact strict operational sync failure schema", () => {
    db = openFull();
    expect(createHash("sha256").update(MIGRATIONS[6]!.sql).digest("hex")).toBe(
      "064cefa015c772c3f642c35d253316905fa41f32ab87396bcaf585f25ead9eec",
    );
    const tables = db.prepare("PRAGMA table_list").all() as Array<{
      name: string;
      strict: number;
    }>;
    expect(tables.find((row) => row.name === "sync_failure")?.strict).toBe(1);
    expect(db.prepare("PRAGMA foreign_key_list(sync_failure)").all()).toEqual([]);
    expect(DUMP_TABLES).toHaveLength(49);
    expect(DERIVED_TABLES).toHaveLength(12);
    expect(PURE_AUTHORED_TABLES).not.toContain("sync_failure");
    expect(MIXED_AUTHORED_TABLES).not.toContain("sync_failure");
  });

  it("creates one immutable store owner record", () => {
    db = openFull();
    expect(createHash("sha256").update(MIGRATIONS[7]!.sql).digest("hex")).toBe(
      "eca323e5177cb64f126cb89919e39d4abfcf3999b3d57ceb7237e59b6b3675e5",
    );
    const columns = db.prepare("PRAGMA table_info(store_owner)").all();
    expect(columns).toContainEqual(expect.objectContaining({ name: "singleton", pk: 1 }));
    expect(columns).toContainEqual(
      expect.objectContaining({ name: "account_fingerprint", notnull: 1 }),
    );
    expect(() =>
      db!
        .prepare("INSERT INTO store_owner(singleton,account_fingerprint) VALUES(1,?)")
        .run("a".repeat(64)),
    ).not.toThrow();
    expect(() => db!.prepare("INSERT INTO store_owner VALUES(2,?)").run("b".repeat(64))).toThrow();
    expect(() =>
      db!.prepare("UPDATE store_owner SET account_fingerprint=?").run("b".repeat(64)),
    ).toThrow();
    expect(() => db!.prepare("DELETE FROM store_owner").run()).toThrow();
  });

  it("adds the canonical-session provider lookup index", () => {
    db = openFull();
    expect(createHash("sha256").update(MIGRATIONS[8]!.sql).digest("hex")).toBe(
      "4fe2e7648bbb09ad62c60a86e26ac4a9e09f4c0e24882428e12ad8722f3d420c",
    );
    expect(db.prepare("PRAGMA index_info(idx_source_record_session_source)").all()).toEqual([
      expect.objectContaining({ seqno: 0, name: "session_key" }),
      expect.objectContaining({ seqno: 1, name: "source" }),
      expect.objectContaining({ seqno: 2, name: "id" }),
    ]);
  });

  it("adds strict immutable four-part analytics curve generations", () => {
    db = openFull();
    expect(createHash("sha256").update(MIGRATIONS[9]!.sql).digest("hex")).toBe(
      "adff3df143002dae23e39a4633d6cc0e39b80fb3689dca843262549b883fbe77",
    );
    const tables = db.prepare("PRAGMA table_list").all() as Array<{
      name: string;
      strict: number;
    }>;
    for (const name of [
      "analytics_curve_generation",
      "analytics_curve_evidence",
      "analytics_curve_generation_promotion",
      "analytics_curve_current",
      "analytics_curve_refresh_failure",
    ]) {
      expect(tables.find((row) => row.name === name)?.strict).toBe(1);
    }
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(DUMP_TABLES).toHaveLength(49);
    expect(DUMP_TABLES.map(({ table }) => table)).not.toContain("analytics_curve_refresh_failure");
    expect(DERIVED_TABLES).not.toContain("analytics_curve_generation");
  });

  it("adds the bounded activity-analysis projection cache", () => {
    db = openFull();
    expect(createHash("sha256").update(MIGRATIONS[10]!.sql).digest("hex")).toBe(
      "b9c22b99343093655536059e68c1846b5deb8b77355a08e38013d807906e300e",
    );
    const table = db
      .prepare("PRAGMA table_list")
      .all()
      .find((row) => (row as { name?: unknown }).name === "activity_analysis_projection") as
      | { strict: number; wr: number }
      | undefined;
    expect(table).toMatchObject({ strict: 1, wr: 1 });
    expect(
      db.prepare("PRAGMA foreign_key_list(activity_analysis_projection)").all(),
    ).toContainEqual(expect.objectContaining({ table: "session", on_delete: "CASCADE" }));
    expect(db.prepare("PRAGMA index_info(idx_activity_analysis_projection_lru)").all()).toEqual([
      expect.objectContaining({ seqno: 0, name: "accessed_epoch_s" }),
      expect.objectContaining({ seqno: 1, name: "canonical_activity_id" }),
      expect.objectContaining({ seqno: 2, name: "source_revision" }),
      expect.objectContaining({ seqno: 3, name: "contract_version" }),
      expect.objectContaining({ seqno: 4, name: "section" }),
    ]);
    expect(DUMP_TABLES.map(({ table: name }) => name)).toContain("activity_analysis_projection");
    expect(DERIVED_TABLES).not.toContain("activity_analysis_projection");
  });

  it("adds strict authored Plan and Plan Workout tables without changing planned_workout", () => {
    db = openFull();
    const tables = db.prepare("PRAGMA table_list").all() as Array<{
      name: string;
      strict: number;
    }>;
    expect(tables.find((row) => row.name === "plan")?.strict).toBe(1);
    expect(tables.find((row) => row.name === "plan_workout")?.strict).toBe(1);
    expect(db.prepare("PRAGMA foreign_key_list(plan_workout)").all()).toContainEqual(
      expect.objectContaining({ table: "plan", on_delete: "CASCADE" }),
    );
    expect(db.prepare("PRAGMA index_info(idx_plan_workout_plan_date)").all()).toEqual([
      expect.objectContaining({ seqno: 0, name: "plan_id" }),
      expect.objectContaining({ seqno: 1, name: "date_key" }),
    ]);
    expect(PURE_AUTHORED_TABLES).toEqual(
      expect.arrayContaining([
        "plan",
        "plan_proposal",
        "plan_proposal_premise",
        "plan_workout",
        "plan_workout_drift",
        "plan_workout_match",
      ]),
    );
    expect(MIXED_AUTHORED_TABLES).toContain("planned_workout");
    expect(db.prepare("PRAGMA table_info(planned_workout)").all()).not.toEqual([]);
  });

  it("adds strict Plan conversation, Draft lineage, and source-request tables", () => {
    db = openFull();
    const tables = db.prepare("PRAGMA table_list").all() as Array<{
      name: string;
      strict: number;
    }>;
    for (const name of [
      "plan_conversation",
      "plan_conversation_turn",
      "plan_draft_revision",
      "plan_source_request",
    ]) {
      expect(tables.find((row) => row.name === name)?.strict).toBe(1);
    }
    expect(db.prepare("PRAGMA foreign_key_list(plan_conversation_turn)").all()).toContainEqual(
      expect.objectContaining({ table: "plan_conversation", on_delete: "CASCADE" }),
    );
    expect(db.prepare("PRAGMA foreign_key_list(plan_draft_revision)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "plan_conversation", on_delete: "CASCADE" }),
        expect.objectContaining({ table: "plan", on_delete: "CASCADE" }),
        expect.objectContaining({ table: "plan_draft_revision", on_delete: "CASCADE" }),
      ]),
    );
    expect(db.prepare("PRAGMA foreign_key_list(plan_source_request)").all()).toContainEqual(
      expect.objectContaining({ table: "plan_conversation", on_delete: "CASCADE" }),
    );
    expect(PURE_AUTHORED_TABLES).toEqual(
      expect.arrayContaining([
        "plan_conversation",
        "plan_conversation_turn",
        "plan_draft_revision",
        "plan_source_request",
      ]),
    );
  });

  it("omits the unreleased prior bone-stress column from the baseline schema", () => {
    db = openMigrated();
    expect(MIGRATIONS[0].sql).not.toContain("prior_bsi");
    const columns = (
      db.prepare("PRAGMA table_info(intake_flags)").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(columns).not.toContain("prior_bsi");
    expect(columns).toEqual([
      "id",
      "swim_skill_floor",
      "continuous_distance_capable",
      "open_water_comfort",
      "clinician_cleared",
      "injury_status",
      "device_id",
      "hlc_physical_ms",
      "hlc_counter",
    ]);
  });
});
