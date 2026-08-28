CREATE TABLE plan_intake (
  conversation_id TEXT PRIMARY KEY REFERENCES plan_conversation(id) ON DELETE CASCADE,
  event_name TEXT
    CHECK (event_name IS NULL OR (length(event_name) BETWEEN 1 AND 200 AND event_name = trim(event_name))),
  event_priority TEXT
    CHECK (event_priority IS NULL OR event_priority IN ('A','B','C')),
  event_date_key INTEGER
    CHECK (event_date_key IS NULL OR event_date_key BETWEEN 10101 AND 99991231),
  athlete_goal TEXT
    CHECK (athlete_goal IS NULL OR (length(athlete_goal) BETWEEN 1 AND 1000 AND athlete_goal = trim(athlete_goal))),
  availability_sessions_per_week INTEGER
    CHECK (availability_sessions_per_week IS NULL OR availability_sessions_per_week BETWEEN 1 AND 6),
  availability_weekdays_mask INTEGER NOT NULL
    CHECK (availability_weekdays_mask BETWEEN 0 AND 127),
  experience TEXT
    CHECK (experience IS NULL OR experience IN ('beginner','intermediate','advanced','elite')),
  current_training_summary TEXT
    CHECK (
      current_training_summary IS NULL
      OR (
        length(current_training_summary) BETWEEN 1 AND 2000
        AND current_training_summary = trim(current_training_summary)
      )
    ),
  source_turn_sequence INTEGER NOT NULL DEFAULT 0 CHECK (source_turn_sequence >= 0),
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

CREATE TABLE plan_draft_build_checkpoint (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 26
      AND id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    ),
  conversation_id TEXT NOT NULL UNIQUE REFERENCES plan_conversation(id) ON DELETE CASCADE,
  build_key TEXT NOT NULL CHECK (length(build_key) BETWEEN 1 AND 16384),
  operation TEXT NOT NULL CHECK (operation IN ('form','revise','course','start-date')),
  plan_id TEXT NOT NULL
    CHECK (
      length(plan_id) = 26
      AND plan_id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    ),
  draft_revision_id TEXT NOT NULL
    CHECK (
      length(draft_revision_id) = 26
      AND draft_revision_id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    ),
  target_revision INTEGER NOT NULL CHECK (target_revision > 0),
  completed_weeks INTEGER NOT NULL CHECK (completed_weeks >= 0),
  total_weeks INTEGER NOT NULL CHECK (total_weeks > 0 AND completed_weeks <= total_weeks),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
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

ALTER TABLE plan_conversation
  ADD COLUMN course_failure_json TEXT
  CHECK (course_failure_json IS NULL OR json_valid(course_failure_json));
