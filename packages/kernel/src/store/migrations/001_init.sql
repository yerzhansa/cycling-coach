-- INV-1 class: authored. Single row. PK = ULID.
CREATE TABLE athlete (
  id               TEXT PRIMARY KEY,   -- ULID
  display_name     TEXT,
  birth_year       INTEGER,
  sex              TEXT,               -- 'male' | 'female' | other closed-union member
  timezone         TEXT,               -- IANA tz id
  units            TEXT NOT NULL DEFAULT 'metric'
                     CHECK (units IN ('metric','imperial')),  -- athlete-wide display default; sport_settings.preferred_units overrides per sport
  device_id        TEXT NOT NULL,
  hlc_physical_ms  INTEGER NOT NULL,
  hlc_counter      INTEGER NOT NULL
);

-- INV-1 class: authored. One row per sport family. PK = ULID.
CREATE TABLE sport_settings (
  id                          TEXT PRIMARY KEY,   -- ULID
  sport                       TEXT NOT NULL UNIQUE,  -- closed SportId union
  session_cluster_conventions_json TEXT,
  preferred_units             TEXT,
  activity_type_map_json      TEXT,
  device_id                   TEXT NOT NULL,
  hlc_physical_ms             INTEGER NOT NULL,
  hlc_counter                 INTEGER NOT NULL
);

-- INV-1 class: per-row source | authored, discriminated by `provenance`
--   ('sync' => source row, provenance-hash id, stamp NULL;
--    'manual' => authored row, ULID id, stamp NOT NULL).
CREATE TABLE anchor_history (
  id               TEXT PRIMARY KEY,
  sport            TEXT NOT NULL,
  anchor_type      TEXT NOT NULL
                     CHECK (anchor_type IN
                       ('ftp','lthr','max_hr','critical_speed','css','threshold_pace')),
  value            REAL NOT NULL,
  unit             TEXT NOT NULL,      -- 'W' (ftp), 'm/s' (critical_speed/css), 'bpm' (lthr/max_hr)
  valid_from       INTEGER NOT NULL,   -- epoch seconds of effective instant
  source           TEXT NOT NULL,      -- provenance origin: 'manual', a connector id, or a seeded FTP annotation ('test'/'estimate')
  confidence       TEXT NOT NULL
                     CHECK (confidence IN ('manual','platform','fit')),  -- trust tier; source precedence manual > platform > fit
  note             TEXT,
  provenance       TEXT NOT NULL CHECK (provenance IN ('sync','manual')),
  device_id        TEXT,
  hlc_physical_ms  INTEGER,
  hlc_counter      INTEGER
);
CREATE INDEX idx_anchor_history_current ON anchor_history (sport, anchor_type, valid_from);

-- INV-1 class: per-row source | authored, discriminated by `provenance`.
-- Default anchor-derived zone tables are computed at read time, NOT stored here;
-- this table stores only explicit zone sets (manual overrides or platform-synced).
CREATE TABLE zone_set_history (
  id               TEXT PRIMARY KEY,
  sport            TEXT NOT NULL,
  stream           TEXT NOT NULL,      -- 'power' | 'hr' | 'pace' | ...
  anchor_ref       TEXT,               -- anchor_type this set hangs off, or NULL = absolute
  boundaries_json  TEXT NOT NULL,
  valid_from       INTEGER NOT NULL,
  source           TEXT NOT NULL,
  provenance       TEXT NOT NULL CHECK (provenance IN ('sync','manual')),
  device_id        TEXT,
  hlc_physical_ms  INTEGER,
  hlc_counter      INTEGER
);
CREATE INDEX idx_zone_set_history_current ON zone_set_history (sport, stream, valid_from);

-- INV-1 class: derived (rebuildable). PK = content-derived hash. Athlete edits
-- (rename/notes) live in field_merge_override_overlay, never as edits here.
CREATE TABLE workout (
  workout_key      TEXT PRIMARY KEY,   -- hex sha256("workout", dedup_cluster_id)
  start_utc        INTEGER NOT NULL,
  tz_offset_s      INTEGER,
  name             TEXT,               -- source-provided; athlete rename is an overlay
  notes            TEXT,               -- source-provided
  is_multisport    INTEGER NOT NULL DEFAULT 0,
  dedup_cluster_id TEXT NOT NULL
);

-- INV-1 class: derived. PK = content-derived hash. Metric attachment point.
CREATE TABLE session (
  session_key      TEXT PRIMARY KEY,   -- hex sha256("session", workout_key, session_seq)
  workout_key      TEXT NOT NULL REFERENCES workout(workout_key) ON DELETE CASCADE,
  session_seq      INTEGER NOT NULL,
  sport            TEXT NOT NULL,      -- single-discipline SportId
  sub_sport        TEXT,
  start_utc        INTEGER NOT NULL,
  tz_offset_s      INTEGER,
  local_date_key   INTEGER NOT NULL,   -- YYYYMMDD local civil date; serves the adherence read
  elapsed_s        INTEGER,
  timer_s          INTEGER,
  moving_s         INTEGER,
  distance_m       REAL,
  is_transition    INTEGER NOT NULL DEFAULT 0,  -- 1 => excluded from sport metrics
  summary_json     TEXT
);
CREATE INDEX idx_session_workout ON session (workout_key);
CREATE INDEX idx_session_adherence ON session (local_date_key, sport);

-- INV-1 class: derived. PK = content-derived hash.
CREATE TABLE lap (
  lap_key          TEXT PRIMARY KEY,   -- hex sha256("lap", session_key, lap_seq)
  session_key      TEXT NOT NULL REFERENCES session(session_key) ON DELETE CASCADE,
  lap_seq          INTEGER NOT NULL,
  start_utc        INTEGER,
  elapsed_s        INTEGER,
  timer_s          INTEGER,
  distance_m       REAL,
  summary_json     TEXT
);
CREATE INDEX idx_lap_session ON lap (session_key);

-- INV-1 class: derived. PK = content-derived hash. NO corrected_stroke_type column
-- (stroke corrections live in stroke_correction_overlay).
CREATE TABLE swim_length (
  length_key       TEXT PRIMARY KEY,   -- hex sha256("swim_length", lap_key, length_seq)
  lap_key          TEXT NOT NULL REFERENCES lap(lap_key) ON DELETE CASCADE,
  length_seq       INTEGER NOT NULL,
  start_utc        INTEGER,
  elapsed_s        INTEGER,
  timer_s          INTEGER,
  strokes          INTEGER,
  stroke_type      TEXT,
  length_type      TEXT
);
CREATE INDEX idx_swim_length_lap ON swim_length (lap_key);

-- INV-1 class: derived. PK = content-derived hash. One row per (session, channel);
-- NEVER row-per-sample. `encoding` is the 'dtype:delta:codec:endian' token grammar.
CREATE TABLE stream (
  stream_key       TEXT PRIMARY KEY,   -- hex sha256("stream", session_key, channel)
  session_key      TEXT NOT NULL REFERENCES session(session_key) ON DELETE CASCADE,
  channel          TEXT NOT NULL,
  encoding         TEXT NOT NULL,      -- 'dtype:delta:codec:endian'
  sample_rate      REAL,               -- nominal Hz; 0 or a 'time' channel when non-uniform
  n                INTEGER NOT NULL,   -- decoded sample count
  data             BLOB NOT NULL,
  UNIQUE (session_key, channel)
);
CREATE INDEX idx_stream_session ON stream (session_key);

-- INV-1 class: source (immutable input). NEVER in the rebuild DELETE set.
-- PK = provenance-derived hash. No fetched_at (sync timing lives in the ops ledger).
CREATE TABLE source_record (
  id               TEXT PRIMARY KEY,   -- hex sha256("source_record", source, external_id)
  workout_key      TEXT,               -- nullable; unconstrained (dedup pre-dates workout rows)
  session_key      TEXT,
  source           TEXT NOT NULL,
  external_id      TEXT NOT NULL,
  raw_sha256       TEXT,               -- REFERENCES raw_file(sha256) when file-backed
  quality_rank     INTEGER NOT NULL,
  payload_json     TEXT NOT NULL,
  UNIQUE (source, external_id)
);

-- INV-1 class: source (immutable input). NEVER in the rebuild DELETE set.
-- PK = the file's own content sha256. No imported_at (sync timing lives in the ops ledger).
CREATE TABLE raw_file (
  sha256                   TEXT PRIMARY KEY,
  path                     TEXT,
  ext                      TEXT,
  bytes                    INTEGER,
  file_id_serial           INTEGER,
  file_id_time_created_utc INTEGER,    -- from file content; feeds canonical rebuild order
  manufacturer             TEXT,
  product                  TEXT
);

-- INV-1 class: per-row source | authored, discriminated by `provenance`.
-- One base row per local day (UNIQUE date_key). Manual per-field corrections on a
-- sync day live in field_merge_override_overlay, NOT as a second row.
-- Collision policy (both orderings): an authored ('manual') day row is never
-- overwritten or displaced by a later sync for the same date_key. The sync payload
-- is always retained in the immutable archive; whether its objective fields surface
-- (via the overlay merge path) is a read-time concern, but the authored row wins and
-- the sync never clobbers it. A 'sync' day row is likewise refreshed only by re-sync.
CREATE TABLE wellness (
  id               TEXT PRIMARY KEY,   -- 'sync': hex sha256("wellness",date_key,source); 'manual': ULID
  date_key         INTEGER NOT NULL UNIQUE,  -- YYYYMMDD local civil date
  provenance       TEXT NOT NULL CHECK (provenance IN ('sync','manual')),
  source           TEXT,               -- NOT NULL on 'sync' rows (hash-tuple field); see CHECK below
  resting_hr       INTEGER,
  hrv              REAL,               -- rMSSD
  hrv_sdnn         REAL,
  sleep_s          INTEGER,
  sleep_score      INTEGER,
  weight_kg        REAL,
  soreness         INTEGER,
  fatigue          INTEGER,
  fields_json      TEXT,               -- open superset of remaining per-field values + per-field source tags
  device_id        TEXT,
  hlc_physical_ms  INTEGER,
  hlc_counter      INTEGER,
  CHECK (provenance != 'sync' OR source IS NOT NULL)
);

-- INV-1 class: per-row source | authored, discriminated by `provenance`.
CREATE TABLE planned_workout (
  id               TEXT PRIMARY KEY,   -- 'sync': hex sha256("planned_workout",source,external_ref); 'manual': ULID
  date_key         INTEGER NOT NULL,   -- YYYYMMDD local civil date
  sport            TEXT NOT NULL,
  structure_json   TEXT NOT NULL,      -- existing serializer shapes
  source           TEXT,               -- NOT NULL on 'sync' rows (hash-tuple field); see CHECK below
  external_ref     TEXT,               -- NOT NULL on 'sync' rows (hash-tuple field); see CHECK below
  status           TEXT,
  provenance       TEXT NOT NULL CHECK (provenance IN ('sync','manual')),
  device_id        TEXT,
  hlc_physical_ms  INTEGER,
  hlc_counter      INTEGER,
  CHECK (provenance != 'sync' OR (source IS NOT NULL AND external_ref IS NOT NULL))
);
CREATE INDEX idx_planned_workout_adherence ON planned_workout (date_key, sport);

-- INV-1 class: authored. PK = ULID.
CREATE TABLE race_goal (
  id               TEXT PRIMARY KEY,   -- ULID
  date_key         INTEGER NOT NULL,   -- YYYYMMDD local civil date
  sport            TEXT NOT NULL,
  name             TEXT,
  priority         TEXT NOT NULL CHECK (priority IN ('A','B','C')),
  type             TEXT,               -- event distance/type tag
  target_json      TEXT,
  outcome_json     TEXT,
  device_id        TEXT NOT NULL,
  hlc_physical_ms  INTEGER NOT NULL,
  hlc_counter      INTEGER NOT NULL
);

-- INV-1 class: authored. Single row. PK = ULID. The five named intake flags.
CREATE TABLE intake_flags (
  id                          TEXT PRIMARY KEY,   -- ULID
  swim_skill_floor            TEXT,     -- swim skill-floor self-report answers
  continuous_distance_capable INTEGER,  -- continuous-distance capability
  open_water_comfort          TEXT,     -- open-water comfort
  clinician_cleared           INTEGER,  -- clinician-cleared flag
  injury_status               TEXT,     -- current injury status
  device_id                   TEXT NOT NULL,
  hlc_physical_ms             INTEGER NOT NULL,
  hlc_counter                 INTEGER NOT NULL
);

-- INV-1 class: derived. PK = content-derived hash. value_json carries the
-- `kind: computed | unknown` envelope. NO computed_at (ops ledger carries timing).
CREATE TABLE metric_snapshot (
  snapshot_key     TEXT PRIMARY KEY,   -- hex sha256("metric_snapshot",scope_kind,scope_id,metric_key)
  scope_kind       TEXT NOT NULL CHECK (scope_kind IN ('session','date')),
  scope_id         TEXT NOT NULL,      -- session_key (session scope) | YYYYMMDD (date scope)
  metric_key       TEXT NOT NULL,
  value_json       TEXT NOT NULL,
  kernel_version   TEXT NOT NULL,
  basis_version    TEXT NOT NULL
);
CREATE INDEX idx_metric_snapshot_scope ON metric_snapshot (scope_kind, scope_id);
CREATE INDEX idx_metric_snapshot_metric ON metric_snapshot (metric_key);

-- INV-1 class: derived. PK = content-derived hash. One row per (session, channel).
CREATE TABLE mean_max_cache (
  mmax_key         TEXT PRIMARY KEY,   -- hex sha256("mean_max_cache", session_key, channel)
  session_key      TEXT NOT NULL REFERENCES session(session_key) ON DELETE CASCADE,
  channel          TEXT NOT NULL,
  curve_json       TEXT NOT NULL,      -- duration -> best-mean-max value pairs
  kernel_version   TEXT NOT NULL,
  UNIQUE (session_key, channel)
);

-- INV-1 class: authored overlay. PK = ULID. Overlays swim_length by natural key;
-- no FK (rebuild DELETE-derived must neither cascade nor block; orphans retained + flagged).
CREATE TABLE stroke_correction_overlay (
  id                    TEXT PRIMARY KEY,   -- ULID
  target_length_key     TEXT NOT NULL,
  corrected_stroke_type TEXT NOT NULL,
  device_id             TEXT NOT NULL,
  hlc_physical_ms       INTEGER NOT NULL,
  hlc_counter           INTEGER NOT NULL
);
CREATE INDEX idx_stroke_correction_target ON stroke_correction_overlay (target_length_key);

-- INV-1 class: authored overlay. PK = ULID. Generic per-field override (workout rename,
-- session edit, wellness per-field correction). No FK; orphans retained + flagged.
CREATE TABLE field_merge_override_overlay (
  id                  TEXT PRIMARY KEY,   -- ULID
  target_table        TEXT NOT NULL,
  target_key          TEXT NOT NULL,
  field_name          TEXT NOT NULL,
  override_value_json TEXT NOT NULL,
  device_id           TEXT NOT NULL,
  hlc_physical_ms     INTEGER NOT NULL,
  hlc_counter         INTEGER NOT NULL,
  UNIQUE (target_table, target_key, field_name)
);

-- INV-1 class: authored overlay. PK = ULID. Overlays a session's pool length.
-- No FK; orphans retained + flagged.
CREATE TABLE pool_size_correction_overlay (
  id                     TEXT PRIMARY KEY,   -- ULID
  target_session_key     TEXT NOT NULL,
  corrected_pool_length_m REAL NOT NULL,
  device_id              TEXT NOT NULL,
  hlc_physical_ms        INTEGER NOT NULL,
  hlc_counter            INTEGER NOT NULL
);
CREATE INDEX idx_pool_size_target ON pool_size_correction_overlay (target_session_key);
