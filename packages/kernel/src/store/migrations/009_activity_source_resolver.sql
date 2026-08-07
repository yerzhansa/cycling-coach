CREATE INDEX idx_source_record_session_source
  ON source_record (session_key, source, id)
  WHERE session_key IS NOT NULL;
