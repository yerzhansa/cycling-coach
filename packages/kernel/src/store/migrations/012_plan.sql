-- INV-1 class: authored Plan aggregate root. PK = ULID.
CREATE TABLE plan (
  id                TEXT PRIMARY KEY CHECK (
    length(id) = 26 AND id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  ),
  origin_id         TEXT,
  name              TEXT NOT NULL,
  primary_goal      TEXT NOT NULL,
  start_date_key    INTEGER NOT NULL CHECK (start_date_key BETWEEN 10000101 AND 99991231),
  target_date_key   INTEGER CHECK (target_date_key BETWEEN 10000101 AND 99991231),
  status            TEXT NOT NULL CHECK (status IN ('draft','active','ended')),
  kind              TEXT NOT NULL CHECK (kind IN ('full_plan','short_race_preparation')),
  total_weeks       INTEGER NOT NULL CHECK (total_weeks > 0),
  week_start_day    INTEGER NOT NULL CHECK (week_start_day BETWEEN 0 AND 6),
  structure_json    TEXT NOT NULL CHECK (json_valid(structure_json)),
  created_at_ms     INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms     INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  device_id         TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 128),
  hlc_physical_ms   INTEGER NOT NULL CHECK (hlc_physical_ms >= 0),
  hlc_counter       INTEGER NOT NULL CHECK (hlc_counter >= 0)
) STRICT, WITHOUT ROWID;

CREATE UNIQUE INDEX idx_plan_origin_id
  ON plan (origin_id)
  WHERE origin_id IS NOT NULL;

-- INV-1 class: authored Workout belonging to a Plan. PK = ULID.
CREATE TABLE plan_workout (
  id                TEXT PRIMARY KEY CHECK (
    length(id) = 26 AND id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  ),
  plan_id           TEXT NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
  date_key          INTEGER NOT NULL CHECK (date_key BETWEEN 10000101 AND 99991231),
  sport             TEXT NOT NULL CHECK (length(sport) > 0),
  name              TEXT NOT NULL CHECK (length(name) > 0),
  duration_s        INTEGER CHECK (duration_s >= 0),
  structure_json    TEXT NOT NULL CHECK (json_valid(structure_json)),
  origin            TEXT NOT NULL CHECK (origin IN ('coach','athlete')),
  device_id         TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 128),
  hlc_physical_ms   INTEGER NOT NULL CHECK (hlc_physical_ms >= 0),
  hlc_counter       INTEGER NOT NULL CHECK (hlc_counter >= 0)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_plan_workout_plan_date ON plan_workout (plan_id, date_key);
