import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACTIVITY_ANALYSIS_PROJECTION_MAX_REVISIONS,
  ActivityAnalysisProjectionError,
  createActivityAnalysisProjectionRepository,
  runMigrations,
  type ActivityAnalysisProjectionRepository,
  type MigratorStore,
  type SqlStore,
} from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../src/sqlite/index.js";

const SESSION = "a".repeat(64);
const WORKOUT = "b".repeat(64);
const REVISION = "c".repeat(64);

describe("activity analysis projection repository", () => {
  let store: SqlStore & MigratorStore;
  let repository: ActivityAnalysisProjectionRepository;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    await store.run(
      "INSERT INTO workout(workout_key,start_utc,tz_offset_s,name,notes,is_multisport,dedup_cluster_id) VALUES(?,?,?,?,?,?,?)",
      [WORKOUT, 900, 0, null, null, 0, "cluster"],
    );
    await store.run(
      "INSERT INTO session(session_key,workout_key,session_seq,sport,sub_sport,start_utc,tz_offset_s,local_date_key,elapsed_s,timer_s,moving_s,distance_m,is_transition,summary_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [SESSION, WORKOUT, 0, "cycling", null, 900, 0, 19980704, 100, 90, 80, 1_000, 0, null],
    );
    repository = createActivityAnalysisProjectionRepository(store);
  });

  afterEach(async () => {
    await store.close();
  });

  it("upserts and reads a bounded projection while advancing LRU access", async () => {
    const projection = {
      canonicalActivityId: SESSION,
      sourceRevision: REVISION,
      contractVersion: 1,
      section: "aerobic-drift",
      source: "local-canonical",
      observedAt: "1998-07-06T12:00:00.000Z",
      dataJson: '{"value":1}',
    } as const;
    await repository.write(projection, 100);
    await expect(repository.read(projection, 120)).resolves.toEqual(projection);
    expect(await store.get(
      "SELECT cached_epoch_s,accessed_epoch_s FROM activity_analysis_projection",
    )).toEqual({ cached_epoch_s: 100, accessed_epoch_s: 120 });

    const replacement = { ...projection, source: "provider", dataJson: '{"value":2}' } as const;
    await repository.write(replacement, 130);
    await expect(repository.read(projection, 125)).resolves.toEqual(replacement);
    expect(await store.get(
      "SELECT cached_epoch_s,accessed_epoch_s FROM activity_analysis_projection",
    )).toEqual({ cached_epoch_s: 130, accessed_epoch_s: 130 });
  });

  it("rejects invalid identities and payloads before SQL and enforces the database boundary", async () => {
    const base = {
      canonicalActivityId: SESSION,
      sourceRevision: REVISION,
      contractVersion: 1,
      section: "intervals",
      source: "provider",
      observedAt: "1998-07-06T12:00:00.000Z",
      dataJson: "{}",
    } as const;
    await expect(repository.write({ ...base, canonicalActivityId: "provider-id" }, 1))
      .rejects.toEqual(new ActivityAnalysisProjectionError("invalid-input"));
    await expect(repository.write({ ...base, dataJson: "not-json" }, 1))
      .rejects.toEqual(new ActivityAnalysisProjectionError("invalid-input"));
    await repository.write(base, 1);
    await expect(store.run(
      "UPDATE activity_analysis_projection SET data_json = ?",
      ["not-json"],
    )).rejects.toThrow();
  });

  it("keeps at most 128 recently accessed activity revisions and cascades deleted sessions", async () => {
    for (let index = 0; index <= ACTIVITY_ANALYSIS_PROJECTION_MAX_REVISIONS; index += 1) {
      await repository.write({
        canonicalActivityId: SESSION,
        sourceRevision: index.toString(16).padStart(64, "0"),
        contractVersion: 1,
        section: "best-efforts",
        source: "provider",
        observedAt: "1998-07-06T12:00:00.000Z",
        dataJson: `{"index":${index}}`,
      }, index + 1);
    }
    expect(await store.get(
      "SELECT count(DISTINCT source_revision) AS count FROM activity_analysis_projection",
    )).toEqual({ count: ACTIVITY_ANALYSIS_PROJECTION_MAX_REVISIONS });
    expect(await store.get(
      "SELECT 1 AS present FROM activity_analysis_projection WHERE source_revision = ?",
      ["0".repeat(64)],
    )).toBeUndefined();

    await store.run("DELETE FROM workout WHERE workout_key = ?", [WORKOUT]);
    expect(await store.get("SELECT count(*) AS count FROM activity_analysis_projection"))
      .toEqual({ count: 0 });
  });
});
