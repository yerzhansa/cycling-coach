import type { DedupConfirmationRepository, DedupConfirmationRow, Row, SqlStore } from "./ports.js";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MEMBER_ID = /^[0-9a-f]{64}$/;

function validate(row: DedupConfirmationRow): void {
  if (!ULID.test(row.id)) throw new TypeError("confirmation id is invalid");
  if (!MEMBER_ID.test(row.member_a) || !MEMBER_ID.test(row.member_b) || row.member_a >= row.member_b) {
    throw new TypeError("confirmation pair is invalid");
  }
  if (row.verdict !== "merge" && row.verdict !== "distinct") throw new TypeError("confirmation verdict is invalid");
  if (!DEVICE_ID.test(row.device_id)) throw new TypeError("confirmation device id is invalid");
  if (!Number.isSafeInteger(row.hlc_physical_ms) || row.hlc_physical_ms < 0
      || !Number.isSafeInteger(row.hlc_counter) || row.hlc_counter < 0) {
    throw new TypeError("confirmation HLC is invalid");
  }
}

function equal(row: Row, expected: DedupConfirmationRow): boolean {
  return row.id === expected.id
    && row.member_a === expected.member_a
    && row.member_b === expected.member_b
    && row.verdict === expected.verdict
    && row.device_id === expected.device_id
    && row.hlc_physical_ms === expected.hlc_physical_ms
    && row.hlc_counter === expected.hlc_counter;
}

function mapped(row: Row): DedupConfirmationRow {
  const value = {
    id: row.id,
    member_a: row.member_a,
    member_b: row.member_b,
    verdict: row.verdict,
    device_id: row.device_id,
    hlc_physical_ms: row.hlc_physical_ms,
    hlc_counter: row.hlc_counter,
  };
  validate(value as DedupConfirmationRow);
  return value as DedupConfirmationRow;
}

export function createDedupConfirmationRepository(store: SqlStore): DedupConfirmationRepository {
  return {
    async insertIfAbsent(row) {
      validate(row);
      const inserted = await store.get(
        "INSERT INTO dedup_confirmation (id,member_a,member_b,verdict,device_id,hlc_physical_ms,hlc_counter) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING id",
        [row.id, row.member_a, row.member_b, row.verdict, row.device_id, row.hlc_physical_ms, row.hlc_counter],
      );
      if (inserted !== undefined) return true;
      const selected = await store.get(
        "SELECT id, member_a, member_b, verdict, device_id, hlc_physical_ms, hlc_counter FROM dedup_confirmation WHERE id = ?",
        [row.id],
      );
      if (selected === undefined || !equal(selected, row)) throw new Error("dedup confirmation invariant mismatch");
      return false;
    },
    async readAll() {
      const rows = await store.all(`SELECT id, member_a, member_b, verdict, device_id, hlc_physical_ms, hlc_counter
FROM dedup_confirmation
ORDER BY member_a ASC, member_b ASC,
         hlc_physical_ms DESC, hlc_counter DESC,
         device_id DESC, id DESC`);
      return rows.map(mapped);
    },
  };
}
