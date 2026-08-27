CREATE TABLE plan_weekly_review (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 26
      AND id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    ),
  plan_id TEXT NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
  week_start_date_key INTEGER NOT NULL,
  week_end_date_key INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','delivered')),
  last_attempt_sync_at_ms INTEGER NOT NULL CHECK (last_attempt_sync_at_ms >= 0),
  summary_json TEXT CHECK (summary_json IS NULL OR json_valid(summary_json)),
  delivered_at_ms INTEGER CHECK (delivered_at_ms IS NULL OR delivered_at_ms >= 0),
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
  UNIQUE (plan_id, week_start_date_key),
  CHECK (week_end_date_key >= week_start_date_key),
  CHECK (
    (status = 'pending' AND summary_json IS NULL AND delivered_at_ms IS NULL)
    OR (status = 'delivered' AND summary_json IS NOT NULL AND delivered_at_ms IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_plan_weekly_review_latest
  ON plan_weekly_review (plan_id, week_start_date_key DESC, id);
