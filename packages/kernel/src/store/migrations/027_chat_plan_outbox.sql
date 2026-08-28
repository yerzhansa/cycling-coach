CREATE TABLE chat_plan_outbox (
  request_id TEXT PRIMARY KEY CHECK (length(request_id) BETWEEN 1 AND 512),
  state TEXT NOT NULL CHECK (state IN ('pending','failed','delivered','cancelled')),
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  payload_hash TEXT NOT NULL
    CHECK (
      length(payload_hash) = 64
      AND payload_hash = lower(payload_hash)
      AND payload_hash NOT GLOB '*[^0-9a-f]*'
    ),
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
  failure_code TEXT CHECK (
    failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 128
  ),
  retryable INTEGER CHECK (retryable IS NULL OR retryable IN (0,1)),
  delivered_at_ms INTEGER CHECK (delivered_at_ms IS NULL OR delivered_at_ms >= 0),
  source_deleted_at_ms INTEGER CHECK (
    source_deleted_at_ms IS NULL OR source_deleted_at_ms >= 0
  ),
  cancelled_at_ms INTEGER CHECK (cancelled_at_ms IS NULL OR cancelled_at_ms >= 0),
  cancel_reason TEXT CHECK (
    cancel_reason IS NULL OR cancel_reason = 'source_conversation_deleted'
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  CHECK (
    (state = 'pending'
      AND payload_json IS NOT NULL
      AND failure_code IS NULL
      AND retryable IS NULL
      AND delivered_at_ms IS NULL
      AND source_deleted_at_ms IS NULL
      AND cancelled_at_ms IS NULL
      AND cancel_reason IS NULL)
    OR
    (state = 'failed'
      AND payload_json IS NOT NULL
      AND attempt_count > 0
      AND failure_code IS NOT NULL
      AND retryable IS NOT NULL
      AND delivered_at_ms IS NULL
      AND source_deleted_at_ms IS NULL
      AND cancelled_at_ms IS NULL
      AND cancel_reason IS NULL)
    OR
    (state = 'delivered'
      AND attempt_count > 0
      AND failure_code IS NULL
      AND retryable IS NULL
      AND delivered_at_ms IS NOT NULL
      AND cancelled_at_ms IS NULL
      AND cancel_reason IS NULL
      AND (
        (source_deleted_at_ms IS NULL AND payload_json IS NOT NULL)
        OR
        (source_deleted_at_ms IS NOT NULL AND payload_json IS NULL)
      ))
    OR
    (state = 'cancelled'
      AND payload_json IS NULL
      AND failure_code IS NULL
      AND retryable IS NULL
      AND delivered_at_ms IS NULL
      AND source_deleted_at_ms IS NULL
      AND cancelled_at_ms IS NOT NULL
      AND cancel_reason = 'source_conversation_deleted')
  )
) STRICT;

CREATE INDEX idx_chat_plan_outbox_recoverable
ON chat_plan_outbox(updated_at_ms, request_id)
WHERE state = 'pending' OR (state = 'failed' AND retryable = 1);

CREATE TRIGGER chat_plan_outbox_no_delete
BEFORE DELETE ON chat_plan_outbox
BEGIN
  SELECT RAISE(ABORT, 'chat plan outbox records are durable');
END;

CREATE TRIGGER chat_plan_outbox_cancelled_no_update
BEFORE UPDATE ON chat_plan_outbox
WHEN OLD.state = 'cancelled'
BEGIN
  SELECT RAISE(ABORT, 'cancelled chat plan outbox records are immutable');
END;

CREATE TRIGGER chat_plan_outbox_detached_delivered_no_update
BEFORE UPDATE ON chat_plan_outbox
WHEN OLD.state = 'delivered' AND OLD.source_deleted_at_ms IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'detached delivered chat plan outbox records are immutable');
END;
