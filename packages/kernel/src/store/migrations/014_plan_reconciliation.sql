CREATE TABLE plan_reconciliation_job (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 26
      AND id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    ),
  plan_id TEXT NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('mirror','cleanup')),
  status TEXT NOT NULL CHECK (status IN ('pending','running','retrying','failed','verified')),
  window_start_date_key INTEGER NOT NULL,
  window_end_date_key INTEGER NOT NULL CHECK (window_end_date_key >= window_start_date_key),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  resumed_count INTEGER NOT NULL DEFAULT 0 CHECK (resumed_count >= 0),
  last_resumed_attempt INTEGER CHECK (
    last_resumed_attempt IS NULL
    OR (last_resumed_attempt > 0 AND last_resumed_attempt <= attempt_count)
  ),
  last_error_code TEXT CHECK (
    last_error_code IS NULL
    OR last_error_code IN (
      'calendar-list-failed',
      'calendar-create-failed',
      'calendar-delete-failed',
      'calendar-verification-failed'
    )
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= created_at_ms),
  CHECK (resumed_count <= attempt_count),
  CHECK (
    (status = 'failed' AND last_error_code IS NOT NULL AND completed_at_ms IS NULL)
    OR (status = 'verified' AND last_error_code IS NULL AND completed_at_ms IS NOT NULL)
    OR (status IN ('pending','running','retrying') AND last_error_code IS NULL AND completed_at_ms IS NULL)
  ),
  UNIQUE (plan_id, kind, window_start_date_key, window_end_date_key)
) STRICT;

CREATE INDEX idx_plan_reconciliation_job_plan_status
  ON plan_reconciliation_job (plan_id, status, updated_at_ms DESC, id);

CREATE TABLE plan_reconciliation_item (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 26
      AND id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    ),
  job_id TEXT NOT NULL REFERENCES plan_reconciliation_job(id) ON DELETE CASCADE,
  plan_workout_id TEXT REFERENCES plan_workout(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('create','delete')),
  status TEXT NOT NULL CHECK (status IN ('pending','running','created','failed','verified')),
  date_key INTEGER NOT NULL,
  external_id TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 256),
  provider_event_id INTEGER CHECK (provider_event_id IS NULL OR provider_event_id > 0),
  expected_json TEXT NOT NULL CHECK (json_valid(expected_json)),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT CHECK (
    last_error_code IS NULL
    OR last_error_code IN (
      'calendar-create-failed',
      'calendar-delete-failed',
      'calendar-verification-failed'
    )
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= created_at_ms),
  CHECK (
    (operation = 'create' AND plan_workout_id IS NOT NULL)
    OR (operation = 'delete' AND plan_workout_id IS NULL)
  ),
  CHECK (status <> 'created' OR operation = 'create'),
  CHECK (
    (operation = 'create' AND status = 'verified' AND provider_event_id IS NOT NULL)
    OR (operation = 'create' AND status <> 'verified' AND provider_event_id IS NULL)
    OR (operation = 'delete' AND provider_event_id IS NULL)
  ),
  CHECK (
    (status = 'failed' AND last_error_code IS NOT NULL AND completed_at_ms IS NULL)
    OR (status = 'verified' AND last_error_code IS NULL AND completed_at_ms IS NOT NULL)
    OR (status IN ('pending','running','created') AND last_error_code IS NULL AND completed_at_ms IS NULL)
  ),
  UNIQUE (job_id, operation, external_id)
) STRICT;

CREATE INDEX idx_plan_reconciliation_item_job_status
  ON plan_reconciliation_item (job_id, status, date_key, id);
