CREATE TABLE planning_plan (
  plan_id TEXT PRIMARY KEY REFERENCES plan(id) ON DELETE RESTRICT
    CHECK (
      length(plan_id) = 26
      AND plan_id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    ),
  status TEXT NOT NULL CHECK (status IN ('active','closed')),
  version INTEGER NOT NULL CHECK (version > 0),
  current_revision_number INTEGER NOT NULL CHECK (current_revision_number > 0),
  activated_at_ms INTEGER NOT NULL CHECK (activated_at_ms >= 0),
  closed_at_ms INTEGER CHECK (closed_at_ms IS NULL OR closed_at_ms >= activated_at_ms),
  close_reason TEXT CHECK (
    close_reason IS NULL OR close_reason IN ('completed','stopped','legacy-unclassified')
  ),
  close_actor TEXT CHECK (close_actor IS NULL OR length(close_actor) BETWEEN 1 AND 128),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= activated_at_ms),
  device_id TEXT NOT NULL
    CHECK (
      length(device_id) BETWEEN 1 AND 128
      AND substr(device_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND device_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  hlc_physical_ms INTEGER NOT NULL CHECK (hlc_physical_ms >= 0),
  hlc_counter INTEGER NOT NULL CHECK (hlc_counter >= 0),
  CHECK (
    (status = 'active'
      AND closed_at_ms IS NULL
      AND close_reason IS NULL
      AND close_actor IS NULL)
    OR
    (status = 'closed'
      AND closed_at_ms IS NOT NULL
      AND close_reason IS NOT NULL
      AND closed_at_ms <= updated_at_ms
      AND (
        (close_reason = 'legacy-unclassified' AND close_actor IS NULL)
        OR (close_reason = 'completed' AND close_actor = 'system:plan-completion')
        OR (close_reason = 'stopped' AND close_actor IS NOT NULL)
      ))
  )
) STRICT;

CREATE UNIQUE INDEX idx_planning_plan_one_active
  ON planning_plan (status)
  WHERE status = 'active';

CREATE TABLE plan_revision (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 26
      AND id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    ),
  plan_id TEXT NOT NULL REFERENCES planning_plan(plan_id) ON DELETE RESTRICT,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  parent_revision_number INTEGER CHECK (parent_revision_number IS NULL OR parent_revision_number > 0),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('activation','plan-change','migration')),
  source_id TEXT CHECK (source_id IS NULL OR length(source_id) BETWEEN 1 AND 512),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  fingerprint TEXT NOT NULL
    CHECK (
      length(fingerprint) = 64
      AND fingerprint = lower(fingerprint)
      AND fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  device_id TEXT NOT NULL
    CHECK (
      length(device_id) BETWEEN 1 AND 128
      AND substr(device_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND device_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  hlc_physical_ms INTEGER NOT NULL CHECK (hlc_physical_ms >= 0),
  hlc_counter INTEGER NOT NULL CHECK (hlc_counter >= 0),
  UNIQUE (plan_id, revision_number),
  FOREIGN KEY (plan_id, parent_revision_number)
    REFERENCES plan_revision(plan_id, revision_number)
    ON DELETE RESTRICT,
  CHECK (
    (revision_number = 1 AND parent_revision_number IS NULL)
    OR (
      revision_number > 1
      AND parent_revision_number IS NOT NULL
      AND parent_revision_number = revision_number - 1
    )
  ),
  CHECK (
    (source_kind = 'migration' AND revision_number = 1)
    OR (
      source_kind = 'activation'
      AND revision_number = 1
      AND source_id IS NOT NULL
      AND length(source_id) = 26
      AND source_id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    )
    OR (
      source_kind = 'plan-change'
      AND revision_number > 1
      AND source_id IS NOT NULL
      AND length(source_id) = 26
      AND source_id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    )
  )
) STRICT;

CREATE INDEX idx_plan_revision_plan
  ON plan_revision (plan_id, revision_number, id);

CREATE TABLE plan_creation (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 26
      AND id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    ),
  status TEXT NOT NULL CHECK (status IN ('in-progress','review','activated','discarded')),
  version INTEGER NOT NULL CHECK (version > 0),
  seed_json TEXT CHECK (seed_json IS NULL OR json_valid(seed_json)),
  current_draft_revision_number INTEGER
    CHECK (current_draft_revision_number IS NULL OR current_draft_revision_number > 0),
  activated_plan_id TEXT REFERENCES planning_plan(plan_id) ON DELETE RESTRICT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  terminal_at_ms INTEGER CHECK (
    terminal_at_ms IS NULL OR (terminal_at_ms >= created_at_ms AND terminal_at_ms <= updated_at_ms)
  ),
  device_id TEXT NOT NULL
    CHECK (
      length(device_id) BETWEEN 1 AND 128
      AND substr(device_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND device_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  hlc_physical_ms INTEGER NOT NULL CHECK (hlc_physical_ms >= 0),
  hlc_counter INTEGER NOT NULL CHECK (hlc_counter >= 0),
  CHECK (
    (status = 'in-progress'
      AND current_draft_revision_number IS NULL
      AND activated_plan_id IS NULL
      AND terminal_at_ms IS NULL)
    OR
    (status = 'review'
      AND current_draft_revision_number IS NOT NULL
      AND activated_plan_id IS NULL
      AND terminal_at_ms IS NULL)
    OR
    (status = 'activated'
      AND current_draft_revision_number IS NOT NULL
      AND activated_plan_id IS NOT NULL
      AND terminal_at_ms IS NOT NULL)
    OR
    (status = 'discarded'
      AND activated_plan_id IS NULL
      AND terminal_at_ms IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX idx_plan_creation_one_unfinished
  ON plan_creation ((1))
  WHERE status IN ('in-progress','review');

CREATE TABLE plan_creation_answer (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 26
      AND id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    ),
  creation_id TEXT NOT NULL REFERENCES plan_creation(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  creation_version INTEGER NOT NULL CHECK (creation_version > 1),
  answer_key TEXT NOT NULL CHECK (length(answer_key) BETWEEN 1 AND 128),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  scope TEXT NOT NULL CHECK (scope IN ('plan-creation','athlete-preference')),
  preference_id TEXT
    CHECK (
      preference_id IS NULL
      OR (
        length(preference_id) = 26
        AND preference_id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
      )
    ),
  confirmed_at_ms INTEGER NOT NULL CHECK (confirmed_at_ms >= 0),
  device_id TEXT NOT NULL
    CHECK (
      length(device_id) BETWEEN 1 AND 128
      AND substr(device_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND device_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  hlc_physical_ms INTEGER NOT NULL CHECK (hlc_physical_ms >= 0),
  hlc_counter INTEGER NOT NULL CHECK (hlc_counter >= 0),
  UNIQUE (creation_id, sequence),
  UNIQUE (creation_id, creation_version),
  CHECK (
    (scope = 'plan-creation' AND preference_id IS NULL)
    OR (scope = 'athlete-preference' AND preference_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_plan_creation_answer_creation
  ON plan_creation_answer (creation_id, sequence, id);

CREATE TABLE plan_creation_draft_revision (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 26
      AND id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    ),
  creation_id TEXT NOT NULL REFERENCES plan_creation(id) ON DELETE RESTRICT,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  parent_revision_number INTEGER CHECK (parent_revision_number IS NULL OR parent_revision_number > 0),
  input_version INTEGER NOT NULL CHECK (input_version > 0),
  input_snapshot_json TEXT NOT NULL CHECK (json_valid(input_snapshot_json)),
  input_fingerprint TEXT NOT NULL
    CHECK (
      length(input_fingerprint) = 64
      AND input_fingerprint = lower(input_fingerprint)
      AND input_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
  builder_id TEXT NOT NULL CHECK (length(builder_id) BETWEEN 1 AND 128),
  builder_version TEXT NOT NULL CHECK (length(builder_version) BETWEEN 1 AND 128),
  output_snapshot_json TEXT NOT NULL CHECK (json_valid(output_snapshot_json)),
  activation_fingerprint TEXT NOT NULL
    CHECK (
      length(activation_fingerprint) = 64
      AND activation_fingerprint = lower(activation_fingerprint)
      AND activation_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  device_id TEXT NOT NULL
    CHECK (
      length(device_id) BETWEEN 1 AND 128
      AND substr(device_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND device_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  hlc_physical_ms INTEGER NOT NULL CHECK (hlc_physical_ms >= 0),
  hlc_counter INTEGER NOT NULL CHECK (hlc_counter >= 0),
  UNIQUE (creation_id, revision_number),
  FOREIGN KEY (creation_id, parent_revision_number)
    REFERENCES plan_creation_draft_revision(creation_id, revision_number)
    ON DELETE RESTRICT,
  CHECK (
    (revision_number = 1 AND parent_revision_number IS NULL)
    OR (
      revision_number > 1
      AND parent_revision_number IS NOT NULL
      AND parent_revision_number = revision_number - 1
    )
  )
) STRICT;

CREATE INDEX idx_plan_creation_draft_revision_creation
  ON plan_creation_draft_revision (creation_id, revision_number, id);

CREATE TABLE athlete_preference (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 26
      AND id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    ),
  preference_key TEXT NOT NULL CHECK (length(preference_key) BETWEEN 1 AND 128),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  status TEXT NOT NULL CHECK (status IN ('active','removed')),
  version INTEGER NOT NULL CHECK (version > 0),
  source_answer_id TEXT REFERENCES plan_creation_answer(id) ON DELETE RESTRICT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  removed_at_ms INTEGER CHECK (
    removed_at_ms IS NULL OR (removed_at_ms >= created_at_ms AND removed_at_ms <= updated_at_ms)
  ),
  device_id TEXT NOT NULL
    CHECK (
      length(device_id) BETWEEN 1 AND 128
      AND substr(device_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND device_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  hlc_physical_ms INTEGER NOT NULL CHECK (hlc_physical_ms >= 0),
  hlc_counter INTEGER NOT NULL CHECK (hlc_counter >= 0),
  CHECK (
    (status = 'active' AND removed_at_ms IS NULL)
    OR (status = 'removed' AND removed_at_ms IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_athlete_preference_key
  ON athlete_preference (preference_key, status, updated_at_ms DESC, id DESC);

CREATE UNIQUE INDEX idx_athlete_preference_one_active_key
  ON athlete_preference (preference_key)
  WHERE status = 'active';

CREATE TABLE training_restriction (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 26
      AND id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    ),
  kind TEXT NOT NULL CHECK (kind IN ('no-training','no-hard-training','maximum-duration')),
  status TEXT NOT NULL CHECK (status IN ('active','ended')),
  version INTEGER NOT NULL CHECK (version > 0),
  start_date_key INTEGER NOT NULL
    CHECK (
      start_date_key BETWEEN 10101 AND 99991231
      AND ((start_date_key / 100) % 100) BETWEEN 1 AND 12
      AND (start_date_key % 100) BETWEEN 1 AND CASE
        WHEN ((start_date_key / 100) % 100) IN (1,3,5,7,8,10,12) THEN 31
        WHEN ((start_date_key / 100) % 100) IN (4,6,9,11) THEN 30
        WHEN ((start_date_key / 10000) % 4) = 0
          AND (
            ((start_date_key / 10000) % 100) <> 0
            OR ((start_date_key / 10000) % 400) = 0
          ) THEN 29
        ELSE 28
      END
    ),
  end_date_key INTEGER
    CHECK (
      end_date_key IS NULL
      OR (
        end_date_key BETWEEN 10101 AND 99991231
        AND ((end_date_key / 100) % 100) BETWEEN 1 AND 12
        AND (end_date_key % 100) BETWEEN 1 AND CASE
          WHEN ((end_date_key / 100) % 100) IN (1,3,5,7,8,10,12) THEN 31
          WHEN ((end_date_key / 100) % 100) IN (4,6,9,11) THEN 30
          WHEN ((end_date_key / 10000) % 4) = 0
            AND (
              ((end_date_key / 10000) % 100) <> 0
              OR ((end_date_key / 10000) % 400) = 0
            ) THEN 29
          ELSE 28
        END
      )
    ),
  maximum_duration_minutes INTEGER
    CHECK (maximum_duration_minutes IS NULL OR maximum_duration_minutes > 0),
  confirmed_at_ms INTEGER NOT NULL CHECK (confirmed_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= confirmed_at_ms),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  ended_at_ms INTEGER CHECK (
    ended_at_ms IS NULL OR (ended_at_ms >= created_at_ms AND ended_at_ms <= updated_at_ms)
  ),
  device_id TEXT NOT NULL
    CHECK (
      length(device_id) BETWEEN 1 AND 128
      AND substr(device_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND device_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  hlc_physical_ms INTEGER NOT NULL CHECK (hlc_physical_ms >= 0),
  hlc_counter INTEGER NOT NULL CHECK (hlc_counter >= 0),
  CHECK (end_date_key IS NULL OR end_date_key >= start_date_key),
  CHECK (
    (kind = 'maximum-duration' AND maximum_duration_minutes IS NOT NULL)
    OR (kind IN ('no-training','no-hard-training') AND maximum_duration_minutes IS NULL)
  ),
  CHECK (
    (status = 'active' AND ended_at_ms IS NULL)
    OR (status = 'ended' AND end_date_key IS NOT NULL AND ended_at_ms IS NOT NULL)
  )
) STRICT;

CREATE INDEX idx_training_restriction_effective
  ON training_restriction (status, start_date_key, end_date_key, id);

CREATE TABLE plan_change (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 26
      AND id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    ),
  plan_id TEXT NOT NULL REFERENCES planning_plan(plan_id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('preview','applied','stale','discarded')),
  version INTEGER NOT NULL CHECK (version > 0),
  base_revision_number INTEGER NOT NULL CHECK (base_revision_number > 0),
  result_revision_number INTEGER CHECK (result_revision_number IS NULL OR result_revision_number > 0),
  diff_json TEXT NOT NULL CHECK (json_valid(diff_json)),
  rationale TEXT NOT NULL CHECK (length(rationale) BETWEEN 1 AND 20000),
  premises_json TEXT NOT NULL CHECK (json_valid(premises_json)),
  preview_fingerprint TEXT NOT NULL
    CHECK (
      length(preview_fingerprint) = 64
      AND preview_fingerprint = lower(preview_fingerprint)
      AND preview_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
  reconciliation_effect_json TEXT NOT NULL CHECK (json_valid(reconciliation_effect_json)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  terminal_at_ms INTEGER CHECK (
    terminal_at_ms IS NULL OR (terminal_at_ms >= created_at_ms AND terminal_at_ms <= updated_at_ms)
  ),
  device_id TEXT NOT NULL
    CHECK (
      length(device_id) BETWEEN 1 AND 128
      AND substr(device_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND device_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  hlc_physical_ms INTEGER NOT NULL CHECK (hlc_physical_ms >= 0),
  hlc_counter INTEGER NOT NULL CHECK (hlc_counter >= 0),
  FOREIGN KEY (plan_id, base_revision_number)
    REFERENCES plan_revision(plan_id, revision_number)
    ON DELETE RESTRICT,
  FOREIGN KEY (plan_id, result_revision_number)
    REFERENCES plan_revision(plan_id, revision_number)
    ON DELETE RESTRICT,
  CHECK (
    (status = 'preview' AND result_revision_number IS NULL AND terminal_at_ms IS NULL)
    OR
    (status = 'applied'
      AND result_revision_number = base_revision_number + 1
      AND terminal_at_ms IS NOT NULL)
    OR
    (status IN ('stale','discarded')
      AND result_revision_number IS NULL
      AND terminal_at_ms IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX idx_plan_change_one_preview
  ON plan_change (plan_id)
  WHERE status = 'preview';

CREATE INDEX idx_plan_change_plan
  ON plan_change (plan_id, created_at_ms, id);

CREATE TABLE planning_command (
  command_name TEXT NOT NULL CHECK (command_name IN (
    'plan_creation.start',
    'plan_creation.answer',
    'plan_creation.preview',
    'plan_creation.activate',
    'plan_creation.discard',
    'plan_change.preview',
    'plan_change.apply',
    'plan.close'
  )),
  command_id TEXT NOT NULL CHECK (length(command_id) BETWEEN 1 AND 512),
  request_digest TEXT NOT NULL
    CHECK (
      length(request_digest) = 64
      AND request_digest = lower(request_digest)
      AND request_digest NOT GLOB '*[^0-9a-f]*'
    ),
  status TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed')),
  aggregate_refs_json TEXT NOT NULL
    CHECK (json_valid(aggregate_refs_json) AND json_type(aggregate_refs_json) = 'object'),
  result_json TEXT CHECK (
    result_json IS NULL OR (json_valid(result_json) AND json_type(result_json) = 'object')
  ),
  error_code TEXT CHECK (
    error_code IS NULL
    OR (
      length(error_code) BETWEEN 1 AND 128
      AND substr(error_code, 1, 1) GLOB '[A-Za-z0-9]'
      AND error_code NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  error_json TEXT CHECK (
    error_json IS NULL
    OR (
      json_valid(error_json)
      AND json_type(error_json) = 'object'
      AND json_type(error_json, '$.code') = 'text'
      AND json_type(error_json, '$.details') IS NOT NULL
      AND json_remove(error_json, '$.code', '$.details') = '{}'
    )
  ),
  version INTEGER NOT NULL CHECK (version > 0),
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
  PRIMARY KEY (command_name, command_id),
  CHECK (
    (status = 'pending'
      AND version = 1
      AND result_json IS NULL
      AND error_code IS NULL
      AND error_json IS NULL)
    OR
    (status = 'succeeded'
      AND version = 2
      AND result_json IS NOT NULL
      AND error_code IS NULL
      AND error_json IS NULL)
    OR
    (status = 'failed'
      AND version = 2
      AND result_json IS NULL
      AND error_code IS NOT NULL
      AND error_json IS NOT NULL
      AND json_extract(error_json, '$.code') = error_code)
  )
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_planning_command_status
  ON planning_command (status, updated_at_ms, command_name, command_id);

CREATE TRIGGER planning_plan_closed_no_update
BEFORE UPDATE ON planning_plan
WHEN OLD.status = 'closed'
BEGIN
  SELECT RAISE(ABORT, 'closed Plan is immutable');
END;

CREATE TRIGGER planning_plan_no_delete
BEFORE DELETE ON planning_plan
BEGIN
  SELECT RAISE(ABORT, 'Plan records are durable');
END;

CREATE TRIGGER planning_plan_revision_requires_preview
BEFORE UPDATE OF current_revision_number ON planning_plan
WHEN NEW.current_revision_number <> OLD.current_revision_number
BEGIN
  SELECT CASE WHEN (
    OLD.status <> 'active'
    OR NEW.status <> 'active'
    OR NEW.version <> OLD.version + 1
    OR NEW.current_revision_number <> OLD.current_revision_number + 1
    OR NOT EXISTS (
      SELECT 1
      FROM plan_revision AS revision
      JOIN plan_change AS pending
        ON pending.id = revision.source_id
        AND pending.plan_id = revision.plan_id
      WHERE revision.plan_id = NEW.plan_id
        AND revision.revision_number = NEW.current_revision_number
        AND revision.source_kind = 'plan-change'
        AND pending.status = 'preview'
        AND pending.base_revision_number = OLD.current_revision_number
        AND revision.created_at_ms >= pending.updated_at_ms
        AND (
          revision.hlc_physical_ms > pending.hlc_physical_ms
          OR (
            revision.hlc_physical_ms = pending.hlc_physical_ms
            AND revision.hlc_counter >= pending.hlc_counter
          )
        )
    )
  ) THEN RAISE(ABORT, 'Plan revision requires its preview Change') END;
END;

CREATE TRIGGER planning_plan_close_transition
BEFORE UPDATE OF status ON planning_plan
WHEN NEW.status <> OLD.status
BEGIN
  SELECT CASE WHEN NOT (
    OLD.status = 'active'
    AND NEW.status = 'closed'
    AND NEW.version = OLD.version + 1
    AND NEW.current_revision_number = OLD.current_revision_number
  ) THEN RAISE(ABORT, 'invalid Plan close transition') END;
END;

CREATE TRIGGER planning_plan_preview_clock
BEFORE UPDATE OF status, current_revision_number ON planning_plan
WHEN (
  NEW.status <> OLD.status
  OR NEW.current_revision_number <> OLD.current_revision_number
) AND EXISTS (
  SELECT 1
  FROM plan_change AS pending
  WHERE pending.plan_id = NEW.plan_id
    AND pending.status = 'preview'
    AND (
      NEW.updated_at_ms < pending.updated_at_ms
      OR (
        NEW.status = 'closed'
        AND NEW.closed_at_ms < pending.updated_at_ms
      )
      OR NEW.hlc_physical_ms < pending.hlc_physical_ms
      OR (
        NEW.hlc_physical_ms = pending.hlc_physical_ms
        AND NEW.hlc_counter < pending.hlc_counter
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'Plan transition clock precedes preview Change');
END;

CREATE TRIGGER planning_plan_revision_applies_preview
AFTER UPDATE OF current_revision_number ON planning_plan
WHEN NEW.current_revision_number <> OLD.current_revision_number
BEGIN
  UPDATE plan_change
  SET status = 'applied',
      version = version + 1,
      result_revision_number = NEW.current_revision_number,
      terminal_at_ms = NEW.updated_at_ms,
      updated_at_ms = NEW.updated_at_ms,
      device_id = NEW.device_id,
      hlc_physical_ms = NEW.hlc_physical_ms,
      hlc_counter = NEW.hlc_counter
  WHERE id = (
    SELECT source_id
    FROM plan_revision
    WHERE plan_id = NEW.plan_id
      AND revision_number = NEW.current_revision_number
  )
    AND plan_id = NEW.plan_id
    AND status = 'preview'
    AND base_revision_number = OLD.current_revision_number;
END;

CREATE TRIGGER planning_plan_close_stales_preview
AFTER UPDATE OF status ON planning_plan
WHEN OLD.status = 'active' AND NEW.status = 'closed'
BEGIN
  UPDATE plan_change
  SET status = 'stale',
      version = version + 1,
      terminal_at_ms = NEW.updated_at_ms,
      updated_at_ms = NEW.updated_at_ms,
      device_id = NEW.device_id,
      hlc_physical_ms = NEW.hlc_physical_ms,
      hlc_counter = NEW.hlc_counter
  WHERE plan_id = NEW.plan_id
    AND status = 'preview';
END;

CREATE TRIGGER plan_revision_no_update
BEFORE UPDATE ON plan_revision
BEGIN
  SELECT RAISE(ABORT, 'Plan revision is immutable');
END;

CREATE TRIGGER plan_revision_no_delete
BEFORE DELETE ON plan_revision
BEGIN
  SELECT RAISE(ABORT, 'Plan revision is immutable');
END;

CREATE TRIGGER plan_creation_terminal_no_update
BEFORE UPDATE ON plan_creation
WHEN OLD.status IN ('activated','discarded')
BEGIN
  SELECT RAISE(ABORT, 'terminal Plan Creation is immutable');
END;

CREATE TRIGGER plan_creation_no_delete
BEFORE DELETE ON plan_creation
BEGIN
  SELECT RAISE(ABORT, 'Plan Creation records are durable');
END;

CREATE TRIGGER plan_creation_answer_no_update
BEFORE UPDATE ON plan_creation_answer
BEGIN
  SELECT RAISE(ABORT, 'Plan Creation answer is immutable');
END;

CREATE TRIGGER plan_creation_answer_no_delete
BEFORE DELETE ON plan_creation_answer
BEGIN
  SELECT RAISE(ABORT, 'Plan Creation answer is immutable');
END;

CREATE TRIGGER plan_creation_draft_revision_no_update
BEFORE UPDATE ON plan_creation_draft_revision
BEGIN
  SELECT RAISE(ABORT, 'Plan Creation Draft revision is immutable');
END;

CREATE TRIGGER plan_creation_draft_revision_no_delete
BEFORE DELETE ON plan_creation_draft_revision
BEGIN
  SELECT RAISE(ABORT, 'Plan Creation Draft revision is immutable');
END;

CREATE TRIGGER athlete_preference_removed_no_update
BEFORE UPDATE ON athlete_preference
WHEN OLD.status = 'removed'
BEGIN
  SELECT RAISE(ABORT, 'removed athlete preference is immutable');
END;

CREATE TRIGGER athlete_preference_no_delete
BEFORE DELETE ON athlete_preference
BEGIN
  SELECT RAISE(ABORT, 'athlete preference records are durable');
END;

CREATE TRIGGER training_restriction_ended_no_update
BEFORE UPDATE ON training_restriction
WHEN OLD.status = 'ended'
BEGIN
  SELECT RAISE(ABORT, 'ended training restriction is immutable');
END;

CREATE TRIGGER training_restriction_no_delete
BEFORE DELETE ON training_restriction
BEGIN
  SELECT RAISE(ABORT, 'training restriction records are durable');
END;

CREATE TRIGGER plan_change_terminal_no_update
BEFORE UPDATE ON plan_change
WHEN OLD.status IN ('applied','stale','discarded')
BEGIN
  SELECT RAISE(ABORT, 'terminal Plan Change is immutable');
END;

CREATE TRIGGER plan_change_preview_transition
BEFORE UPDATE ON plan_change
WHEN OLD.status = 'preview'
BEGIN
  SELECT CASE WHEN NOT (
    NEW.id = OLD.id
    AND NEW.plan_id = OLD.plan_id
    AND NEW.base_revision_number = OLD.base_revision_number
    AND NEW.diff_json = OLD.diff_json
    AND NEW.rationale = OLD.rationale
    AND NEW.premises_json = OLD.premises_json
    AND NEW.preview_fingerprint = OLD.preview_fingerprint
    AND NEW.reconciliation_effect_json = OLD.reconciliation_effect_json
    AND NEW.created_at_ms = OLD.created_at_ms
    AND NEW.version = OLD.version + 1
    AND NEW.terminal_at_ms IS NOT NULL
    AND NEW.terminal_at_ms >= OLD.updated_at_ms
    AND NEW.updated_at_ms >= NEW.terminal_at_ms
    AND NEW.updated_at_ms >= OLD.updated_at_ms
    AND (
      NEW.hlc_physical_ms > OLD.hlc_physical_ms
      OR (
        NEW.hlc_physical_ms = OLD.hlc_physical_ms
        AND NEW.hlc_counter >= OLD.hlc_counter
      )
    )
    AND (
      (NEW.status = 'discarded' AND NEW.result_revision_number IS NULL)
      OR (
        NEW.status = 'stale'
        AND NEW.result_revision_number IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM planning_plan AS aggregate
          WHERE aggregate.plan_id = OLD.plan_id
            AND aggregate.status = 'active'
            AND aggregate.current_revision_number = OLD.base_revision_number
        )
      )
      OR (
        NEW.status = 'applied'
        AND NEW.result_revision_number = OLD.base_revision_number + 1
        AND EXISTS (
          SELECT 1
          FROM planning_plan AS aggregate
          JOIN plan_revision AS revision
            ON revision.plan_id = aggregate.plan_id
            AND revision.revision_number = aggregate.current_revision_number
          WHERE aggregate.plan_id = OLD.plan_id
            AND aggregate.status = 'active'
            AND aggregate.current_revision_number = NEW.result_revision_number
            AND revision.source_kind = 'plan-change'
            AND revision.source_id = OLD.id
        )
      )
    )
  ) THEN RAISE(ABORT, 'invalid Plan Change transition') END;
END;

CREATE TRIGGER plan_change_no_delete
BEFORE DELETE ON plan_change
BEGIN
  SELECT RAISE(ABORT, 'Plan Change records are durable');
END;

CREATE TRIGGER planning_command_terminal_no_update
BEFORE UPDATE ON planning_command
WHEN OLD.status IN ('succeeded','failed')
BEGIN
  SELECT RAISE(ABORT, 'terminal planning command is immutable');
END;

CREATE TRIGGER planning_command_pending_transition
BEFORE UPDATE ON planning_command
WHEN OLD.status = 'pending' AND NOT (
  NEW.status IN ('succeeded','failed')
  AND NEW.version = OLD.version + 1
  AND NEW.command_name = OLD.command_name
  AND NEW.command_id = OLD.command_id
  AND NEW.request_digest = OLD.request_digest
  AND NEW.aggregate_refs_json = OLD.aggregate_refs_json
  AND NEW.created_at_ms = OLD.created_at_ms
  AND NEW.updated_at_ms >= OLD.updated_at_ms
  AND (
    NEW.hlc_physical_ms > OLD.hlc_physical_ms
    OR (
      NEW.hlc_physical_ms = OLD.hlc_physical_ms
      AND NEW.hlc_counter >= OLD.hlc_counter
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid planning command transition');
END;

CREATE TRIGGER planning_command_no_delete
BEFORE DELETE ON planning_command
BEGIN
  SELECT RAISE(ABORT, 'planning command records are durable');
END;
