CREATE TABLE activity_analysis_projection (
  canonical_activity_id TEXT NOT NULL
    REFERENCES session(session_key) ON DELETE CASCADE
    CHECK (
      length(canonical_activity_id) = 64
      AND canonical_activity_id = lower(canonical_activity_id)
      AND canonical_activity_id NOT GLOB '*[^0-9a-f]*'
    ),
  source_revision TEXT NOT NULL
    CHECK (
      length(source_revision) = 64
      AND source_revision = lower(source_revision)
      AND source_revision NOT GLOB '*[^0-9a-f]*'
    ),
  contract_version INTEGER NOT NULL CHECK (contract_version = 1),
  section TEXT NOT NULL CHECK (section IN (
    'aerobic-drift',
    'intervals',
    'best-efforts',
    'power-distribution',
    'heart-rate-distribution',
    'power-heart-rate'
  )),
  source TEXT NOT NULL CHECK (source IN ('local-canonical','provider')),
  observed_at TEXT NOT NULL CHECK (
    length(observed_at) BETWEEN 20 AND 32
    AND observed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'
  ),
  data_json TEXT NOT NULL CHECK (
    json_valid(data_json)
    AND length(CAST(data_json AS BLOB)) BETWEEN 2 AND 262144
  ),
  cached_epoch_s INTEGER NOT NULL CHECK (cached_epoch_s >= 0),
  accessed_epoch_s INTEGER NOT NULL CHECK (accessed_epoch_s >= cached_epoch_s),
  PRIMARY KEY (canonical_activity_id, source_revision, contract_version, section)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_activity_analysis_projection_lru
  ON activity_analysis_projection (
    accessed_epoch_s,
    canonical_activity_id,
    source_revision,
    contract_version,
    section
  );
