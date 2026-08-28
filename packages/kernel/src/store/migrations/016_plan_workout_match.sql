CREATE TABLE plan_workout_match (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 26
      AND id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    ),
  plan_id TEXT NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
  plan_workout_id TEXT NOT NULL REFERENCES plan_workout(id) ON DELETE CASCADE,
  activity_id TEXT NOT NULL
    CHECK (
      length(activity_id) = 64
      AND activity_id = lower(activity_id)
      AND activity_id NOT GLOB '*[^0-9a-f]*'
    ),
  provider_activity_id TEXT CHECK (
    provider_activity_id IS NULL OR length(provider_activity_id) BETWEEN 1 AND 128
  ),
  provider_event_id INTEGER CHECK (provider_event_id IS NULL OR provider_event_id > 0),
  source TEXT NOT NULL CHECK (source IN ('platform','heuristic')),
  decision TEXT NOT NULL CHECK (decision IN ('suggested','confirmed','rejected','unpaired')),
  activity_date_key INTEGER NOT NULL,
  activity_sport TEXT NOT NULL CHECK (length(activity_sport) > 0),
  activity_duration_s INTEGER CHECK (activity_duration_s IS NULL OR activity_duration_s > 0),
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
  decided_at_ms INTEGER CHECK (decided_at_ms IS NULL OR decided_at_ms >= observed_at_ms),
  device_id TEXT NOT NULL
    CHECK (
      length(device_id) BETWEEN 1 AND 128
      AND substr(device_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND device_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  hlc_physical_ms INTEGER NOT NULL CHECK (hlc_physical_ms >= 0),
  hlc_counter INTEGER NOT NULL CHECK (hlc_counter >= 0),
  CHECK (
    (source = 'platform' AND provider_activity_id IS NOT NULL AND provider_event_id IS NOT NULL)
    OR (source = 'heuristic' AND provider_event_id IS NULL)
  ),
  CHECK (decision <> 'suggested' OR source = 'heuristic'),
  CHECK (decision <> 'unpaired' OR source = 'platform'),
  CHECK (
    (decision = 'suggested' AND decided_at_ms IS NULL)
    OR (decision <> 'suggested' AND decided_at_ms IS NOT NULL)
  ),
  UNIQUE (plan_workout_id, activity_id)
) STRICT;

CREATE INDEX idx_plan_workout_match_plan_decision
  ON plan_workout_match (plan_id, decision, activity_date_key, id);
