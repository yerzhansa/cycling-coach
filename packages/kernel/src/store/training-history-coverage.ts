import { strictUtf8Length } from "../strict-utf8.js";
import type { Row, SqlReadStore, SqlStore } from "./ports.js";

export type CoverageAuthorityKind = "reference-capture" | "activity-backfill";

export interface CoverageGapEvidence {
  readonly datedLocalDates: readonly string[];
  readonly undatedCount: number;
}

export interface CoverageCommitInput {
  readonly source: "intervals-icu";
  readonly lane: "activities";
  readonly authorityKind: CoverageAuthorityKind;
  readonly authorityId: string;
  readonly calendarTimeZone: string;
  readonly coveredOldest: string;
  readonly coveredNewest: string;
  readonly committedEpochSeconds: number;
  readonly gaps: CoverageGapEvidence;
}

export interface CoverageCommitRow extends CoverageCommitInput {
  readonly coverageCommitId: number;
}

export interface BackfillCheckpointInput {
  readonly authorityId: string;
  readonly sourceCycle: number;
  readonly pageOrdinal: number;
  readonly requestedOldest: string;
  readonly requestedNewest: string;
  readonly calendarTimeZone: string;
  readonly cursorAfter: string;
  readonly droppedSourceRestricted: number;
  readonly droppedOther: number;
  readonly gaps: CoverageGapEvidence;
  readonly terminal: boolean;
}

export interface BackfillCheckpointRow extends BackfillCheckpointInput {
  readonly checkpointId: number;
}

export type CoverageCommitAppendResult =
  | { readonly kind: "inserted"; readonly commitId: number }
  | { readonly kind: "already-recorded"; readonly commitId: number };

export type TrainingCoverageErrorCode = "invalid_row" | "authority_conflict";

export class TrainingCoverageError extends Error {
  readonly code: TrainingCoverageErrorCode;

  constructor(code: TrainingCoverageErrorCode) {
    super(`training coverage rejected: ${code}`);
    this.name = "TrainingCoverageError";
    this.code = code;
  }
}

export interface TrainingCoverageRepository {
  appendCommitInTransaction(
    store: Pick<SqlStore, "get">,
    input: CoverageCommitInput,
  ): Promise<CoverageCommitAppendResult>;
  appendBackfillCheckpointInTransaction(
    store: Pick<SqlStore, "get">,
    input: BackfillCheckpointInput,
  ): Promise<{
    readonly kind: "inserted" | "already-recorded";
    readonly checkpointId: number;
  }>;
  readBackfillCheckpoint(
    store: Pick<SqlReadStore, "get">,
    input: { readonly sourceCycle: number; readonly cursorAfter: string },
  ): Promise<BackfillCheckpointRow | undefined>;
}

export interface TrainingCoverageReader {
  listCommits(input: {
    readonly source: "intervals-icu";
    readonly lane: "activities";
  }): Promise<readonly CoverageCommitRow[]>;
}

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ROW_KEYS = [
  "coverage_commit_id",
  "source",
  "lane",
  "authority_kind",
  "authority_id",
  "calendar_timezone",
  "covered_oldest_date_key",
  "covered_newest_date_key",
  "committed_epoch_seconds",
  "gap_state",
  "dropped_local_dates_json",
  "undated_dropped_count",
  "gap_evidence_version",
] as const;

const READ_COMMIT_SQL = `SELECT
  coverage_commit_id,
  source,
  lane,
  authority_kind,
  authority_id,
  calendar_timezone,
  covered_oldest_date_key,
  covered_newest_date_key,
  committed_epoch_seconds,
  gap_state,
  dropped_local_dates_json,
  undated_dropped_count,
  gap_evidence_version
FROM training_history_coverage_commit
WHERE authority_kind = ? AND authority_id = ?`;

const CHECKPOINT_ROW_KEYS = [
  "checkpoint_id",
  "authority_id",
  "source_cycle",
  "page_ordinal",
  "requested_oldest_key",
  "requested_newest_key",
  "calendar_timezone",
  "cursor_after",
  "dropped_source_restricted",
  "dropped_other",
  "dropped_local_dates_json",
  "undated_dropped_count",
  "gap_evidence_version",
  "terminal",
] as const;

const READ_CHECKPOINT_SQL = `SELECT
  checkpoint_id,
  authority_id,
  source_cycle,
  page_ordinal,
  requested_oldest_key,
  requested_newest_key,
  calendar_timezone,
  cursor_after,
  dropped_source_restricted,
  dropped_other,
  dropped_local_dates_json,
  undated_dropped_count,
  gap_evidence_version,
  terminal
FROM training_history_backfill_checkpoint
WHERE source_cycle = ? AND cursor_after = ?`;

function civilDateKey(value: unknown): number | undefined {
  if (typeof value !== "string" || !CIVIL_DATE.test(value)) return undefined;
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== value) {
    return undefined;
  }
  const key = Number(value.replaceAll("-", ""));
  return key >= 19000101 && key <= 29991231 ? key : undefined;
}

function civilDateFromKey(value: unknown): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) invalidRow();
  const compact = String(value).padStart(8, "0");
  if (compact.length !== 8) invalidRow();
  const candidate = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  if (civilDateKey(candidate) !== value) invalidRow();
  return candidate;
}

function hasExactKeys(row: Row, keys: readonly string[]): boolean {
  const actual = Object.keys(row);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function invalidRow(): never {
  throw new TrainingCoverageError("invalid_row");
}

function validateGaps(
  value: CoverageGapEvidence,
  oldestKey: number,
  newestKey: number,
  name: string,
): CoverageGapEvidence {
  if (
    value === null ||
    typeof value !== "object" ||
    !Array.isArray(value.datedLocalDates) ||
    !Number.isSafeInteger(value.undatedCount) ||
    value.undatedCount < 0
  ) {
    throw new TypeError(`invalid ${name}`);
  }
  const dates = value.datedLocalDates.map((date) => {
    const key = civilDateKey(date);
    if (key === undefined || key < oldestKey || key > newestKey) {
      throw new TypeError(`invalid ${name}`);
    }
    return date;
  });
  if (dates.some((date, index) => index > 0 && dates[index - 1]! >= date)) {
    throw new TypeError(`invalid ${name}`);
  }
  return Object.freeze({
    datedLocalDates: Object.freeze([...dates]),
    undatedCount: value.undatedCount,
  });
}

function parseStoredGaps(
  row: Row,
  oldestKey: number,
  newestKey: number,
  legacyUndatedCount = 0,
): CoverageGapEvidence {
  if (
    typeof row.dropped_local_dates_json !== "string" ||
    typeof row.undated_dropped_count !== "number" ||
    !Number.isSafeInteger(row.undated_dropped_count) ||
    typeof row.gap_evidence_version !== "number" ||
    !Number.isSafeInteger(row.gap_evidence_version) ||
    (row.gap_evidence_version !== 0 && row.gap_evidence_version !== 1)
  ) {
    invalidRow();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.dropped_local_dates_json);
  } catch {
    invalidRow();
  }
  const legacyUndated = row.gap_evidence_version === 0 ? legacyUndatedCount : 0;
  try {
    return validateGaps(
      {
        datedLocalDates: parsed as readonly string[],
        undatedCount: legacyUndated > 0 ? legacyUndated : row.undated_dropped_count,
      },
      oldestKey,
      newestKey,
      "stored training coverage gaps",
    );
  } catch {
    invalidRow();
  }
}

function validateInput(input: CoverageCommitInput): {
  readonly oldestKey: number;
  readonly newestKey: number;
} {
  const oldestKey = civilDateKey(input?.coveredOldest);
  const newestKey = civilDateKey(input?.coveredNewest);
  const zoneBytes =
    typeof input?.calendarTimeZone === "string"
      ? strictUtf8Length(input.calendarTimeZone)
      : undefined;
  if (
    input === null ||
    typeof input !== "object" ||
    input.source !== "intervals-icu" ||
    input.lane !== "activities" ||
    (input.authorityKind !== "reference-capture" && input.authorityKind !== "activity-backfill") ||
    typeof input.authorityId !== "string" ||
    input.authorityId.length < 1 ||
    input.authorityId.length > 128 ||
    zoneBytes === undefined ||
    zoneBytes < 1 ||
    zoneBytes > 255 ||
    oldestKey === undefined ||
    newestKey === undefined ||
    oldestKey > newestKey ||
    !Number.isSafeInteger(input.committedEpochSeconds) ||
    input.committedEpochSeconds < 0 ||
    input.gaps === undefined
  ) {
    throw new TypeError("invalid training coverage commit");
  }
  validateGaps(input.gaps, oldestKey, newestKey, "training coverage gaps");
  return { oldestKey, newestKey };
}

function validateCheckpointInput(input: BackfillCheckpointInput): {
  readonly oldestKey: number;
  readonly newestKey: number;
} {
  const oldestKey = civilDateKey(input?.requestedOldest);
  const newestKey = civilDateKey(input?.requestedNewest);
  const zoneBytes =
    typeof input?.calendarTimeZone === "string"
      ? strictUtf8Length(input.calendarTimeZone)
      : undefined;
  if (
    input === null ||
    typeof input !== "object" ||
    typeof input.authorityId !== "string" ||
    input.authorityId.length < 1 ||
    input.authorityId.length > 128 ||
    !Number.isSafeInteger(input.sourceCycle) ||
    input.sourceCycle < 0 ||
    !Number.isSafeInteger(input.pageOrdinal) ||
    input.pageOrdinal < 0 ||
    oldestKey === undefined ||
    newestKey === undefined ||
    oldestKey > newestKey ||
    zoneBytes === undefined ||
    zoneBytes < 1 ||
    zoneBytes > 255 ||
    typeof input.cursorAfter !== "string" ||
    input.cursorAfter.length < 1 ||
    !Number.isSafeInteger(input.droppedSourceRestricted) ||
    input.droppedSourceRestricted < 0 ||
    !Number.isSafeInteger(input.droppedOther) ||
    input.droppedOther < 0 ||
    input.gaps === undefined ||
    typeof input.terminal !== "boolean"
  ) {
    throw new TypeError("invalid training history backfill checkpoint");
  }
  const gaps = validateGaps(
    input.gaps,
    oldestKey,
    newestKey,
    "training history checkpoint gaps",
  );
  if (gaps.datedLocalDates.length + gaps.undatedCount > input.droppedSourceRestricted + input.droppedOther) {
    throw new TypeError("invalid training history checkpoint gaps");
  }
  return { oldestKey, newestKey };
}

function commitRow(row: Row): CoverageCommitRow {
  if (!hasExactKeys(row, ROW_KEYS)) invalidRow();
  const id = row.coverage_commit_id;
  const committed = row.committed_epoch_seconds;
  const oldest = civilDateFromKey(row.covered_oldest_date_key);
  const newest = civilDateFromKey(row.covered_newest_date_key);
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    row.source !== "intervals-icu" ||
    row.lane !== "activities" ||
    (row.authority_kind !== "reference-capture" && row.authority_kind !== "activity-backfill") ||
    typeof row.authority_id !== "string" ||
    typeof row.calendar_timezone !== "string" ||
    typeof committed !== "number" ||
    !Number.isSafeInteger(committed) ||
    committed < 0 ||
    (row.gap_state !== "none" && row.gap_state !== "undated-dropped-rows")
  ) {
    invalidRow();
  }
  const result: CoverageCommitRow = {
    coverageCommitId: id,
    source: row.source,
    lane: row.lane,
    authorityKind: row.authority_kind,
    authorityId: row.authority_id,
    calendarTimeZone: row.calendar_timezone,
    coveredOldest: civilDateFromKey(row.covered_oldest_date_key),
    coveredNewest: civilDateFromKey(row.covered_newest_date_key),
    committedEpochSeconds: committed,
    gaps: parseStoredGaps(
      row,
      civilDateKey(oldest)!,
      civilDateKey(newest)!,
      row.gap_state === "undated-dropped-rows" ? 1 : 0,
    ),
  };
  validateInput(result);
  return Object.freeze(result);
}

function storedGapEvidenceVersion(row: Row): 0 | 1 {
  return row.gap_evidence_version === 1 ? 1 : 0;
}

function hasGaps(gaps: CoverageGapEvidence): boolean {
  return gaps.datedLocalDates.length + gaps.undatedCount > 0;
}

function exactGaps(left: CoverageGapEvidence, right: CoverageGapEvidence): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function legacyCommitGapsCompatible(
  stored: CoverageGapEvidence,
  retry: CoverageGapEvidence,
): boolean {
  return hasGaps(stored) || !hasGaps(retry);
}

function sameCommit(
  left: CoverageCommitRow,
  right: CoverageCommitInput,
  version: 0 | 1,
): boolean {
  return (
    left.source === right.source &&
    left.lane === right.lane &&
    left.authorityKind === right.authorityKind &&
    left.authorityId === right.authorityId &&
    left.calendarTimeZone === right.calendarTimeZone &&
    left.coveredOldest === right.coveredOldest &&
    left.coveredNewest === right.coveredNewest &&
    left.committedEpochSeconds === right.committedEpochSeconds &&
    (version === 1
      ? exactGaps(left.gaps, right.gaps)
      : legacyCommitGapsCompatible(left.gaps, right.gaps))
  );
}

function checkpointRow(row: Row): BackfillCheckpointRow {
  if (!hasExactKeys(row, CHECKPOINT_ROW_KEYS)) invalidRow();
  const checkpointId = row.checkpoint_id;
  const terminal = row.terminal;
  if (
    typeof checkpointId !== "number" ||
    !Number.isSafeInteger(checkpointId) ||
    checkpointId <= 0 ||
    typeof row.authority_id !== "string" ||
    typeof row.source_cycle !== "number" ||
    !Number.isSafeInteger(row.source_cycle) ||
    typeof row.page_ordinal !== "number" ||
    !Number.isSafeInteger(row.page_ordinal) ||
    typeof row.calendar_timezone !== "string" ||
    typeof row.cursor_after !== "string" ||
    typeof row.dropped_source_restricted !== "number" ||
    !Number.isSafeInteger(row.dropped_source_restricted) ||
    typeof row.dropped_other !== "number" ||
    !Number.isSafeInteger(row.dropped_other) ||
    (terminal !== 0 && terminal !== 1)
  ) {
    invalidRow();
  }
  const result: BackfillCheckpointRow = {
    checkpointId,
    authorityId: row.authority_id,
    sourceCycle: row.source_cycle,
    pageOrdinal: row.page_ordinal,
    requestedOldest: civilDateFromKey(row.requested_oldest_key),
    requestedNewest: civilDateFromKey(row.requested_newest_key),
    calendarTimeZone: row.calendar_timezone,
    cursorAfter: row.cursor_after,
    droppedSourceRestricted: row.dropped_source_restricted,
    droppedOther: row.dropped_other,
    gaps: parseStoredGaps(
      row,
      civilDateKey(civilDateFromKey(row.requested_oldest_key))!,
      civilDateKey(civilDateFromKey(row.requested_newest_key))!,
      row.dropped_source_restricted + row.dropped_other,
    ),
    terminal: terminal === 1,
  };
  validateCheckpointInput(result);
  return Object.freeze(result);
}

function sameCheckpoint(
  left: BackfillCheckpointRow,
  right: BackfillCheckpointInput,
  version: 0 | 1,
): boolean {
  return (
    left.authorityId === right.authorityId &&
    left.sourceCycle === right.sourceCycle &&
    left.pageOrdinal === right.pageOrdinal &&
    left.requestedOldest === right.requestedOldest &&
    left.requestedNewest === right.requestedNewest &&
    left.calendarTimeZone === right.calendarTimeZone &&
    left.cursorAfter === right.cursorAfter &&
    left.droppedSourceRestricted === right.droppedSourceRestricted &&
    left.droppedOther === right.droppedOther &&
    (version === 0 || exactGaps(left.gaps, right.gaps)) &&
    left.terminal === right.terminal
  );
}

export function createTrainingCoverageRepository(): TrainingCoverageRepository {
  return {
    async appendCommitInTransaction(store, input) {
      const { oldestKey, newestKey } = validateInput(input);
      const inserted = await store.get(
        `INSERT INTO training_history_coverage_commit (
  source,
  lane,
  authority_kind,
  authority_id,
  calendar_timezone,
  covered_oldest_date_key,
  covered_newest_date_key,
  committed_epoch_seconds,
  gap_state,
  dropped_local_dates_json,
  undated_dropped_count,
  gap_evidence_version
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (authority_kind, authority_id) DO NOTHING
RETURNING coverage_commit_id`,
        [
          input.source,
          input.lane,
          input.authorityKind,
          input.authorityId,
          input.calendarTimeZone,
          oldestKey,
          newestKey,
          input.committedEpochSeconds,
          input.gaps.undatedCount > 0 ? "undated-dropped-rows" : "none",
          JSON.stringify(input.gaps.datedLocalDates),
          input.gaps.undatedCount,
          1,
        ],
      );
      if (
        inserted !== undefined &&
        (!hasExactKeys(inserted, ["coverage_commit_id"]) ||
          typeof inserted.coverage_commit_id !== "number" ||
          !Number.isSafeInteger(inserted.coverage_commit_id) ||
          inserted.coverage_commit_id <= 0)
      ) {
        invalidRow();
      }
      const selected = await store.get(READ_COMMIT_SQL, [input.authorityKind, input.authorityId]);
      if (selected === undefined) invalidRow();
      const stored = commitRow(selected);
      if (!sameCommit(stored, input, storedGapEvidenceVersion(selected))) {
        throw new TrainingCoverageError("authority_conflict");
      }
      return Object.freeze({
        kind: inserted === undefined ? "already-recorded" : "inserted",
        commitId: stored.coverageCommitId,
      });
    },
    async appendBackfillCheckpointInTransaction(store, input) {
      const { oldestKey, newestKey } = validateCheckpointInput(input);
      const inserted = await store.get(
        `INSERT INTO training_history_backfill_checkpoint (
  authority_id,
  source_cycle,
  page_ordinal,
  requested_oldest_key,
  requested_newest_key,
  calendar_timezone,
  cursor_after,
  dropped_source_restricted,
  dropped_other,
  dropped_local_dates_json,
  undated_dropped_count,
  gap_evidence_version,
  terminal
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT DO NOTHING
RETURNING checkpoint_id`,
        [
          input.authorityId,
          input.sourceCycle,
          input.pageOrdinal,
          oldestKey,
          newestKey,
          input.calendarTimeZone,
          input.cursorAfter,
          input.droppedSourceRestricted,
          input.droppedOther,
          JSON.stringify(input.gaps.datedLocalDates),
          input.gaps.undatedCount,
          1,
          input.terminal ? 1 : 0,
        ],
      );
      if (
        inserted !== undefined &&
        (!hasExactKeys(inserted, ["checkpoint_id"]) ||
          typeof inserted.checkpoint_id !== "number" ||
          !Number.isSafeInteger(inserted.checkpoint_id) ||
          inserted.checkpoint_id <= 0)
      ) {
        invalidRow();
      }
      const selected = await store.get(READ_CHECKPOINT_SQL, [
        input.sourceCycle,
        input.cursorAfter,
      ]);
      if (selected === undefined) {
        if (inserted === undefined) throw new TrainingCoverageError("authority_conflict");
        invalidRow();
      }
      const stored = checkpointRow(selected);
      if (!sameCheckpoint(stored, input, storedGapEvidenceVersion(selected))) {
        throw new TrainingCoverageError("authority_conflict");
      }
      return Object.freeze({
        kind: inserted === undefined ? "already-recorded" : "inserted",
        checkpointId: stored.checkpointId,
      });
    },
    async readBackfillCheckpoint(store, input) {
      if (
        input === null ||
        typeof input !== "object" ||
        !Number.isSafeInteger(input.sourceCycle) ||
        input.sourceCycle < 0 ||
        typeof input.cursorAfter !== "string" ||
        input.cursorAfter.length < 1
      ) {
        throw new TypeError("invalid training history checkpoint lookup");
      }
      const row = await store.get(READ_CHECKPOINT_SQL, [input.sourceCycle, input.cursorAfter]);
      return row === undefined ? undefined : checkpointRow(row);
    },
  };
}

export function createTrainingCoverageReader(
  store: Pick<SqlReadStore, "all">,
): TrainingCoverageReader {
  return {
    async listCommits(input) {
      if (
        input === null ||
        typeof input !== "object" ||
        input.source !== "intervals-icu" ||
        input.lane !== "activities"
      ) {
        throw new TypeError("invalid training coverage key");
      }
      const rows = await store.all(
        `SELECT
  coverage_commit_id,
  source,
  lane,
  authority_kind,
  authority_id,
  calendar_timezone,
  covered_oldest_date_key,
  covered_newest_date_key,
  committed_epoch_seconds,
  gap_state,
  dropped_local_dates_json,
  undated_dropped_count,
  gap_evidence_version
FROM training_history_coverage_commit
WHERE source = ? AND lane = ?
ORDER BY committed_epoch_seconds ASC, coverage_commit_id ASC`,
        [input.source, input.lane],
      );
      return Object.freeze(rows.map(commitRow));
    },
  };
}
