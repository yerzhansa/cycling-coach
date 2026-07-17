CREATE TABLE ingest_incremental_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  initialized INTEGER NOT NULL CHECK (initialized IN (0,1))
) STRICT;

INSERT INTO ingest_incremental_state (singleton, initialized) VALUES (1, 0);

CREATE TABLE ingest_candidate_index (
  candidate_id TEXT PRIMARY KEY CHECK (length(candidate_id) > 0),
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('raw_file','source_record')),
  artifact_id TEXT NOT NULL CHECK (length(artifact_id) > 0),
  member_id TEXT NOT NULL
    CHECK (length(member_id) = 64 AND member_id NOT GLOB '*[^0-9a-f]*'),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('fit','tcx','gpx','platform_api')),
  source_session_seq INTEGER NOT NULL CHECK (source_session_seq >= 0),
  sport_family TEXT NOT NULL CHECK (length(sport_family) > 0),
  is_transition INTEGER NOT NULL CHECK (is_transition IN (0,1)),
  start_utc REAL NOT NULL CHECK (start_utc >= 0),
  duration_s REAL NOT NULL CHECK (duration_s >= 0),
  distance_m REAL CHECK (distance_m IS NULL OR distance_m >= 0),
  file_id_manufacturer TEXT,
  file_id_serial INTEGER CHECK (file_id_serial IS NULL OR file_id_serial >= 0),
  file_id_time_created_utc INTEGER
    CHECK (file_id_time_created_utc IS NULL OR file_id_time_created_utc >= 0),
  candidate_summary_json TEXT NOT NULL,
  UNIQUE (artifact_kind, artifact_id, candidate_id)
) STRICT;

CREATE INDEX idx_ingest_candidate_artifact
  ON ingest_candidate_index (artifact_kind, artifact_id, candidate_id);

CREATE INDEX idx_ingest_candidate_member
  ON ingest_candidate_index (member_id, candidate_id);

CREATE INDEX idx_ingest_candidate_topology
  ON ingest_candidate_index (sport_family, start_utc, candidate_id);

CREATE TABLE ingest_dedup_pair_state (
  candidate_a TEXT NOT NULL
    REFERENCES ingest_candidate_index(candidate_id) ON DELETE CASCADE,
  candidate_b TEXT NOT NULL
    REFERENCES ingest_candidate_index(candidate_id) ON DELETE CASCADE,
  edge_tier TEXT CHECK (edge_tier IS NULL OR edge_tier IN ('tier2','tier3','confirmation')),
  threshold_near_miss_json TEXT,
  overlap_watchlist_json TEXT,
  confirm_queue_json TEXT,
  PRIMARY KEY (candidate_a, candidate_b),
  CHECK (candidate_a < candidate_b),
  CHECK (
    edge_tier IS NOT NULL
    OR threshold_near_miss_json IS NOT NULL
    OR overlap_watchlist_json IS NOT NULL
    OR confirm_queue_json IS NOT NULL
  )
) STRICT;

CREATE INDEX idx_ingest_dedup_pair_candidate_b
  ON ingest_dedup_pair_state (candidate_b, candidate_a);

CREATE TABLE ingest_dedup_session_state (
  session_group_id TEXT PRIMARY KEY CHECK (length(session_group_id) > 0),
  topology_signature_json TEXT NOT NULL,
  candidate_ids_json TEXT NOT NULL,
  summaries_json TEXT NOT NULL,
  members_json TEXT NOT NULL,
  edge_tiers_json TEXT NOT NULL
) STRICT;

CREATE TABLE ingest_cluster_state (
  cluster_id TEXT PRIMARY KEY CHECK (length(cluster_id) > 0),
  workout_key TEXT NOT NULL UNIQUE
    REFERENCES workout(workout_key) ON DELETE CASCADE,
  topology_signature_json TEXT NOT NULL,
  cluster_report_json TEXT NOT NULL
) STRICT;
