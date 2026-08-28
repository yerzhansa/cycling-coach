CREATE TABLE planning_request (
  request_id TEXT PRIMARY KEY CHECK (length(request_id) BETWEEN 1 AND 512),
  kind TEXT NOT NULL CHECK (kind IN ('workout_review','plan_question','plan_change','plan_creation')),
  target TEXT NOT NULL CHECK (target IN ('active_plan','draft','plan_creation')),
  intent TEXT NOT NULL CHECK (length(intent) BETWEEN 1 AND 20000),
  payload_hash TEXT NOT NULL
    CHECK (
      length(payload_hash) = 64
      AND payload_hash = lower(payload_hash)
      AND payload_hash NOT GLOB '*[^0-9a-f]*'
    ),
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  source_status TEXT NOT NULL CHECK (source_status IN ('linked','detached_open','compacted')),
  source_chat_id TEXT NOT NULL CHECK (length(source_chat_id) BETWEEN 1 AND 512),
  source_message_id TEXT NOT NULL CHECK (length(source_message_id) BETWEEN 1 AND 512),
  source_attachment_id TEXT CHECK (
    source_attachment_id IS NULL OR length(source_attachment_id) BETWEEN 1 AND 512
  ),
  provenance_json TEXT CHECK (provenance_json IS NULL OR json_valid(provenance_json)),
  plan_conversation_id TEXT REFERENCES plan_conversation(id) ON DELETE SET NULL,
  proposal_id TEXT REFERENCES plan_proposal(id) ON DELETE SET NULL,
  requested_date_key INTEGER
    CHECK (
      requested_date_key IS NULL
      OR (
        requested_date_key BETWEEN 10101 AND 99991231
        AND ((requested_date_key / 100) % 100) BETWEEN 1 AND 12
        AND (requested_date_key % 100) BETWEEN 1 AND CASE
          WHEN ((requested_date_key / 100) % 100) IN (1,3,5,7,8,10,12) THEN 31
          WHEN ((requested_date_key / 100) % 100) IN (4,6,9,11) THEN 30
          WHEN ((requested_date_key / 10000) % 4) = 0
            AND (
              ((requested_date_key / 10000) % 100) <> 0
              OR ((requested_date_key / 10000) % 400) = 0
            ) THEN 29
          ELSE 28
        END
      )
    ),
  resolved_date_key INTEGER
    CHECK (
      resolved_date_key IS NULL
      OR (
        resolved_date_key BETWEEN 10101 AND 99991231
        AND ((resolved_date_key / 100) % 100) BETWEEN 1 AND 12
        AND (resolved_date_key % 100) BETWEEN 1 AND CASE
          WHEN ((resolved_date_key / 100) % 100) IN (1,3,5,7,8,10,12) THEN 31
          WHEN ((resolved_date_key / 100) % 100) IN (4,6,9,11) THEN 30
          WHEN ((resolved_date_key / 10000) % 4) = 0
            AND (
              ((resolved_date_key / 10000) % 100) <> 0
              OR ((resolved_date_key / 10000) % 400) = 0
            ) THEN 29
          ELSE 28
        END
      )
    ),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('open','applied','rejected','ended')),
  attention TEXT NOT NULL
    CHECK (attention IN ('none','needs_review','date_conflict','revalidating','stale_base','apply_failed')),
  revision INTEGER NOT NULL CHECK (revision > 0),
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
  CHECK (
    (source_status = 'linked' AND payload_json IS NOT NULL AND provenance_json IS NULL)
    OR (source_status = 'detached_open' AND payload_json IS NOT NULL AND provenance_json IS NOT NULL)
    OR (source_status = 'compacted' AND payload_json IS NULL AND provenance_json IS NOT NULL)
  ),
  CHECK (attention = 'none' OR (lifecycle = 'open' AND proposal_id IS NOT NULL)),
  CHECK (lifecycle = 'open' OR attention = 'none')
) STRICT;

CREATE INDEX idx_planning_request_lifecycle
  ON planning_request (lifecycle, attention, updated_at_ms DESC, request_id DESC);

CREATE INDEX idx_planning_request_proposal
  ON planning_request (proposal_id)
  WHERE proposal_id IS NOT NULL;

CREATE TABLE planning_request_terminal_result (
  request_id TEXT PRIMARY KEY REFERENCES planning_request(request_id) ON DELETE CASCADE,
  result_id TEXT NOT NULL UNIQUE CHECK (length(result_id) BETWEEN 1 AND 512),
  kind TEXT NOT NULL CHECK (kind IN ('applied','rejected','ended')),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  completed_at_ms INTEGER NOT NULL CHECK (completed_at_ms >= 0),
  plan_revision_id TEXT CHECK (
    plan_revision_id IS NULL OR length(plan_revision_id) BETWEEN 1 AND 512
  ),
  CHECK (
    (kind = 'applied' AND plan_revision_id IS NOT NULL)
    OR (kind IN ('rejected','ended'))
  )
) STRICT;

CREATE TRIGGER planning_request_terminal_result_no_update
BEFORE UPDATE ON planning_request_terminal_result
BEGIN
  SELECT RAISE(ABORT, 'planning request terminal result is immutable');
END;

CREATE TRIGGER planning_request_terminal_result_no_delete
BEFORE DELETE ON planning_request_terminal_result
BEGIN
  SELECT RAISE(ABORT, 'planning request terminal result is immutable');
END;

CREATE TABLE planning_request_tombstone (
  request_id TEXT PRIMARY KEY REFERENCES planning_request(request_id) ON DELETE CASCADE,
  payload_hash TEXT NOT NULL
    CHECK (
      length(payload_hash) = 64
      AND payload_hash = lower(payload_hash)
      AND payload_hash NOT GLOB '*[^0-9a-f]*'
    ),
  status TEXT NOT NULL CHECK (status IN ('applied','rejected','ended','source_deleted')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  terminal_at_ms INTEGER CHECK (terminal_at_ms IS NULL OR terminal_at_ms >= created_at_ms),
  CHECK (
    (status = 'source_deleted')
    OR terminal_at_ms IS NOT NULL
  )
) STRICT;

CREATE TRIGGER planning_request_tombstone_no_update
BEFORE UPDATE ON planning_request_tombstone
BEGIN
  SELECT RAISE(ABORT, 'planning request tombstone is immutable');
END;

CREATE TRIGGER planning_request_tombstone_no_delete
BEFORE DELETE ON planning_request_tombstone
BEGIN
  SELECT RAISE(ABORT, 'planning request tombstone is immutable');
END;
