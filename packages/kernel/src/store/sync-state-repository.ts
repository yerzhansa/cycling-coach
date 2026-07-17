import type { Row, SqlStore } from "./ports.js";
import type {
  SourceId,
  SourceLane,
  SyncCompletion,
  SyncCompletionResult,
  SyncStateRepository,
  SourceWatermark,
} from "./sync-source.js";

const READ_WATERMARK_SQL = `SELECT watermark
FROM source_watermark
WHERE source = ? AND lane = ?`;

function isValidKey(source: unknown, lane: unknown): source is SourceId {
  if (
    (source !== "intervals-icu" && source !== "file-import") ||
    (lane !== "activities" &&
      lane !== "streams" &&
      lane !== "wellness" &&
      lane !== "settings" &&
      lane !== "bulk-fit" &&
      lane !== "file-discovery")
  ) {
    return false;
  }
  return source === "intervals-icu" ? lane !== "file-discovery" : lane === "file-discovery";
}

function isWatermark(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0);
}

function hasExactKeys(row: Row, keys: readonly string[]): boolean {
  const actual = Object.keys(row);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function validateCompletion(input: SyncCompletion): void {
  if (
    input === null ||
    typeof input !== "object" ||
    !isValidKey(input.source, input.lane) ||
    !isWatermark(input.watermarkBefore) ||
    !isWatermark(input.watermarkAfter) ||
    (input.watermarkBefore !== null && input.watermarkAfter === null) ||
    !Number.isSafeInteger(input.artifactsSeen) ||
    input.artifactsSeen < 0 ||
    !Number.isSafeInteger(input.sourceChanges) ||
    input.sourceChanges < 0
  ) {
    throw new TypeError("invalid sync completion");
  }
}

export function createSyncStateRepository(store: SqlStore): SyncStateRepository {
  const readWatermark = async (source: SourceId, lane: SourceLane): Promise<SourceWatermark> => {
    if (!isValidKey(source, lane)) {
      throw new TypeError("invalid sync watermark key");
    }
    const row = await store.get(READ_WATERMARK_SQL, [source, lane]);
    if (row === undefined) {
      return Object.freeze({ source, lane, value: null });
    }
    if (
      !hasExactKeys(row, ["watermark"]) ||
      typeof row.watermark !== "string" ||
      row.watermark.length === 0
    ) {
      throw new Error("invalid sync watermark row");
    }
    return Object.freeze({ source, lane, value: row.watermark });
  };

  return {
    readWatermark,
    async recordCompletionInTransaction(input: SyncCompletion): Promise<SyncCompletionResult> {
      validateCompletion(input);
      const current = await readWatermark(input.source, input.lane);
      if (current.value !== input.watermarkBefore) {
        throw new Error("sync watermark changed during planning");
      }

      const completionKind =
        input.sourceChanges === 0 && input.watermarkBefore === input.watermarkAfter
          ? "no-op"
          : "applied";
      const inserted = await store.get(
        `INSERT INTO sync_operation (
  source,
  lane,
  watermark_before,
  watermark_after,
  artifacts_seen,
  source_changes,
  completion_kind
) VALUES (?, ?, ?, ?, ?, ?, ?)
RETURNING operation_id`,
        [
          input.source,
          input.lane,
          input.watermarkBefore,
          input.watermarkAfter,
          input.artifactsSeen,
          input.sourceChanges,
          completionKind,
        ],
      );
      if (
        inserted === undefined ||
        !hasExactKeys(inserted, ["operation_id"]) ||
        typeof inserted.operation_id !== "number" ||
        !Number.isSafeInteger(inserted.operation_id) ||
        inserted.operation_id <= 0
      ) {
        throw new Error("sync operation insert failed");
      }
      const operationId = inserted.operation_id;

      if (input.watermarkAfter !== null && input.watermarkAfter !== input.watermarkBefore) {
        await store.run(
          `INSERT INTO source_watermark (source, lane, watermark)
VALUES (?, ?, ?)
ON CONFLICT(source, lane) DO UPDATE
SET watermark = excluded.watermark`,
          [input.source, input.lane, input.watermarkAfter],
        );
      }

      const updated = await readWatermark(input.source, input.lane);
      if (updated.value !== input.watermarkAfter) {
        throw new Error("sync watermark update failed");
      }
      return Object.freeze({ operationId, completionKind });
    },
  };
}
