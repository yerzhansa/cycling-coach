CREATE TABLE sync_failure (
  source TEXT PRIMARY KEY
    CHECK (source IN ('intervals-icu','file-import')),
  severity TEXT NOT NULL CHECK (severity IN ('warn','block')),
  detail TEXT NOT NULL
    CHECK (detail IN (
      'source authorization failed',
      'source temporarily unavailable',
      'source data failed validation',
      'source synchronization budget exhausted',
      'source synchronization failed',
      'source failure classification failed'
    )),
  logical_ordinal INTEGER NOT NULL
    CHECK (logical_ordinal BETWEEN 0 AND 8640000000000000)
) STRICT;
