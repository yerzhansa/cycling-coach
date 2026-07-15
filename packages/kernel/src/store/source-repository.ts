import { RawFileInvariantError, type RawFileColumn, type RawFileRepository, type RawFileRow, type SourceRecordRepository, type SourceRecordRow, type SqlStore } from "./ports.js";

export function createRawFileRepository(store: SqlStore): RawFileRepository {
  return {
    async upsert(row: RawFileRow): Promise<boolean> {
      const inserted = await store.get(
        "INSERT INTO raw_file (sha256, path, ext, bytes, file_id_serial, file_id_time_created_utc, manufacturer, product) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING sha256",
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
      const selected = await store.get(
        "SELECT sha256, path, ext, bytes, file_id_serial, file_id_time_created_utc, manufacturer, product FROM raw_file WHERE sha256=?",
        [row.sha256],
      );
      const columns: readonly RawFileColumn[] = [
        "sha256",
        "path",
        "ext",
        "bytes",
        "file_id_serial",
        "file_id_time_created_utc",
        "manufacturer",
        "product",
      ];
      if (selected === undefined) throw new RawFileInvariantError(row.sha256, columns);
      const mismatched = columns.filter((column) => selected[column] !== row[column]);
      if (mismatched.length > 0) throw new RawFileInvariantError(row.sha256, mismatched);
      return inserted !== undefined;
    },
  };
}

export function createSourceRecordRepository(store: SqlStore): SourceRecordRepository {
  return {
    async upsert(row: SourceRecordRow): Promise<boolean> {
      const inserted = await store.get(
        "INSERT INTO source_record (id,workout_key,session_key,source,external_id,raw_sha256,quality_rank,payload_json) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING id",
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
      if (inserted !== undefined) return true;
      const byId = await store.get(
        "SELECT id, source, external_id, raw_sha256, quality_rank, payload_json FROM source_record WHERE id = ?",
        [row.id],
      );
      const bySource = await store.get(
        "SELECT id, source, external_id, raw_sha256, quality_rank, payload_json FROM source_record WHERE source = ? AND external_id = ?",
        [row.source, row.external_id],
      );
      const exact = (selected: typeof byId): boolean => selected !== undefined
        && selected.id === row.id
        && selected.source === row.source
        && selected.external_id === row.external_id
        && selected.raw_sha256 === row.raw_sha256
        && selected.quality_rank === row.quality_rank
        && selected.payload_json === row.payload_json;
      if (!exact(byId) || !exact(bySource) || byId!.id !== bySource!.id) {
        throw new Error("source record invariant mismatch");
      }
      return false;
    },
  };
}
