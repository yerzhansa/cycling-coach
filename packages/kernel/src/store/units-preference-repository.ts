import type { Row, SqlStore } from "./ports.js";

export type PersistedUnitsPreference = "metric" | "imperial";
export type UnitsPreferenceSource = "cycling" | "athlete" | "default";

export interface UnitsPreferenceReadResult {
  readonly value: PersistedUnitsPreference;
  readonly source: UnitsPreferenceSource;
}

export interface UnitsPreferenceMutationStamp {
  readonly id: string;
  readonly deviceId: string;
  readonly now: number;
}

export interface UnitsPreferenceRepository {
  read(): Promise<UnitsPreferenceReadResult>;
  set(
    value: PersistedUnitsPreference,
    stamp: UnitsPreferenceMutationStamp,
  ): Promise<{ readonly value: PersistedUnitsPreference; readonly source: "cycling" }>;
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function preference(value: unknown, nullable: boolean): PersistedUnitsPreference | null {
  if (value === "metric" || value === "imperial") return value;
  if (nullable && value === null) return null;
  throw new TypeError("Persisted units preference is invalid.");
}

function exactRows(rows: readonly Row[], maximum: number, label: string): void {
  if (rows.length > maximum) throw new Error(`${label} row cardinality is invalid.`);
}

function validateStamp(stamp: UnitsPreferenceMutationStamp): void {
  if (!ULID.test(stamp.id) || !DEVICE_ID.test(stamp.deviceId)) {
    throw new TypeError("Units mutation identity is invalid.");
  }
  if (!Number.isSafeInteger(stamp.now) || stamp.now < 0) {
    throw new TypeError("Units mutation time is invalid.");
  }
}

export function createUnitsPreferenceRepository(store: SqlStore): UnitsPreferenceRepository {
  const cyclingRows = (): Promise<Row[]> =>
    store.all(
      `SELECT id, sport, session_cluster_conventions_json, preferred_units,
              activity_type_map_json, device_id, hlc_physical_ms, hlc_counter
       FROM sport_settings WHERE sport = ?`,
      ["cycling"],
    );

  return {
    async read() {
      const settings = await cyclingRows();
      exactRows(settings, 1, "Cycling settings");
      const athletes = await store.all("SELECT units FROM athlete");
      exactRows(athletes, 1, "Athlete");
      if (settings[0] !== undefined) {
        const value = preference(settings[0].preferred_units, true);
        if (value !== null) return { value, source: "cycling" };
      }
      if (athletes[0] !== undefined) {
        return {
          value: preference(athletes[0].units, false) as PersistedUnitsPreference,
          source: "athlete",
        };
      }
      return { value: "metric", source: "default" };
    },
    async set(value, stamp) {
      preference(value, false);
      validateStamp(stamp);
      const settings = await cyclingRows();
      exactRows(settings, 1, "Cycling settings");
      const current = settings[0];
      if (current === undefined) {
        await store.run(
          `INSERT INTO sport_settings
             (id, sport, session_cluster_conventions_json, preferred_units,
              activity_type_map_json, device_id, hlc_physical_ms, hlc_counter)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [stamp.id, "cycling", null, value, null, stamp.deviceId, stamp.now, 0],
        );
      } else {
        if (
          typeof current.hlc_physical_ms !== "number" ||
          !Number.isSafeInteger(current.hlc_physical_ms) ||
          current.hlc_physical_ms < 0 ||
          typeof current.hlc_counter !== "number" ||
          !Number.isSafeInteger(current.hlc_counter) ||
          current.hlc_counter < 0
        ) {
          throw new TypeError("Cycling settings stamp is invalid.");
        }
        const physical = Math.max(stamp.now, current.hlc_physical_ms);
        const counter = stamp.now > current.hlc_physical_ms ? 0 : current.hlc_counter + 1;
        await store.run(
          `UPDATE sport_settings
           SET preferred_units = ?, hlc_physical_ms = ?, hlc_counter = ?
           WHERE id = ? AND sport = ?`,
          [value, physical, counter, current.id, "cycling"],
        );
      }
      return { value, source: "cycling" };
    },
  };
}
