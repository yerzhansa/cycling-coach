import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/store/migrations/index.js";
import { DERIVED_TABLES } from "../src/store/dump.js";

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
const EXPECTED_FULL_TABLES = [...EXPECTED_TABLES, "ingest_metadata", "repair_log"];
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
  next.exec(MIGRATIONS[1]!.sql);
  return next;
}

afterEach(() => {
  db?.close();
  db = undefined;
});

describe("001_init migration", () => {
  it("wires the ordered migration list with real inlined SQL", () => {
    expect(MIGRATIONS.map(({version,name})=>({version,name}))).toEqual([{version:1,name:"001_init"},{version:2,name:"002_repair_log"}]);
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
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual([...EXPECTED_TABLES].sort());
  });

  it("creates exactly the 12 named indexes", () => {
    db = openMigrated();
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'",
      )
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual([...EXPECTED_INDEXES].sort());
  });

  it("does NOT build any Domain I table (reservation check)", () => {
    db = openMigrated();
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
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
    expect(DERIVED_TABLES.join(",")).toBe("metric_snapshot,mean_max_cache,repair_log,stream,swim_length,lap,session,workout");
    for (const table of DERIVED_TABLES.filter((name) => EXPECTED_TABLES.includes(name))) {
      const cols = db
        .prepare(`PRAGMA table_info(${table});`)
        .all() as Array<{ name: string }>;
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
        .run(
          `snap-${scopeKind}`,
          scopeKind,
          "scope",
          "metric",
          "{}",
          "k",
          "b",
        );
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
    expect(
      (db.prepare("SELECT count(*) c FROM session").get() as { c: number }).c,
    ).toBe(1);
    db.prepare("DELETE FROM workout").run();
    expect(
      (db.prepare("SELECT count(*) c FROM session").get() as { c: number }).c,
    ).toBe(0);
  });

  it("preserves the exact migration 002 SQL string", () => {
    expect(MIGRATIONS[1]!.sql).toBe(MIGRATION_002);
  });

  it("applies 001 then 002 with exactly twenty-two tables and no foreign-key violations", () => {
    db = openFull();
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{name:string}>).map((row)=>row.name).sort();
    expect(names).toEqual([...EXPECTED_FULL_TABLES].sort());
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("adds nullable REAL distance_m to swim_length", () => {
    db = openFull();
    const column = (db.prepare("PRAGMA table_info(swim_length)").all() as Array<{name:string;type:string;notnull:number}>).find((entry)=>entry.name==="distance_m");
    expect(column).toMatchObject({name:"distance_m",type:"REAL",notnull:0});
  });

  it("creates both STRICT tables with exact foreign keys and unique repair tuple", () => {
    db = openFull();
    const strict = db.prepare("PRAGMA table_list").all() as Array<{name:string;strict:number}>;
    expect(strict.find((row)=>row.name==="ingest_metadata")?.strict).toBe(1);
    expect(strict.find((row)=>row.name==="repair_log")?.strict).toBe(1);
    expect(db.prepare("PRAGMA foreign_key_list(repair_log)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({from:"raw_sha256",table:"raw_file",to:"sha256",on_delete:"RESTRICT"}),
      expect.objectContaining({from:"session_key",table:"session",to:"session_key",on_delete:"CASCADE"}),
    ]));
    const indexes=db.prepare("PRAGMA index_list(repair_log)").all() as Array<{name:string;unique:number}>;
    expect(indexes.some((index)=>index.unique===1)).toBe(true);
  });

  it("seeds and enforces singleton, version, and changed-count constraints", () => {
    db = openFull();
    expect(db.prepare("SELECT singleton,ingest_version FROM ingest_metadata").all()).toEqual([{singleton:1,ingest_version:0}]);
    expect(()=>db!.prepare("INSERT INTO ingest_metadata(singleton,ingest_version) VALUES(2,0)").run()).toThrow();
    expect(()=>db!.prepare("UPDATE ingest_metadata SET ingest_version=-1").run()).toThrow();
    db.prepare("INSERT INTO raw_file(sha256,path,ext,bytes) VALUES(?,?,?,?)").run("01".repeat(32),"x.fit","fit",1);
    db.prepare("INSERT INTO workout(workout_key,start_utc,is_multisport,dedup_cluster_id) VALUES('w',0,0,'d')").run();
    db.prepare("INSERT INTO session(session_key,workout_key,session_seq,sport,start_utc,local_date_key,is_transition) VALUES('s','w',0,'cycling',0,19700101,0)").run();
    expect(()=>db!.prepare("INSERT INTO repair_log VALUES(?,?,?,?,?,?,?,?)").run("k","01".repeat(32),"s","power","summitGuard",-1,"[]","{}")).toThrow();
  });
});
