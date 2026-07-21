CREATE TABLE store_owner (
  singleton INTEGER PRIMARY KEY
    CHECK (singleton = 1),
  account_fingerprint TEXT NOT NULL
    CHECK (
      length(account_fingerprint) = 64
      AND account_fingerprint = lower(account_fingerprint)
      AND account_fingerprint NOT GLOB '*[^0-9a-f]*'
    )
) STRICT;

CREATE TRIGGER store_owner_no_update
BEFORE UPDATE ON store_owner
BEGIN
  SELECT RAISE(ABORT, 'store owner is immutable');
END;

CREATE TRIGGER store_owner_no_delete
BEFORE DELETE ON store_owner
BEGIN
  SELECT RAISE(ABORT, 'store owner is immutable');
END;
