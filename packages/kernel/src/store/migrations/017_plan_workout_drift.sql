CREATE TABLE plan_workout_drift (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 26
      AND id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    ),
  plan_id TEXT NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
  plan_workout_id TEXT NOT NULL REFERENCES plan_workout(id) ON DELETE CASCADE,
  provider_event_id INTEGER NOT NULL CHECK (provider_event_id > 0),
  provider_revision TEXT NOT NULL CHECK (length(provider_revision) > 0),
  status TEXT NOT NULL CHECK (status IN ('detected','adopted','restored')),
  plan_snapshot_json TEXT NOT NULL CHECK (json_valid(plan_snapshot_json)),
  provider_snapshot_json TEXT NOT NULL CHECK (json_valid(provider_snapshot_json)),
  detected_at_ms INTEGER NOT NULL CHECK (detected_at_ms >= 0),
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= detected_at_ms),
  resolved_at_ms INTEGER CHECK (resolved_at_ms IS NULL OR resolved_at_ms >= detected_at_ms),
  device_id TEXT NOT NULL
    CHECK (
      length(device_id) BETWEEN 1 AND 128
      AND substr(device_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND device_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  hlc_physical_ms INTEGER NOT NULL CHECK (hlc_physical_ms >= 0),
  hlc_counter INTEGER NOT NULL CHECK (hlc_counter >= 0),
  CHECK (
    (status = 'detected' AND resolved_at_ms IS NULL)
    OR (status <> 'detected' AND resolved_at_ms IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX idx_plan_workout_drift_open
  ON plan_workout_drift (plan_workout_id)
  WHERE status = 'detected';

CREATE INDEX idx_plan_workout_drift_plan_status
  ON plan_workout_drift (plan_id, status, detected_at_ms, id);
