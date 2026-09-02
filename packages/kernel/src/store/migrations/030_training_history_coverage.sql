CREATE TABLE training_history_coverage_commit (
  coverage_commit_id INTEGER PRIMARY KEY,
  source TEXT NOT NULL CHECK (source = 'intervals-icu'),
  lane TEXT NOT NULL CHECK (lane = 'activities'),
  authority_kind TEXT NOT NULL
    CHECK (authority_kind IN ('reference-capture','activity-backfill')),
  authority_id TEXT NOT NULL CHECK (length(authority_id) BETWEEN 1 AND 128),
  calendar_timezone TEXT NOT NULL
    CHECK (length(CAST(calendar_timezone AS BLOB)) BETWEEN 1 AND 255),
  covered_oldest_date_key INTEGER NOT NULL
    CHECK (covered_oldest_date_key BETWEEN 19000101 AND 29991231),
  covered_newest_date_key INTEGER NOT NULL
    CHECK (covered_newest_date_key BETWEEN 19000101 AND 29991231),
  committed_epoch_seconds INTEGER NOT NULL CHECK (committed_epoch_seconds >= 0),
  gap_state TEXT NOT NULL CHECK (gap_state IN ('none','undated-dropped-rows')),
  CHECK (covered_oldest_date_key <= covered_newest_date_key)
) STRICT;

CREATE UNIQUE INDEX training_history_coverage_commit_authority
  ON training_history_coverage_commit (authority_kind, authority_id);

CREATE TABLE training_history_backfill_checkpoint (
  checkpoint_id INTEGER PRIMARY KEY,
  authority_id TEXT NOT NULL CHECK (length(authority_id) BETWEEN 1 AND 128),
  source_cycle INTEGER NOT NULL CHECK (source_cycle >= 0),
  page_ordinal INTEGER NOT NULL CHECK (page_ordinal >= 0),
  requested_oldest_key INTEGER NOT NULL
    CHECK (requested_oldest_key BETWEEN 19000101 AND 29991231),
  requested_newest_key INTEGER NOT NULL
    CHECK (requested_newest_key BETWEEN 19000101 AND 29991231),
  calendar_timezone TEXT NOT NULL
    CHECK (length(CAST(calendar_timezone AS BLOB)) BETWEEN 1 AND 255),
  cursor_after TEXT NOT NULL,
  dropped_source_restricted INTEGER NOT NULL CHECK (dropped_source_restricted >= 0),
  dropped_other INTEGER NOT NULL CHECK (dropped_other >= 0),
  terminal INTEGER NOT NULL CHECK (terminal IN (0, 1)),
  UNIQUE (authority_id, page_ordinal),
  UNIQUE (source_cycle, cursor_after),
  CHECK (requested_oldest_key <= requested_newest_key)
) STRICT;

CREATE TRIGGER training_history_coverage_commit_no_update
BEFORE UPDATE ON training_history_coverage_commit
BEGIN
  SELECT RAISE(ABORT, 'training history coverage commit is append-only');
END;

CREATE TRIGGER training_history_coverage_commit_no_delete
BEFORE DELETE ON training_history_coverage_commit
BEGIN
  SELECT RAISE(ABORT, 'training history coverage commit is append-only');
END;

CREATE TRIGGER training_history_backfill_checkpoint_no_update
BEFORE UPDATE ON training_history_backfill_checkpoint
BEGIN
  SELECT RAISE(ABORT, 'training history backfill checkpoint is append-only');
END;

CREATE TRIGGER training_history_backfill_checkpoint_no_delete
BEFORE DELETE ON training_history_backfill_checkpoint
BEGIN
  SELECT RAISE(ABORT, 'training history backfill checkpoint is append-only');
END;
