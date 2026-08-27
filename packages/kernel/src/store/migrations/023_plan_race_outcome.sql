CREATE TABLE plan_race_outcome (
  plan_id TEXT PRIMARY KEY REFERENCES plan(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('completed','not-completed')),
  recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= recorded_at_ms),
  device_id TEXT NOT NULL
    CHECK (
      length(device_id) BETWEEN 1 AND 128
      AND substr(device_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND device_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  hlc_physical_ms INTEGER NOT NULL CHECK (hlc_physical_ms >= 0),
  hlc_counter INTEGER NOT NULL CHECK (hlc_counter >= 0)
) STRICT;
