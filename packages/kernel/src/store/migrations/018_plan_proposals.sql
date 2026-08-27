CREATE TABLE plan_proposal (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 26
      AND id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    ),
  plan_id TEXT NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
  parent_proposal_id TEXT REFERENCES plan_proposal(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('proposed','applied','rejected','superseded','refused')),
  title TEXT NOT NULL CHECK (length(title) > 0),
  rationale TEXT NOT NULL CHECK (length(rationale) > 0),
  confidence TEXT NOT NULL CHECK (confidence IN ('Low','Moderate','High')),
  mutation_json TEXT NOT NULL CHECK (json_valid(mutation_json)),
  base_snapshot_json TEXT NOT NULL CHECK (json_valid(base_snapshot_json)),
  refusal_reason TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  resolved_at_ms INTEGER CHECK (resolved_at_ms IS NULL OR resolved_at_ms >= created_at_ms),
  device_id TEXT NOT NULL
    CHECK (
      length(device_id) BETWEEN 1 AND 128
      AND substr(device_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND device_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  hlc_physical_ms INTEGER NOT NULL CHECK (hlc_physical_ms >= 0),
  hlc_counter INTEGER NOT NULL CHECK (hlc_counter >= 0),
  CHECK (
    (status = 'proposed' AND resolved_at_ms IS NULL AND refusal_reason IS NULL)
    OR (status IN ('applied','rejected','superseded') AND resolved_at_ms IS NOT NULL AND refusal_reason IS NULL)
    OR (status = 'refused' AND resolved_at_ms IS NOT NULL AND refusal_reason IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_plan_proposal_plan_status
  ON plan_proposal (plan_id, status, created_at_ms DESC, id DESC);

CREATE TABLE plan_proposal_premise (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 26
      AND id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    ),
  proposal_id TEXT NOT NULL REFERENCES plan_proposal(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (length(source_type) > 0),
  source_id TEXT NOT NULL CHECK (length(source_id) > 0),
  source_label TEXT NOT NULL CHECK (length(source_label) > 0),
  source_date_key INTEGER
    CHECK (
      source_date_key IS NULL
      OR (
        source_date_key BETWEEN 10101 AND 99991231
        AND ((source_date_key / 100) % 100) BETWEEN 1 AND 12
        AND (source_date_key % 100) BETWEEN 1 AND CASE
          WHEN ((source_date_key / 100) % 100) IN (1,3,5,7,8,10,12) THEN 31
          WHEN ((source_date_key / 100) % 100) IN (4,6,9,11) THEN 30
          WHEN ((source_date_key / 10000) % 4) = 0
            AND (
              ((source_date_key / 10000) % 100) <> 0
              OR ((source_date_key / 10000) % 400) = 0
            ) THEN 29
          ELSE 28
        END
      )
    ),
  confidence TEXT NOT NULL CHECK (confidence IN ('Low','Moderate','High')),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  device_id TEXT NOT NULL
    CHECK (
      length(device_id) BETWEEN 1 AND 128
      AND substr(device_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND device_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  hlc_physical_ms INTEGER NOT NULL CHECK (hlc_physical_ms >= 0),
  hlc_counter INTEGER NOT NULL CHECK (hlc_counter >= 0),
  UNIQUE (proposal_id, source_type, source_id)
) STRICT;

CREATE INDEX idx_plan_proposal_premise_proposal
  ON plan_proposal_premise (proposal_id, source_type, source_id);
