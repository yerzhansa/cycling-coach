ALTER TABLE swim_length ADD COLUMN distance_m REAL;

CREATE TABLE ingest_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  ingest_version INTEGER NOT NULL CHECK (ingest_version >= 0)
) STRICT;

INSERT INTO ingest_metadata (singleton, ingest_version) VALUES (1, 0);

CREATE TABLE repair_log (
  repair_key TEXT PRIMARY KEY,
  raw_sha256 TEXT NOT NULL REFERENCES raw_file(sha256) ON DELETE RESTRICT,
  session_key TEXT NOT NULL REFERENCES session(session_key) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  fixer TEXT NOT NULL,
  changed_count INTEGER NOT NULL CHECK (changed_count >= 0),
  changed_indices_json TEXT NOT NULL,
  params_json TEXT NOT NULL,
  UNIQUE (raw_sha256, session_key, channel, fixer)
) STRICT;
