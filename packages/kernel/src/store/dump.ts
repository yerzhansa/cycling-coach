import { canonicalRowJson } from "./canonical-json.js";
import type { Row, SqlStore } from "./ports.js";

/** Every table in 001_init.sql, alphabetical, with its content-derived order key (DDL-SPEC §4/§8). */
export const DUMP_TABLES: readonly { readonly table: string; readonly orderBy: string }[] = [
  { table: "anchor_history", orderBy: "id" },
  { table: "athlete", orderBy: "id" },
  { table: "field_merge_override_overlay", orderBy: "id" },
  { table: "intake_flags", orderBy: "id" },
  { table: "lap", orderBy: "lap_key" },
  { table: "mean_max_cache", orderBy: "mmax_key" },
  { table: "metric_snapshot", orderBy: "snapshot_key" },
  { table: "planned_workout", orderBy: "id" },
  { table: "pool_size_correction_overlay", orderBy: "id" },
  { table: "race_goal", orderBy: "id" },
  { table: "raw_file", orderBy: "sha256" },
  { table: "session", orderBy: "session_key" },
  { table: "source_record", orderBy: "id" },
  { table: "sport_settings", orderBy: "id" },
  { table: "stream", orderBy: "stream_key" },
  { table: "stroke_correction_overlay", orderBy: "id" },
  { table: "swim_length", orderBy: "length_key" },
  { table: "wellness", orderBy: "id" },
  { table: "workout", orderBy: "workout_key" },
  { table: "zone_set_history", orderBy: "id" },
];

/** Pure: already-ordered rows → the canonical section for one table (header line + one line per row). */
export function canonicalizeTable(table: string, rows: readonly Row[]): string {
  return [`# ${table}`, ...rows.map(canonicalRowJson)].join("\n");
}

/** Async: SELECT * ORDER BY <key> per table, canonicalize, concatenate. */
export async function dumpStore(store: SqlStore): Promise<string> {
  const sections: string[] = [];
  for (const { table, orderBy } of DUMP_TABLES) {
    const rows = await store.all(`SELECT * FROM ${table} ORDER BY ${orderBy} ASC`);
    sections.push(canonicalizeTable(table, rows));
  }
  return sections.join("\n");
}
