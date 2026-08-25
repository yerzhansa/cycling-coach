CREATE TABLE plan_conversation (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 26
      AND id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    ),
  plan_id TEXT REFERENCES plan(id) ON DELETE SET NULL,
  replaces_plan_id TEXT REFERENCES plan(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('open','ended')),
  ended_at_ms INTEGER CHECK (ended_at_ms IS NULL OR ended_at_ms >= 0),
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
  CHECK (plan_id IS NULL OR plan_id <> replaces_plan_id),
  CHECK (
    (status = 'open' AND ended_at_ms IS NULL)
    OR (status = 'ended' AND ended_at_ms IS NOT NULL AND ended_at_ms <= updated_at_ms)
  )
) STRICT;

CREATE UNIQUE INDEX idx_plan_conversation_plan
  ON plan_conversation (plan_id)
  WHERE plan_id IS NOT NULL;

CREATE INDEX idx_plan_conversation_replacement
  ON plan_conversation (replaces_plan_id, created_at_ms, id)
  WHERE replaces_plan_id IS NOT NULL;

CREATE TABLE plan_conversation_turn (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 26
      AND id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    ),
  conversation_id TEXT NOT NULL REFERENCES plan_conversation(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  athlete_text TEXT NOT NULL CHECK (length(athlete_text) > 0),
  coach_text TEXT NOT NULL CHECK (length(coach_text) > 0),
  lineage_json TEXT NOT NULL CHECK (json_valid(lineage_json)),
  completed_at_ms INTEGER NOT NULL CHECK (completed_at_ms >= 0),
  device_id TEXT NOT NULL
    CHECK (
      length(device_id) BETWEEN 1 AND 128
      AND substr(device_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND device_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  hlc_physical_ms INTEGER NOT NULL CHECK (hlc_physical_ms >= 0),
  hlc_counter INTEGER NOT NULL CHECK (hlc_counter >= 0),
  UNIQUE (conversation_id, sequence)
) STRICT;

CREATE INDEX idx_plan_conversation_turn_order
  ON plan_conversation_turn (conversation_id, sequence, id);

CREATE TABLE plan_draft_revision (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 26
      AND id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    ),
  conversation_id TEXT NOT NULL REFERENCES plan_conversation(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  parent_revision_id TEXT,
  parent_revision INTEGER,
  status TEXT NOT NULL CHECK (status IN ('forming','ready','failed','discarded','approved')),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
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
  UNIQUE (plan_id, revision),
  UNIQUE (id, conversation_id, plan_id, revision),
  UNIQUE (parent_revision_id),
  FOREIGN KEY (parent_revision_id, conversation_id, plan_id, parent_revision)
    REFERENCES plan_draft_revision(id, conversation_id, plan_id, revision)
    ON DELETE CASCADE,
  CHECK (
    (revision = 1 AND parent_revision_id IS NULL AND parent_revision IS NULL)
    OR (revision > 1 AND parent_revision_id IS NOT NULL AND parent_revision = revision - 1)
  )
) STRICT;

CREATE INDEX idx_plan_draft_revision_conversation
  ON plan_draft_revision (conversation_id, revision, id);

CREATE TABLE plan_source_request (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 26
      AND id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    ),
  conversation_id TEXT NOT NULL REFERENCES plan_conversation(id) ON DELETE CASCADE,
  source_chat_id TEXT NOT NULL CHECK (length(source_chat_id) > 0),
  source_boundary_ref TEXT CHECK (source_boundary_ref IS NULL OR length(source_boundary_ref) > 0),
  source_message_id TEXT NOT NULL CHECK (length(source_message_id) > 0),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
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

CREATE INDEX idx_plan_source_request_conversation
  ON plan_source_request (conversation_id, created_at_ms, id);
