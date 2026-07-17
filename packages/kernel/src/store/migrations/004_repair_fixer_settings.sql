CREATE TABLE repair_fixer_settings (
  fixer TEXT PRIMARY KEY
    CHECK (fixer IN ('chronoBridge','summitGuard','pulseWeave')),
  enabled INTEGER NOT NULL CHECK (enabled = 1)
) STRICT;
