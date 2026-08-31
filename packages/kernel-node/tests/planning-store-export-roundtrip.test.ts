import { describe, expect, it } from "vitest";
import {
  buildExport,
  importExport,
  type ArchiveManifestReader,
  type ArchivePresenceChecker,
  type ExportSource,
  type ImportSink,
  type RestoreTableResult,
} from "@enduragent/kernel/store/export";
import {
  dumpStore,
  runMigrations,
  type MigratorStore,
  type SqlStore,
  type SqlValue,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { webCryptoExportEnv } from "@enduragent/kernel-node/store-export";
import { openSqliteStorage } from "../src/sqlite/index.js";

const PLANNING_TABLES = [
  "planning_plan",
  "plan_revision",
  "plan_creation",
  "plan_creation_answer",
  "plan_creation_draft_revision",
  "athlete_preference",
  "training_restriction",
  "plan_change",
  "planning_command",
] as const;

const id = (suffix: number): string => String(suffix).padStart(26, "0");
const BASE_MS = 903_945_600_000;
const DEVICE_ID = "roundtrip-device-1998";
const PLAN_ID = id(1);
const FIRST_REVISION_ID = id(2);
const SECOND_REVISION_ID = id(3);
const CREATION_ID = id(4);
const ANSWER_ID = id(5);
const DRAFT_ID = id(6);
const PREFERENCE_ID = id(7);
const RESTRICTION_ID = id(8);
const CHANGE_ID = id(9);

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function toSqlValue(value: unknown): SqlValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  throw new TypeError("Export row contains a non-SQL value");
}

function sqliteExportSource(store: SqlStore & MigratorStore): ExportSource {
  return {
    readUserVersion: () => store.getUserVersion(),
    readAuthoredTable: (table, { manualOnly }) =>
      store.all(
        `SELECT * FROM ${quoteIdentifier(table)}${manualOnly ? " WHERE provenance = 'manual'" : ""}`,
      ),
  };
}

function sqliteImportSink(store: SqlStore): ImportSink {
  return {
    async restoreAuthoredTable(table, rows): Promise<RestoreTableResult> {
      const tableName = quoteIdentifier(table);
      const before = Number((await store.get(`SELECT COUNT(*) AS count FROM ${tableName}`))?.count);
      for (const row of rows) {
        const columns = Object.keys(row);
        await store.run(
          `INSERT OR IGNORE INTO ${tableName} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
          columns.map((column) => toSqlValue(row[column])),
        );
      }
      const after = Number((await store.get(`SELECT COUNT(*) AS count FROM ${tableName}`))?.count);
      const inserted = after - before;
      return { table, inserted, skipped: rows.length - inserted };
    },
  };
}

async function populatePlanningDomain(store: SqlStore): Promise<void> {
  await store.run(
    `INSERT INTO plan (
      id, origin_id, name, primary_goal, start_date_key, target_date_key, status, kind,
      total_weeks, week_start_day, structure_json, created_at_ms, updated_at_ms,
      device_id, hlc_physical_ms, hlc_counter
    ) VALUES (?, NULL, ?, ?, 19980824, 19981115, 'active', 'full_plan', 12, 1, ?, ?, ?, ?, ?, 0)`,
    [
      PLAN_ID,
      "Synthetic export Plan",
      "Build durable endurance",
      '{"schemaVersion":1}',
      BASE_MS,
      BASE_MS + 5,
      DEVICE_ID,
      BASE_MS + 5,
    ],
  );
  await store.run(
    `INSERT INTO planning_plan (
      plan_id, status, version, current_revision_number, activated_at_ms, closed_at_ms,
      close_reason, close_actor, updated_at_ms, device_id, hlc_physical_ms, hlc_counter
    ) VALUES (?, 'active', 2, 2, ?, NULL, NULL, NULL, ?, ?, ?, 0)`,
    [PLAN_ID, BASE_MS + 3, BASE_MS + 5, DEVICE_ID, BASE_MS + 5],
  );
  await store.run(
    `INSERT INTO plan_revision (
      id, plan_id, revision_number, parent_revision_number, source_kind, source_id,
      snapshot_json, fingerprint, created_at_ms, device_id, hlc_physical_ms, hlc_counter
    ) VALUES (?, ?, 1, NULL, 'activation', ?, ?, ?, ?, ?, ?, 0)`,
    [
      FIRST_REVISION_ID,
      PLAN_ID,
      CREATION_ID,
      '{"revision":1}',
      "a".repeat(64),
      BASE_MS + 3,
      DEVICE_ID,
      BASE_MS + 3,
    ],
  );
  await store.run(
    `INSERT INTO plan_revision (
      id, plan_id, revision_number, parent_revision_number, source_kind, source_id,
      snapshot_json, fingerprint, created_at_ms, device_id, hlc_physical_ms, hlc_counter
    ) VALUES (?, ?, 2, 1, 'plan-change', ?, ?, ?, ?, ?, ?, 0)`,
    [
      SECOND_REVISION_ID,
      PLAN_ID,
      CHANGE_ID,
      '{"revision":2}',
      "b".repeat(64),
      BASE_MS + 5,
      DEVICE_ID,
      BASE_MS + 5,
    ],
  );
  await store.run(
    `INSERT INTO plan_creation (
      id, status, version, seed_json, current_draft_revision_number, activated_plan_id,
      created_at_ms, updated_at_ms, terminal_at_ms, device_id, hlc_physical_ms, hlc_counter
    ) VALUES (?, 'activated', 4, ?, 1, ?, ?, ?, ?, ?, ?, 0)`,
    [
      CREATION_ID,
      '{"goalDate":"1998-11-15"}',
      PLAN_ID,
      BASE_MS,
      BASE_MS + 3,
      BASE_MS + 3,
      DEVICE_ID,
      BASE_MS + 3,
    ],
  );
  await store.run(
    `INSERT INTO plan_creation_answer (
      id, creation_id, sequence, creation_version, answer_key, value_json, scope,
      preference_id, confirmed_at_ms, device_id, hlc_physical_ms, hlc_counter
    ) VALUES (?, ?, 1, 2, 'weekly-availability', ?, 'athlete-preference', ?, ?, ?, ?, 0)`,
    [ANSWER_ID, CREATION_ID, '{"sessions":4}', PREFERENCE_ID, BASE_MS + 1, DEVICE_ID, BASE_MS + 1],
  );
  await store.run(
    `INSERT INTO plan_creation_draft_revision (
      id, creation_id, revision_number, parent_revision_number, input_version,
      input_snapshot_json, input_fingerprint, builder_id, builder_version,
      output_snapshot_json, activation_fingerprint, created_at_ms, device_id,
      hlc_physical_ms, hlc_counter
    ) VALUES (?, ?, 1, NULL, 2, ?, ?, 'roundtrip-builder', '1', ?, ?, ?, ?, ?, 0)`,
    [
      DRAFT_ID,
      CREATION_ID,
      '{"answerVersion":2}',
      "c".repeat(64),
      '{"revision":1}',
      "a".repeat(64),
      BASE_MS + 2,
      DEVICE_ID,
      BASE_MS + 2,
    ],
  );
  await store.run(
    `INSERT INTO athlete_preference (
      id, preference_key, value_json, status, version, source_answer_id, created_at_ms,
      updated_at_ms, removed_at_ms, device_id, hlc_physical_ms, hlc_counter
    ) VALUES (?, 'weekly-availability', ?, 'active', 1, ?, ?, ?, NULL, ?, ?, 0)`,
    [PREFERENCE_ID, '{"sessions":4}', ANSWER_ID, BASE_MS + 1, BASE_MS + 1, DEVICE_ID, BASE_MS + 1],
  );
  await store.run(
    `INSERT INTO training_restriction (
      id, kind, status, version, start_date_key, end_date_key, maximum_duration_minutes,
      confirmed_at_ms, created_at_ms, updated_at_ms, ended_at_ms, device_id,
      hlc_physical_ms, hlc_counter
    ) VALUES (?, 'maximum-duration', 'active', 1, 19980824, 19980830, 90, ?, ?, ?, NULL, ?, ?, 0)`,
    [RESTRICTION_ID, BASE_MS, BASE_MS, BASE_MS, DEVICE_ID, BASE_MS],
  );
  await store.run(
    `INSERT INTO plan_change (
      id, plan_id, status, version, base_revision_number, result_revision_number,
      diff_json, rationale, premises_json, preview_fingerprint,
      reconciliation_effect_json, created_at_ms, updated_at_ms, terminal_at_ms,
      device_id, hlc_physical_ms, hlc_counter
    ) VALUES (?, ?, 'applied', 2, 1, 2, ?, 'Add recovery after the long ride', ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      CHANGE_ID,
      PLAN_ID,
      '{"replace":["1998-08-30"]}',
      '[{"kind":"fatigue"}]',
      "d".repeat(64),
      '{"reschedule":true}',
      BASE_MS + 4,
      BASE_MS + 5,
      BASE_MS + 5,
      DEVICE_ID,
      BASE_MS + 5,
    ],
  );
  await store.run(
    `INSERT INTO planning_command (
      command_name, command_id, request_digest, status, aggregate_refs_json,
      result_json, error_code, error_json, version, created_at_ms, updated_at_ms,
      device_id, hlc_physical_ms, hlc_counter
    ) VALUES ('plan_change.apply', ?, ?, 'succeeded', ?, ?, NULL, NULL, 2, ?, ?, ?, ?, 0)`,
    [
      id(10),
      "e".repeat(64),
      JSON.stringify({ changeId: CHANGE_ID, planId: PLAN_ID }),
      JSON.stringify({ revisionNumber: 2 }),
      BASE_MS + 4,
      BASE_MS + 5,
      DEVICE_ID,
      BASE_MS + 5,
    ],
  );
}

const emptyManifest: ArchiveManifestReader = {
  listArtifacts: async () => [],
};

const completePresence: ArchivePresenceChecker = {
  hasArtifact: async () => true,
};

describe("planning-domain SQLite export round-trip", () => {
  it("restores all nine tables with valid links and is idempotent", async () => {
    const source = openSqliteStorage(":memory:");
    const destination = openSqliteStorage(":memory:");
    try {
      await runMigrations(source, MIGRATIONS);
      await runMigrations(destination, MIGRATIONS);
      await populatePlanningDomain(source);
      const sourceDump = await dumpStore(source);
      const built = await buildExport(
        {
          source: sqliteExportSource(source),
          manifest: emptyManifest,
          ...webCryptoExportEnv,
        },
        {},
      );

      for (const table of PLANNING_TABLES) {
        expect(built.tables.find((entry) => entry.table === table)?.count).toBeGreaterThan(0);
      }

      const first = await importExport(
        {
          sink: sqliteImportSink(destination),
          presence: completePresence,
          targetUserVersion: 29,
          ...webCryptoExportEnv,
        },
        { container: built.container },
      );

      for (const table of PLANNING_TABLES) {
        expect(first.restored.find((entry) => entry.table === table)?.inserted).toBeGreaterThan(0);
      }
      expect(await dumpStore(destination)).toBe(sourceDump);
      expect(await destination.all("PRAGMA foreign_key_check")).toEqual([]);

      const second = await importExport(
        {
          sink: sqliteImportSink(destination),
          presence: completePresence,
          targetUserVersion: 29,
          ...webCryptoExportEnv,
        },
        { container: built.container },
      );

      expect(second.restored.reduce((total, entry) => total + entry.inserted, 0)).toBe(0);
      for (const table of PLANNING_TABLES) {
        expect(second.restored.find((entry) => entry.table === table)?.skipped).toBeGreaterThan(0);
      }
      expect(await dumpStore(destination)).toBe(sourceDump);
      expect(await destination.all("PRAGMA foreign_key_check")).toEqual([]);
    } finally {
      await source.close();
      await destination.close();
    }
  });
});
