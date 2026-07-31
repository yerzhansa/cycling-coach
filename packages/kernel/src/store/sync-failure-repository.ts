import type { Row, SqlStore } from "./ports.js";

export const SYNC_FAILURE_SEVERITIES = Object.freeze(["warn", "block"] as const);
export type SyncFailureSeverity = (typeof SYNC_FAILURE_SEVERITIES)[number];

export const SYNC_FAILURE_DETAILS = Object.freeze([
  "source authorization failed",
  "source temporarily unavailable",
  "source data failed validation",
  "source synchronization budget exhausted",
  "source synchronization failed",
  "source failure classification failed",
] as const);
export type SyncFailureDetail = (typeof SYNC_FAILURE_DETAILS)[number];

export interface SyncFailureRow {
  readonly source: "intervals-icu" | "file-import";
  readonly severity: SyncFailureSeverity;
  readonly detail: SyncFailureDetail;
  readonly logical_ordinal: number;
}

export interface SyncFailureCompatibilitySignal {
  readonly schema_version: "1";
  readonly step: "source_failure";
  readonly detail: string;
  readonly ts: string;
  readonly mitigation: "block_coaching" | "warn_only";
}

export interface SyncFailureRepository {
  readAll(): Promise<readonly SyncFailureRow[]>;
  upsert(row: SyncFailureRow): Promise<void>;
  clear(source: SyncFailureRow["source"]): Promise<boolean>;
}

const MAX_ORDINAL = 8_640_000_000_000_000;
const ROW_KEYS = ["source", "severity", "detail", "logical_ordinal"] as const;

function isSource(value: unknown): value is SyncFailureRow["source"] {
  return value === "intervals-icu" || value === "file-import";
}

function isSeverity(value: unknown): value is SyncFailureSeverity {
  return value === "warn" || value === "block";
}

function isDetail(value: unknown): value is SyncFailureDetail {
  return (SYNC_FAILURE_DETAILS as readonly unknown[]).includes(value);
}

function isOrdinal(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_ORDINAL;
}

function validateRow(value: unknown): asserts value is SyncFailureRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("invalid sync failure row");
  }
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.fromEntries(
    ROW_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(value, key)]),
  ) as Record<(typeof ROW_KEYS)[number], PropertyDescriptor | undefined>;
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== ROW_KEYS.length ||
    !ROW_KEYS.every((key) => keys.includes(key)) ||
    ROW_KEYS.some((key) =>
      descriptors[key] === undefined ||
      !("value" in descriptors[key]) ||
      !descriptors[key].enumerable
    ) ||
    !isSource(descriptors.source!.value) ||
    !isSeverity(descriptors.severity!.value) ||
    !isDetail(descriptors.detail!.value) ||
    !isOrdinal(descriptors.logical_ordinal!.value)
  ) {
    throw new TypeError("invalid sync failure row");
  }
}

function validatedRows(values: unknown): SyncFailureRow[] {
  if (!Array.isArray(values)) throw new TypeError("invalid sync failure row");
  const result: SyncFailureRow[] = [];
  const sources = new Set<SyncFailureRow["source"]>();
  for (const value of values) {
    validateRow(value);
    if (sources.has(value.source)) throw new TypeError("duplicate sync failure source");
    sources.add(value.source);
    result.push(value);
  }
  return result;
}

export function nextSyncFailureOrdinal(
  rows: readonly SyncFailureRow[],
  observedEpochMs: number,
): number {
  const valid = validatedRows(rows);
  if (!isOrdinal(observedEpochMs)) throw new TypeError("invalid sync failure row");
  let maximum = -1;
  for (const row of valid) maximum = Math.max(maximum, row.logical_ordinal);
  if (maximum === MAX_ORDINAL) throw new RangeError("sync failure ordinal exhausted");
  return Math.max(observedEpochMs, maximum + 1);
}

export function reduceSyncFailures(
  rows: readonly SyncFailureRow[],
): SyncFailureCompatibilitySignal | null {
  const valid = validatedRows(rows);
  if (valid.length === 0) return null;
  const selected = [...valid].sort(
    (left, right) =>
      (left.severity === right.severity ? 0 : left.severity === "block" ? -1 : 1) ||
      right.logical_ordinal - left.logical_ordinal ||
      (left.source < right.source ? -1 : left.source > right.source ? 1 : 0),
  )[0]!;
  return Object.freeze({
    schema_version: "1",
    step: "source_failure",
    detail: `${selected.source}: ${selected.detail}`,
    ts: new Date(selected.logical_ordinal).toISOString(),
    mitigation: selected.severity === "block" ? "block_coaching" : "warn_only",
  });
}

const READ_ALL_SQL = `SELECT source,severity,detail,logical_ordinal
FROM sync_failure
ORDER BY source COLLATE BINARY ASC`;

const UPSERT_SQL = `INSERT INTO sync_failure (source,severity,detail,logical_ordinal)
VALUES (?,?,?,?)
ON CONFLICT(source) DO UPDATE SET
  severity=excluded.severity,
  detail=excluded.detail,
  logical_ordinal=excluded.logical_ordinal`;

const CLEAR_SQL = "DELETE FROM sync_failure WHERE source=? RETURNING source";

export function createSyncFailureRepository(store: SqlStore): SyncFailureRepository {
  return Object.freeze({
    async readAll(): Promise<readonly SyncFailureRow[]> {
      const rows = validatedRows(await store.all(READ_ALL_SQL));
      return Object.freeze(
        rows.map((row) =>
          Object.freeze({
            source: row.source,
            severity: row.severity,
            detail: row.detail,
            logical_ordinal: row.logical_ordinal,
          }),
        ),
      );
    },
    async upsert(row: SyncFailureRow): Promise<void> {
      validateRow(row);
      await store.run(UPSERT_SQL, [row.source, row.severity, row.detail, row.logical_ordinal]);
    },
    async clear(source: SyncFailureRow["source"]): Promise<boolean> {
      if (!isSource(source)) throw new TypeError("invalid sync failure row");
      const row: Row | undefined = await store.get(CLEAR_SQL, [source]);
      if (row === undefined) return false;
      const keys = Reflect.ownKeys(row);
      const descriptor = Object.getOwnPropertyDescriptor(row, "source");
      if (
        keys.length !== 1 ||
        keys[0] !== "source" ||
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable ||
        descriptor.value !== source
      ) {
        throw new TypeError("invalid sync failure row");
      }
      return true;
    },
  });
}
