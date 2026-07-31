CREATE TABLE dedup_confirmation (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 26
      AND id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
    ),
  member_a TEXT NOT NULL
    CHECK (length(member_a) = 64 AND member_a NOT GLOB '*[^0-9a-f]*'),
  member_b TEXT NOT NULL
    CHECK (length(member_b) = 64 AND member_b NOT GLOB '*[^0-9a-f]*'),
  verdict TEXT NOT NULL CHECK (verdict IN ('merge','distinct')),
  device_id TEXT NOT NULL
    CHECK (
      length(device_id) BETWEEN 1 AND 128
      AND substr(device_id, 1, 1) GLOB '[A-Za-z0-9]'
      AND device_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    ),
  hlc_physical_ms INTEGER NOT NULL,
  hlc_counter INTEGER NOT NULL,
  CHECK (member_a < member_b)
) STRICT;

CREATE INDEX idx_dedup_confirmation_effective
  ON dedup_confirmation (
    member_a,
    member_b,
    hlc_physical_ms DESC,
    hlc_counter DESC,
    device_id DESC,
    id DESC
  );
