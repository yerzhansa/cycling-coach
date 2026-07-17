CREATE TABLE source_artifact (
  artifact_key TEXT PRIMARY KEY,
  source TEXT NOT NULL
    CHECK (source IN ('intervals-icu','file-import')),
  lane TEXT NOT NULL
    CHECK (lane IN ('activities','streams','wellness','settings','bulk-fit','file-discovery')),
  external_id TEXT,
  artifact_kind TEXT NOT NULL
    CHECK (artifact_kind IN ('snapshot','raw_file')),
  archive_address TEXT NOT NULL
    CHECK (length(archive_address) = 64 AND archive_address = lower(archive_address) AND archive_address NOT GLOB '*[^0-9a-f]*'),
  archive_rel_path TEXT NOT NULL
    CHECK (length(archive_rel_path) > 0),
  archive_epoch_s INTEGER NOT NULL
    CHECK (archive_epoch_s >= 0),
  CHECK (
    (source = 'intervals-icu' AND lane != 'file-discovery')
    OR (source = 'file-import' AND lane = 'file-discovery')
  ),
  CHECK (
    (artifact_kind = 'snapshot' AND lane IN ('activities','streams','wellness','settings'))
    OR (artifact_kind = 'raw_file' AND lane IN ('bulk-fit','file-discovery'))
  ),
  CHECK (
    (lane = 'file-discovery' AND external_id IS NULL)
    OR (lane != 'file-discovery' AND external_id IS NOT NULL AND length(external_id) > 0)
  )
) STRICT;

CREATE INDEX idx_source_artifact_address
  ON source_artifact (archive_address, source, lane);

ALTER TABLE source_record
  ADD COLUMN artifact_key TEXT
  REFERENCES source_artifact(artifact_key) ON DELETE RESTRICT;

CREATE TABLE source_record_revision (
  revision_id TEXT PRIMARY KEY,
  source_record_id TEXT NOT NULL
    REFERENCES source_record(id) ON DELETE RESTRICT,
  artifact_key TEXT
    REFERENCES source_artifact(artifact_key) ON DELETE RESTRICT,
  raw_sha256 TEXT,
  quality_rank INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  CHECK (
    raw_sha256 IS NULL
    OR (
      length(raw_sha256) = 64
      AND raw_sha256 = lower(raw_sha256)
      AND raw_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (artifact_key IS NOT NULL OR revision_id = source_record_id),
  UNIQUE (source_record_id, revision_id)
) STRICT;

CREATE INDEX idx_source_record_revision_record
  ON source_record_revision (source_record_id, revision_id);

INSERT INTO source_record_revision (
  revision_id,
  source_record_id,
  artifact_key,
  raw_sha256,
  quality_rank,
  payload_json
)
SELECT
  id,
  id,
  artifact_key,
  raw_sha256,
  quality_rank,
  payload_json
FROM source_record;

CREATE TABLE source_record_current (
  source_record_id TEXT PRIMARY KEY
    REFERENCES source_record(id) ON DELETE RESTRICT,
  revision_id TEXT NOT NULL,
  FOREIGN KEY (source_record_id, revision_id)
    REFERENCES source_record_revision(source_record_id, revision_id)
    ON DELETE RESTRICT
) STRICT;

INSERT INTO source_record_current (source_record_id, revision_id)
SELECT id, id
FROM source_record;

CREATE TRIGGER source_record_seed_revision
AFTER INSERT ON source_record
BEGIN
  INSERT INTO source_record_revision (
    revision_id,
    source_record_id,
    artifact_key,
    raw_sha256,
    quality_rank,
    payload_json
  ) VALUES (
    NEW.id,
    NEW.id,
    NEW.artifact_key,
    NEW.raw_sha256,
    NEW.quality_rank,
    NEW.payload_json
  );
  INSERT INTO source_record_current (source_record_id, revision_id)
  VALUES (NEW.id, NEW.id);
END;

CREATE TRIGGER source_record_immutable_presentation
BEFORE UPDATE OF source, external_id, raw_sha256, quality_rank, payload_json, artifact_key
ON source_record
BEGIN
  SELECT RAISE(ABORT, 'source record presentation is immutable');
END;

CREATE TABLE source_watermark (
  source TEXT NOT NULL
    CHECK (source IN ('intervals-icu','file-import')),
  lane TEXT NOT NULL
    CHECK (lane IN ('activities','streams','wellness','settings','bulk-fit','file-discovery')),
  watermark TEXT NOT NULL
    CHECK (length(watermark) > 0),
  PRIMARY KEY (source, lane),
  CHECK (
    (source = 'intervals-icu' AND lane != 'file-discovery')
    OR (source = 'file-import' AND lane = 'file-discovery')
  )
) STRICT, WITHOUT ROWID;

CREATE TABLE sync_operation (
  operation_id INTEGER PRIMARY KEY,
  source TEXT NOT NULL
    CHECK (source IN ('intervals-icu','file-import')),
  lane TEXT NOT NULL
    CHECK (lane IN ('activities','streams','wellness','settings','bulk-fit','file-discovery')),
  watermark_before TEXT,
  watermark_after TEXT,
  artifacts_seen INTEGER NOT NULL
    CHECK (artifacts_seen >= 0),
  source_changes INTEGER NOT NULL
    CHECK (source_changes >= 0),
  completion_kind TEXT NOT NULL
    CHECK (completion_kind IN ('applied','no-op')),
  CHECK (
    (source = 'intervals-icu' AND lane != 'file-discovery')
    OR (source = 'file-import' AND lane = 'file-discovery')
  ),
  CHECK (watermark_before IS NULL OR length(watermark_before) > 0),
  CHECK (watermark_after IS NULL OR length(watermark_after) > 0),
  CHECK (
    (
      completion_kind = 'no-op'
      AND source_changes = 0
      AND watermark_before IS watermark_after
    )
    OR
    (
      completion_kind = 'applied'
      AND (
        source_changes > 0
        OR watermark_before IS NOT watermark_after
      )
    )
  )
) STRICT;

CREATE INDEX idx_sync_operation_source_lane
  ON sync_operation (source, lane, operation_id);

CREATE TRIGGER source_artifact_no_update
BEFORE UPDATE ON source_artifact
BEGIN
  SELECT RAISE(ABORT, 'source artifact is append-only');
END;

CREATE TRIGGER source_artifact_no_delete
BEFORE DELETE ON source_artifact
BEGIN
  SELECT RAISE(ABORT, 'source artifact is append-only');
END;

CREATE TRIGGER source_record_revision_no_update
BEFORE UPDATE ON source_record_revision
BEGIN
  SELECT RAISE(ABORT, 'source record revision is append-only');
END;

CREATE TRIGGER source_record_revision_no_delete
BEFORE DELETE ON source_record_revision
BEGIN
  SELECT RAISE(ABORT, 'source record revision is append-only');
END;

CREATE TRIGGER source_record_current_no_delete
BEFORE DELETE ON source_record_current
BEGIN
  SELECT RAISE(ABORT, 'source record current selection cannot be deleted');
END;

CREATE TRIGGER sync_operation_no_update
BEFORE UPDATE ON sync_operation
BEGIN
  SELECT RAISE(ABORT, 'sync operation is append-only');
END;

CREATE TRIGGER sync_operation_no_delete
BEFORE DELETE ON sync_operation
BEGIN
  SELECT RAISE(ABORT, 'sync operation is append-only');
END;
