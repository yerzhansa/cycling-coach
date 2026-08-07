CREATE TABLE analytics_curve_generation (
  generation_id TEXT PRIMARY KEY
    CHECK (
      length(generation_id) = 64
      AND generation_id = lower(generation_id)
      AND generation_id NOT GLOB '*[^0-9a-f]*'
    ),
  source TEXT NOT NULL CHECK (source = 'intervals-icu'),
  lane TEXT NOT NULL CHECK (lane = 'analytics-curves'),
  frozen_epoch_s INTEGER NOT NULL CHECK (frozen_epoch_s >= 0),
  frozen_on TEXT NOT NULL
    CHECK (length(frozen_on) = 10 AND frozen_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  current_start TEXT NOT NULL
    CHECK (length(current_start) = 10 AND current_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  current_end TEXT NOT NULL
    CHECK (length(current_end) = 10 AND current_end GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  previous_start TEXT NOT NULL
    CHECK (length(previous_start) = 10 AND previous_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  previous_end TEXT NOT NULL
    CHECK (length(previous_end) = 10 AND previous_end GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  sustainability_start TEXT NOT NULL
    CHECK (length(sustainability_start) = 10 AND sustainability_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  sustainability_end TEXT NOT NULL
    CHECK (length(sustainability_end) = 10 AND sustainability_end GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (current_end = frozen_on),
  CHECK (sustainability_end = frozen_on),
  CHECK (previous_start < previous_end),
  CHECK (previous_end < current_start),
  CHECK (current_start < current_end),
  CHECK (sustainability_start < sustainability_end),
  UNIQUE (
    frozen_epoch_s,
    current_start,
    current_end,
    previous_start,
    previous_end,
    sustainability_start,
    sustainability_end
  )
) STRICT;

CREATE TABLE analytics_curve_evidence (
  evidence_id TEXT PRIMARY KEY
    CHECK (
      length(evidence_id) = 64
      AND evidence_id = lower(evidence_id)
      AND evidence_id NOT GLOB '*[^0-9a-f]*'
    ),
  generation_id TEXT NOT NULL
    REFERENCES analytics_curve_generation(generation_id) ON DELETE RESTRICT,
  curve_family TEXT NOT NULL CHECK (curve_family IN ('power','heart-rate')),
  activity_type TEXT NOT NULL CHECK (activity_type IN ('Ride','VirtualRide')),
  request_identity TEXT NOT NULL
    CHECK (
      length(request_identity) = 64
      AND request_identity = lower(request_identity)
      AND request_identity NOT GLOB '*[^0-9a-f]*'
    ),
  archive_address TEXT NOT NULL
    CHECK (
      length(archive_address) = 64
      AND archive_address = lower(archive_address)
      AND archive_address NOT GLOB '*[^0-9a-f]*'
    ),
  archive_rel_path TEXT NOT NULL
    CHECK (
      length(archive_rel_path) = 80
      AND archive_rel_path GLOB '[0-9][0-9][0-9][0-9]/[0-9][0-9]/*.json.gz'
      AND substr(archive_rel_path, 9) = archive_address || '.json.gz'
    ),
  archive_epoch_s INTEGER NOT NULL CHECK (archive_epoch_s >= 0),
  decoded_bytes INTEGER NOT NULL CHECK (decoded_bytes BETWEEN 1 AND 2097152),
  UNIQUE (generation_id, curve_family, activity_type)
) STRICT;

CREATE INDEX idx_analytics_curve_evidence_request
  ON analytics_curve_evidence (request_identity, archive_epoch_s, evidence_id);

CREATE TRIGGER analytics_curve_evidence_uses_generation_instant
BEFORE INSERT ON analytics_curve_evidence
WHEN NEW.archive_epoch_s != (
  SELECT frozen_epoch_s
  FROM analytics_curve_generation
  WHERE generation_id = NEW.generation_id
)
BEGIN
  SELECT RAISE(ABORT, 'analytics curve evidence instant mismatch');
END;

CREATE TABLE analytics_curve_generation_promotion (
  generation_id TEXT PRIMARY KEY
    REFERENCES analytics_curve_generation(generation_id) ON DELETE RESTRICT,
  promoted_epoch_s INTEGER NOT NULL CHECK (promoted_epoch_s >= 0)
) STRICT;

CREATE TRIGGER analytics_curve_generation_promotion_requires_complete_evidence
BEFORE INSERT ON analytics_curve_generation_promotion
WHEN (
  SELECT count(*)
  FROM analytics_curve_evidence
  WHERE generation_id = NEW.generation_id
) != 4
BEGIN
  SELECT RAISE(ABORT, 'analytics curve generation is incomplete');
END;

CREATE TRIGGER analytics_curve_generation_promotion_uses_later_instant
BEFORE INSERT ON analytics_curve_generation_promotion
WHEN NEW.promoted_epoch_s < (
  SELECT frozen_epoch_s
  FROM analytics_curve_generation
  WHERE generation_id = NEW.generation_id
)
BEGIN
  SELECT RAISE(ABORT, 'analytics curve promotion instant mismatch');
END;

CREATE TABLE analytics_curve_current (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  generation_id TEXT NOT NULL UNIQUE
    REFERENCES analytics_curve_generation_promotion(generation_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE analytics_curve_refresh_failure (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  generation_id TEXT NOT NULL
    CHECK (
      length(generation_id) = 64
      AND generation_id = lower(generation_id)
      AND generation_id NOT GLOB '*[^0-9a-f]*'
    )
    REFERENCES analytics_curve_generation(generation_id) ON DELETE RESTRICT,
  code TEXT NOT NULL
    CHECK (code IN (
      'request-budget-exhausted',
      'rate-limited',
      'timeout',
      'network',
      'provider-unavailable',
      'malformed-response',
      'response-too-large',
      'cancelled',
      'temporary-failure'
    )),
  failed_epoch_s INTEGER NOT NULL CHECK (failed_epoch_s >= 0)
) STRICT;

CREATE TRIGGER analytics_curve_refresh_failure_insert_uses_later_instant
BEFORE INSERT ON analytics_curve_refresh_failure
WHEN NEW.failed_epoch_s < (
  SELECT frozen_epoch_s
  FROM analytics_curve_generation
  WHERE generation_id = NEW.generation_id
)
BEGIN
  SELECT RAISE(ABORT, 'analytics curve failure instant mismatch');
END;

CREATE TRIGGER analytics_curve_refresh_failure_update_uses_later_instant
BEFORE UPDATE ON analytics_curve_refresh_failure
WHEN NEW.failed_epoch_s < (
  SELECT frozen_epoch_s
  FROM analytics_curve_generation
  WHERE generation_id = NEW.generation_id
)
BEGIN
  SELECT RAISE(ABORT, 'analytics curve failure instant mismatch');
END;

CREATE TRIGGER analytics_curve_generation_no_update
BEFORE UPDATE ON analytics_curve_generation
BEGIN
  SELECT RAISE(ABORT, 'analytics curve generation is append-only');
END;

CREATE TRIGGER analytics_curve_generation_no_delete
BEFORE DELETE ON analytics_curve_generation
BEGIN
  SELECT RAISE(ABORT, 'analytics curve generation is append-only');
END;

CREATE TRIGGER analytics_curve_evidence_no_update
BEFORE UPDATE ON analytics_curve_evidence
BEGIN
  SELECT RAISE(ABORT, 'analytics curve evidence is append-only');
END;

CREATE TRIGGER analytics_curve_evidence_no_delete
BEFORE DELETE ON analytics_curve_evidence
BEGIN
  SELECT RAISE(ABORT, 'analytics curve evidence is append-only');
END;

CREATE TRIGGER analytics_curve_generation_promotion_no_update
BEFORE UPDATE ON analytics_curve_generation_promotion
BEGIN
  SELECT RAISE(ABORT, 'analytics curve promotion is append-only');
END;

CREATE TRIGGER analytics_curve_generation_promotion_no_delete
BEFORE DELETE ON analytics_curve_generation_promotion
BEGIN
  SELECT RAISE(ABORT, 'analytics curve promotion is append-only');
END;

CREATE TRIGGER analytics_curve_current_no_delete
BEFORE DELETE ON analytics_curve_current
BEGIN
  SELECT RAISE(ABORT, 'analytics curve current selection cannot be deleted');
END;

CREATE TRIGGER analytics_curve_current_insert_clears_failure
AFTER INSERT ON analytics_curve_current
BEGIN
  DELETE FROM analytics_curve_refresh_failure;
END;

CREATE TRIGGER analytics_curve_current_update_clears_failure
AFTER UPDATE OF generation_id ON analytics_curve_current
BEGIN
  DELETE FROM analytics_curve_refresh_failure;
END;
