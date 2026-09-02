ALTER TABLE training_history_coverage_commit
  ADD COLUMN dropped_local_dates_json TEXT NOT NULL DEFAULT '[]'
  CHECK (
    json_valid(dropped_local_dates_json)
    AND json_type(dropped_local_dates_json) = 'array'
  );

ALTER TABLE training_history_coverage_commit
  ADD COLUMN undated_dropped_count INTEGER NOT NULL DEFAULT 0
  CHECK (undated_dropped_count >= 0);

ALTER TABLE training_history_coverage_commit
  ADD COLUMN gap_evidence_version INTEGER NOT NULL DEFAULT 0
  CHECK (gap_evidence_version IN (0, 1));

ALTER TABLE training_history_backfill_checkpoint
  ADD COLUMN dropped_local_dates_json TEXT NOT NULL DEFAULT '[]'
  CHECK (
    json_valid(dropped_local_dates_json)
    AND json_type(dropped_local_dates_json) = 'array'
  );

ALTER TABLE training_history_backfill_checkpoint
  ADD COLUMN undated_dropped_count INTEGER NOT NULL DEFAULT 0
  CHECK (undated_dropped_count >= 0);

ALTER TABLE training_history_backfill_checkpoint
  ADD COLUMN gap_evidence_version INTEGER NOT NULL DEFAULT 0
  CHECK (gap_evidence_version IN (0, 1));
