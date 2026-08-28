ALTER TABLE plan_adaptation_ledger RENAME TO plan_adaptation_ledger_v26;

CREATE TABLE plan_adaptation_ledger (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 26
      AND id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    ),
  plan_id TEXT NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
  target_workout_id TEXT NOT NULL
    CHECK (
      length(target_workout_id) = 26
      AND target_workout_id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    ),
  operation TEXT NOT NULL CHECK (operation IN ('update','add','remove')),
  kind TEXT NOT NULL CHECK (kind IN ('proposal-applied','drift-adopted','undo')),
  source_id TEXT NOT NULL CHECK (length(source_id) > 0),
  reversal_of_id TEXT REFERENCES plan_adaptation_ledger(id) ON DELETE RESTRICT,
  label TEXT NOT NULL CHECK (length(label) > 0),
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  week_load_before REAL CHECK (week_load_before IS NULL OR week_load_before >= 0),
  week_load_after REAL CHECK (week_load_after IS NULL OR week_load_after >= 0),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  device_id TEXT NOT NULL
    CHECK (
      length(device_id) BETWEEN 1 AND 128
      AND substr(device_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND device_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  hlc_physical_ms INTEGER NOT NULL CHECK (hlc_physical_ms >= 0),
  hlc_counter INTEGER NOT NULL CHECK (hlc_counter >= 0),
  CHECK (
    (kind = 'undo' AND reversal_of_id IS NOT NULL)
    OR (kind <> 'undo' AND reversal_of_id IS NULL)
  ),
  CHECK (
    (operation = 'update' AND before_json IS NOT NULL AND after_json IS NOT NULL)
    OR (operation = 'add' AND before_json IS NULL AND after_json IS NOT NULL)
    OR (operation = 'remove' AND before_json IS NOT NULL AND after_json IS NULL)
  ),
  CHECK ((week_load_before IS NULL) = (week_load_after IS NULL)),
  UNIQUE (reversal_of_id)
) STRICT;

INSERT INTO plan_adaptation_ledger (
  id, plan_id, target_workout_id, operation, kind, source_id, reversal_of_id, label,
  before_json, after_json, week_load_before, week_load_after, occurred_at_ms, device_id,
  hlc_physical_ms, hlc_counter
)
SELECT
  id, plan_id, target_workout_id, 'update', kind, source_id, reversal_of_id, label,
  before_json, after_json, week_load_before, week_load_after, occurred_at_ms, device_id,
  hlc_physical_ms, hlc_counter
FROM plan_adaptation_ledger_v26
ORDER BY occurred_at_ms, id;

DROP TABLE plan_adaptation_ledger_v26;

CREATE INDEX idx_plan_adaptation_ledger_plan_time
  ON plan_adaptation_ledger (plan_id, occurred_at_ms DESC, id DESC);
