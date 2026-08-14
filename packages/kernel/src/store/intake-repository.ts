import type { IntakeFlagsRow, IntakeRepository, Row, SqlStore } from "./ports.js";
import type { MigratorStore } from "./migrator.js";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function validate(row: IntakeFlagsRow): void {
  if (!ULID.test(row.id)) throw new TypeError("intake id is invalid");
  if (
    row.swim_skill_floor !== null ||
    row.continuous_distance_capable !== null ||
    row.open_water_comfort !== null
  ) {
    throw new TypeError("intake multisport flags are invalid");
  }
  if (
    row.injury_status !== "none" &&
    row.injury_status !== "managing" &&
    row.injury_status !== "returning"
  ) {
    throw new TypeError("intake injury status is invalid");
  }
  if (row.injury_status === "none" && row.clinician_cleared !== null) {
    throw new TypeError("intake clinician clearance is invalid");
  }
  if (!DEVICE_ID.test(row.device_id)) throw new TypeError("intake device id is invalid");
  if (
    !Number.isSafeInteger(row.hlc_physical_ms) ||
    row.hlc_physical_ms < 0 ||
    !Number.isSafeInteger(row.hlc_counter) ||
    row.hlc_counter < 0
  ) {
    throw new TypeError("intake HLC is invalid");
  }
}

function booleanValue(value: unknown): boolean | null {
  if (value === null) return null;
  if (value === 0) return false;
  if (value === 1) return true;
  throw new TypeError("intake boolean is invalid");
}

function mapped(row: Row): IntakeFlagsRow {
  const value: IntakeFlagsRow = {
    id: String(row.id),
    swim_skill_floor: row.swim_skill_floor as null,
    continuous_distance_capable: row.continuous_distance_capable as null,
    open_water_comfort: row.open_water_comfort as null,
    clinician_cleared: booleanValue(row.clinician_cleared),
    injury_status: row.injury_status as IntakeFlagsRow["injury_status"],
    device_id: String(row.device_id),
    hlc_physical_ms: Number(row.hlc_physical_ms),
    hlc_counter: Number(row.hlc_counter),
  };
  validate(value);
  return value;
}

export function createIntakeRepository(
  store: SqlStore & Pick<MigratorStore, "transaction">,
): IntakeRepository {
  return {
    async replace(row) {
      validate(row);
      await store.transaction(async () => {
        await store.run("DELETE FROM intake_flags");
        await store.run(
          "INSERT INTO intake_flags (id,swim_skill_floor,continuous_distance_capable,open_water_comfort,clinician_cleared,injury_status,device_id,hlc_physical_ms,hlc_counter) VALUES (?,?,?,?,?,?,?,?,?)",
          [
            row.id,
            null,
            null,
            null,
            row.clinician_cleared === null ? null : row.clinician_cleared ? 1 : 0,
            row.injury_status,
            row.device_id,
            row.hlc_physical_ms,
            row.hlc_counter,
          ],
        );
      });
    },
    async read() {
      const rows = await store.all(
        "SELECT id, swim_skill_floor, continuous_distance_capable, open_water_comfort, clinician_cleared, injury_status, device_id, hlc_physical_ms, hlc_counter FROM intake_flags",
      );
      if (rows.length > 1) throw new Error("intake single-row invariant mismatch");
      return rows[0] === undefined ? undefined : mapped(rows[0]);
    },
  };
}
