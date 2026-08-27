CREATE TABLE plan (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 26
      AND id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    ),
  origin_id TEXT,
  name TEXT NOT NULL,
  primary_goal TEXT NOT NULL,
  start_date_key INTEGER NOT NULL,
  target_date_key INTEGER,
  status TEXT NOT NULL CHECK (status IN ('draft','active','ended')),
  kind TEXT NOT NULL CHECK (kind IN ('full_plan','short_race_preparation')),
  total_weeks INTEGER NOT NULL CHECK (total_weeks > 0),
  week_start_day INTEGER NOT NULL CHECK (week_start_day BETWEEN 0 AND 6),
  structure_json TEXT NOT NULL CHECK (json_valid(structure_json)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  device_id TEXT NOT NULL
    CHECK (
      length(device_id) BETWEEN 1 AND 128
      AND substr(device_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND device_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  hlc_physical_ms INTEGER NOT NULL CHECK (hlc_physical_ms >= 0),
  hlc_counter INTEGER NOT NULL CHECK (hlc_counter >= 0)
) STRICT;

CREATE UNIQUE INDEX idx_plan_origin_id
  ON plan (origin_id)
  WHERE origin_id IS NOT NULL;

CREATE TABLE plan_workout (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 26
      AND id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    ),
  plan_id TEXT NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
  date_key INTEGER NOT NULL,
  sport TEXT NOT NULL,
  name TEXT NOT NULL,
  duration_s INTEGER CHECK (duration_s IS NULL OR duration_s > 0),
  structure_json TEXT NOT NULL CHECK (json_valid(structure_json)),
  origin TEXT NOT NULL CHECK (origin IN ('coach','athlete')),
  device_id TEXT NOT NULL
    CHECK (
      length(device_id) BETWEEN 1 AND 128
      AND substr(device_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND device_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  hlc_physical_ms INTEGER NOT NULL CHECK (hlc_physical_ms >= 0),
  hlc_counter INTEGER NOT NULL CHECK (hlc_counter >= 0)
) STRICT;

CREATE INDEX idx_plan_workout_plan_date
  ON plan_workout (plan_id, date_key);
