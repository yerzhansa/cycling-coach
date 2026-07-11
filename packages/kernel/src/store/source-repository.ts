import type {
  RawFileRepository,
  RawFileRow,
  SourceRecordRepository,
  SourceRecordRow,
  SqlStore,
} from "./ports.js";

export function createRawFileRepository(store: SqlStore): RawFileRepository {
  return {
    async upsert(row: RawFileRow): Promise<void> {
      await store.run(
        "INSERT INTO raw_file (sha256, path, ext, bytes, file_id_serial, file_id_time_created_utc, manufacturer, product) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
        [
          row.sha256,
          row.path,
          row.ext,
          row.bytes,
          row.file_id_serial,
          row.file_id_time_created_utc,
          row.manufacturer,
          row.product,
        ],
      );
    },
  };
}

export function createSourceRecordRepository(store: SqlStore): SourceRecordRepository {
  return {
    async upsert(row: SourceRecordRow): Promise<void> {
      await store.run(
        "INSERT INTO source_record (id, workout_key, session_key, source, external_id, raw_sha256, quality_rank, payload_json) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
        [
          row.id,
          row.workout_key,
          row.session_key,
          row.source,
          row.external_id,
          row.raw_sha256,
          row.quality_rank,
          row.payload_json,
        ],
      );
    },
  };
}
