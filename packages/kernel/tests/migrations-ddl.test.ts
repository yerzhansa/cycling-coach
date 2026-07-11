import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/store/migrations/index.js";

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

const DERIVED_TABLES = [
  "metric_snapshot",
  "mean_max_cache",
  "workout",
  "session",
  "lap",
  "swim_length",
  "stream",
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

afterEach(() => {
  db?.close();
  db = undefined;
});

describe("001_init migration", () => {
  it("wires the ordered migration list with real inlined SQL", () => {
    expect(MIGRATIONS.length).toBe(1);
    expect(MIGRATIONS[0].version).toBe(1);
    expect(MIGRATIONS[0].name).toBe("001_init");
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
    for (const table of DERIVED_TABLES) {
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
});
