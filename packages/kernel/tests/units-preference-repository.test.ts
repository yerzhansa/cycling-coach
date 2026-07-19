import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSqliteStorage } from "../../kernel-node/src/sqlite/index.js";
import { MIGRATIONS } from "../src/store/migrations/index.js";
import { runMigrations } from "../src/store/migrator.js";
import { createUnitsPreferenceRepository } from "../src/store/units-preference-repository.js";

let store: ReturnType<typeof openSqliteStorage>;

beforeEach(async () => {
  store = openSqliteStorage(":memory:");
  await runMigrations(store, MIGRATIONS);
});

afterEach(async () => {
  await store.close();
});

async function insertAthlete(id: string, units: "metric" | "imperial") {
  await store.run(
    `INSERT INTO athlete
       (id, display_name, birth_year, sex, timezone, units, device_id, hlc_physical_ms, hlc_counter)
     VALUES (?, NULL, NULL, NULL, NULL, ?, ?, 1, 0)`,
    [id, units, `device:${id}`],
  );
}

async function insertSettings(preferred: string | null) {
  await store.run(
    `INSERT INTO sport_settings
       (id, sport, session_cluster_conventions_json, preferred_units,
        activity_type_map_json, device_id, hlc_physical_ms, hlc_counter)
     VALUES (?, 'cycling', ?, ?, ?, ?, ?, ?)`,
    [
      "01J00000000000000000000000",
      '{"gap":30}',
      preferred,
      '{"Ride":"ride"}',
      "device:original",
      200,
      4,
    ],
  );
}

describe("units preference repository", () => {
  it("uses cycling then athlete then metric-default precedence", async () => {
    const repository = createUnitsPreferenceRepository(store);
    await expect(repository.read()).resolves.toEqual({ value: "metric", source: "default" });
    await insertAthlete("01J00000000000000000000001", "imperial");
    await expect(repository.read()).resolves.toEqual({ value: "imperial", source: "athlete" });
    await insertSettings("metric");
    await expect(repository.read()).resolves.toEqual({ value: "metric", source: "cycling" });
  });

  it("falls back through a null cycling preference", async () => {
    await insertAthlete("01J00000000000000000000001", "imperial");
    await insertSettings(null);
    await expect(createUnitsPreferenceRepository(store).read()).resolves.toEqual({
      value: "imperial",
      source: "athlete",
    });
  });

  it("inserts a cycling row with the supplied authored stamp", async () => {
    const repository = createUnitsPreferenceRepository(store);
    await expect(
      repository.set("imperial", {
        id: "01J00000000000000000000002",
        deviceId: "desktop:01J00000000000000000000002",
        now: 300,
      }),
    ).resolves.toEqual({ value: "imperial", source: "cycling" });
    await expect(
      store.get("SELECT * FROM sport_settings WHERE sport = 'cycling'"),
    ).resolves.toMatchObject({
      id: "01J00000000000000000000002",
      preferred_units: "imperial",
      device_id: "desktop:01J00000000000000000000002",
      hlc_physical_ms: 300,
      hlc_counter: 0,
    });
  });

  it("updates only preference and HLC fields while preserving authored row identity", async () => {
    await insertSettings("metric");
    const before = await store.get("SELECT * FROM sport_settings WHERE sport = 'cycling'");
    const repository = createUnitsPreferenceRepository(store);
    await repository.set("imperial", {
      id: "01J00000000000000000000003",
      deviceId: "desktop:01J00000000000000000000003",
      now: 100,
    });
    const regressed = await store.get("SELECT * FROM sport_settings WHERE sport = 'cycling'");
    expect(regressed).toMatchObject({
      id: before?.id,
      sport: before?.sport,
      session_cluster_conventions_json: before?.session_cluster_conventions_json,
      activity_type_map_json: before?.activity_type_map_json,
      device_id: before?.device_id,
      preferred_units: "imperial",
      hlc_physical_ms: 200,
      hlc_counter: 5,
    });
    await repository.set("metric", {
      id: "01J00000000000000000000004",
      deviceId: "desktop:01J00000000000000000000004",
      now: 400,
    });
    await expect(
      store.get("SELECT * FROM sport_settings WHERE sport = 'cycling'"),
    ).resolves.toMatchObject({ preferred_units: "metric", hlc_physical_ms: 400, hlc_counter: 0 });
  });

  it("fails closed for malformed literals and multi-athlete state", async () => {
    await insertSettings("unsupported");
    await expect(createUnitsPreferenceRepository(store).read()).rejects.toThrow(
      "Persisted units preference is invalid.",
    );
    await store.run("DELETE FROM sport_settings");
    await insertAthlete("01J00000000000000000000005", "metric");
    await insertAthlete("01J00000000000000000000006", "imperial");
    await expect(createUnitsPreferenceRepository(store).read()).rejects.toThrow(
      "Athlete row cardinality is invalid.",
    );
    await insertSettings("metric");
    await expect(createUnitsPreferenceRepository(store).read()).rejects.toThrow(
      "Athlete row cardinality is invalid.",
    );
  });

  it("rejects values and authored stamps outside the closed contracts", async () => {
    const repository = createUnitsPreferenceRepository(store);
    await expect(
      repository.set("other" as never, {
        id: "01J00000000000000000000007",
        deviceId: "desktop:01J00000000000000000000007",
        now: 500,
      }),
    ).rejects.toThrow();
    await expect(
      repository.set("metric", { id: "uuid", deviceId: "desktop:uuid", now: 500 }),
    ).rejects.toThrow("Units mutation identity is invalid.");
  });
});
