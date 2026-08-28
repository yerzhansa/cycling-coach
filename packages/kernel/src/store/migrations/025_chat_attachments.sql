CREATE TABLE chat_attachment_object (
  id                TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  conversation_id   TEXT NOT NULL CHECK (length(conversation_id) BETWEEN 1 AND 512),
  conversation_key  TEXT NOT NULL CHECK (
    length(conversation_key) = 64 AND conversation_key NOT GLOB '*[^0-9a-f]*'
  ),
  sha256            TEXT NOT NULL CHECK (
    length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  byte_size         INTEGER NOT NULL CHECK (byte_size > 0),
  relative_path     TEXT NOT NULL CHECK (
    length(relative_path) BETWEEN 1 AND 512
    AND relative_path NOT LIKE '/%'
    AND relative_path NOT LIKE '%\\%'
    AND relative_path NOT LIKE '%..%'
  ),
  status            TEXT NOT NULL CHECK (status IN ('reserved','durable','failed')),
  failure_code      TEXT,
  created_at_ms     INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms     INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  CHECK (
    (status = 'failed' AND failure_code IS NOT NULL)
    OR (status != 'failed' AND failure_code IS NULL)
  )
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_chat_attachment_object_capacity
  ON chat_attachment_object (conversation_id, status, byte_size);
CREATE UNIQUE INDEX idx_chat_attachment_object_live_digest
  ON chat_attachment_object (conversation_id, sha256)
  WHERE status IN ('reserved','durable');

CREATE TABLE chat_attachment (
  id                TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  schema_version    INTEGER NOT NULL CHECK (schema_version = 1),
  conversation_id   TEXT NOT NULL CHECK (length(conversation_id) BETWEEN 1 AND 512),
  object_id         TEXT NOT NULL REFERENCES chat_attachment_object(id) ON DELETE RESTRICT,
  kind              TEXT NOT NULL CHECK (kind IN ('document','activity','workout','image')),
  display_name      TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 512),
  media_type        TEXT NOT NULL CHECK (length(media_type) BETWEEN 1 AND 256),
  extension         TEXT NOT NULL CHECK (
    extension IN ('pdf','txt','csv','docx','fit','tcx','gpx','zwo','mrc','erg','png','jpg','jpeg','webp')
  ),
  byte_size         INTEGER NOT NULL CHECK (byte_size > 0),
  sha256            TEXT NOT NULL CHECK (
    length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  status            TEXT NOT NULL CHECK (
    status IN ('preprocessing','blocked','failed','ready','importing','imported','sent')
  ),
  state_json        TEXT CHECK (state_json IS NULL OR json_valid(state_json)),
  message_id        TEXT,
  created_at_ms     INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms     INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  UNIQUE (conversation_id, id)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_chat_attachment_conversation
  ON chat_attachment (conversation_id, created_at_ms, id);
CREATE INDEX idx_chat_attachment_object
  ON chat_attachment (object_id);

CREATE TABLE chat_attachment_draft (
  conversation_id   TEXT PRIMARY KEY CHECK (length(conversation_id) BETWEEN 1 AND 512),
  schema_version    INTEGER NOT NULL CHECK (schema_version = 1),
  text              TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('active','restored','submitting','clearing')),
  updated_at_ms     INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT, WITHOUT ROWID;

CREATE TABLE chat_attachment_draft_ref (
  conversation_id   TEXT NOT NULL REFERENCES chat_attachment_draft(conversation_id) ON DELETE CASCADE,
  attachment_id     TEXT NOT NULL,
  ordinal           INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 4),
  PRIMARY KEY (conversation_id, attachment_id),
  UNIQUE (conversation_id, ordinal),
  FOREIGN KEY (conversation_id, attachment_id)
    REFERENCES chat_attachment(conversation_id, id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE chat_message_attachment (
  message_id        TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 512),
  conversation_id   TEXT NOT NULL CHECK (length(conversation_id) BETWEEN 1 AND 512),
  attachment_id     TEXT NOT NULL,
  ordinal           INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 4),
  created_at_ms     INTEGER NOT NULL CHECK (created_at_ms >= 0),
  PRIMARY KEY (message_id, attachment_id),
  UNIQUE (message_id, ordinal),
  FOREIGN KEY (conversation_id, attachment_id)
    REFERENCES chat_attachment(conversation_id, id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_chat_message_attachment_conversation
  ON chat_message_attachment (conversation_id, message_id, ordinal);
