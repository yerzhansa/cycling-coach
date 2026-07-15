export type SqlValue = string | number | bigint | Uint8Array | null;
export type Row = Record<string, SqlValue>;

import type { RepairFixer } from "../ingest/repair/types.js";

/**
 * Low-level async SQL-exec port. The SQLite driver in kernel-node implements it
 * (wrapping the synchronous DatabaseSync in resolved promises, per the
 * async-first port rule). No driver types cross this boundary.
 */
export interface SqlStore {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: readonly SqlValue[]): Promise<void>;
  get(sql: string, params?: readonly SqlValue[]): Promise<Row | undefined>;
  all(sql: string, params?: readonly SqlValue[]): Promise<Row[]>;
  close(): Promise<void>;
}

export interface AnchorHistoryRow {
  id: string;
  sport: string;
  anchor_type: string;
  value: number;
  unit: string;
  valid_from: number;
  source: string;
  confidence: string;
  note: string | null;
  provenance: string;
  device_id: string | null;
  hlc_physical_ms: number | null;
  hlc_counter: number | null;
}

export interface RawFileRow {
  sha256: string;
  path: string | null;
  ext: string | null;
  bytes: number | null;
  file_id_serial: number | null;
  file_id_time_created_utc: number | null;
  manufacturer: string | null;
  product: string | null;
}

export interface SourceRecordRow {
  id: string;
  workout_key: string | null;
  session_key: string | null;
  source: string;
  external_id: string;
  raw_sha256: string | null;
  quality_rank: number;
  payload_json: string;
}

export interface AnchorRepository {
  /** Insert iff no row exists for (sport, anchor_type, valid_from). Returns true if inserted. */
  insertIfAbsent(row: AnchorHistoryRow): Promise<boolean>;
  /** Effective-dated current row: max valid_from ≤ asOfEpochS, tie-broken by confidence precedence. */
  readCurrent(sport: string, anchorType: string, asOfEpochS: number): Promise<AnchorHistoryRow | undefined>;
}

export type RawFileColumn =
  | "sha256"
  | "path"
  | "ext"
  | "bytes"
  | "file_id_serial"
  | "file_id_time_created_utc"
  | "manufacturer"
  | "product";

export class RawFileInvariantError extends Error {
  readonly sha256: string;
  readonly mismatchedColumns: readonly RawFileColumn[];
  constructor(sha256: string, mismatchedColumns: readonly RawFileColumn[]) {
    super("raw file invariant mismatch");
    this.name = "RawFileInvariantError";
    this.sha256 = sha256;
    this.mismatchedColumns = [...mismatchedColumns];
  }
}

export interface RawFileRepository {
  upsert(row: RawFileRow): Promise<boolean>;
}

export interface SourceRecordRepository {
  upsert(row: SourceRecordRow): Promise<boolean>;
}

export interface DedupConfirmationRow {
  id: string;
  member_a: string;
  member_b: string;
  verdict: "merge" | "distinct";
  device_id: string;
  hlc_physical_ms: number;
  hlc_counter: number;
}

export interface DedupConfirmationRepository {
  insertIfAbsent(row: DedupConfirmationRow): Promise<boolean>;
  readAll(): Promise<readonly DedupConfirmationRow[]>;
}

export interface RepairLogInsert {
  readonly rawSha256: string;
  readonly sessionKey: string;
  readonly channel: string;
  readonly fixer: RepairFixer;
  readonly changedIndices: unknown;
  readonly params: unknown;
}

export interface RepairLogRow {
  readonly repair_key: string;
  readonly raw_sha256: string;
  readonly session_key: string;
  readonly channel: string;
  readonly fixer: RepairFixer;
  readonly changed_count: number;
  readonly changed_indices_json: string;
  readonly params_json: string;
}

export interface RepairLogRepository {
  insertOrAssertIdentical(input: RepairLogInsert): Promise<void>;
}
