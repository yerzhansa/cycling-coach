import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTrustedActivitySourceResolver,
  runMigrations,
  type MigratorStore,
  type SqlStore,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/database.js";

const SESSION = "a".repeat(64);
const WORKOUT = "b".repeat(64);

describe("activity source resolver over SQLite", () => {
  let directory = "";
  let store: SqlStore & MigratorStore;

  beforeEach(async () => {
    directory = mkdtempSync(join(realpathSync(tmpdir()), "activity-source-"));
    store = openSqliteStorage(join(directory, "store.db"));
    await runMigrations(store, MIGRATIONS);
    await store.run(
      "INSERT INTO workout(workout_key,start_utc,tz_offset_s,name,notes,is_multisport,dedup_cluster_id) VALUES(?,?,?,?,?,?,?)",
      [WORKOUT, 900, 0, null, null, 0, "cluster"],
    );
    await store.run(
      "INSERT INTO session(session_key,workout_key,session_seq,sport,sub_sport,start_utc,tz_offset_s,local_date_key,elapsed_s,timer_s,moving_s,distance_m,is_transition,summary_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [SESSION, WORKOUT, 0, "cycling", null, 900, 0, 19980704, 100, 90, 80, 1_000, 0, null],
    );
  });

  afterEach(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function insertSource(sequence: number, providerActivityId: string): Promise<string> {
    const sourceRecordId = sequence.toString(16).padStart(64, "0");
    const artifactKey = (sequence + 16).toString(16).padStart(64, "0");
    const archiveAddress = (sequence + 32).toString(16).padStart(64, "0");
    await store.run(
      "INSERT INTO source_artifact(artifact_key,source,lane,external_id,artifact_kind,archive_address,archive_rel_path,archive_epoch_s) VALUES(?,?,?,?,?,?,?,?)",
      [artifactKey, "intervals-icu", "activities", providerActivityId, "snapshot", archiveAddress,
        `1998/01/${archiveAddress}.json.gz`, 900],
    );
    await store.run(
      "INSERT INTO source_record(id,workout_key,session_key,source,external_id,raw_sha256,quality_rank,payload_json,artifact_key) VALUES(?,?,?,?,?,?,?,?,?)",
      [sourceRecordId, WORKOUT, SESSION, "intervals-icu", providerActivityId, archiveAddress, 300, "{}", artifactKey],
    );
    return sourceRecordId;
  }

  it("reads the selected revision and rejects a deduplicated multi-source session as ambiguous", async () => {
    const firstRevision = await insertSource(1, "i42");
    const resolver = createTrustedActivitySourceResolver(store);

    await expect(resolver.resolve({ canonicalActivityId: SESSION })).resolves.toEqual({
      kind: "resolved",
      providerActivityId: "i42",
      sourceRevision: firstRevision,
    });

    await insertSource(2, "i43");
    await expect(resolver.resolve({ canonicalActivityId: SESSION })).resolves.toEqual({
      kind: "unavailable",
      reason: "ambiguous",
    });
  });
});
