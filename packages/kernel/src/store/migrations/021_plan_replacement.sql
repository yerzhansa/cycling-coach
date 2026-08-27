CREATE TABLE plan_replacement (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 26
      AND id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    ),
  previous_plan_id TEXT NOT NULL UNIQUE REFERENCES plan(id) ON DELETE RESTRICT,
  replacement_plan_id TEXT NOT NULL UNIQUE REFERENCES plan(id) ON DELETE RESTRICT,
  draft_revision_id TEXT NOT NULL UNIQUE REFERENCES plan_draft_revision(id) ON DELETE RESTRICT,
  cleanup_job_id TEXT NOT NULL UNIQUE REFERENCES plan_reconciliation_job(id) ON DELETE RESTRICT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  device_id TEXT NOT NULL
    CHECK (
      length(device_id) BETWEEN 1 AND 128
      AND substr(device_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND device_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  hlc_physical_ms INTEGER NOT NULL CHECK (hlc_physical_ms >= 0),
  hlc_counter INTEGER NOT NULL CHECK (hlc_counter >= 0),
  CHECK (previous_plan_id <> replacement_plan_id)
) STRICT;

CREATE INDEX idx_plan_replacement_previous
  ON plan_replacement (previous_plan_id, created_at_ms DESC, id DESC);
